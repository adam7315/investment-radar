/* ── 投資情報雷達 — app.js ───────────────── */

const STATE = {
  currentDate: '',
  availableDates: [],
  report: null,
  supplyChain: null,
  watchlist: null,
  activeFilter: 'all'
};

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

    const today = formatDate(new Date());
    const target = STATE.availableDates.includes(today)
      ? today
      : (indexData.latest || STATE.availableDates.slice(-1)[0] || today);

    setupDatePicker();
    setupNewsFilters();
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

  // 狀態列設為 loading
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  if(dot)  { dot.className = 'status-dot loading'; }
  if(text) { text.textContent = '載入中...'; text.style.color = 'var(--text3)'; }

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
      document.getElementById('stocks-container').innerHTML = '';
      document.getElementById('news-container').innerHTML = '';
    }
  }
}

// ── 渲染全部 ──────────────────────────────
function renderAll() {
  const r = STATE.report;
  if(!r) return;
  renderInsights(r.key_insights || []);
  renderStocks(r.stocks || {});
  renderNewsList(r.stocks || {});
  hideLoading();
  updateStatusBar(r);
}

function updateStatusBar(r) {
  const dot  = document.getElementById('status-dot');
  const text = document.getElementById('status-text');
  const dateEl      = document.getElementById('status-date');
  const analyzedEl  = document.getElementById('status-analyzed');
  const collectedEl = document.getElementById('status-collected');

  const isToday = r.date === formatDate(new Date());
  dot.className  = 'status-dot ok';
  text.textContent = isToday ? '✓ 今日報告已就緒' : `查看 ${r.date} 歷史記錄`;
  text.style.color = 'var(--buy)';

  dateEl.textContent      = r.date || '—';
  analyzedEl.textContent  = r.generated_at || '—';
  collectedEl.textContent = r.collected_at  || r.generated_at || '—';
}

// ── 渲染 AI 洞察 ──────────────────────────
function renderInsights(insights) {
  const el = document.getElementById('insights-container');
  if(!insights.length) {
    el.innerHTML = '<p style="color:var(--text3);font-size:13px">今日尚無洞察記錄</p>';
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

// ── 渲染個股卡片 ──────────────────────────
function renderStocks(stocks) {
  const el = document.getElementById('stocks-container');

  const order = ['5274','2303','3008','00403A','0050'];
  const codes  = [...order.filter(c => stocks[c]),
                  ...Object.keys(stocks).filter(c => !order.includes(c))];

  if(!codes.length) {
    el.innerHTML = '<p style="color:var(--text3);font-size:13px">今日尚無個股資料</p>';
    return;
  }

  el.innerHTML = codes.map(code => buildStockCard(code, stocks[code])).join('');

  // 展開詳情按鈕
  el.querySelectorAll('.card-expand-btn').forEach(btn => {
    btn.addEventListener('click', () => openModal(btn.dataset.code, stocks[btn.dataset.code]));
  });
}

function buildStockCard(code, data) {
  const sc   = STATE.supplyChain[code] || {};
  const wl   = (STATE.watchlist || []).find(s => s.code === code) || {};
  const tags = wl.tags || [];

  const signalClass = { buy:'signal-buy', sell:'signal-sell', hold:'signal-hold', watch:'signal-watch' }[data.signal] || 'signal-watch';
  const insiderHl   = data.insider && data.insider.includes('⭐') ? 'highlight' : '';

  // 供應鏈
  const chainHTML = buildChainHTML(sc);

  // 新聞（最多3條）
  const newsHTML = (data.news || []).slice(0,3).map(n => `
    <div class="news-item">
      <span class="news-tag">${n.tag}</span>
      <span class="news-title">${n.url
        ? `<a href="${n.url}" target="_blank" rel="noopener">${n.title}</a>`
        : n.title}</span>
      <span class="news-date">${n.date}</span>
    </div>
  `).join('');

  // 法人
  const inst = data.institutional || {};
  const instHTML = buildInstHTML(inst);

  return `
    <div class="stock-card">
      <div class="card-header">
        <div class="card-title-group">
          <span class="card-code">${code}</span>
          <span class="card-name">${data.name || sc.name || code}</span>
          ${tags.map(t => `<span class="tag">${t}</span>`).join('')}
        </div>
        <span class="signal-badge ${signalClass}">${data.signal_text || data.signal}</span>
      </div>

      <div class="card-body">

        <!-- AI 分析 -->
        <div>
          <div class="card-label">📌 今日判斷</div>
          <div class="analysis-text">${truncate(data.analysis, 180)}</div>
          <div class="analysis-reason">${data.signal_reason || ''}</div>
        </div>

        ${sc.name ? `
        <!-- 供應鏈 -->
        <div>
          <div class="card-label">🔗 供應鏈脈絡</div>
          ${chainHTML}
        </div>` : ''}

        <!-- 大戶動向 -->
        <div>
          <div class="card-label">🏦 大戶動向</div>
          ${instHTML}
        </div>

        <!-- 董監 / 內部人 -->
        <div>
          <div class="card-label">👤 董監 / 內部人</div>
          <div class="insider-box ${insiderHl}">${data.insider || '無最新申報異動'}</div>
        </div>

        ${newsHTML ? `
        <!-- 新聞 -->
        <div>
          <div class="card-label">📰 最新新聞</div>
          <div class="card-news">${newsHTML}</div>
        </div>` : ''}

        <button class="card-expand-btn" data-code="${code}">查看完整分析 ↓</button>
      </div>
    </div>
  `;
}

function buildChainHTML(sc) {
  const parts = [];

  if(sc.upstream && sc.upstream.length) {
    const tags = sc.upstream.map(u =>
      `<a class="chain-tag" href="https://tw.stock.yahoo.com/quote/${u.code}.TW" target="_blank" rel="noopener">
        ↑ ${u.code} ${u.name}
       </a>`
    ).join('');
    parts.push(`<div class="chain-row">
      <span class="chain-direction">上游</span>
      <div class="chain-tags">${tags}</div>
    </div>`);
  }

  if(sc.downstream && sc.downstream.length) {
    const tags = sc.downstream.map(d => {
      const url = d.market === 'NASDAQ' || d.market === 'NYSE'
        ? `https://finance.yahoo.com/quote/${d.code}`
        : `https://tw.stock.yahoo.com/quote/${d.code}.TW`;
      return `<a class="chain-tag" href="${url}" target="_blank" rel="noopener">↓ ${d.code} ${d.name}</a>`;
    }).join('');
    parts.push(`<div class="chain-row">
      <span class="chain-direction">下游</span>
      <div class="chain-tags">${tags}</div>
    </div>`);
  }

  if(sc.top_holdings && sc.top_holdings.length) {
    const tags = sc.top_holdings.map(h =>
      `<a class="chain-tag" href="https://tw.stock.yahoo.com/quote/${h.code}.TW" target="_blank" rel="noopener">
        ${h.code} ${h.name} <span style="color:var(--text3)">${h.weight}</span>
       </a>`
    ).join('');
    parts.push(`<div class="chain-row">
      <span class="chain-direction">持股</span>
      <div class="chain-tags">${tags}</div>
    </div>`);
  }

  if(!parts.length) return '<span style="color:var(--text3);font-size:12px">ETF / 無供應鏈資料</span>';
  return `<div class="supply-chain-section">${parts.join('')}</div>`;
}

function buildInstHTML(inst) {
  if(!inst || Object.keys(inst).every(k => inst[k] === 'ETF，不適用')) {
    return '<span style="color:var(--text3);font-size:12px">ETF，不適用法人買賣超</span>';
  }
  const items = [
    { label:'外資', value: inst.foreign },
    { label:'投信', value: inst.trust },
    { label:'自營商', value: inst.dealer },
    { label:'融資', value: inst.margin }
  ].filter(i => i.value && !i.value.includes('不適用'));

  return `<div class="institutional-grid">
    ${items.map(i => {
      const cls = i.value && (i.value.includes('+') ? 'positive' : i.value.includes('-') ? 'negative' : '');
      return `<div class="inst-item">
        <div class="inst-label">${i.label}</div>
        <div class="inst-value ${cls}">${i.value}</div>
      </div>`;
    }).join('')}
  </div>`;
}

// ── Modal 展開完整分析 ────────────────────
function openModal(code, data) {
  const sc   = STATE.supplyChain[code] || {};
  const body = document.getElementById('modal-body');

  const signalClass = { buy:'signal-buy', sell:'signal-sell', hold:'signal-hold', watch:'signal-watch' }[data.signal] || 'signal-watch';

  // 供應鏈信號
  const scSignals = (data.supply_chain_signals || []).map(s => {
    const cls = s.includes('正面') ? 'positive' : s.includes('需') || s.includes('注意') ? 'negative' : '';
    return `<div class="chain-signal-tag ${cls}">• ${s}</div>`;
  }).join('');

  // 關鍵風險
  const risks = (sc.key_risks || []).map(r => `<li style="color:var(--sell);font-size:12px;margin-bottom:4px">${r}</li>`).join('');
  const catalysts = (sc.next_catalysts || []).map(c => `<li style="color:var(--buy);font-size:12px;margin-bottom:4px">${c}</li>`).join('');

  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px">
      <span style="font-size:12px;color:var(--text3);background:var(--bg3);padding:2px 8px;border-radius:4px">${code}</span>
      <span style="font-size:18px;font-weight:700">${data.name}</span>
      <span class="signal-badge ${signalClass}">${data.signal_text || data.signal}</span>
    </div>

    <div style="margin-bottom:20px">
      <div class="card-label" style="margin-bottom:8px">📌 完整分析</div>
      <div style="font-size:13px;color:var(--text2);line-height:1.8;white-space:pre-line">${data.analysis || ''}</div>
    </div>

    ${scSignals ? `
    <div style="margin-bottom:20px">
      <div class="card-label" style="margin-bottom:8px">🔗 供應鏈今日信號</div>
      <div style="display:flex;flex-direction:column;gap:4px">${scSignals}</div>
    </div>` : ''}

    ${risks ? `
    <div style="margin-bottom:20px">
      <div class="card-label" style="margin-bottom:8px">⚠️ 關鍵風險</div>
      <ul style="list-style:none;padding:0">${risks}</ul>
    </div>` : ''}

    ${catalysts ? `
    <div style="margin-bottom:20px">
      <div class="card-label" style="margin-bottom:8px">🚀 未來觸媒</div>
      <ul style="list-style:none;padding:0">${catalysts}</ul>
    </div>` : ''}

    <div style="margin-bottom:8px">
      <div class="card-label" style="margin-bottom:8px">👤 董監 / 內部人動向</div>
      <div class="insider-box ${data.insider && data.insider.includes('⭐') ? 'highlight' : ''}">${data.insider || '無最新申報'}</div>
    </div>

    ${(data.news||[]).length ? `
    <div style="margin-top:16px">
      <div class="card-label" style="margin-bottom:8px">📰 相關新聞</div>
      <div class="card-news">
        ${data.news.map(n => `
          <div class="news-item">
            <span class="news-tag">${n.tag}</span>
            <span class="news-title">${n.url ? `<a href="${n.url}" target="_blank">${n.title}</a>` : n.title}</span>
            <span class="news-date">${n.date}</span>
          </div>
        `).join('')}
      </div>
    </div>` : ''}
  `;

  document.getElementById('stock-modal').classList.remove('hidden');
}

function closeModal() {
  document.getElementById('stock-modal').classList.add('hidden');
}

// ── 新聞列表 ──────────────────────────────
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
    el.innerHTML = '<div style="padding:20px;color:var(--text3);font-size:13px;text-align:center">此分類暫無新聞</div>';
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
    const today = formatDate(new Date());
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

// ── Modal 事件 ────────────────────────────
document.getElementById('modal-close').addEventListener('click', closeModal);
document.getElementById('modal-overlay').addEventListener('click', closeModal);
document.addEventListener('keydown', e => { if(e.key === 'Escape') closeModal(); });

// ── Helpers ───────────────────────────────
async function fetchJSON(url) {
  const r = await fetch(url + '?t=' + Date.now());
  if(!r.ok) throw new Error(`HTTP ${r.status}: ${url}`);
  return r.json();
}
function formatDate(d) {
  return d.toISOString().slice(0,10);
}
function truncate(str, max) {
  if(!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}
function getStockName(code) {
  if(!STATE.report) return code;
  const s = STATE.report.stocks[code];
  return s ? `${code} ${s.name}` : code;
}
function showLoading() {
  ['insights-container','stocks-container','news-container'].forEach(id => {
    document.getElementById(id).innerHTML =
      '<div class="loading"><div class="spinner"></div>載入中...</div>';
  });
}
function hideLoading() {}
function showError(msg) {
  document.getElementById('insights-container').innerHTML =
    `<p style="color:var(--sell);font-size:13px">⚠️ ${msg}</p>`;
}

// ── 啟動 ──────────────────────────────────
init();
