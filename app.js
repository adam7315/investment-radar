/* ── 投資情報雷達 — app.js ───────────────── */

const WEBHOOK_URL = 'https://script.google.com/macros/s/AKfycbyBxm2DGCnKScXLOentEVitcjoh-pdNRVVMU206SyQnTYjhC4QEffm2OBT2SJIBC8un/exec';

const STATE = {
  currentDate:    '',
  availableDates: [],
  report:         null,
  supplyChain:    {},
  activeStock:    null,
  activeCat:      'all',
  activePanel:    'analysis',
  _allNews:       [],
  _reportCache:   {},
  _newsPage:      1,
  _newsFilter:    { from: '', to: '', stock: 'all' },
  NEWS_PAGE_SIZE: 30,
  _watchedCat:    'all',
};

const US_CODES = new Set(['NVDA','AAPL','MSFT','TSM','AMZN','MU','TSLA','DELL']);
function isUSStock(code, d) {
  if(d?.market === 'NASDAQ' || d?.market === 'NYSE') return true;
  return US_CODES.has(code);
}

function getTop10Codes(stocks) {
  return Object.entries(stocks)
    .filter(([code, d]) => d.price?.price && !isUSStock(code, d))
    .sort((a, b) => (b[1].price.price || 0) - (a[1].price.price || 0))
    .slice(0, 10)
    .map(([code]) => code);
}

// 全部顯示順序：台股高價股 → 個人持倉 → ETF → 美股
const STOCK_ORDER = [
  '5274','6515','7769','6223','2383','3443','6669','2059','2454','3661',
  '2330','2327','3017','8299','2303','3481','3008','2313','2308','0050','00403A',
  'NVDA','AAPL','MSFT','TSM','AMZN','MU','TSLA','DELL',
];

// ── 使用者分類（localStorage）────────────────
function loadUserCats() {
  try { return JSON.parse(localStorage.getItem('user_cats') || '{}'); }
  catch(e) { return {}; }
}
function saveUserCats(cats) {
  localStorage.setItem('user_cats', JSON.stringify(cats));
}

// ── 日期格式 ──────────────────────────────
function toIso(d) { return d.toISOString().slice(0, 10); }

function isoToDisplay(iso) {
  if(!iso || iso.length < 10) return iso || '—';
  const [y, m, d] = iso.split('-');
  return `${y}年${parseInt(m)}月${parseInt(d)}日`;
}

function isRealNews(n) {
  const t = n.title || '';
  if(!t) return false;
  // 過濾掉股票查詢頁、網站導覽標題（含「個股概覽」、「| 個股 - 股市」等）
  if(/個股概覽|技術分析圖表|即時股價|行情報價/.test(t)) return false;
  if(/\|\s*(個股|股市|技術分析|行情)/.test(t)) return false;
  // 排除明顯的 CMoney / TradingView 頁面標題
  const url = n.url || '';
  if(/cmoney\.tw|tradingview\.com/.test(url) && /\|/.test(t)) return false;
  return true;
}

function formatNewsDate(d) {
  if(!d) return '';
  // ISO "2026-05-27" → "2026年5月27日"
  if(/^\d{4}-\d{2}-\d{2}/.test(d)) {
    const y   = d.slice(0, 4);
    const m   = parseInt(d.slice(5, 7));
    const day = parseInt(d.slice(8, 10));
    return `${y}年${m}月${day}日`;
  }
  // RFC 2822 "Mon, 25 May 2026 ..." → "2026年5月25日"
  const _months = {jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  const _m = d.match(/(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})/);
  if(_m) {
    const month = _months[_m[2].slice(0,3).toLowerCase()];
    if(month) return `${_m[3]}年${month}月${parseInt(_m[1])}日`;
  }
  return '';
}

function escAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function fmtDateTime(dt) {
  if(!dt) return '—';
  // "2026-05-27T11:04" → "5月27日 11:04"
  if(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(dt)) {
    const m   = parseInt(dt.slice(5, 7));
    const day = parseInt(dt.slice(8, 10));
    const hm  = dt.slice(11, 16);
    return `${m}月${day}日 ${hm}`;
  }
  return dt;
}

// ── 初始化 ────────────────────────────────
async function init() {
  try {
    const [indexData, scData] = await Promise.all([
      fetchJSON('./data/reports/index.json'),
      fetchJSON('./data/supply_chain.json').catch(() => ({ chains: {} }))
    ]);
    loadVipMoves();
    switchHVTab(localStorage.getItem('hvtab') || 'attention');
    STATE.availableDates = indexData.dates || [];
    STATE.supplyChain    = scData.chains   || {};

    const today  = toIso(new Date());
    const target = STATE.availableDates.includes(today)
      ? today
      : (indexData.latest || STATE.availableDates.slice(-1)[0] || today);

    // 把 localStorage 中使用者額外加入的股票合入報告
    STATE._extraCodes = JSON.parse(localStorage.getItem('watchlist_extra') || '[]');

    setupDatePicker();
    setupCategoryTabs();
    setupDetailTabs();
    setupWatchlistAdd();
    setupNewsSection();
    renderWatchedSection();
      await loadDate(target);
  } catch(e) {
    console.error(e);
    showError('載入失敗：' + e.message);
  }
}

// ── 載入指定日期 ──────────────────────────
async function loadDate(date) {
  STATE.currentDate = date;
  document.getElementById('date-picker').value = date;
  document.getElementById('date-display').textContent = isoToDisplay(date);
  document.getElementById('last-update').textContent = isoToDisplay(date);
  document.getElementById('no-data').classList.add('hidden');

  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  if(dot)  dot.className = 'status-dot loading';
  if(text) { text.textContent = '載入中...'; text.style.color = ''; }

  showLoading();
  try {
    STATE.report = await fetchJSON(`./data/reports/${date}.json`);
    STATE._reportCache[date] = STATE.report;
    renderAll();
    restoreLiveStocks();
  } catch(e) {
    hideLoading();
    if(STATE.availableDates.includes(date)) {
      showError('報告載入失敗，請稍後再試');
    } else {
      document.getElementById('no-data').classList.remove('hidden');
      document.getElementById('attention-container').innerHTML = '';
      document.getElementById('stock-grid').innerHTML = '';
      document.getElementById('news-container').innerHTML = '';
      if(dot) dot.className = 'status-dot';
    }
  }
}

// ── 渲染全部 ──────────────────────────────
function renderAll() {
  const r = STATE.report;
  if(!r) return;
  updateStatusBar(r);
  renderAttentionCards(r);
  renderStockGrid(r.stocks || {});
  // 重置新聞篩選至當日
  const fromEl = document.getElementById('news-from');
  const toEl   = document.getElementById('news-to');
  if(fromEl) fromEl.value = STATE.currentDate;
  if(toEl)   toEl.value   = STATE.currentDate;
  STATE._newsFilter = { from: STATE.currentDate, to: STATE.currentDate, stock: 'all' };
  STATE._newsPage   = 1;
  buildAndDisplayNews();
  renderWatchedSection();
}

function updateStatusBar(r) {
  // 品牌欄副標題：日期 + 收集時間
  const timeOnly = r.collected_at ? r.collected_at.slice(11, 16) : '';
  document.getElementById('last-update').textContent =
    isoToDisplay(r.date) + (timeOnly ? ' ' + timeOnly : '');
}

// ── 今日特別關注（清單式）────────────────────────
function renderAttentionCards(r) {
  const el   = document.getElementById('attention-container');
  const sub  = document.getElementById('attention-subtitle');
  const stks = r.stocks || {};
  const cats = loadUserCats();

  const owned   = Object.entries(stks).filter(([c]) => cats[c] === 'own');
  const notable = Object.entries(stks)
    .filter(([c, d]) => (d.attention_score || 0) >= 4 && cats[c] !== 'own')
    .sort((a, b) => (b[1].attention_score||0) - (a[1].attention_score||0))
    .slice(0, 6);

  function lineHtml(code, d) {
    const pct = d.price?.change_pct;
    const pctStr = pct != null ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : '—';
    const pctCls = pct > 0 ? 'pos' : pct < 0 ? 'neg' : '';
    const reason = d.attention_reason || d.news_summary || '';
    return `<div class="briefing-line" onclick="selectStockAndScroll('${code}')">
      <span class="bl-name">${d.name}</span>
      <span class="bl-code">${code}</span>
      <span class="bl-pct ${pctCls}">${pctStr}</span>
      <span class="bl-reason">${reason}</span>
    </div>`;
  }

  if(!owned.length && !notable.length) {
    el.innerHTML = '<div class="briefing-wrap"><p class="briefing-quiet">今日市況平靜，無特別關注訊號</p></div>';
    sub.textContent = '—';
    return;
  }

  let groups = [];
  if(owned.length) {
    groups.push(`<div class="briefing-group">
      <div class="briefing-group-label">💼 持股動態</div>
      ${owned.map(([c,d]) => lineHtml(c,d)).join('')}
    </div>`);
  }
  if(notable.length) {
    groups.push(`<div class="briefing-group">
      <div class="briefing-group-label">🔥 今日熱點</div>
      ${notable.map(([c,d]) => lineHtml(c,d)).join('')}
    </div>`);
  }

  el.innerHTML = `<div class="briefing-wrap">${groups.join('')}</div>`;
  sub.textContent = [
    owned.length   ? `持股 ${owned.length}` : '',
    notable.length ? `熱點 ${notable.length}` : '',
  ].filter(Boolean).join(' · ');
}

// ── 分類 Tabs ─────────────────────────────
function setupCategoryTabs() {
  document.getElementById('category-tabs').addEventListener('click', e => {
    const btn = e.target.closest('.cat-tab');
    if(!btn) return;
    document.querySelectorAll('.cat-tab').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    STATE.activeCat = btn.dataset.cat;
    if(STATE.report) renderStockGrid(STATE.report.stocks || {});
  });
}

function allSortedCodes(stocks) {
  // 只列出今日報告中有資料的股票（extra 股票今日無資料，不放入 grid）
  return [
    ...STOCK_ORDER.filter(c => stocks[c]),
    ...Object.keys(stocks).filter(c => !STOCK_ORDER.includes(c))
  ];
}

function filterByCat(stocks) {
  const cats  = loadUserCats();
  const codes = allSortedCodes(stocks);
  if(STATE.activeCat === 'top10') return getTop10Codes(stocks).filter(c => stocks[c]);
  if(STATE.activeCat === 'watch') return codes.filter(c => cats[c] === 'watch');
  if(STATE.activeCat === 'own')   return codes.filter(c => cats[c] === 'own');
  if(STATE.activeCat === 'us')    return codes.filter(c => isUSStock(c, stocks[c]));
  return codes;
}

function updateCatCounts(stocks) {
  const cats  = loadUserCats();
  const codes = allSortedCodes(stocks);
  const _ct10 = new Set(getTop10Codes(stocks));
  document.getElementById('cnt-top10').textContent = codes.filter(c => _ct10.has(c)).length;
  document.getElementById('cnt-watch').textContent = codes.filter(c => cats[c] === 'watch').length;
  document.getElementById('cnt-own').textContent   = codes.filter(c => cats[c] === 'own').length;
  document.getElementById('cnt-all').textContent   = codes.length;
  const usEl = document.getElementById('cnt-us');
  if(usEl) usEl.textContent = codes.filter(c => isUSStock(c, stocks[c])).length;
}

// ── 個股卡片 Grid ────────────────────────
function renderCard(code, d, cats) {
  const score   = d.attention_score || 0;
  const newsN   = (d.news || []).filter(n => n.date === STATE.currentDate && isRealNews(n)).length;
  const userCat = cats[code];
  const isActive = STATE.activeStock === code;
  const fire = score >= 5 ? '🔥' : score >= 4 ? '⚡' : '';
  return `<div class="stock-card${isActive ? ' active' : ''}" data-code="${code}" onclick="selectStock('${code}')">
    <div class="card-row1">
      ${fire ? `<span class="card-fire">${fire}</span>` : ''}
      <span class="card-name">${d.name}</span>
    </div>
    <div class="card-row2">
      <span class="card-code">${code}</span>
      <span class="card-actions">
        ${newsN ? `<span class="card-news-count">📰${newsN}</span>` : ''}
        <button class="card-tag-sm${userCat === 'watch' ? ' active-watch' : ''}"
          onclick="event.stopPropagation();toggleCardCat('${code}','watch')">⭐</button>
        <button class="card-tag-sm${userCat === 'own' ? ' active-own' : ''}"
          onclick="event.stopPropagation();toggleCardCat('${code}','own')">💼</button>
      </span>
    </div>
  </div>`;
}
function renderStockGrid(stocks) {
  const grid = document.getElementById('stock-grid');
  updateCatCounts(stocks);
  const cats = loadUserCats();

  if(STATE.activeCat === 'all') {
    const top10 = getTop10Codes(stocks).filter(c => stocks[c]);
    const _rt10 = new Set(top10);
    const allCodes = [
      ...STOCK_ORDER.filter(c => stocks[c]),
      ...Object.keys(stocks).filter(c => !STOCK_ORDER.includes(c))
    ];
    const twOthers = allCodes.filter(c => !_rt10.has(c) && !isUSStock(c, stocks[c]));
    const usAll    = allCodes.filter(c => isUSStock(c, stocks[c]));

    let html = '';
    if(top10.length) {
      html += `<div class="card-group-hdr">前十大高價股</div>`;
      html += top10.map(c => renderCard(c, stocks[c], cats)).join('');
    }
    if(twOthers.length) {
      html += `<div class="card-group-hdr">台股追蹤</div>`;
      html += twOthers.map(c => renderCard(c, stocks[c], cats)).join('');
    }
    if(usAll.length) {
      html += `<div class="card-group-hdr">🇺🇸 美股追蹤</div>`;
      html += usAll.map(c => renderCard(c, stocks[c], cats)).join('');
    }
    if(!html) html = `<div style="grid-column:1/-1;padding:40px;color:var(--text3);font-size:14px;text-align:center">今日尚無個股資料</div>`;
    grid.innerHTML = html;
    return;
  }

  const codes = filterByCat(stocks);
  if(!codes.length) {
    const msg = STATE.activeCat === 'watch' ? '點卡片右上角 ⭐ 來標記關注'
              : STATE.activeCat === 'own'   ? '點卡片右上角 💼 來標記持股'
              : '今日尚無個股資料';
    grid.innerHTML = `<div style="grid-column:1/-1;padding:40px;color:var(--text3);font-size:14px;text-align:center">${msg}</div>`;
    return;
  }
  grid.innerHTML = codes.map(c => renderCard(c, stocks[c], cats)).join('');
}


// ── 分類操作 ──────────────────────────────
function toggleCardCat(code, cat) {
  const cats = loadUserCats();
  if(cats[code] === cat) { delete cats[code]; }
  else { cats[code] = cat; }
  saveUserCats(cats);
  if(STATE.report) {
    renderStockGrid(STATE.report.stocks || {});
    if(STATE.activeStock === code) updateDetailTagButtons(code);
  }
}

function toggleCategory(cat) {
  if(STATE.activeStock) toggleCardCat(STATE.activeStock, cat);
}

// ── 選股 / 詳情面板 ───────────────────────
function selectStock(code) {
  STATE.activeStock = code;
  const stocks = STATE.report?.stocks || {};
  const data   = stocks[code];
  if(!data) return;

  // 更新卡片選中狀態
  document.querySelectorAll('.stock-card').forEach(c => {
    c.classList.toggle('active', c.dataset.code === code);
  });

  // 填入詳情 header
  const pct   = data.price?.change_pct;
  const price = data.price?.price;
  const isUS  = data.market === 'NASDAQ' || data.market === 'NYSE';
  document.getElementById('detail-code').textContent  = code;
  document.getElementById('detail-name').textContent  = data.name;
  document.getElementById('detail-price').textContent = price
    ? (isUS ? `USD ${price.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`
             : `NT$ ${price.toLocaleString()}`)
    : '';
  const pctEl = document.getElementById('detail-pct');
  if(pct != null) {
    pctEl.textContent = `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
    pctEl.className   = `detail-pct ${pct > 0 ? 'pos' : pct < 0 ? 'neg' : ''}`;
  } else {
    pctEl.textContent = '';
    pctEl.className   = 'detail-pct';
  }
  updateDetailTagButtons(code);

  // 渲染四個面板
  renderDPAnalysis(code, data);
  renderDPSupply(code, data);
  renderDPChips(code, data);
  renderDPNews(code, data);

  // 顯示詳情面板並切換到上次的 tab
  document.getElementById('detail-panel').classList.add('visible');
  switchDetailTab(STATE.activePanel);
}

function selectStockAndScroll(code) {
  selectStock(code);
  setTimeout(() => {
    document.getElementById('detail-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 50);
}

function closeDetail() {
  STATE.activeStock = null;
  document.getElementById('detail-panel').classList.remove('visible');
  document.querySelectorAll('.stock-card').forEach(c => c.classList.remove('active'));
}

function updateDetailTagButtons(code) {
  const cats = loadUserCats();
  const cat  = cats[code];
  document.getElementById('btn-watch').className = `tag-btn${cat === 'watch' ? ' active-watch' : ''}`;
  document.getElementById('btn-own').className   = `tag-btn${cat === 'own'   ? ' active-own'   : ''}`;
}

// ── 詳情面板子分頁 ────────────────────────
function setupDetailTabs() {
  document.getElementById('detail-tabs').addEventListener('click', e => {
    const btn = e.target.closest('.dtab');
    if(!btn) return;
    switchDetailTab(btn.dataset.panel);
  });
}

function switchDetailTab(panel) {
  STATE.activePanel = panel;
  document.querySelectorAll('.dtab').forEach(b => {
    b.classList.toggle('active', b.dataset.panel === panel);
  });
  document.querySelectorAll('.detail-body').forEach(p => {
    p.classList.toggle('active', p.id === `dp-${panel}`);
  });
}

// ── 詳情：AI 分析 ─────────────────────────
function renderDPAnalysis(code, data) {
  const el    = document.getElementById('dp-analysis');
  const score = data.attention_score || 0;
  const stars = score ? '★'.repeat(score) + '☆'.repeat(5 - score) : '';
  const tags  = (data.tags || []).map(t => `<span class="tag">${t}</span>`).join('');
  const cls   = score >= 5 ? 'score-5' : score >= 4 ? 'score-4' : '';

  const hasAI = data.attention_reason || data.news_summary || data.signal_type;

  const aiHtml = hasAI ? `<div class="ai-block ${cls}">
    <div class="ai-block-head">
      ${stars ? `<span class="ai-stars">${stars}</span>` : ''}
      ${data.signal_type ? `<span class="ai-signal-pill">${data.signal_type}</span>` : ''}
    </div>
    ${data.attention_reason ? `<div class="ai-reason">📌 ${data.attention_reason}</div>` : ''}
    ${data.news_summary     ? `<div class="ai-summary">📰 ${data.news_summary}</div>`     : ''}
  </div>` : '<p style="color:var(--text3);font-size:14px;padding:8px 0">今日 AI 分析尚未產生</p>';

  el.innerHTML = `<div>
    ${tags ? `<div class="tags" style="margin-bottom:12px">${tags}</div>` : ''}
    ${aiHtml}
  </div>`;
}

// ── 詳情：供應鏈 ──────────────────────────
function renderDPSupply(code, data) {
  const el = document.getElementById('dp-supply');
  const sc = (STATE.supplyChain || {})[code] || {};

  if(!sc.upstream?.length && !sc.downstream?.length && !sc.top_holdings?.length && !sc.position) {
    el.innerHTML = '<p style="color:var(--text3);font-size:14px">此股票暫無供應鏈資料</p>';
    return;
  }

  const renderTags = (list) => (list || []).map(u => {
    const dep = u.dependency || '';
    const cls = dep === '高' || dep === '極高' ? 'chain-dep-high' : 'chain-dep-med';
    return `<a class="chain-tag ${cls}" href="${getStockUrl(u)}" target="_blank" rel="noopener">
      <span class="chain-tag-code">${u.code}</span>
      <span>${u.name}</span>
      ${dep ? `<span style="font-size:10px;color:var(--text3)">依賴:${dep}</span>` : ''}
    </a>`;
  }).join('');

  const posHTML = sc.position ? `<div class="supply-group">
    <div class="supply-label">產業定位</div>
    <div style="font-size:14px;color:var(--text2);line-height:1.7">
      <strong>${sc.position}</strong>
      ${sc.moat ? `<br><span style="color:var(--text3)">${sc.moat}</span>` : ''}
    </div>
  </div>` : '';

  const upHTML = sc.upstream?.length ? `<div class="supply-group">
    <div class="supply-label">↑ 上游供應商</div>
    <div class="chain-tags">${renderTags(sc.upstream)}</div>
  </div>` : '';

  const downHTML = sc.downstream?.length ? `<div class="supply-group">
    <div class="supply-label">↓ 下游客戶</div>
    <div class="chain-tags">${renderTags(sc.downstream)}</div>
  </div>` : '';

  const holdHTML = sc.top_holdings?.length ? `<div class="supply-group">
    <div class="supply-label">主要持股</div>
    <div class="chain-tags">
      ${sc.top_holdings.map(h => `<a class="chain-tag" href="${getStockUrl({...h, market:'TW'})}" target="_blank" rel="noopener">
        <span class="chain-tag-code">${h.code}</span>
        <span>${h.name}</span>
        ${h.weight ? `<span style="font-size:10px;color:var(--text3)">${h.weight}</span>` : ''}
      </a>`).join('')}
    </div>
  </div>` : '';

  const risks     = (sc.key_risks      || []).map(r => `<li>${r}</li>`).join('');
  const catalysts = (sc.next_catalysts || []).map(c => `<li>${c}</li>`).join('');
  const rcHTML = (risks || catalysts) ? `<div class="risk-catalyst-row">
    ${risks     ? `<div class="risk-box"><div class="risk-box-title">⚠️ 關鍵風險</div><ul>${risks}</ul></div>` : ''}
    ${catalysts ? `<div class="catalyst-box"><div class="catalyst-box-title">🚀 未來觸媒</div><ul>${catalysts}</ul></div>` : ''}
  </div>` : '';

  el.innerHTML = `<div class="supply-section">${posHTML}${upHTML}${downHTML}${holdHTML}${rcHTML}</div>`;
}

// ── 詳情：籌碼 ────────────────────────────
function renderDPChips(code, data) {
  const el   = document.getElementById('dp-chips');
  const inst = data.institutional || {};
  const rows = [
    { label: '外資買賣超', value: inst.foreign_net },
    { label: '投信買賣超', value: inst.trust_net   },
    { label: '自營商買賣超', value: inst.dealer_net },
  ].filter(i => i.value != null);

  if(!rows.length) {
    const isUS = data.market === 'NASDAQ' || data.market === 'NYSE';
    el.innerHTML = `<p style="color:var(--text3);font-size:14px">${isUS
      ? '美股無三大法人揭露制度，可參考 SEC Form 4（內部人申報）'
      : '三大法人資料今日未取得（非交易日或 ETF）'}</p>`;
    return;
  }
  el.innerHTML = `<div class="chips-grid">
    ${rows.map(i => {
      const cls = i.value > 0 ? 'pos' : i.value < 0 ? 'neg' : '';
      return `<div class="chip-card">
        <div class="chip-label">${i.label}</div>
        <div class="chip-value ${cls}">${i.value > 0 ? '+' : ''}${i.value.toLocaleString()} 張</div>
      </div>`;
    }).join('')}
  </div>`;
}

// ── 詳情：新聞 ────────────────────────────
function renderDPNews(code, data) {
  const el    = document.getElementById('dp-news');
  const all   = data.news || [];
  const news  = all.filter(n => n.date === STATE.currentDate && isRealNews(n));
  const badge = document.getElementById('news-count-badge');
  if(badge) badge.textContent = news.length || '';
  if(!news.length) {
    el.innerHTML = '<p class="dp-empty">此股票今日無新聞</p>';
    return;
  }
  el.innerHTML = `<div class="dp-news-header">${isoToDisplay(STATE.currentDate)} 收集的新聞</div>
    <div class="news-item-list">
      ${news.map(n => `<div class="news-item">
        <span class="news-source">${n.source || ''}</span>
        <span class="news-title">${n.url
          ? `<a href="${n.url}" target="_blank" rel="noopener">${n.title}</a>`
          : n.title}</span>
        <span class="news-date">${formatNewsDate(n.date)}</span>
        <button class="news-watch-btn ${isNewsWatched(n.url)?'on':''}"
          data-code="${code}" data-sname="${escAttr(data.name)}"
          data-title="${escAttr(n.title)}" data-url="${escAttr(n.url)}"
          data-source="${escAttr(n.source||'')}" data-date="${n.date||''}"
          onclick="watchFromBtn(this)" title="${isNewsWatched(n.url)?'取消追蹤':'加入追蹤'}">📌</button>
      </div>`).join('')}
    </div>`;
}

// ── 新聞資料庫：初始化日期篩選 ──────────────────
function setupNewsSection() {
  const dates = STATE.availableDates;
  if(!dates.length) return;
  const first = dates[0];
  const last  = dates[dates.length - 1];
  const fromEl = document.getElementById('news-from');
  const toEl   = document.getElementById('news-to');
  if(!fromEl || !toEl) return;
  fromEl.min = first; fromEl.max = last;
  toEl.min   = first; toEl.max   = last;
  const label = document.getElementById('news-date-range-label');
  if(label) label.textContent = `資料範圍：${isoToDisplay(first)} ～ ${isoToDisplay(last)}`;
  document.getElementById('news-search-btn')?.addEventListener('click', () => {
    STATE._newsFilter.from  = fromEl.value || last;
    STATE._newsFilter.to    = toEl.value   || last;
    STATE._newsFilter.stock = 'all';
    STATE._newsPage = 1;
    loadNewsRange(STATE._newsFilter.from, STATE._newsFilter.to);
  });
  document.getElementById('news-reset-btn')?.addEventListener('click', () => {
    const cur = STATE.currentDate || last;
    fromEl.value = cur; toEl.value = cur;
    STATE._newsFilter = { from: cur, to: cur, stock: 'all' };
    STATE._newsPage   = 1;
    buildAndDisplayNews();
  });
}

// ── 新聞資料庫：載入跨日期報告 ──────────────────
async function loadNewsRange(from, to) {
  const dates   = STATE.availableDates.filter(d => d >= from && d <= to);
  const missing = dates.filter(d => !STATE._reportCache[d]);
  if(missing.length) {
    const btn = document.getElementById('news-search-btn');
    if(btn) { btn.disabled = true; btn.textContent = '載入中...'; }
    try {
      await Promise.all(missing.map(async d => {
        try {
          STATE._reportCache[d] = await fetchJSON(`./data/reports/${d}.json`);
        } catch(e) { /* skip */ }
      }));
    } finally {
      const btn2 = document.getElementById('news-search-btn');
      if(btn2) { btn2.disabled = false; btn2.textContent = '🔍 搜尋'; }
    }
  }
  buildAndDisplayNews();
}

// ── 新聞資料庫：組合並渲染 ─────────────────────
function buildAndDisplayNews() {
  const { from, to } = STATE._newsFilter;
  const dates = STATE.availableDates.filter(d => d >= from && d <= to);
  let all = [];
  for(const d of dates) {
    const r = STATE._reportCache[d];
    if(!r) continue;
    for(const [code, data] of Object.entries(r.stocks || {})) {
      (data.news || []).filter(isRealNews).forEach(n => {
        all.push({ ...n, code, stockName: data.name, reportDate: d });
      });
    }
  }
  all.sort((a, b) => (b.date || b.reportDate || '').localeCompare(a.date || a.reportDate || ''));
  STATE._allNews = all;
  _renderNewsChips(all);
  renderNewsPage(all);
}

function _renderNewsChips(all) {
  const { stock } = STATE._newsFilter;
  const bar   = document.getElementById('news-filters');
  const codes = [...new Set(all.map(n => n.code))];
  bar.innerHTML = `<button class="nfbtn ${stock === 'all' ? 'active' : ''}" data-f="all">全部 (${all.length})</button>
    ${codes.map(c => {
      const cnt  = all.filter(n => n.code === c).length;
      const name = all.find(n => n.code === c)?.stockName || c;
      return cnt ? `<button class="nfbtn ${stock === c ? 'active' : ''}" data-f="${c}">${name} (${cnt})</button>` : '';
    }).join('')}`;
  bar.querySelectorAll('.nfbtn').forEach(btn => {
    btn.addEventListener('click', () => {
      bar.querySelectorAll('.nfbtn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      STATE._newsFilter.stock = btn.dataset.f;
      STATE._newsPage = 1;
      renderNewsPage(STATE._allNews);
    });
  });
}

function renderNewsPage(all) {
  const { stock } = STATE._newsFilter;
  const page     = STATE._newsPage;
  const pageSize = STATE.NEWS_PAGE_SIZE;
  const items    = stock === 'all' ? all : all.filter(n => n.code === stock);
  const total    = items.length;
  const totalPgs = Math.ceil(total / pageSize) || 1;
  const slice    = items.slice((page - 1) * pageSize, page * pageSize);
  const el       = document.getElementById('news-container');
  if(!slice.length) {
    el.innerHTML = '<div class="news-empty">此條件暫無新聞</div>';
  } else {
    el.innerHTML = slice.map(n => `<div class="news-all-item">
      <span class="news-stock-badge" onclick="selectStock('${n.code}')" style="cursor:pointer">
        ${n.code}<br><small>${n.stockName}</small>
      </span>
      <span class="news-src-badge">${n.source || ''}</span>
      <span class="news-all-title">${n.url
        ? `<a href="${n.url}" target="_blank" rel="noopener">${n.title}</a>`
        : n.title}</span>
      <span class="news-all-date">${formatNewsDate(n.date) || isoToDisplay(n.reportDate)}</span>
      <button class="news-watch-btn ${isNewsWatched(n.url)?'on':''}"
        data-code="${n.code}" data-sname="${escAttr(n.stockName)}"
        data-title="${escAttr(n.title)}" data-url="${escAttr(n.url)}"
        data-source="${escAttr(n.source||'')}" data-date="${n.date||n.reportDate||''}"
        onclick="watchFromBtn(this)" title="${isNewsWatched(n.url)?'取消追蹤':'加入追蹤'}">📌</button>
    </div>`).join('');
  }
  const pgEl = document.getElementById('news-pagination');
  if(!pgEl) return;
  if(totalPgs <= 1) {
    pgEl.innerHTML = total ? `<span class="pg-info">共 ${total} 筆</span>` : '';
    return;
  }
  let pgs = `<button class="pg-btn" ${page===1?'disabled':''} onclick="newsGoPage(${page-1})">‹</button>`;
  const s = Math.max(1, page - 2);
  const e = Math.min(totalPgs, page + 2);
  if(s > 1) pgs += `<button class="pg-btn" onclick="newsGoPage(1)">1</button>${s > 2 ? '<span class="pg-ellipsis">…</span>' : ''}`;
  for(let i = s; i <= e; i++) pgs += `<button class="pg-btn${i===page?' on':''}" onclick="newsGoPage(${i})">${i}</button>`;
  if(e < totalPgs) pgs += `${e < totalPgs-1 ? '<span class="pg-ellipsis">…</span>' : ''}<button class="pg-btn" onclick="newsGoPage(${totalPgs})">${totalPgs}</button>`;
  pgs += `<button class="pg-btn" ${page===totalPgs?'disabled':''} onclick="newsGoPage(${page+1})">›</button>`;
  pgs += `<span class="pg-info">${(page-1)*pageSize+1}–${Math.min(page*pageSize,total)} / ${total} 筆</span>`;
  pgEl.innerHTML = pgs;
}

function newsGoPage(p) {
  STATE._newsPage = p;
  renderNewsPage(STATE._allNews);
  document.getElementById('news-container')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ── 日期導航 ──────────────────────────────
function setupDatePicker() {
  const picker = document.getElementById('date-picker');
  picker.addEventListener('change', () => loadDate(picker.value));
  // 讓 📅 label 點選後真的開啟 date picker
  document.querySelector('.date-picker-label')?.addEventListener('click', () => picker.showPicker?.());

  document.getElementById('prev-date').addEventListener('click', () => {
    const idx = STATE.availableDates.indexOf(STATE.currentDate);
    if(idx > 0) loadDate(STATE.availableDates[idx - 1]);
  });
  document.getElementById('next-date').addEventListener('click', () => {
    const idx = STATE.availableDates.indexOf(STATE.currentDate);
    if(idx < STATE.availableDates.length - 1) loadDate(STATE.availableDates[idx + 1]);
  });
  document.getElementById('goto-today').addEventListener('click', () => {
    const today  = toIso(new Date());
    const target = STATE.availableDates.includes(today)
      ? today : STATE.availableDates.slice(-1)[0];
    if(target) loadDate(target);
  });
}

// ── 新增追蹤 / 即時搜尋 ──────────────────
function setupWatchlistAdd() {
  const btn   = document.getElementById('add-stock-btn');
  const input = document.getElementById('add-stock-input');
  const doAdd = async () => {
    const code = input.value.trim().toUpperCase();
    if(!code) return;
    input.value = '';
    const stocks = STATE.report?.stocks || {};
    if(stocks[code]) {
      selectStockAndScroll(code);
      showToast(`已跳至 ${code} ${stocks[code].name}`, 'ok');
      return;
    }
    showToast(`🔍 搜尋 ${code} 中...`, 'info');
    btn.disabled = true;
    const data = await fetchStockLive(code);
    btn.disabled = false;
    if(!data) {
      showToast(`找不到 ${code}，請確認代號是否正確`, 'warn');
      return;
    }
    if(!STATE.report) return;
    STATE.report.stocks[code] = data;
    // 存入 localStorage
    try {
      const live = JSON.parse(localStorage.getItem('live_stocks') || '{}');
      live[code] = { name: data.name, market: data._market || 'TW' };
      localStorage.setItem('live_stocks', JSON.stringify(live));
    } catch(e) {}
    STATE._reportCache[STATE.currentDate] = STATE.report;
    renderStockGrid(STATE.report.stocks);
    STATE._newsFilter.from = STATE.currentDate;
    STATE._newsFilter.to   = STATE.currentDate;
    STATE._newsPage = 1;
    buildAndDisplayNews();
    selectStockAndScroll(code);
    showToast(`✓ ${code} ${data.name} 已加入`, 'ok');
  };
  btn.addEventListener('click', doAdd);
  input.addEventListener('keydown', e => { if(e.key === 'Enter') doAdd(); });
}

// ── 即時抓取股票資料（TWSE MIS API）────────
async function fetchStockLive(code) {
  const tries = [
    { market: 'TW',  ex: 'tse' },
    { market: 'TWO', ex: 'otc' },
  ];
  for(const { market, ex } of tries) {
    try {
      const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${ex}_${code.toLowerCase()}.tw&json=1&delay=0`;
      const r = await fetch(url);
      const d = await r.json();
      const info = d?.msgArray?.[0];
      if(!info || !info.n || info.n === '-') continue;
      const rawZ = parseFloat(info.z);
      const rawY = parseFloat(info.y);
      const price  = isNaN(rawZ) ? rawY : rawZ;
      const prev   = isNaN(rawY) ? price : rawY;
      const change = isNaN(price) ? 0 : +(price - prev).toFixed(2);
      const pct    = (prev && !isNaN(price)) ? +((change / prev) * 100).toFixed(2) : 0;
      const name   = info.n;
      const news   = await fetchNewsLive(code, name);
      return {
        name,
        type: 'stock',
        tags: ['即時查詢'],
        price: (!isNaN(price) && price > 0) ? { price, change, change_pct: pct } : {},
        institutional: {},
        news,
        attention_score: 0,
        signal_type: '即時查詢',
        attention_reason: '由使用者即時新增，新聞為 Google News 即時搜尋',
        news_summary: '',
        _market: market,
        _live: true,
      };
    } catch(e) { /* try next */ }
  }
  return null;
}

// ── 即時抓取 Google News RSS（透過 CORS proxy）──
async function fetchNewsLive(code, name) {
  try {
    const q = encodeURIComponent(`${name} 股票`);
    const rss = `https://news.google.com/rss/search?q=${q}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
    const proxy = `https://api.allorigins.win/raw?url=${encodeURIComponent(rss)}`;
    const r = await fetch(proxy, { signal: AbortSignal.timeout(8000) });
    const xml = await r.text();
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    return Array.from(doc.querySelectorAll('item')).slice(0, 8).map(item => ({
      title:  item.querySelector('title')?.textContent  || '',
      url:    item.querySelector('link')?.textContent   || '',
      date:   item.querySelector('pubDate')?.textContent|| '',
      source: 'Google News',
    })).filter(n => n.title);
  } catch(e) { return []; }
}

// ── 還原 localStorage 即時股票（每次載入報告後）──
async function restoreLiveStocks() {
  if(!STATE.report) return;
  const live = JSON.parse(localStorage.getItem('live_stocks') || '{}');
  const stocks = STATE.report.stocks;
  const missing = Object.entries(live).filter(([c]) => !stocks[c]);
  if(!missing.length) return;
  for(const [code] of missing) {
    const data = await fetchStockLive(code);
    if(data) stocks[code] = data;
  }
  STATE._reportCache[STATE.currentDate] = STATE.report;
  renderStockGrid(stocks);
  STATE._newsFilter.from = STATE.currentDate;
  STATE._newsFilter.to   = STATE.currentDate;
  STATE._newsPage = 1;
  buildAndDisplayNews();
}

// ── 追蹤新聞：localStorage ──────────────────────────────
function loadWatched() {
  try { return JSON.parse(localStorage.getItem('news_watched') || '[]'); }
  catch(e) { return []; }
}
function saveWatched(arr) {
  localStorage.setItem('news_watched', JSON.stringify(arr));
}
function isNewsWatched(url) {
  if(!url) return false;
  return loadWatched().some(w => w.url === url);
}
function syncToSheet(item, action) {
  try {
    fetch(WEBHOOK_URL, {
      method: 'POST', mode: 'no-cors',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...item }),
    });
  } catch(e) { /* 靜默失敗 */ }
}

function toggleNewsWatch(item) {
  const arr = loadWatched();
  const idx = arr.findIndex(w => w.url === item.url);
  if(idx >= 0) {
    arr.splice(idx, 1);
    saveWatched(arr);
    syncToSheet(item, 'remove');
    showToast('已取消追蹤', 'info');
    return false;
  }
  arr.unshift({ ...item, id: Date.now(), bookmarked_at: new Date().toISOString() });
  saveWatched(arr);
  syncToSheet(item, 'add');
  showToast(`📌 已加入追蹤`, 'ok');
  return true;
}
function watchFromBtn(btn) {
  const item = {
    code:      btn.dataset.code,
    stockName: btn.dataset.sname,
    title:     btn.dataset.title,
    url:       btn.dataset.url,
    source:    btn.dataset.source,
    date:      btn.dataset.date,
  };
  const watched = toggleNewsWatch(item);
  btn.classList.toggle('on', watched);
  btn.title = watched ? '取消追蹤' : '加入追蹤';
  renderWatchedSection();
}
function removeWatched(url) {
  const arr = loadWatched().filter(w => w.url !== url);
  saveWatched(arr);
  renderWatchedSection();
  document.querySelectorAll(`.news-watch-btn`).forEach(btn => {
    if(btn.dataset.url === url) { btn.classList.remove('on'); btn.title = '加入追蹤'; }
  });
}
function setWatchedCat(cat) {
  STATE._watchedCat = cat;
  renderWatchedSection();
}
function renderWatchedSection() {
  const arr    = loadWatched();
  const cntEl  = document.getElementById('watched-count');
  if(cntEl) cntEl.textContent = arr.length ? `${arr.length} 則` : '';
  const sec = document.getElementById('watched-section');
  if(sec) sec.style.display = arr.length ? '' : 'none';
  if(!arr.length) return;
  // 個股分類 tabs
  const codes = [...new Set(arr.map(w => w.code))];
  const cat   = STATE._watchedCat || 'all';
  const tabs  = document.getElementById('watched-tabs');
  if(tabs) {
    tabs.innerHTML = `<button class="nfbtn ${cat==='all'?'active':''}" onclick="setWatchedCat('all')">全部 (${arr.length})</button>
      ${codes.map(c => {
        const cnt  = arr.filter(w => w.code === c).length;
        const name = arr.find(w => w.code === c)?.stockName || c;
        return `<button class="nfbtn ${cat===c?'active':''}" onclick="setWatchedCat('${c}')">${name} (${cnt})</button>`;
      }).join('')}`;
  }
  const el    = document.getElementById('watched-list');
  if(!el) return;
  const items = cat === 'all' ? arr : arr.filter(w => w.code === cat);
  el.innerHTML = items.map(w => `<div class="watched-item">
    <span class="news-stock-badge" onclick="selectStock('${w.code}')" style="cursor:pointer">
      ${w.code}<br><small>${w.stockName}</small>
    </span>
    <span class="news-src-badge">${w.source || ''}</span>
    <span class="watched-title">${w.url
      ? `<a href="${w.url}" target="_blank" rel="noopener">${w.title}</a>`
      : w.title}</span>
    <span class="news-all-date">${formatNewsDate(w.date)}</span>
    <button class="watched-remove" onclick="removeWatched('${escAttr(w.url)}')" title="移除追蹤">✕</button>
  </div>`).join('');
}

// ── 設定面板 ──────────────────────────────
function openSettings() {
  const panel = document.getElementById('settings-panel');
  if(!panel) return;
  renderSettingsPanel();
  panel.style.display = 'flex';
}
function closeSettings() {
  const panel = document.getElementById('settings-panel');
  if(panel) panel.style.display = 'none';
}
function renderSettingsPanel() {
  const arr = loadWatched();
  const el  = document.getElementById('settings-body');
  if(!el) return;

  // 統計：各股 bookmark 數
  const byCodes = {};
  arr.forEach(w => { byCodes[w.code] = byCodes[w.code] || []; byCodes[w.code].push(w); });

  const sheetNote = `<div class="settings-sheet-note">
    <span>📊 資料同步至 Google Sheets「投資追蹤新聞」試算表</span>
    <a href="https://docs.google.com/spreadsheets/" target="_blank" class="settings-sheet-link">開啟 Google Sheets ↗</a>
  </div>`;

  if(!arr.length) {
    el.innerHTML = sheetNote + '<div class="settings-empty">尚未追蹤任何新聞<br><small>在新聞右方點 📌 即可加入追蹤</small></div>';
    return;
  }

  const rows = Object.entries(byCodes).map(([code, items]) => `
    <div class="settings-stock-group">
      <div class="settings-stock-label">
        <span class="settings-stock-code">${code}</span>
        <span class="settings-stock-name">${items[0].stockName || ''}</span>
        <span class="settings-stock-cnt">${items.length} 則</span>
      </div>
      ${items.map(w => `
        <div class="settings-news-item">
          <div class="settings-news-meta">${w.date || ''} · ${w.source || ''}</div>
          <a class="settings-news-title" href="${w.url || '#'}" target="_blank">${w.title || ''}</a>
          <button class="settings-news-del" onclick="removeWatched('${escAttr(w.url)}');renderSettingsPanel()">✕</button>
        </div>`).join('')}
    </div>`).join('');

  el.innerHTML = sheetNote + `<div class="settings-total">${arr.length} 則追蹤新聞</div>` + rows;
}

// ── Toast ─────────────────────────────────
function showToast(msg, type = 'info') {
  let t = document.getElementById('toast');
  if(!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  const color = type === 'ok' ? 'var(--sell)' : type === 'warn' ? 'var(--buy)' : 'var(--accent)';
  t.style.borderColor = color;
  t.style.color       = color;
  t.textContent       = msg;
  t.style.opacity     = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; }, 2500);
}

// ── Helpers ───────────────────────────────
async function fetchJSON(url) {
  const r = await fetch(url + '?t=' + Date.now());
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function getStockUrl(item) {
  if(!item?.code) return '#';
  if(item.market === 'NASDAQ' || item.market === 'NYSE')
    return `https://finance.yahoo.com/quote/${item.code}`;
  if(item.market === 'TWO')
    return `https://tw.stock.yahoo.com/quote/${item.code}.TWO`;
  return `https://tw.stock.yahoo.com/quote/${item.code}.TW`;
}

function showLoading() {
  document.getElementById('attention-container').innerHTML =
    '<div class="loading"><div class="spinner"></div>載入中...</div>';
  document.getElementById('stock-grid').innerHTML =
    '<div style="grid-column:1/-1" class="loading"><div class="spinner"></div>載入中...</div>';
  document.getElementById('news-container').innerHTML = '';
}

function hideLoading() {
  document.getElementById('attention-container').innerHTML = '';
  document.getElementById('stock-grid').innerHTML = '';
}

function showError(msg) {
  document.getElementById('attention-container').innerHTML =
    `<p style="color:var(--buy);font-size:14px;padding:8px 0">⚠️ ${msg}</p>`;
}

// ── 今日特別關注 / VIP 分頁切換 ─────────────
function switchHVTab(tab) {
  ['attention', 'vip'].forEach(t => {
    const btn = document.getElementById('hvtab-' + t);
    const panel = document.getElementById('hvpanel-' + t);
    if(btn)   btn.classList.toggle('active', t === tab);
    if(panel) panel.style.display = t === tab ? '' : 'none';
  });
  const subA = document.getElementById('attention-subtitle');
  const subV = document.getElementById('vip-update-time');
  if(subA) subA.style.display = tab === 'attention' ? '' : 'none';
  if(subV) subV.style.display = tab === 'vip'       ? '' : 'none';
  localStorage.setItem('hvtab', tab);
}

// ── VIP 投資動向 ──────────────────────────
async function loadVipMoves() {
  const el = document.getElementById('vip-grid');
  if(!el) return;
  el.innerHTML = '<div class="vip-loading">載入中...</div>';
  try {
    const data = await fetchJSON('./data/vip_moves.json');
    renderVipSection(data);
  } catch(e) {
    el.innerHTML = '<div class="vip-loading">暫無資料</div>';
  }
}

function renderVipSection(data) {
  const grid = document.getElementById('vip-grid');
  const sub  = document.getElementById('vip-update-time');
  if(!grid) return;

  if(sub && data.updated_at) {
    sub.textContent = '最後更新：' + fmtDateTime(data.updated_at);
  }

  const vips = data.vips || {};
  if(!Object.keys(vips).length) {
    grid.innerHTML = '<div class="vip-loading">等待下次更新...</div>';
    return;
  }

  const ORDER = ['buffett', 'huang', 'trump', 'wei', 'su', 'musk'];
  const cards = ORDER.map(id => {
    const v = vips[id];
    if(!v) return '';
    const newsHtml = (v.news || []).slice(0, 5).map(n => {
      const dateStr = n.date ? `<span class="vip-news-date">${n.date.slice(5).replace('-', '/')}</span>` : '';
      return `<a class="vip-news-item" href="${escAttr(n.url || '#')}" target="_blank" rel="noopener">
        ${dateStr}
        <span class="vip-news-title">${n.title || ''}</span>
      </a>`;
    }).join('') || '<div class="vip-news-empty">目前無最新消息</div>';

    return `<div class="vip-card">
      <div class="vip-card-header">
        <span class="vip-icon">${v.icon || '👤'}</span>
        <div>
          <div class="vip-name">${v.name}</div>
          <div class="vip-role">${v.title}</div>
        </div>
      </div>
      <div class="vip-news-list">${newsHtml}</div>
    </div>`;
  }).join('');

  grid.innerHTML = cards;
}

// ── 啟動 ──────────────────────────────────
// ── 自動更新：每 5 分鐘檢查今日是否有新報告 ──────────────────────
function startAutoRefresh() {
  setInterval(async () => {
    try {
      const today = toIso(new Date());
      if(STATE.currentDate !== today) return;  // 非今日不自動刷
      const idx = await fetchJSON('./data/reports/index.json');
      const latest = idx.latest || '';
      if(latest === today && !STATE.report) {
        // 之前沒資料，現在有了
        await loadDate(today);
        showToast('今日資料已更新', 'ok');
      } else if(latest === today && STATE.report) {
        // 已有資料，確認 collected_at 是否更新
        const fresh = await fetchJSON(`./data/reports/${today}.json`);
        if(fresh.collected_at !== STATE.report.collected_at) {
          STATE.report = fresh;
          renderAll();
          showToast('今日資料已重新整理', 'ok');
        }
      }
    } catch(e) { /* 靜默失敗 */ }
  }, 5 * 60 * 1000);
}
init();
startAutoRefresh();
