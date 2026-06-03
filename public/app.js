const BINANCE_API = 'https://api.binance.com';
let cachedSymbols = null;
let lastSymbolsFetch = 0;
const newCoinsMap = {};
const metricsCache = {};
const FETCH_INTERVAL_MS = 25000;

function createLimiter(concurrency) {
  let running = 0;
  const queue = [];
  function runNext() {
    while (running < concurrency && queue.length > 0) {
      const { fn, resolve, reject } = queue.shift();
      running++;
      fn().then(resolve).catch(reject).finally(() => { running--; runNext(); });
    }
  }
  return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); runNext(); });
}

async function getUsdtSymbols() {
  const now = Date.now();
  if (cachedSymbols && (now - lastSymbolsFetch < 60 * 60 * 1000)) return cachedSymbols;
  const res = await fetch(`${BINANCE_API}/api/v3/exchangeInfo`);
  const data = await res.json();
  cachedSymbols = data.symbols
    .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.isSpotTradingAllowed)
    .map(s => s.symbol);
  lastSymbolsFetch = now;
  return cachedSymbols;
}

async function fetchKlinesData(symbol, interval) {
  try {
    const isNew = newCoinsMap[symbol] || false;
    if (interval === '30s') {
      const res = await fetch(`${BINANCE_API}/api/v3/klines?symbol=${symbol}&interval=1s&limit=990`);
      const data = await res.json();
      const blocks = [];
      for (let i = 0; i < data.length; i += 30) {
        const chunk = data.slice(i, i + 30);
        if (chunk.length === 30) {
          const close = parseFloat(chunk[29][4]);
          const vol = chunk.reduce((sum, c) => sum + parseFloat(c[7]), 0);
          blocks.push({ close, vol, timestamp: chunk[0][0] });
        }
      }
      if (blocks.length < 2) return null;
      const history = [];
      for (let i = blocks.length - 1; i >= 1; i--) {
        const curr = blocks[i], prev = blocks[i - 1];
        history.push({
          timestamp: curr.timestamp,
          price: curr.close,
          volume: curr.vol,
          priceChangePct: prev.close === 0 ? 0 : ((curr.close - prev.close) / prev.close) * 100,
          volumeChangePct: prev.vol === 0 ? 0 : ((curr.vol - prev.vol) / prev.vol) * 100
        });
      }
      return { symbol, isNew, history };
    } else {
      const res = await fetch(`${BINANCE_API}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=101`);
      const data = await res.json();
      if (data.length < 2) return null;
      const history = [];
      for (let i = data.length - 1; i >= 1; i--) {
        const prevClose = parseFloat(data[i - 1][4]);
        const prevVol = parseFloat(data[i - 1][7]);
        history.push({
          timestamp: data[i][0],
          price: parseFloat(data[i][4]),
          volume: parseFloat(data[i][7]),
          priceChangePct: prevClose === 0 ? 0 : ((parseFloat(data[i][4]) - prevClose) / prevClose) * 100,
          volumeChangePct: prevVol === 0 ? 0 : ((parseFloat(data[i][7]) - prevVol) / prevVol) * 100
        });
      }
      return { symbol, isNew, history };
    }
  } catch {
    return null;
  }
}

let state = {
  data: [],
  interval: '1m',
  filterPct: 1.0,
  hideUnfiltered: false,
  hideVolume: true,
  search: '',
  sortCol: 'streak',
  sortAsc: false,
  minPrice: 0,
  minVolume: 0
};

const DOMElements = {
  tableContainer: document.querySelector('.table-container'),
  tableHead: document.getElementById('tableHead'),
  tableBody: document.getElementById('tableBody'),
  loading: document.getElementById('loading'),
  intervalSelect: document.getElementById('intervalSelect'),
  filterInput: document.getElementById('filterInput'),
  hideToggle: document.getElementById('hideUnfilteredToggle'),
  hideVolumeToggle: document.getElementById('hideVolumeToggle'),
  searchInput: document.getElementById('searchInput'),
  sortStreakBtn: document.getElementById('sortStreakBtn'),
  fabUp: document.getElementById('fabUp'),
  fabDown: document.getElementById('fabDown'),
  fabLeft: document.getElementById('fabLeft')
};

let pollTimer = null;
let processedData = []; // Cached sorted & filtered data

function setupMenu() {
  const btn = document.getElementById('settingsBtn');
  const panel = document.getElementById('settingsPanel');
  const overlay = document.getElementById('settingsOverlay');
  const close = document.getElementById('settingsClose');
  const open = () => { panel.classList.add('open'); overlay.classList.add('open'); };
  const shut = () => { panel.classList.remove('open'); overlay.classList.remove('open'); };
  btn.addEventListener('click', open);
  close.addEventListener('click', shut);
  overlay.addEventListener('click', shut);
}

// Initialization
async function init() {
  setupMenu();
  setupEventListeners();
  setupFABs();
  await fetchData();

  // Start polling every 30 seconds
  pollTimer = setInterval(fetchData, 30000);
}

function setupEventListeners() {
  DOMElements.intervalSelect.addEventListener('change', async (e) => {
    state.interval = e.target.value;
    DOMElements.tableHead.innerHTML = ''; // Force re-render headers
    await fetchData();
  });

  // Debounced % Filter — waits 2s after last keystroke before processing
  let filterDebounceTimer = null;
  DOMElements.filterInput.addEventListener('input', (e) => {
    clearTimeout(filterDebounceTimer);
    filterDebounceTimer = setTimeout(() => {
      state.filterPct = parseFloat(e.target.value) || 0;
      processDataAndRender();
    }, 2000);
  });

  DOMElements.hideToggle.addEventListener('change', (e) => {
    state.hideUnfiltered = e.target.checked;
    renderTable(true);
  });

  DOMElements.hideVolumeToggle.addEventListener('change', (e) => {
    state.hideVolume = e.target.checked;
    // Re-render headers so colspan adjusts, then full re-render rows
    if (state.data.length > 0) {
      renderHeaders(state.data[0].history);
      renderTable(true);
    }
  });

  DOMElements.searchInput.addEventListener('input', (e) => {
    state.search = e.target.value.toLowerCase().trim();
    renderTable(true);
  });

  DOMElements.sortStreakBtn.addEventListener('click', () => {
    state.sortCol = 'streak';
    state.sortAsc = false;
    DOMElements.sortStreakBtn.classList.add('active');
    renderTable(true);
  });

  // Scroll Listener for FABs
  DOMElements.tableContainer.addEventListener('scroll', updateFABVisibility);
}

// --- Floating Action Buttons (FABs) Logic ---
function setupFABs() {
  const container = DOMElements.tableContainer;
  let pressTimer;

  const handlePointerDown = (action) => {
    pressTimer = setTimeout(() => {
      // Long press detected
      if (action === 'up') container.scrollTo({ top: 0, behavior: 'smooth' });
      if (action === 'down') container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
      pressTimer = null;
    }, 500);
  };

  const handlePointerUp = (action) => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
      // Short click detected
      const pageHeight = container.clientHeight;
      if (action === 'up') container.scrollBy({ top: -pageHeight, behavior: 'smooth' });
      if (action === 'down') container.scrollBy({ top: pageHeight, behavior: 'smooth' });
    }
  };

  // Up Button
  DOMElements.fabUp.addEventListener('mousedown', () => handlePointerDown('up'));
  DOMElements.fabUp.addEventListener('mouseup', () => handlePointerUp('up'));
  DOMElements.fabUp.addEventListener('mouseleave', () => clearTimeout(pressTimer));
  DOMElements.fabUp.addEventListener('touchstart', (e) => { e.preventDefault(); handlePointerDown('up'); });
  DOMElements.fabUp.addEventListener('touchend', (e) => { e.preventDefault(); handlePointerUp('up'); });

  // Down Button
  DOMElements.fabDown.addEventListener('mousedown', () => handlePointerDown('down'));
  DOMElements.fabDown.addEventListener('mouseup', () => handlePointerUp('down'));
  DOMElements.fabDown.addEventListener('mouseleave', () => clearTimeout(pressTimer));
  DOMElements.fabDown.addEventListener('touchstart', (e) => { e.preventDefault(); handlePointerDown('down'); });
  DOMElements.fabDown.addEventListener('touchend', (e) => { e.preventDefault(); handlePointerUp('down'); });

  // Left Button (Current Time)
  DOMElements.fabLeft.addEventListener('click', () => {
    container.scrollTo({ left: 0, behavior: 'smooth' });
  });
}

function updateFABVisibility() {
  const { scrollTop, scrollHeight, clientHeight, scrollLeft } = DOMElements.tableContainer;
  
  // Vertical
  if (scrollTop === 0) {
    DOMElements.fabUp.classList.add('hidden');
  } else {
    DOMElements.fabUp.classList.remove('hidden');
  }

  if (scrollTop + clientHeight >= scrollHeight - 2) {
    DOMElements.fabDown.classList.add('hidden');
  } else {
    DOMElements.fabDown.classList.remove('hidden');
  }

  // Horizontal
  if (scrollLeft > 150) {
    DOMElements.fabLeft.classList.remove('hidden');
  } else {
    DOMElements.fabLeft.classList.add('hidden');
  }
}

// Function to handle header clicks dynamically
function handleHeaderClick(col) {
  // Prevent click when interacting with filter inputs
  if (event && event.target.tagName === 'INPUT') return;

  if (state.sortCol === col) {
    state.sortAsc = !state.sortAsc;
  } else {
    state.sortCol = col;
    state.sortAsc = false;
  }
  
  if (col !== 'streak') DOMElements.sortStreakBtn.classList.remove('active');
  else DOMElements.sortStreakBtn.classList.add('active');
  
  renderTable(true); // force full render on sort
}

async function fetchData() {
  try {
    if (state.data.length === 0) {
      DOMElements.loading.classList.remove('hidden');
    }

    const interval = state.interval;
    const now = Date.now();

    if (metricsCache[interval] && (now - metricsCache[interval].timestamp < FETCH_INTERVAL_MS)) {
      const cached = metricsCache[interval].data;
      if (cached.length > 0) {
        state.data = cached;
        renderHeaders(cached[0].history);
        processDataAndRender();
        return;
      }
    }

    const symbols = await getUsdtSymbols();
    const limit = createLimiter(15);
    const results = await Promise.all(symbols.map(sym => limit(() => fetchKlinesData(sym, interval))));
    const validResults = results.filter(r => r !== null);

    if (validResults.length > 0) {
      metricsCache[interval] = { timestamp: Date.now(), data: validResults };
      state.data = validResults;
      renderHeaders(validResults[0].history);
      processDataAndRender();
    } else {
      DOMElements.tableHead.innerHTML = `<tr><th>Error</th></tr>`;
      DOMElements.tableBody.innerHTML = `<tr><td>No data returned from Binance API.</td></tr>`;
    }
  } catch (error) {
    console.error("Failed to fetch data:", error);
    if (state.data.length === 0) {
      DOMElements.tableBody.innerHTML = `<tr><td colspan="5">Failed to fetch data. Check your internet connection.</td></tr>`;
    }
  } finally {
    DOMElements.loading.classList.add('hidden');
  }
}

// Formatters
const formatPrice = (price) => {
  if (price === 0) return '0.00';
  if (price < 0.001) return price.toPrecision(4);
  if (price < 1) return price.toFixed(4);
  return price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

const formatVolume = (vol) => {
  if (vol > 1e9) return (vol / 1e9).toFixed(2) + 'B';
  if (vol > 1e6) return (vol / 1e6).toFixed(2) + 'M';
  if (vol > 1e3) return (vol / 1e3).toFixed(2) + 'K';
  return vol.toFixed(2);
};

const formatPct = (pct) => {
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(2)}%`;
};

const formatTime = (ts) => {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return state.interval === '30s' || state.interval === '1m' ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
};

// Listeners for inline header inputs
window.updateMinPrice = function(val) {
  state.minPrice = parseFloat(val) || 0;
  renderTable(true);
};

window.updateMinVolume = function(val) {
  state.minVolume = parseFloat(val) || 0;
  renderTable(true);
};

function renderHeaders(historyArray) {
  // colspan is 4 when volume is shown, 2 when hidden
  const colsPerInterval = state.hideVolume ? 2 : 4;

  let groupRow = `<tr>
    <th class="sticky-col sl-cell" rowspan="2" onclick="handleHeaderClick('sl')">#</th>
    <th class="sticky-col-2" rowspan="2" onclick="handleHeaderClick('symbol')">Symbol</th>`;
  
  let subRow = `<tr>`;

  historyArray.forEach((hist, index) => {
    let title = index === 0 ? "Current" : `T-${index}`;
    groupRow += `<th colspan="${colsPerInterval}">${title} (${formatTime(hist.timestamp)})</th>`;
    
    // Price & % Price columns (always shown)
    subRow += `<th onclick="handleHeaderClick('price_${index}')">Price</th>`;
    subRow += `<th onclick="handleHeaderClick('priceChangePct_${index}')">% Prc</th>`;

    // Volume columns — only when not hidden
    if (!state.hideVolume) {
      subRow += `<th onclick="handleHeaderClick('volume_${index}')">Vol</th>`;
      subRow += `<th onclick="handleHeaderClick('volumeChangePct_${index}')">% Vol</th>`;
    }
  });

  groupRow += `</tr>`;
  subRow += `</tr>`;

  DOMElements.tableHead.innerHTML = groupRow + subRow;
}

// Pre-process streaks
function processDataAndRender() {
  state.data.forEach(row => {
    let streakCount = 0;
    let streakType = 'none';
    
    if (row.history && row.history.length > 0) {
      const currentPct = row.history[0].priceChangePct;
      if (currentPct >= state.filterPct && state.filterPct > 0) {
        streakType = 'bull';
      } else if (currentPct <= -state.filterPct && state.filterPct > 0) {
        streakType = 'bear';
      }
      
      if (streakType !== 'none') {
        for (let i = 0; i < row.history.length; i++) {
          const pct = row.history[i].priceChangePct;
          if (streakType === 'bull' && pct >= state.filterPct) streakCount++;
          else if (streakType === 'bear' && pct <= -state.filterPct) streakCount++;
          else break;
        }
      }
    }
    row.streakCount = streakCount;
    row.streakType = streakType;
  });
  
  renderTable();
}

function renderTable(forceFullRender = false) {
  let displayData = [...state.data];
  
  displayData = displayData.filter(row => {
    if (state.search && !row.symbol.toLowerCase().includes(state.search)) return false;
    
    const currentHist = row.history[0];
    if (!currentHist) return false;

    if (state.minPrice > 0 && currentHist.price < state.minPrice) return false;
    if (state.minVolume > 0 && currentHist.volume < state.minVolume) return false;

    if (state.hideUnfiltered) {
      const currentPctAbs = Math.abs(currentHist.priceChangePct);
      if (currentPctAbs < state.filterPct) return false;
    }
    return true;
  });

  displayData.sort((a, b) => {
    if (state.sortCol === 'symbol') return state.sortAsc ? a.symbol.localeCompare(b.symbol) : b.symbol.localeCompare(a.symbol);
    if (state.sortCol === 'sl') return 0;
    if (state.sortCol === 'streak') return state.sortAsc ? (a.streakCount - b.streakCount) : (b.streakCount - a.streakCount);
    
    const parts = state.sortCol.split('_');
    if (parts.length === 2) {
      const key = parts[0];
      const idx = parseInt(parts[1]);
      const valA = a.history[idx] ? a.history[idx][key] : 0;
      const valB = b.history[idx] ? b.history[idx][key] : 0;
      return state.sortAsc ? valA - valB : valB - valA;
    }
    return 0;
  });

  processedData = displayData;

  // DOM Diffing Optimization
  // If the number of rows matches and we are not forcing a full re-render (like on sort/filter),
  // we do a targeted DOM update of just the text nodes for maximum performance!
  if (!forceFullRender && DOMElements.tableBody.rows.length === processedData.length && processedData.length > 0) {
    for (let r = 0; r < processedData.length; r++) {
      const rowData = processedData[r];
      const tr = DOMElements.tableBody.rows[r];
      
      let cellIdx = 2; // skip # and Symbol
      
      rowData.history.forEach((hist, index) => {
        const pricePctClass = hist.priceChangePct > 0 ? 'trend-up' : (hist.priceChangePct < 0 ? 'trend-down' : 'trend-neutral');
        const volPctClass = hist.volumeChangePct > 0 ? 'trend-up' : (hist.volumeChangePct < 0 ? 'trend-down' : 'trend-neutral');

        let highlightClass = '';
        if (Math.abs(hist.priceChangePct) >= state.filterPct && state.filterPct > 0) {
          highlightClass = hist.priceChangePct > 0 ? 'highlight-up' : 'highlight-down';
        }

        let streakHtml = '';
        if (index === 0 && rowData.streakCount > 1) {
          streakHtml = `<span class="streak-badge ${rowData.streakType}">🔥${rowData.streakCount}</span>`;
        }
        
        tr.cells[cellIdx].textContent = '$' + formatPrice(hist.price);
        tr.cells[cellIdx+1].className = `${pricePctClass} ${highlightClass}`;
        tr.cells[cellIdx+1].innerHTML = formatPct(hist.priceChangePct) + streakHtml;
        if (!state.hideVolume) {
          tr.cells[cellIdx+2].textContent = '$' + formatVolume(hist.volume);
          tr.cells[cellIdx+3].className = volPctClass;
          tr.cells[cellIdx+3].textContent = formatPct(hist.volumeChangePct);
        }
        
        cellIdx += state.hideVolume ? 2 : 4;
      });
    }
    return;
  }

  // Full HTML Render
  let html = '';
  let slNumber = 1;
  
  for (const row of processedData) {
    const newCoinClass = row.isNew ? 'new-coin-highlight' : '';
    const baseAsset = row.symbol.replace('USDT', '');

    html += `<tr class="${newCoinClass}">`;
    html += `<td class="sticky-col sl-cell">${slNumber++}</td>`;
    html += `<td class="sticky-col-2 symbol-cell ${newCoinClass}">${baseAsset}</td>`;
    
    row.history.forEach((hist, index) => {
      const pricePctClass = hist.priceChangePct > 0 ? 'trend-up' : (hist.priceChangePct < 0 ? 'trend-down' : 'trend-neutral');
      const volPctClass = hist.volumeChangePct > 0 ? 'trend-up' : (hist.volumeChangePct < 0 ? 'trend-down' : 'trend-neutral');

      let highlightClass = '';
      if (Math.abs(hist.priceChangePct) >= state.filterPct && state.filterPct > 0) {
        highlightClass = hist.priceChangePct > 0 ? 'highlight-up' : 'highlight-down';
      }

      let streakHtml = '';
      if (index === 0 && row.streakCount > 1) {
        streakHtml = `<span class="streak-badge ${row.streakType}">🔥${row.streakCount}</span>`;
      }

      html += `<td class="price-cell">$${formatPrice(hist.price)}</td>`;
      html += `<td class="${pricePctClass} ${highlightClass}">${formatPct(hist.priceChangePct)}${streakHtml}</td>`;
      if (!state.hideVolume) {
        html += `<td class="volume-cell">$${formatVolume(hist.volume)}</td>`;
        html += `<td class="${volPctClass}">${formatPct(hist.volumeChangePct)}</td>`;
      }
    });
    
    html += `</tr>`;
  }
  
  if (processedData.length === 0) {
    html = `<tr><td colspan="5" style="text-align: center; color: var(--text-secondary);">No matching data</td></tr>`;
  }

  DOMElements.tableBody.innerHTML = html;
  
  // Update header sort indicators
  const headers = document.querySelectorAll('#tableHead th');
  headers.forEach(th => {
    let text = th.childNodes[0].textContent.replace(' ↑', '').replace(' ↓', '').trim();
    if (th.getAttribute('onclick') && th.getAttribute('onclick').includes(`'${state.sortCol}'`)) {
      text += state.sortAsc ? ' ↑' : ' ↓';
    }
    th.childNodes[0].textContent = text;
  });

  updateFABVisibility();
}

init();
