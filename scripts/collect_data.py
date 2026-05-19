"""
投資情報雷達 — 每日資料蒐集腳本
每天 06:00 (台灣時間) 由 GitHub Actions 執行
只負責「抓原始資料」，不做分析
分析由 Claude 在每日對話中進行
"""

import json
import os
import time
import datetime
import requests
import feedparser
from pathlib import Path

BASE = Path(__file__).parent.parent
DATA_DIR   = BASE / "data"
REPORTS_DIR = DATA_DIR / "reports"
REPORTS_DIR.mkdir(parents=True, exist_ok=True)

TODAY = datetime.date.today().isoformat()


# ── 讀取追蹤清單 ──────────────────────────
def load_watchlist():
    with open(DATA_DIR / "watchlist.json", encoding="utf-8") as f:
        return json.load(f)["stocks"]


# ── 從 FinMind 抓三大法人 ─────────────────
def fetch_institutional(code, market="TW"):
    """抓三大法人買賣超，回傳今日資料"""
    try:
        # FinMind 免費 API（需先到 finmindtrade.com 註冊取得 token）
        token = os.environ.get("FINMIND_TOKEN", "")
        url = "https://api.finmindtrade.com/api/v4/data"
        params = {
            "dataset": "TaiwanStockInstitutionalInvestorsBuySell",
            "data_id": code,
            "start_date": TODAY,
            "end_date": TODAY,
            "token": token
        }
        r = requests.get(url, params=params, timeout=10)
        data = r.json().get("data", [])
        if not data:
            return {}

        result = {}
        for row in data:
            name = row.get("name", "")
            buy  = row.get("buy", 0)
            sell = row.get("sell", 0)
            net  = (buy - sell) // 1000  # 換算成張
            if "外資" in name:
                result["foreign_net"] = net
            elif "投信" in name:
                result["trust_net"] = net
            elif "自營" in name:
                result["dealer_net"] = net
        return result
    except Exception as e:
        print(f"  [WARN] 法人資料失敗 {code}: {e}")
        return {}


# ── 從 Yahoo Finance 抓股價 ───────────────
def fetch_price(code, market="TW"):
    """抓今日收盤價與漲跌"""
    try:
        if market in ("TW", "TWO"):
            suffix = ".TWO" if market == "TWO" else ".TW"
            # 代碼含英文字母時（如 00403A）需特殊處理
            yf_code = code.upper() + suffix
        else:
            yf_code = code

        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{yf_code}"
        headers = {"User-Agent": "Mozilla/5.0"}
        r = requests.get(url, headers=headers, timeout=10)
        d = r.json()
        meta = d["chart"]["result"][0]["meta"]
        price  = meta.get("regularMarketPrice", 0)
        prev   = meta.get("previousClose", 0)
        change = round(price - prev, 2)
        pct    = round((change / prev * 100) if prev else 0, 2)
        return {"price": price, "change": change, "change_pct": pct}
    except Exception as e:
        print(f"  [WARN] 股價失敗 {code}: {e}")
        return {}


# ── 從 RSS 抓個股相關新聞 ─────────────────
NEWS_SOURCES = [
    # 鉅亨網
    "https://news.cnyes.com/rss/tw/fnstockstw",
    # Yahoo 財經台股
    "https://tw.stock.yahoo.com/rss",
]

def fetch_news_for_stock(code, name, max_items=5):
    """從多個 RSS 源抓與此股相關的新聞"""
    keywords = [code, name]
    found = []
    for src in NEWS_SOURCES:
        try:
            feed = feedparser.parse(src)
            for entry in feed.entries:
                title   = entry.get("title", "")
                summary = entry.get("summary", "")
                link    = entry.get("link", "")
                date    = entry.get("published", "")[:10] if entry.get("published") else TODAY
                if any(kw in title or kw in summary for kw in keywords):
                    found.append({"title": title, "url": link, "date": date, "tag": "即時"})
                if len(found) >= max_items:
                    break
        except Exception as e:
            print(f"  [WARN] RSS 失敗 {src}: {e}")
    return found[:max_items]


# ── 從公開資訊觀測站抓董監持股申報 ──────
def fetch_insider_filing(code):
    """
    抓最近董監大股東異動申報
    實作：呼叫 TWSE opendata
    """
    try:
        url = f"https://mops.twse.com.tw/mops/web/ajax_t100sb04"
        # 注意：此為示意，實際需配合 mops 的 POST 參數
        # 若未設定，回傳空字串（不影響其他功能）
        return ""
    except:
        return ""


# ── 主流程 ────────────────────────────────
def main():
    print(f"=== 投資情報雷達 資料蒐集 {TODAY} ===")
    watchlist = load_watchlist()

    raw = {
        "date": TODAY,
        "collected_at": datetime.datetime.now().isoformat(timespec="minutes"),
        "note": "原始資料由 GitHub Actions 自動蒐集，分析由 Claude 在每日對話中進行",
        "stocks": {}
    }

    for stock in watchlist:
        code   = stock["code"]
        name   = stock["name"]
        market = stock.get("market", "TW")
        print(f"  抓取 {code} {name}...")

        price_data = fetch_price(code, market)
        inst_data  = fetch_institutional(code, market)
        news_data  = fetch_news_for_stock(code, name)
        time.sleep(0.5)  # 避免請求過快

        raw["stocks"][code] = {
            "name":          name,
            "price":         price_data,
            "institutional": inst_data,
            "news_raw":      news_data,
            "insider_raw":   fetch_insider_filing(code)
        }
        print(f"    股價={price_data.get('price','—')}  新聞={len(news_data)}條")

    # 儲存原始資料
    out_path = REPORTS_DIR / f"{TODAY}_raw.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(raw, f, ensure_ascii=False, indent=2)
    print(f"\n原始資料已儲存：{out_path}")

    # 更新 index.json（加入今天日期）
    update_index()
    print("index.json 已更新")
    print("=== 完成 ===")


def update_index():
    idx_path = REPORTS_DIR / "index.json"
    if idx_path.exists():
        with open(idx_path, encoding="utf-8") as f:
            idx = json.load(f)
    else:
        idx = {"dates": [], "latest": ""}

    dates = idx.get("dates", [])
    if TODAY not in dates:
        dates.append(TODAY)
        dates.sort()
    idx["dates"]  = dates
    idx["latest"] = dates[-1]

    with open(idx_path, "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    main()
