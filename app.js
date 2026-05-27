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

// 顯示順序：高價股先，ETF 最後
const STOCK_ORDER = [
  '5274','6515','7769','6223','2383','3443','6669','2059','2454','3661',
  '2330','2327','3017','8299','2303','3481','3008','0050','00403A'
];

// ── 初始化 ────────────────────────────────
async function init() {
  try {
    const [indexData, scData, wlData] = await Promise.all([
      fetchJSON('./data/reports/index.json'),
      fetchJSON('./data/supply_chain.json'),
      fetchJSON('./data/watchlist.json')
    ]);
    STATE.availableDates = indexData.dates || [];
    STATE.supplyChain    = scData.chains  || {};
    STATE.watchlist      = wlData.stocks  || [];

    // 載入使用者自行加入的追蹤股票
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
      document.getElementById('attention-container').innerHTML = '';
      document.getElementById('stock-tab-bar').innerHTML = '';
      document.getElementById('news-container').innerHTML = '';
    }
  }
}

// ── 渲染全部 ──────────────────────────────
function renderAll() {
  const r = STATE.report;
  if(!r) return;
  updateStatusBar(r);
  renderAttentionCards(r);
  renderStockTabs(r.stocks || {});
  renderNewsList(r.stocks || {});
}

function updateStatusBar(r) {
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const isToday = r.date === formatDate(new Date());
  dot.className    = 'status-dot ok';
  text.textContent = isToday ? '✓ 今日資料就緒' : `查看 ${r.date} 歷史`;
  text.style.color = 'var(--sell)';

  document.getElementById('status-date').textContent      = r.date || '—';
  document.getElementById('status-analyzed').textContent  = r.analyzed_at  || r.generated_at || '—';
  document.getElementById('status-collected').textContent = r.collected_at  || '—';
  document.getElementById('status-news-count').textContent = r.total_news != null ? r.total_news : '—';
}

// ── 今日特別關注卡片 ──────────────────────
function renderAttentionCards(r) {
  const el      = document.getElementById('attention-container');
  const sub     = document.getElementById('attention-subtitle');
  const stocks  = r.stocks || {};
  const topList = r.top_attention || [];

  // 收集所有 attention_score >= 4 的股票（依評分排序）
  const attentionStocks = Object.entries(stocks)
    .filter(([, d]) => (d.attention_score || 0) >= 4)
    .sort((a, b) => (b[1].attention_score || 0) - (a[1].attention_score || 0));

  if(!attentionStocks.length) {
    el.innerHTML = '<p class="no-attention">今日無特別關注個股，市況平靜</p>';
    sub.textContent = 'AI 評分 4~5 時顯示';
    return;
  }

  sub.textContent = `共 ${attentionStocks.length} 支`;

  el.innerHTML = attentionStocks.map(([code, data]) => {
    const score  = data.attention_score || 1;
    const stars  = '★'.repeat(score) + '☆'.repeat(5 - score);
    const scoreClass = score >= 5 ? 'score-5' : score >= 4 ? 'score-4' : 'score-3';
    const pct    = data.price?.change_pct;
    const pctStr = pct != null ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : '';
    const pctCls = pct > 0 ? 'pos' : pct < 0 ? 'neg' : '';

    return `
      <div class="attention-card ${scoreClass}" onclick="selectStockAndScroll('${code}')">
        <div class="attention-card-top">
          <span class="att-code">${code}</span>
          <span class="att-name">${data.name}</span>
          ${pctStr ? `<span class="att-pct ${pctCls}">${pctStr}</span>` : ''}
        </div>
        <div class="att-stars">${stars}</div>
        <div class="att-signal">${data.signal_type || ''}</div>
        <div class="att-reason">${data.attention_reason || ''}</div>
      </div>
    `;
  }).join('');
}

// ── 個股分頁 Tabs ─────────────────────────
function renderStockTabs(stocks) {
  const bar   = document.getElementById('stock-tab-bar');
  const codes = [
    ...STOCK_ORDER.filter(c => stocks[c]),
    ...Object.keys(stocks).filter(c => !STOCK_ORDER.includes(c))
  ];

  if(!codes.length) {
    bar.innerHTML = '<p style="color:var(--text3);font-size:14px">今日尚無個股資料</p>';
    return;
  }

  bar.innerHTML = codes.map(code => {
    const data  = stocks[code];
    const score = data.attention_score || 0;
    const badge = score >= 5 ? '<span class="tab-fire">🔥</span>'
                : score >= 4 ? '<span class="tab-alert">⚡</span>' : '';
    const pct   = data.price?.change_pct;
    const pctStr = pct != null ? `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%` : '';
    const pctCls = pct > 0 ? 'pos' : pct < 0 ? 'neg' : '';
    return `
      <button class="stock-tab" data-code="${code}">
        <div class="stab-top">
          <span class="stab-code">${code}</span>
          ${badge}
          <span class="stab-name">${data.name}</span>
        </div>
        ${pctStr ? `<span class="stab-pct ${pctCls}">${pctStr}</span>` : ''}
      </button>
    `;
  }).join('');

  bar.querySelectorAll('.stock-tab').forEach(btn => {
    btn.addEventListener('click', () => selectStock(btn.dataset.code));
  });

  const firstActive = STATE.activeStock && stocks[STATE.activeStock]
    ? STATE.activeStock : codes[0];
  selectStock(firstActive);
}

function selectStock(code) {
  STATE.activeStock = code;
  const stocks = STATE.report?.stocks || {};
  const data   = stocks[code];
  if(!data) return;

  document.querySelectorAll('.stock-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.code === code);
  });

  renderPanelAnalysis(code, data);
  renderPanelSupply(code, data);
  renderPanelChips(code, data);
  renderPanelNews(data);
  switchSubTab(STATE.activeSubTab);
}

function selectStockAndScroll(code) {
  selectStock(code);
  document.getElementById('stock-tab-bar').scrollIntoView({ behavior: 'smooth', block: 'start' });
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
  const el   = document.getElementById('panel-analysis');
  const wl   = (STATE.watchlist || []).find(s => s.code === code) || {};
  const tags = (wl.tags || data.tags || []).map(t => `<span class="tag">${t}</span>`).join('');

  const score    = data.attention_score || 0;
  const scoreClass = score >= 5 ? 'score-5' : score >= 4 ? 'score-4' : '';
  const stars    = score ? '★'.repeat(score) + '☆'.repeat(5 - score) : '';
  const pct      = data.price?.change_pct;
  const priceEl  = data.price?.price
    ? `<span class="price-tag">NT$ ${data.price.price.toLocaleString()}</span>`
    + (pct != null ? `<span class="pct-tag ${pct > 0 ? 'pos' : pct < 0 ? 'neg' : ''}">${pct > 0 ? '+' : ''}${pct.toFixed(2)}%</span>` : '')
    : '';

  // AI 分析區塊
  const aiBlock = (data.attention_reason || data.news_summary) ? `
    <div class="ai-analysis-block ${scoreClass}">
      ${score ? `<div class="ai-score-row">
        <span class="ai-stars">${stars}</span>
        <span class="ai-signal-type">${data.signal_type || ''}</span>
      </div>` : ''}
      ${data.attention_reason ? `<div class="ai-reason">📌 ${data.attention_reason}</div>` : ''}
      ${data.news_summary     ? `<div class="ai-summary">📰 ${data.news_summary}</div>` : ''}
    </div>
  ` : '';

  // 舊版 analysis 欄位（向下相容）
  const legacyAnalysis = data.analysis ? `<div class="analysis-full">${data.analysis}</div>` : '';

  el.innerHTML = `
    <div class="analysis-header">
      <span class="analysis-name">${data.name}</span>
      ${priceEl}
      ${tags ? `<div class="tags">${tags}</div>` : ''}
    </div>
    ${aiBlock}
    ${legacyAnalysis}
    ${!aiBlock && !legacyAnalysis ? '<p style="color:var(--text3);font-size:14px">今日 AI 分析尚未產生</p>' : ''}
  `;
}

// ── 面板：供應鏈 ──────────────────────────
function renderPanelSupply(code, data) {
  const el = document.getElementById('panel-supply');
  const sc = STATE.supplyChain[code] || {};

  if(!sc.name && !sc.top_holdings) {
    el.innerHTML = '<p style="color:var(--text3);font-size:14px">此股票無供應鏈資料</p>';
    return;
  }

  const renderChainTags = (list) => list.map(u => {
    const url      = getStockUrl(u);
    const depClass = (u.dependency === '高' || u.dependency === '極高') ? 'chain-dep-high' : 'chain-dep-med';
    return `<a class="chain-tag ${depClass}" href="${url}" target="_blank" rel="noopener">
      <span class="chain-tag-code">${u.code}</span>
      <span>${u.name}</span>
      <span style="font-size:11px;color:var(--text3)">依賴：${u.dependency}</span>
    </a>`;
  }).join('');

  const upHTML   = sc.upstream?.length   ? `<div class="supply-group"><div class="supply-group-label">↑ 上游供應商</div><div class="chain-tags">${renderChainTags(sc.upstream)}</div></div>` : '';
  const downHTML = sc.downstream?.length ? `<div class="supply-group"><div class="supply-group-label">↓ 下游客戶</div><div class="chain-tags">${renderChainTags(sc.downstream)}</div></div>` : '';

  const holdHTML = sc.top_holdings?.length ? `<div class="supply-group">
    <div class="supply-group-label">主要持股</div>
    <div class="chain-tags">
      ${sc.top_holdings.map(h => `<a class="chain-tag" href="https://tw.stock.yahoo.com/quote/${h.code}.TW" target="_blank" rel="noopener">
        <span class="chain-tag-code">${h.code}</span><span>${h.name}</span>
        <span style="font-size:11px;color:var(--text3)">${h.weight}</span>
      </a>`).join('')}
    </div>
  </div>` : '';

  const risks     = (sc.key_risks      || []).map(r => `<li>${r}</li>`).join('');
  const catalysts = (sc.next_catalysts || []).map(c => `<li>${c}</li>`).join('');
  const rcHTML = (risks || catalysts) ? `
    <div class="risk-catalyst-row">
      ${risks     ? `<div class="risk-list"><div class="risk-list-title">⚠️ 關鍵風險</div><ul>${risks}</ul></div>` : ''}
      ${catalysts ? `<div class="catalyst-list"><div class="catalyst-list-title">🚀 未來觸媒</div><ul>${catalysts}</ul></div>` : ''}
    </div>` : '';

  const posHTML = sc.position ? `<div class="supply-group">
    <div class="supply-group-label">產業定位</div>
    <div style="font-size:14px;color:var(--text2);line-height:1.6">
      <strong>${sc.position}</strong><br>
      <span style="color:var(--text3)">${sc.moat || ''}</span>
    </div>
  </div>` : '';

  el.innerHTML = `<div class="supply-section">${posHTML}${upHTML}${downHTML}${holdHTML}${rcHTML}</div>`;
}

// ── 面板：籌碼 ────────────────────────────
function renderPanelChips(code, data) {
  const el   = document.getElementById('panel-chips');
  const inst = data.institutional || {};
  const fNet = inst.foreign_net;
  const tNet = inst.trust_net;
  const dNet = inst.dealer_net;

  const hasInst = fNet != null || tNet != null || dNet != null;

  let instHTML = '';
  if(!hasInst) {
    instHTML = '<p style="color:var(--text3);font-size:14px">三大法人資料今日未取得（ETF或非交易日）</p>';
  } else {
    const items = [
      { label: '外資買賣超', value: fNet, unit: '張' },
      { label: '投信買賣超', value: tNet, unit: '張' },
      { label: '自營商',     value: dNet, unit: '張' },
    ].filter(i => i.value != null);

    instHTML = `<div class="chips-grid">
      ${items.map(i => {
        const cls = i.value > 0 ? 'positive' : i.value < 0 ? 'negative' : '';
        return `<div class="chip-card">
          <div class="chip-label">${i.label}</div>
          <div class="chip-value ${cls}">${i.value > 0 ? '+' : ''}${i.value}${i.unit}</div>
        </div>`;
      }).join('')}
    </div>`;
  }

  el.innerHTML = `
    <div class="chips-section">
      <div>
        <div class="panel-sub-label">🏦 三大法人</div>
        ${instHTML}
      </div>
    </div>
  `;
}

// ── 面板：新聞 ────────────────────────────
function renderPanelNews(data) {
  const el   = document.getElementById('panel-news');
  const news = data.news || [];
  if(!news.length) {
    el.innerHTML = '<p style="color:var(--text3);font-size:14px">此股票今日無新聞</p>';
    return;
  }
  el.innerHTML = `
    <div class="panel-news-list">
      ${news.map(n => `
        <div class="panel-news-item">
          <span class="panel-news-source">${n.source || n.tag || ''}</span>
          <span class="panel-news-title">${n.url
            ? `<a href="${n.url}" target="_blank" rel="noopener">${n.title}</a>`
            : n.title}</span>
          <span class="panel-news-date">${n.date || ''}</span>
        </div>
      `).join('')}
    </div>
  `;
}

// ── 跨股新聞聚合（底部） ──────────────────
function renderNewsList(stocks) {
  STATE._allNews = [];
  const sources  = new Set();

  Object.entries(stocks).forEach(([code, data]) => {
    (data.news || []).forEach(n => {
      STATE._allNews.push({ ...n, code, stockName: data.name });
      if(n.source) sources.add(n.source);
    });
  });
  STATE._allNews.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  // 動態產生按個股篩選的 filter buttons
  const filtersEl = document.getElementById('news-filters');
  const stockCodes = Object.keys(stocks);
  filtersEl.innerHTML = `
    <button class="filter-btn active" data-filter="all">全部 (${STATE._allNews.length})</button>
    ${stockCodes.map(code => {
      const cnt = STATE._allNews.filter(n => n.code === code).length;
      return cnt ? `<button class="filter-btn" data-filter="${code}">${stocks[code].name} (${cnt})</button>` : '';
    }).join('')}
  `;
  filtersEl.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      filtersEl.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      filterNews(btn.dataset.filter);
    });
  });

  filterNews('all');
}

function filterNews(filter) {
  STATE.activeFilter = filter;
  const el    = document.getElementById('news-container');
  const items = filter === 'all'
    ? STATE._allNews
    : STATE._allNews.filter(n => n.code === filter);

  if(!items.length) {
    el.innerHTML = '<div style="padding:20px;color:var(--text3);font-size:14px;text-align:center">此分類暫無新聞</div>';
    return;
  }
  el.innerHTML = items.map(n => `
    <div class="news-list-item">
      <span class="news-list-stock">${n.code} ${n.stockName}</span>
      <span class="news-list-source">${n.source || ''}</span>
      <span class="news-list-title">${n.url
        ? `<a href="${n.url}" target="_blank" rel="noopener">${n.title}</a>`
        : n.title}</span>
      <span class="news-list-date">${n.date || ''}</span>
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

// ── 加入追蹤 ──────────────────────────────
function setupWatchlistAdd() {
  const btn   = document.getElementById('add-stock-btn');
  const input = document.getElementById('add-stock-input');

  const doAdd = () => {
    const code = input.value.trim().toUpperCase();
    if(!code) return;
    if(STATE.watchlist.some(s => s.code === code)) {
      showToast(`${code} 已在追蹤清單中`, 'warn');
      input.value = '';
      return;
    }
    STATE.watchlist.push({ code, name: code, type: 'stock', market: 'TW', tags: [] });
    try {
      const saved = JSON.parse(localStorage.getItem('watchlist_extra') || '[]');
      if(!saved.includes(code)) { saved.push(code); localStorage.setItem('watchlist_extra', JSON.stringify(saved)); }
    } catch(e) {}
    const stocks = STATE.report?.stocks || {};
    if(stocks[code]) {
      renderStockTabs(stocks);
      selectStock(code);
      showToast(`✓ ${code} 已加入追蹤`, 'ok');
    } else {
      showToast(`${code} 已記錄，下次更新時顯示`, 'info');
    }
    input.value = '';
  };

  btn.addEventListener('click', doAdd);
  input.addEventListener('keydown', e => { if(e.key === 'Enter') doAdd(); });
}

// ── Toast ──────────────────────────────────
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
  toast.style.color       = color;
  toast.textContent       = msg;
  toast.style.opacity     = '1';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, 2500);
}

// ── Helpers ───────────────────────────────
async function fetchJSON(url) {
  const r = await fetch(url + '?t=' + Date.now());
  if(!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}
function formatDate(d) { return d.toISOString().slice(0, 10); }
function getStockUrl(item) {
  if(item.market === 'NASDAQ' || item.market === 'NYSE')
    return `https://finance.yahoo.com/quote/${item.code}`;
  if(item.market === 'TWO')
    return `https://tw.stock.yahoo.com/quote/${item.code}.TWO`;
  return `https://tw.stock.yahoo.com/quote/${item.code}.TW`;
}
function showLoading() {
  document.getElementById('attention-container').innerHTML =
    '<div class="loading"><div class="spinner"></div>載入中...</div>';
  document.getElementById('stock-tab-bar').innerHTML =
    '<div class="loading"><div class="spinner"></div>載入中...</div>';
  document.getElementById('news-container').innerHTML = '';
}
function hideLoading() {}
function showError(msg) {
  document.getElementById('attention-container').innerHTML =
    `<p style="color:var(--buy);font-size:14px">⚠️ ${msg}</p>`;
}

// ── 啟動 ──────────────────────────────────
init();
