"""
投資情報雷達 — 每日資料蒐集
每天 06:00 (台灣時間) 由 GitHub Actions 執行
新聞來源：Google News / 鉅亨 / Yahoo / 經濟日報 / MoneyDJ / ETtoday / Reuters + TWSE公告
"""

import json
import os
import time
import datetime
import requests
import feedparser
from pathlib import Path
from urllib.parse import quote

BASE        = Path(__file__).parent.parent
DATA_DIR    = BASE / "data"
REPORTS_DIR = DATA_DIR / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

TZ_OFFSET   = datetime.timezone(datetime.timedelta(hours=8))
NOW         = datetime.datetime.now(TZ_OFFSET)
TODAY       = NOW.date().isoformat()

HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}

# ── 8 個通用 RSS 新聞源（全抓，再用關鍵字篩選） ──────────────
GENERAL_SOURCES = [
    {"name": "鉅亨網台股",  "url": "https://news.cnyes.com/rss/tw/fnstockstw"},
    {"name": "鉅亨網科技",  "url": "https://news.cnyes.com/rss/tw/tech"},
    {"name": "Yahoo財經",   "url": "https://tw.stock.yahoo.com/rss"},
    {"name": "經濟日報股市","url": "https://money.udn.com/rssfeed/news/1001/7251"},
    {"name": "MoneyDJ",     "url": "https://www.moneydj.com/KMDJ/RSSFeed.aspx?cid=MB010001"},
    {"name": "ETtoday財經", "url": "https://finance.ettoday.net/news_rss.php"},
    {"name": "Reuters科技", "url": "https://feeds.reuters.com/reuters/technologyNews"},
    {"name": "工商時報",    "url": "https://ctee.com.tw/feed"},
]

# ── 預先抓取所有通用 RSS（避免每支股票重複請求）─────────────
def prefetch_general_feeds():
    feeds = []
    for src in GENERAL_SOURCES:
        try:
            feed = feedparser.parse(src["url"])
            for entry in feed.entries:
                pub = entry.get("published", "")[:10] if entry.get("published") else TODAY
                feeds.append({
                    "title":   entry.get("title", ""),
                    "summary": entry.get("summary", ""),
                    "url":     entry.get("link", ""),
                    "date":    pub,
                    "source":  src["name"],
                })
        except Exception as e:
            print(f"  [WARN] RSS 失敗 {src['name']}: {e}")
    return feeds


# ── Google News RSS 個股專屬搜尋 ─────────────────────────────
def fetch_google_news(code, name, max_items=8):
    query = f"{name} 股票"
    url   = f"https://news.google.com/rss/search?q={quote(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant"
    found = []
    try:
        feed = feedparser.parse(url)
        for entry in feed.entries[:max_items]:
            pub = entry.get("published", "")[:10] if entry.get("published") else TODAY
            found.append({
                "title":   entry.get("title", ""),
                "url":     entry.get("link", ""),
                "date":    pub,
                "source":  "Google News",
            })
    except Exception as e:
        print(f"  [WARN] Google News 失敗 {code}: {e}")
    return found


# ── TWSE/MOPS 重大訊息公告 ────────────────────────────────────
def fetch_twse_announcements(code, market="TW"):
    """從 TWSE opendata 抓個股最近重大訊息"""
    try:
        # TWSE 上市公司重大訊息
        url = "https://www.twse.com.tw/rwd/zh/announcement/announcement.json"
        params = {
            "STK_NO":    code,
            "startDate": (NOW.date() - datetime.timedelta(days=3)).strftime("%Y%m%d"),
            "endDate":   NOW.date().strftime("%Y%m%d"),
            "_":         int(time.time() * 1000),
        }
        r = requests.get(url, params=params, headers=HEADERS, timeout=10)
        data = r.json()
        rows = data.get("data", []) or []
        results = []
        for row in rows[:5]:
            if len(row) >= 4:
                results.append({
                    "title":  row[3] if len(row) > 3 else row[-1],
                    "url":    "",
                    "date":   TODAY,
                    "source": "TWSE公告",
                })
        return results
    except Exception:
        return []


# ── 從通用 feeds 篩選與個股相關新聞 ────────────────────────────
def filter_news_for_stock(all_feeds, code, name, max_items=6):
    keywords = [code, name]
    # 公司簡稱（取前2字，避免過短誤抓）
    if len(name) >= 3:
        keywords.append(name[:2])
    found = []
    seen_urls = set()
    for item in all_feeds:
        text = item["title"] + " " + item["summary"]
        if any(kw in text for kw in keywords):
            if item["url"] not in seen_urls:
                seen_urls.add(item["url"])
                found.append({
                    "title":  item["title"],
                    "url":    item["url"],
                    "date":   item["date"],
                    "source": item["source"],
                })
            if len(found) >= max_items:
                break
    return found


# ── 整合所有新聞來源 ────────────────────────────────────────────
def fetch_all_news(code, name, market, all_feeds, max_total=12):
    # 1. 從通用 feeds 篩選
    general_news = filter_news_for_stock(all_feeds, code, name, max_items=6)
    # 2. Google News 個股專搜
    google_news  = fetch_google_news(code, name, max_items=6)
    # 3. TWSE 重大公告（僅上市公司）
    twse_news = fetch_twse_announcements(code, market) if market in ("TW",) else []

    # 合併去重
    merged = []
    seen   = set()
    for item in (twse_news + google_news + general_news):
        key = item.get("url") or item["title"]
        if key and key not in seen:
            seen.add(key)
            merged.append(item)
        if len(merged) >= max_total:
            break
    return merged


# ── Yahoo Finance 股價 ───────────────────────────────────────────
def fetch_price(code, market="TW"):
    # TWO 先試 .TWO，失敗再試 .TW（部分上櫃股 Yahoo 以 .TW 收錄）
    if market == "TWO":
        candidates = [code.upper() + ".TWO", code.upper() + ".TW"]
    elif market == "TW":
        candidates = [code.upper() + ".TW"]
    else:
        candidates = [code]

    for yf_code in candidates:
        try:
            url    = f"https://query1.finance.yahoo.com/v8/finance/chart/{yf_code}"
            r      = requests.get(url, headers=HEADERS, timeout=10)
            data   = r.json()
            result = (data.get("chart") or {}).get("result") or []
            if not result:
                continue
            meta   = result[0]["meta"]
            price  = meta.get("regularMarketPrice") or 0
            prev   = meta.get("previousClose") or 0
            if not price:
                continue
            change = round(price - prev, 2)
            pct    = round((change / prev * 100) if prev else 0, 2)
            return {"price": price, "change": change, "change_pct": pct}
        except Exception as e:
            print(f"  [WARN] 股價失敗 {yf_code}: {e}")
    return {}


# ── FinMind 三大法人 ────────────────────────────────────────────
def fetch_institutional(code, market="TW"):
    try:
        token = os.environ.get("FINMIND_TOKEN", "")
        if not token:
            return {}
        url = "https://api.finmindtrade.com/api/v4/data"
        params = {
            "dataset":    "TaiwanStockInstitutionalInvestorsBuySell",
            "data_id":    code,
            "start_date": TODAY,
            "end_date":   TODAY,
            "token":      token,
        }
        r    = requests.get(url, params=params, timeout=10)
        data = r.json().get("data", [])
        result = {}
        for row in data:
            name_r = row.get("name", "")
            net    = (row.get("buy", 0) - row.get("sell", 0)) // 1000
            if "外資" in name_r:
                result["foreign_net"] = net
            elif "投信" in name_r:
                result["trust_net"] = net
            elif "自營" in name_r:
                result["dealer_net"] = net
        return result
    except Exception as e:
        print(f"  [WARN] 法人資料失敗 {code}: {e}")
        return {}


# ── 主流程 ─────────────────────────────────────────────────────
def main():
    print(f"=== 投資情報雷達 資料蒐集 {TODAY} ===")
    watchlist = json.loads((DATA_DIR / "watchlist.json").read_text(encoding="utf-8"))["stocks"]

    print("  預載通用 RSS feeds...")
    all_feeds = prefetch_general_feeds()
    print(f"  共取得 {len(all_feeds)} 則通用新聞")

    report = {
        "date":         TODAY,
        "collected_at": NOW.strftime("%Y-%m-%dT%H:%M"),
        "total_news":   0,
        "stocks":       {},
    }

    for stock in watchlist:
        code   = stock["code"]
        name   = stock["name"]
        market = stock.get("market", "TW")
        print(f"  [{code}] {name}...")

        price_data = fetch_price(code, market)
        inst_data  = fetch_institutional(code, market)
        news       = fetch_all_news(code, name, market, all_feeds)
        time.sleep(0.3)

        report["stocks"][code] = {
            "name":          name,
            "type":          stock.get("type", "stock"),
            "tags":          stock.get("tags", []),
            "price":         price_data,
            "institutional": inst_data,
            "news":          news,
            # AI 分析欄位由 analyze.py 填入
            "attention_score":  0,
            "signal_type":      "待分析",
            "attention_reason": "",
            "news_summary":     "",
        }
        report["total_news"] += len(news)
        print(f"    股價={price_data.get('price','—')}  新聞={len(news)}則")

    # 存成 {TODAY}.json（直接可被前端讀取）
    out_path = REPORTS_DIR / f"{TODAY}.json"
    out_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n✓ 資料已儲存：{out_path}  (總新聞 {report['total_news']} 則)")

    _update_index()
    print("✓ index.json 已更新")
    print("=== 收集完成 ===")


def _update_index():
    idx_path = REPORTS_DIR / "index.json"
    if idx_path.exists():
        idx = json.loads(idx_path.read_text(encoding="utf-8"))
    else:
        idx = {"dates": [], "latest": ""}
    dates = idx.get("dates", [])
    if TODAY not in dates:
        dates.append(TODAY)
        dates.sort()
    idx["dates"]  = dates
    idx["latest"] = dates[-1]
    idx_path.write_text(json.dumps(idx, ensure_ascii=False, indent=2), encoding="utf-8")


if __name__ == "__main__":
    main()
