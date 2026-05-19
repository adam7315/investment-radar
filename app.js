/* ── 投資情報雷達 — app.js ───────────────── */

const STATE = {
  currentDate:    '',
  availableDates: [],
  report:         null,
  supplyChain:    null,
  watchlist:      null,
  activeFilter:   'all',
  activeStock:    null,
  activeSubTab:   'analysis',
  _allNews:       []
};

const STOCK_ORDER = ['5274', '2303', '3008', '00403A', '0050'];

// ── 初始化 ────────────────────────────────
async function init() {
  try {
    const [indexData, scData, wlData] = await Promise.all([
      fetchJSON('./data/reports/index.json'),
      fetchJSON('./data/supply_chain.json'),
      fetchJSON('./data/watchlist.json')
    ]);
    STATE.availableDates = indexData.dates || [];
    STATE.supplyChain    = scData.chains || {};
    STATE.watchlist      = wlData.stocks || [];

    // 載入使用者自行加入的追蹤股票（localStorage）
    try {
      const extra = JSON.parse(localStorage.getItem('watchlist_extra') || '[]');
      extra.forEach(code => {
        if(!STATE.watchlist.some(s => s.code === code))
          STATE.watchlist.push({ code, name: code, type: 'stock', market: 'TW', tags: [] });
      });
    } catch(e) {}

    const today  = formatDate(new Date());
    const target = STATE.availableDates.includes(today)
      ? today
      : (indexData.latest || STATE.availableDates.slice(-1)[0] || today);

    setupDatePicker();
    setupNewsFilters();
    setupSubTabs();
    setupWatchlistAdd();
    await loadDate(target);
  } catch(e) {
    console.error(e);
    showError('載入失敗，請確認資料檔案是否存在');
  }
}

// ── 載入指定日期 ──────────────────────────
async function loadDate(date) {
  STATE.currentDate = date;
  document.getElementById('date-picker').value = date;
  document.getElementById('no-data').classList.add('hidden');

  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  if(dot)  dot.className = 'status-dot loading';
  if(text) { text.textContent = '載入中...'; text.style.color = ''; }

  showLoading();
  try {
    STATE.report = await fetchJSON(`./data/reports/${date}.json`);
    renderAll();
  } catch(e) {
    hideLoading();
    if(STATE.availableDates.includes(date)) {
      showError('報告載入失敗');
    } else {
      document.getElementById('no-data').classList.remove('hidden');
      document.getElementById('insights-container').innerHTML = '';
      document.getElementById('stock-tab-bar').innerHTML = '';
      document.getElementById('news-container').innerHTML = '';
    }
  }
}

// ── 渲染全部 ──────────────────────────────
function renderAll() {
  const r = STATE.report;
  if(!r) return;
  renderInsights(r.key_insights || []);
  renderStockTabs(r.stocks || {});
  renderNewsList(r.stocks || {});
  updateStatusBar(r);
}

function updateStatusBar(r) {
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const isToday = r.date === formatDate(new Date());
  dot.className    = 'status-dot ok';
  text.textContent = isToday ? '✓ 今日報告已就緒' : `查看 ${r.date} 歷史記錄`;
  text.style.color = 'var(--sell)';

  document.getElementById('status-date').textContent      = r.date || '—';
  document.getElementById('status-analyzed').textContent  = r.generated_at || '—';
  document.getElementById('status-collected').textContent = r.collected_at || r.generated_at || '—';
}

// ── AI 洞察 ───────────────────────────────
function renderInsights(insights) {
  const el = document.getElementById('insights-container');
  if(!insights.length) {
    el.innerHTML = '<p style="color:var(--text3);font-size:14px">今日尚無洞察記錄</p>';
    return;
  }
  el.innerHTML = insights.map(i => `
    <div class="insight-card ${i.type || 'info'}">
      <div class="insight-icon">${i.icon || '💡'}</div>
      <div class="insight-content">
        <div class="insight-stock">${i.stock ? getStockName(i.stock) : ''}</div>
        <div class="insight-title">${i.title}</div>
        <div class="insight-body">${i.body}</div>
      </div>
    </div>
  `).join('');
}

// ── 個股分頁 Tabs ─────────────────────────
function renderStockTabs(stocks) {
  const bar = document.getElementById('stock-tab-bar');
  const codes = [
    ...STOCK_ORDER.filter(c => stocks[c]),
    ...Object.keys(stocks).filter(c => !STOCK_ORDER.includes(c))
  ];

  if(!codes.length) {
    bar.innerHTML = '<p style="color:var(--text3);font-size:14px">今日尚無個股資料</p>';
    return;
  }

  bar.innerHTML = codes.map(code => {
    const data = stocks[code];
    const sc   = STATE.supplyChain[code] || {};
    const signalClass = getSignalClass(data.signal);
    return `
      <button class="stock-tab" data-code="${code}">
        <div class="stab-top">
          <span class="stab-code">${code}</span>
          <span class="stab-name">${data.name || sc.name || code}</span>
        </div>
        <span class="signal-badge ${signalClass}">${data.signal_text || data.signal || '—'}</span>
      </button>
    `;
  }).join('');

  bar.querySelectorAll('.stock-tab').forEach(btn => {
    btn.addEventListener('click', () => selectStock(btn.dataset.code));
  });

  // 預設選第一個
  const firstActive = STATE.activeStock && stocks[STATE.activeStock]
    ? STATE.activeStock : codes[0];
  selectStock(firstActive);
}

function selectStock(code) {
  STATE.activeStock = code;
  const stocks = STATE.report?.stocks || {};
  const data   = stocks[code];
  if(!data) return;

  // 更新 tab active 狀態
  document.querySelectorAll('.stock-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.code === code);
  });

  // 渲染所有子面板
  renderPanelAnalysis(code, data);
  renderPanelSupply(code, data);
  renderPanelChips(data);
  renderPanelNews(data);

  // 回到上次選的子分頁
  switchSubTab(STATE.activeSubTab);
}

// ── 子分頁切換 ────────────────────────────
function setupSubTabs() {
  document.getElementById('sub-tab-bar').addEventListener('click', e => {
    const btn = e.target.closest('.sub-tab');
    if(!btn) return;
    switchSubTab(btn.dataset.panel);
  });
}

function switchSubTab(panelName) {
  STATE.activeSubTab = panelName;
  document.querySelectorAll('.sub-tab').forEach(b => {
    b.classList.toggle('active', b.dataset.panel === panelName);
  });
  document.querySelectorAll('.panel-body').forEach(p => {
    p.classList.toggle('active', p.id === `panel-${panelName}`);
  });
}

// ── 面板：AI 分析 ─────────────────────────
function renderPanelAnalysis(code, data) {
  const el  = document.getElementById('panel-analysis');
  const sc  = STATE.supplyChain[code] || {};
  const wl  = (STATE.watchlist || []).find(s => s.code === code) || {};
  const tags = (wl.tags || []).map(t => `<span class="tag">${t}</span>`).join('');
  const signalClass = getSignalClass(data.signal);

  // SMCI 追蹤卡（僅 5274）
  let smciTrackerHTML = '';
  if(data.smci_tracker) {
    const t = data.smci_tracker;
    const proxiesHTML = (t.proxy_indicators || [])
      .map(p => `<li>${p}</li>`).join('');
    smciTrackerHTML = `
      <div class="smci-tracker">
        <div class="smci-tracker-header">
          <span class="smci-tracker-label">📡 SMCI 庫存追蹤</span>
          <span class="smci-status-badge">${t.status}</span>
        </div>
        <div class="smci-tracker-note">${t.note}</div>
        <div class="smci-tracker-meta">
          <strong>資料來源：</strong>${t.data_source}<br>
          <strong>查詢方式：</strong>${t.how_to_find}<br>
          <strong>代理指標：</strong>
          <ul class="smci-proxies">${proxiesHTML}</ul>
        </div>
      </div>
    `;
  }

  el.innerHTML = `
    <div class="signal-row">
      <span style="font-size:16px;font-weight:700">${data.name}</span>
      <span class="signal-badge ${signalClass}">${data.signal_text || data.signal}</span>
      <span class="signal-reason">${data.signal_reason || ''}</span>
      ${tags ? `<div class="tags" style="margin-left:auto">${tags}</div>` : ''}
    </div>
    <div class="analysis-full">${data.analysis || '尚無分析資料'}</div>
    ${smciTrackerHTML}
  `;
}

// ── 面板：供應鏈 ──────────────────────────
function renderPanelSupply(code, data) {
  const el = document.getElementById('panel-supply');
  const sc = STATE.supplyChain[code] || {};

  if(!sc.name) {
    el.innerHTML = '<p style="color:var(--text3);font-size:14px">此股票無供應鏈資料</p>';
    return;
  }

  // 上游
  let upstreamHTML = '';
  if(sc.upstream && sc.upstream.length) {
    const tags = sc.upstream.map(u => {
      const url = getStockUrl(u);
      const depClass = u.dependency === '高' || u.dependency === '極高' ? 'chain-dep-high' : 'chain-dep-med';
      return `<a class="chain-tag ${depClass}" href="${url}" target="_blank" rel="noopener">
        <span class="chain-tag-code">${u.code}</span>
        <span>${u.name}</span>
        <span style="font-size:11px;color:var(--text3)">依賴：${u.dependency}</span>
      </a>`;
    }).join('');
    upstreamHTML = `
      <div class="supply-group">
        <div class="supply-group-label">↑ 上游供應商</div>
        <div class="chain-tags">${tags}</div>
      </div>
    `;
  }

  // 下游
  let downstreamHTML = '';
  if(sc.downstream && sc.downstream.length) {
    const tags = sc.downstream.map(d => {
      const url = getStockUrl(d);
      const depClass = d.dependency === '高' || d.dependency === '極高' ? 'chain-dep-high' : 'chain-dep-med';
      return `<a class="chain-tag ${depClass}" href="${url}" target="_blank" rel="noopener">
        <span class="chain-tag-code">${d.code}</span>
        <span>${d.name}</span>
        <span style="font-size:11px;color:var(--text3)">依賴：${d.dependency}</span>
      </a>`;
    }).join('');
    downstreamHTML = `
      <div class="supply-group">
        <div class="supply-group-label">↓ 下游客戶</div>
        <div class="chain-tags">${tags}</div>
      </div>
    `;
  }

  // ETF持股
  let holdingsHTML = '';
  if(sc.top_holdings && sc.top_holdings.length) {
    const tags = sc.top_holdings.map(h => {
      const url = `https://tw.stock.yahoo.com/quote/${h.code}.TW`;
      return `<a class="chain-tag" href="${url}" target="_blank" rel="noopener">
        <span class="chain-tag-code">${h.code}</span>
        <span>${h.name}</span>
        <span style="font-size:11px;color:var(--text3)">${h.weight}</span>
      </a>`;
    }).join('');
    holdingsHTML = `
      <div class="supply-group">
        <div class="supply-group-label">主要持股</div>
        <div class="chain-tags">${tags}</div>
      </div>
    `;
  }

  // 今日供應鏈信號
  let signalsHTML = '';
  if(data.supply_chain_signals && data.supply_chain_signals.length) {
    const items = data.supply_chain_signals.map(s => {
      const cls = s.includes('正面') ? 'positive' : (s.includes('需') || s.includes('注意') || s.includes('偏高')) ? 'negative' : '';
      return `<div class="supply-signal ${cls}">• ${s}</div>`;
    }).join('');
    signalsHTML = `
      <div class="supply-group">
        <div class="supply-group-label">今日供應鏈信號</div>
        <div class="supply-signals">${items}</div>
      </div>
    `;
  }

  // 關鍵風險 & 未來觸媒
  const risks = (sc.key_risks || []).map(r => `<li>${r}</li>`).join('');
  const catalysts = (sc.next_catalysts || []).map(c => `<li>${c}</li>`).join('');
  const rcHTML = (risks || catalysts) ? `
    <div class="risk-catalyst-row">
      ${risks ? `<div class="risk-list">
        <div class="risk-list-title">⚠️ 關鍵風險</div>
        <ul>${risks}</ul>
      </div>` : ''}
      ${catalysts ? `<div class="catalyst-list">
        <div class="catalyst-list-title">🚀 未來觸媒</div>
        <ul>${catalysts}</ul>
      </div>` : ''}
    </div>
  ` : '';

  // 產業地位
  const posHTML = sc.position ? `
    <div class="supply-group">
      <div class="supply-group-label">產業定位</div>
      <div style="font-size:14px;color:var(--text2);line-height:1.6">
        <strong>${sc.position}</strong><br>
        <span style="color:var(--text3)">${sc.moat || ''}</span>
      </div>
    </div>
  ` : '';

  el.innerHTML = `
    <div class="supply-section">
      ${posHTML}
      ${upstreamHTML}
      ${downstreamHTML}
      ${holdingsHTML}
      ${signalsHTML}
      ${rcHTML}
    </div>
  `;
}

// ── 面板：籌碼 ────────────────────────────
function renderPanelChips(data) {
  const el   = document.getElementById('panel-chips');
  const inst = data.institutional || {};
  const isETF = Object.values(inst).every(v => v && v.includes('不適用'));

  let instHTML = '';
  if(isETF) {
    instHTML = '<p style="color:var(--text3);font-size:14px">ETF，不適用法人買賣超</p>';
  } else {
    const items = [
      { label:'外資',  value: inst.foreign },
      { label:'投信',  value: inst.trust },
      { label:'自營商', value: inst.dealer },
      { label:'融資',  value: inst.margin }
    ].filter(i => i.value && !i.value.includes('不適用'));

    instHTML = `<div class="chips-grid">
      ${items.map(i => {
        const cls = i.value.includes('+') ? 'positive' : i.value.includes('-') ? 'negative' : '';
        return `<div class="chip-card">
          <div class="chip-label">${i.label}</div>
          <div class="chip-value ${cls}">${i.value}</div>
        </div>`;
      }).join('')}
    </div>`;
  }

  const insiderHL = data.insider && data.insider.includes('⭐') ? 'highlight' : '';

  el.innerHTML = `
    <div class="chips-section">
      <div>
        <div class="panel-sub-label">🏦 三大法人 / 融資</div>
        ${instHTML}
      </div>
      <div>
        <div class="panel-sub-label">👤 董監 / 內部人申報</div>
        <div class="insider-box ${insiderHL}">${data.insider || '無最新申報異動'}</div>
      </div>
    </div>
  `;
}

// ── 面板：新聞 ────────────────────────────
function renderPanelNews(data) {
  const el    = document.getElementById('panel-news');
  const news  = data.news || [];
  if(!news.length) {
    el.innerHTML = '<p style="color:var(--text3);font-size:14px">此股票暫無新聞記錄</p>';
    return;
  }
  el.innerHTML = `
    <div class="panel-news-list">
      ${news.map(n => `
        <div class="panel-news-item">
          <span class="panel-news-tag">${n.tag}</span>
          <span class="panel-news-title">${n.url
            ? `<a href="${n.url}" target="_blank" rel="noopener">${n.title}</a>`
            : n.title}</span>
          <span class="panel-news-date">${n.date}</span>
        </div>
      `).join('')}
    </div>
  `;
}

// ── 跨股新聞聚合（底部） ──────────────────
function renderNewsList(stocks) {
  STATE._allNews = [];
  Object.entries(stocks).forEach(([code, data]) => {
    (data.news || []).forEach(n => {
      STATE._allNews.push({ ...n, code, stockName: data.name });
    });
  });
  STATE._allNews.sort((a,b) => b.date.localeCompare(a.date));
  filterNews(STATE.activeFilter);
}

function filterNews(filter) {
  STATE.activeFilter = filter;
  const el = document.getElementById('news-container');
  const items = filter === 'all'
    ? STATE._allNews
    : STATE._allNews.filter(n => n.tag === filter);

  if(!items.length) {
    el.innerHTML = '<div style="padding:20px;color:var(--text3);font-size:14px;text-align:center">此分類暫無新聞</div>';
    return;
  }
  el.innerHTML = items.map(n => `
    <div class="news-list-item">
      <span class="news-list-stock">${n.code} ${n.stockName}</span>
      <span class="news-list-tag">${n.tag}</span>
      <span class="news-list-title">${n.url
        ? `<a href="${n.url}" target="_blank" rel="noopener">${n.title}</a>`
        : n.title}</span>
      <span class="news-list-date">${n.date}</span>
    </div>
  `).join('');
}

// ── 日期導航 ──────────────────────────────
function setupDatePicker() {
  const picker = document.getElementById('date-picker');
  picker.addEventListener('change', () => loadDate(picker.value));

  document.getElementById('prev-date').addEventListener('click', () => {
    const idx = STATE.availableDates.indexOf(STATE.currentDate);
    if(idx > 0) loadDate(STATE.availableDates[idx - 1]);
  });
  document.getElementById('next-date').addEventListener('click', () => {
    const idx = STATE.availableDates.indexOf(STATE.currentDate);
    if(idx < STATE.availableDates.length - 1) loadDate(STATE.availableDates[idx + 1]);
  });
  document.getElementById('goto-today').addEventListener('click', () => {
    const today  = formatDate(new Date());
    const target = STATE.availableDates.includes(today)
      ? today : STATE.availableDates.slice(-1)[0];
    if(target) loadDate(target);
  });
}

function setupNewsFilters() {
  document.getElementById('news-filters').addEventListener('click', e => {
    if(!e.target.matches('.filter-btn')) return;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    filterNews(e.target.dataset.filter);
  });
}

// ── 加入追蹤 ──────────────────────────────
function setupWatchlistAdd() {
  const btn   = document.getElementById('add-stock-btn');
  const input = document.getElementById('add-stock-input');

  const doAdd = () => {
    const code = input.value.trim().toUpperCase();
    if(!code) return;

    // 已在 watchlist
    if(STATE.watchlist.some(s => s.code === code)) {
      showToast(`${code} 已在追蹤清單中`, 'warn');
      input.value = '';
      return;
    }

    // 加入 watchlist state
    STATE.watchlist.push({ code, name: code, type: 'stock', market: 'TW', tags: [] });

    // 存到 localStorage 保留下次開啟
    try {
      const saved = JSON.parse(localStorage.getItem('watchlist_extra') || '[]');
      if(!saved.includes(code)) { saved.push(code); localStorage.setItem('watchlist_extra', JSON.stringify(saved)); }
    } catch(e) {}

    // 若當日報告有此股，立即加入 tab
    const stocks = STATE.report?.stocks || {};
    if(stocks[code]) {
      renderStockTabs(stocks);
      selectStock(code);
      showToast(`✓ ${code} 已加入追蹤`, 'ok');
    } else {
      showToast(`${code} 已記錄，下次報告更新時會顯示`, 'info');
    }
    input.value = '';
  };

  btn.addEventListener('click', doAdd);
  input.addEventListener('keydown', e => { if(e.key === 'Enter') doAdd(); });
}

function showToast(msg, type = 'info') {
  let toast = document.getElementById('toast');
  if(!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.style.cssText = `
      position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
      background:var(--bg3); border:1px solid var(--border);
      color:var(--text); padding:10px 20px; border-radius:8px;
      font-size:14px; z-index:300; transition:opacity 0.3s;
      box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    `;
    document.body.appendChild(toast);
  }
  const color = type === 'ok' ? 'var(--sell)' : type === 'warn' ? 'var(--buy)' : 'var(--accent)';
  toast.style.borderColor = color;
  toast.style.color = color;
  toast.textContent = msg;
  toast.style.opacity = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 2500);
}

// ── Helpers ───────────────────────────────
async function fetchJSON(url) {
  const r = await fetch(url + '?t=' + Date.now());
  if(!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}
function formatDate(d) {
  return d.toISOString().slice(0,10);
}
function getStockName(code) {
  if(!STATE.report) return code;
  const s = STATE.report.stocks[code];
  return s ? `${code} ${s.name}` : code;
}
function getSignalClass(signal) {
  return { buy:'signal-buy', sell:'signal-sell', hold:'signal-hold', watch:'signal-watch' }[signal] || 'signal-watch';
}
function getStockUrl(item) {
  if(item.market === 'NASDAQ' || item.market === 'NYSE')
    return `https://finance.yahoo.com/quote/${item.code}`;
  if(item.market === 'TWO')
    return `https://tw.stock.yahoo.com/quote/${item.code}.TWO`;
  return `https://tw.stock.yahoo.com/quote/${item.code}.TW`;
}
function showLoading() {
  document.getElementById('insights-container').innerHTML =
    '<div class="loading"><div class="spinner"></div>載入中...</div>';
  document.getElementById('stock-tab-bar').innerHTML =
    '<div class="loading"><div class="spinner"></div>載入中...</div>';
  document.getElementById('news-container').innerHTML = '';
}
function hideLoading() {}
function showError(msg) {
  document.getElementById('insights-container').innerHTML =
    `<p style="color:var(--buy);font-size:14px">⚠️ ${msg}</p>`;
}

// ── 啟動 ──────────────────────────────────
init();
