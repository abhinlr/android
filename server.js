const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const pLimit = require('p-limit');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Cache data to prevent hitting Binance API limits
let cachedSymbols = null;
let lastSymbolsFetch = 0;
const newCoinsMap = {}; // { 'BTCUSDT': false, 'NEWCOINUSDT': true }

const metricsCache = {};
const FETCH_INTERVAL_MS = 25000; // 25 seconds cache

const binanceClient = axios.create({
  baseURL: 'https://api.binance.com',
  timeout: 15000,
});

// Background task to identify new coins (< 24h old)
async function detectNewCoins(symbols) {
  const limit = pLimit(10); // Low concurrency so we don't spam
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
  
  const promises = symbols.map(sym => limit(async () => {
    if (newCoinsMap[sym] !== undefined) return; // Already checked
    
    try {
      const res = await binanceClient.get(`/api/v3/klines`, {
        params: { symbol: sym, interval: '1M', startTime: 0, limit: 1 } // Get very first kline ever
      });
      if (res.data && res.data.length > 0) {
        const firstKlineOpenTime = res.data[0][0];
        newCoinsMap[sym] = firstKlineOpenTime > oneDayAgo;
      }
    } catch (err) {
      // ignore
    }
  }));
  
  await Promise.all(promises);
}

async function getUsdtSymbols() {
  const now = Date.now();
  if (cachedSymbols && (now - lastSymbolsFetch < 1000 * 60 * 60)) { 
    return cachedSymbols;
  }
  
  try {
    const response = await binanceClient.get('/api/v3/exchangeInfo');
    const symbols = response.data.symbols
      .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.isSpotTradingAllowed)
      .map(s => s.symbol);
    
    cachedSymbols = symbols;
    lastSymbolsFetch = now;
    
    // Fire off background new coin detection
    detectNewCoins(symbols).catch(e => console.log('New coin detection error:', e.message));
    
    return symbols;
  } catch (err) {
    console.error('Error fetching symbols:', err.message);
    return cachedSymbols || [];
  }
}

async function fetchKlines(symbol, interval) {
  try {
    const isNew = newCoinsMap[symbol] || false;
    
    if (interval === '30s') {
      // Max limit for 1s data is 1000. 1000 seconds = 33 blocks of 30 seconds.
      const res = await binanceClient.get(`/api/v3/klines`, {
        params: { symbol, interval: '1s', limit: 990 }
      });
      const data = res.data;
      
      const blocks = [];
      // Group by 30s chunks
      for (let i = 0; i < data.length; i += 30) {
        const chunk = data.slice(i, i + 30);
        if (chunk.length === 30) {
          const close = parseFloat(chunk[29][4]);
          const vol = chunk.reduce((sum, candle) => sum + parseFloat(candle[7]), 0);
          const timestamp = chunk[0][0]; // start time of this 30s block
          blocks.push({ close, vol, timestamp });
        }
      }
      
      if (blocks.length < 2) return null;
      
      const history = [];
      // Go backwards from newest to oldest to compute changes compared to the prior block
      for (let i = blocks.length - 1; i >= 1; i--) {
        const curr = blocks[i];
        const prev = blocks[i-1];
        
        const priceChangePct = prev.close === 0 ? 0 : ((curr.close - prev.close) / prev.close) * 100;
        const volChangePct = prev.vol === 0 ? 0 : ((curr.vol - prev.vol) / prev.vol) * 100;
        
        history.push({
          timestamp: curr.timestamp,
          price: curr.close,
          volume: curr.vol,
          priceChangePct,
          volumeChangePct: volChangePct
        });
      }
      
      return { symbol, isNew, history };
      
    } else {
      // Standard intervals: fetch 101 candles (current + 100 previous)
      // The oldest one (index 0) is used as the base for index 1's % changes.
      const res = await binanceClient.get(`/api/v3/klines`, {
        params: { symbol, interval, limit: 101 }
      });
      const data = res.data;
      if (data.length < 2) return null;
      
      const history = [];
      
      // Go backwards from newest to oldest
      for (let i = data.length - 1; i >= 1; i--) {
        const currClose = parseFloat(data[i][4]);
        const currVol = parseFloat(data[i][7]);
        const currTime = data[i][0];
        
        const prevClose = parseFloat(data[i-1][4]);
        const prevVol = parseFloat(data[i-1][7]);
        
        const priceChangePct = prevClose === 0 ? 0 : ((currClose - prevClose) / prevClose) * 100;
        const volChangePct = prevVol === 0 ? 0 : ((currVol - prevVol) / prevVol) * 100;
        
        history.push({
          timestamp: currTime,
          price: currClose,
          volume: currVol,
          priceChangePct,
          volumeChangePct: volChangePct
        });
      }
      
      return { symbol, isNew, history };
    }
  } catch (err) {
    if (err.response) {
      console.error(`Error fetching ${symbol}: ${err.response.status} - ${err.response.data.msg}`);
    } else {
      console.error(`Error fetching ${symbol}: ${err.message}`);
    }
    return null;
  }
}

const activeFetches = {};

async function refreshMetrics(interval) {
  if (activeFetches[interval]) return activeFetches[interval];
  
  const fetchPromise = (async () => {
    const symbols = await getUsdtSymbols();
    const limit = pLimit(15);
    
    const promises = symbols.map(sym => limit(() => fetchKlines(sym, interval)));
    const results = await Promise.all(promises);
    
    const validResults = results.filter(r => r !== null);
    
    metricsCache[interval] = {
      timestamp: Date.now(),
      data: validResults
    };
    
    delete activeFetches[interval];
    return validResults;
  })();
  
  activeFetches[interval] = fetchPromise;
  return fetchPromise;
}

app.get('/api/metrics', async (req, res) => {
  const interval = req.query.interval || '15m';
  const now = Date.now();
  
  const validIntervals = ['30s', '1m', '3m', '5m', '15m', '30m', '1h'];
  if (!validIntervals.includes(interval)) {
    return res.status(400).json({ error: 'Invalid interval' });
  }

  if (metricsCache[interval] && (now - metricsCache[interval].timestamp < FETCH_INTERVAL_MS)) {
    return res.json(metricsCache[interval].data);
  }
  
  if (metricsCache[interval]) {
    refreshMetrics(interval).catch(err => console.error("Background refresh error:", err.message));
    
    const data = metricsCache[interval].data;
    if (Array.isArray(data) && data.length > 0) {
      return res.json(data);
    } else {
      return res.status(404).json({ error: 'No data available' });
    }
  }

  try {
    const data = await refreshMetrics(interval);
    if (Array.isArray(data) && data.length > 0) {
      res.json(data);
    } else {
      res.status(404).json({ error: 'No data returned from server' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

app.listen(port, '0.0.0.0', () => {
  const { networkInterfaces } = require('os');
  const nets = networkInterfaces();
  let localIP = 'YOUR-PC-IP';
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        localIP = net.address;
      }
    }
  }
  console.log(`Server running at http://localhost:${port}`);
  console.log(`\n📱 To open on your phone (same WiFi): http://${localIP}:${port}\n`);
});
