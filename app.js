/* ── 投資情報雷達 — app.js ───────────────── */

const STATE = {
  currentDate:    '',
  availableDates: [],
  report:         null,
  supplyChain:    {},
  activeStock:    null,
  activeCat:      'all',
  activePanel:    'analysis',
  _allNews:       []
};

// 前十大高價股（固定）
const TOP10 = ['5274','6515','7769','6223','2383','3443','6669','2059','2454','3661'];

// 全部顯示順序：高價股 → 個人持倉 → ETF
const STOCK_ORDER = [
  '5274','6515','7769','6223','2383','3443','6669','2059','2454','3661',
  '2330','2327','3017','8299','2303','3481','3008','0050','00403A'
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

function formatNewsDate(d) {
  if(!d) return '';
  // ISO "2026-05-27" → "5月27日"
  if(/^\d{4}-\d{2}-\d{2}/.test(d)) {
    const m   = parseInt(d.slice(5, 7));
    const day = parseInt(d.slice(8, 10));
    return `${m}月${day}日`;
  }
  return d;
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
    setupAiInput();
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
    renderAll();
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
  renderAttentionCards(r);
  renderStockGrid(r.stocks || {});
  renderNewsList(r.stocks || {});
}

function updateStatusBar(r) {
  // 品牌欄副標題：日期 + 收集時間
  const timeOnly = r.collected_at ? r.collected_at.slice(11, 16) : '';
  document.getElementById('last-update').textContent =
    isoToDisplay(r.date) + (timeOnly ? ' ' + timeOnly : '');
}

// ── 今日特別關注 ──────────────────────────
function renderAttentionCards(r) {
  const el   = document.getElementById('attention-container');
  const sub  = document.getElementById('attention-subtitle');
  const stks = r.stocks || {};

  const list = Object.entries(stks)
    .filter(([, d]) => (d.attention_score || 0) >= 4)
    .sort((a, b) => (b[1].attention_score || 0) - (a[1].attention_score || 0));

  if(!list.length) {
    el.innerHTML = '<p class="no-attention">今日無特別關注個股，市況平靜</p>';
    sub.textContent = 'AI 評分 4~5 時顯示';
    return;
  }
  sub.textContent = `共 ${list.length} 支`;

  el.innerHTML = list.map(([code, d]) => {
    const score  = d.attention_score || 1;
    const stars  = '★'.repeat(score) + '☆'.repeat(5 - score);
    const cls    = score >= 5 ? 'score-5' : 'score-4';
    const pct    = d.price?.change_pct;
    const pctStr = pct != null ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : '';
    const pctCls = pct > 0 ? 'pos' : pct < 0 ? 'neg' : '';
    return `<div class="attention-card ${cls}" onclick="selectStockAndScroll('${code}')">
      <div class="att-head">
        <span class="att-code">${code}</span>
        <span class="att-name">${d.name}</span>
        ${pctStr ? `<span class="att-pct ${pctCls}">${pctStr}</span>` : ''}
      </div>
      <div class="att-stars">${stars}</div>
      <div class="att-signal-pill">${d.signal_type || '—'}</div>
      <div class="att-reason">${d.attention_reason || ''}</div>
    </div>`;
  }).join('');
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
  if(STATE.activeCat === 'top10') return codes.filter(c => TOP10.includes(c));
  if(STATE.activeCat === 'watch') return codes.filter(c => cats[c] === 'watch');
  if(STATE.activeCat === 'own')   return codes.filter(c => cats[c] === 'own');
  return codes;
}

function updateCatCounts(stocks) {
  const cats  = loadUserCats();
  const codes = allSortedCodes(stocks);
  document.getElementById('cnt-top10').textContent = codes.filter(c => TOP10.includes(c)).length;
  document.getElementById('cnt-watch').textContent = codes.filter(c => cats[c] === 'watch').length;
  document.getElementById('cnt-own').textContent   = codes.filter(c => cats[c] === 'own').length;
  document.getElementById('cnt-all').textContent   = codes.length;
}

// ── 個股卡片 Grid ────────────────────────
function renderCard(code, d, cats) {
  const score   = d.attention_score || 0;
  const newsN   = (d.news || []).length;
  const userCat = cats[code];
  const isActive = STATE.activeStock === code;
  const fire = score >= 5 ? '🔥' : score >= 4 ? '⚡' : '';
  return `<div class="stock-card${isActive ? ' active' : ''}" data-code="${code}" onclick="selectStock('${code}')">
    <div class="card-row1">
      ${fire ? `<span class="card-fire">${fire}</span>` : ''}
      <span class="card-name">${d.name}</span>
      <button class="tag-btn${userCat === 'watch' ? ' active-watch' : ''}"
        onclick="event.stopPropagation();toggleCardCat('${code}','watch')" title="關注">⭐</button>
      <button class="tag-btn${userCat === 'own' ? ' active-own' : ''}"
        onclick="event.stopPropagation();toggleCardCat('${code}','own')" title="持股">💼</button>
    </div>
    <div class="card-row2">
      <span class="card-code">${code}</span>
      ${newsN ? `<span class="card-news-count">📰${newsN}</span>` : ''}
    </div>
  </div>`;
}

function renderStockGrid(stocks) {
  const grid = document.getElementById('stock-grid');
  updateCatCounts(stocks);
  const cats = loadUserCats();

  if(STATE.activeCat === 'all') {
    const top10 = STOCK_ORDER.filter(c => TOP10.includes(c) && stocks[c]);
    const others = [
      ...STOCK_ORDER.filter(c => !TOP10.includes(c) && stocks[c]),
      ...Object.keys(stocks).filter(c => !STOCK_ORDER.includes(c))
    ];
    let html = '';
    if(top10.length) {
      html += `<div class="card-group-hdr">前十大高價股</div>`;
      html += top10.map(c => renderCard(c, stocks[c], cats)).join('');
    }
    if(others.length) {
      html += `<div class="card-group-hdr">其他追蹤</div>`;
      html += others.map(c => renderCard(c, stocks[c], cats)).join('');
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
  document.getElementById('detail-code').textContent  = code;
  document.getElementById('detail-name').textContent  = data.name;
  document.getElementById('detail-price').textContent = price ? `NT$ ${price.toLocaleString()}` : '';
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
    el.innerHTML = '<p style="color:var(--text3);font-size:14px">三大法人資料今日未取得（非交易日或 ETF）</p>';
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
  const news  = data.news || [];
  const badge = document.getElementById('news-count-badge');
  if(badge) badge.textContent = news.length || '';

  if(!news.length) {
    el.innerHTML = '<p style="color:var(--text3);font-size:14px">此股票今日無新聞</p>';
    return;
  }
  el.innerHTML = `<div class="news-item-list">
    ${news.map(n => `<div class="news-item">
      <span class="news-source">${n.source || ''}</span>
      <span class="news-title">${n.url
        ? `<a href="${n.url}" target="_blank" rel="noopener">${n.title}</a>`
        : n.title}</span>
      <span class="news-date">${formatNewsDate(n.date)}</span>
    </div>`).join('')}
  </div>`;
}

// ── 全站新聞聚合 ──────────────────────────
function renderNewsList(stocks) {
  STATE._allNews = [];
  const order = allSortedCodes(stocks);
  for(const code of order) {
    (stocks[code].news || []).forEach(n =>
      STATE._allNews.push({ ...n, code, stockName: stocks[code].name })
    );
  }
  STATE._allNews.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const bar = document.getElementById('news-filters');
  bar.innerHTML = `<button class="nfbtn active" data-f="all">全部 (${STATE._allNews.length})</button>
    ${order.map(c => {
      const cnt = STATE._allNews.filter(n => n.code === c).length;
      return cnt ? `<button class="nfbtn" data-f="${c}">${stocks[c].name} (${cnt})</button>` : '';
    }).join('')}`;

  bar.querySelectorAll('.nfbtn').forEach(btn => {
    btn.addEventListener('click', () => {
      bar.querySelectorAll('.nfbtn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      displayAllNews(btn.dataset.f);
    });
  });
  displayAllNews('all');
}

function displayAllNews(f) {
  const el    = document.getElementById('news-container');
  const items = f === 'all' ? STATE._allNews : STATE._allNews.filter(n => n.code === f);
  if(!items.length) {
    el.innerHTML = '<div style="padding:20px;color:var(--text3);font-size:14px;text-align:center">此分類暫無新聞</div>';
    return;
  }
  el.innerHTML = items.map(n => `<div class="news-all-item">
    <span class="news-stock-badge" onclick="selectStock('${n.code}')" style="cursor:pointer">
      ${n.code}<br><small>${n.stockName}</small>
    </span>
    <span class="news-src-badge">${n.source || ''}</span>
    <span class="news-all-title">${n.url
      ? `<a href="${n.url}" target="_blank" rel="noopener">${n.title}</a>`
      : n.title}</span>
    <span class="news-all-date">${formatNewsDate(n.date)}</span>
  </div>`).join('');
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

// ── 新增追蹤 / 跳至個股 ──────────────────
function setupWatchlistAdd() {
  const btn   = document.getElementById('add-stock-btn');
  const input = document.getElementById('add-stock-input');

  const doAdd = () => {
    const code = input.value.trim().toUpperCase();
    if(!code) return;
    const stocks = STATE.report?.stocks || {};
    if(stocks[code]) {
      // 今日資料已有此股 → 直接跳至
      selectStockAndScroll(code);
      showToast(`已切換到 ${code} ${stocks[code].name}`, 'ok');
    } else {
      // 今日資料無此股 → 加入 localStorage 追蹤清單
      try {
        const saved = JSON.parse(localStorage.getItem('watchlist_extra') || '[]');
        if(!saved.includes(code)) {
          saved.push(code);
          localStorage.setItem('watchlist_extra', JSON.stringify(saved));
          showToast(`✓ ${code} 已加入追蹤，明日資料更新後顯示`, 'ok');
        } else {
          showToast(`${code} 已在追蹤清單中`, 'warn');
        }
      } catch(e) {}
    }
    input.value = '';
  };

  btn.addEventListener('click', doAdd);
  input.addEventListener('keydown', e => { if(e.key === 'Enter') doAdd(); });
}

// ── AI 問答 ───────────────────────────────
function setupAiInput() {
  const input = document.getElementById('ai-input');
  if(input) {
    input.addEventListener('keydown', e => {
      if(e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendAiQuestion(); }
    });
  }
}

function setQ(q) {
  const input = document.getElementById('ai-input');
  if(input) { input.value = q; input.focus(); }
}

function buildAiContext() {
  const r = STATE.report;
  if(!r) return '（尚無今日報告）';
  const stocks = r.stocks || {};
  const order  = allSortedCodes(stocks);

  let ctx = `今天日期：${isoToDisplay(r.date)}\n\n`;

  // 今日特別關注
  const topList = (r.top_attention || []).map(code => {
    const d = stocks[code];
    return d ? `${code} ${d.name}（評分${d.attention_score}，${d.signal_type || ''}）：${d.attention_reason || ''}` : code;
  });
  if(topList.length) ctx += `今日特別關注：\n${topList.map(s => '- ' + s).join('\n')}\n\n`;

  // 各股今日狀況
  ctx += '各股今日狀況：\n';
  for(const code of order) {
    const d      = stocks[code];
    const pct    = d.price?.change_pct;
    const pctStr = pct != null ? `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%` : '—';
    const inst   = d.institutional || {};
    const fNet   = inst.foreign_net != null ? `外資${inst.foreign_net >= 0 ? '買' : '賣'}超${Math.abs(inst.foreign_net)}張` : '';
    const sig    = d.signal_type && d.signal_type !== '無特殊' ? `[${d.signal_type}]` : '';
    const reason = d.attention_reason ? ` — ${d.attention_reason}` : '';
    ctx += `- ${code} ${d.name}：漲跌${pctStr} ${fNet} ${sig}${reason}\n`;
  }
  ctx += '\n';

  // 新聞摘要（前 25 則）
  const newsLines = [];
  for(const code of order) {
    (stocks[code].news || []).slice(0, 3).forEach(n =>
      newsLines.push(`[${stocks[code].name}] ${n.title}（${n.source}）`)
    );
  }
  if(newsLines.length) ctx += `今日相關新聞（節錄）：\n${newsLines.slice(0, 25).map(s => '- ' + s).join('\n')}\n\n`;

  // 供應鏈（簡要，最多 5 支）
  const sc = STATE.supplyChain || {};
  const scKeys = Object.keys(sc).filter(c => stocks[c]).slice(0, 5);
  if(scKeys.length) {
    ctx += '供應鏈關係（摘要）：\n';
    for(const code of scKeys) {
      const s = sc[code];
      if(s.upstream?.length || s.downstream?.length) {
        const up   = (s.upstream   || []).map(u => u.name).join('、') || '—';
        const down = (s.downstream || []).map(d => d.name).join('、') || '—';
        ctx += `- ${code} ${stocks[code]?.name}：上游=${up}，下游=${down}\n`;
      }
    }
  }
  return ctx;
}

async function sendAiQuestion() {
  const input   = document.getElementById('ai-input');
  const respEl  = document.getElementById('ai-response');
  const sendBtn = document.getElementById('ai-send-btn');
  const question = input.value.trim();
  if(!question) return;

  const apiKey = localStorage.getItem('claude_api_key') || '';
  if(!apiKey) {
    openApiKeyModal();
    showToast('請先設定 Claude API Key', 'warn');
    return;
  }

  sendBtn.disabled = true;
  input.disabled   = true;
  respEl.className = 'ai-response visible loading';
  respEl.textContent = '⏳ AI 分析中，請稍候...';

  const ctx = buildAiContext();
  const prompt = `你是一位專業的台灣股市分析師，擅長分析籌碼、供應鏈、新聞事件對個股的影響。

以下是今日市場數據背景資訊：
${ctx}
---
使用者問題：${question}

請用繁體中文回答，結合上方今日數據，提供具體、實用的分析。避免空泛建議。`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type':                      'application/json',
        'x-api-key':                         apiKey,
        'anthropic-version':                 '2023-06-01',
        'anthropic-dangerous-allow-browser': 'true'
      },
      body: JSON.stringify({
        model:      'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages:   [{ role: 'user', content: prompt }]
      })
    });

    if(!res.ok) {
      const errText = await res.text();
      throw new Error(`API 錯誤 ${res.status}: ${errText.slice(0, 200)}`);
    }

    const json  = await res.json();
    const reply = json.content?.[0]?.text || '（無回應）';
    respEl.className  = 'ai-response visible';
    respEl.textContent = reply;
  } catch(e) {
    console.error(e);
    respEl.className  = 'ai-response visible';
    respEl.textContent = `⚠️ ${e.message}\n\n請確認 API Key 是否正確，或稍後再試。`;
  } finally {
    sendBtn.disabled = false;
    input.disabled   = false;
    input.value      = '';
  }
}

// ── API Key Modal ─────────────────────────
function openApiKeyModal() {
  const modal = document.getElementById('modal-apikey');
  modal.classList.add('visible');
  const existing = localStorage.getItem('claude_api_key') || '';
  const inp = document.getElementById('modal-apikey-input');
  inp.value = existing;
  setTimeout(() => inp.focus(), 50);
}

function closeApiKeyModal() {
  document.getElementById('modal-apikey').classList.remove('visible');
}

function saveApiKey() {
  const key = document.getElementById('modal-apikey-input').value.trim();
  if(key) {
    localStorage.setItem('claude_api_key', key);
    showToast('✓ API Key 已儲存', 'ok');
  } else {
    localStorage.removeItem('claude_api_key');
    showToast('已清除 API Key', 'info');
  }
  closeApiKeyModal();
}

// 點擊 modal 背景關閉
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('modal-apikey').addEventListener('click', e => {
    if(e.target === e.currentTarget) closeApiKeyModal();
  });
});

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

// ── 啟動 ──────────────────────────────────
init();
