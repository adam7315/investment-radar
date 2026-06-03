"""
投資情報雷達 — VIP 投資動向追蹤
追蹤：巴菲特、黃仁勳、川普、魏哲家
每次 Actions 更新時執行，存入 data/vip_moves.json
"""

import json
import datetime
import email.utils
import feedparser
from pathlib import Path
from urllib.parse import quote

BASE      = Path(__file__).parent.parent
DATA_DIR  = BASE / "data"
TZ_OFFSET = datetime.timezone(datetime.timedelta(hours=8))
NOW       = datetime.datetime.now(TZ_OFFSET)
TODAY     = NOW.date().isoformat()

VIP_CONFIG = [
    {
        "id":    "buffett",
        "name":  "巴菲特",
        "title": "Berkshire CEO",
        "icon":  "🏦",
        "queries_tw": ["巴菲特 買進 持股 投資 賣出"],
        "queries_en": [
            "Warren Buffett investment buys sells 2026",
            "Berkshire Hathaway portfolio changes 2026",
        ],
    },
    {
        "id":    "huang",
        "name":  "黃仁勳",
        "title": "NVIDIA CEO",
        "icon":  "🤖",
        "queries_tw": ["黃仁勳 股票 持股 申報 賣出"],
        "queries_en": [
            "Jensen Huang NVDA insider transaction 2026",
            "Jensen Huang stock sale SEC filing 2026",
        ],
    },
    {
        "id":    "trump",
        "name":  "川普",
        "title": "美國總統",
        "icon":  "🦅",
        "queries_tw": ["川普 投資 股票 DJT 持股 財務"],
        "queries_en": [
            "Trump DJT TMTG stock investment 2026",
            "Trump financial disclosure holdings 2026",
        ],
    },
    {
        "id":    "wei",
        "name":  "魏哲家",
        "title": "台積電 CEO",
        "icon":  "💎",
        "queries_tw": ["魏哲家 台積電 申報 持股 買進 賣出"],
        "queries_en": [
            "CC Wei TSMC insider transaction 2026",
        ],
    },
]


def parse_rss_date(entry):
    pub = entry.get("published") or entry.get("updated") or ""
    if not pub:
        return TODAY
    if len(pub) >= 10 and pub[4:5] == "-":
        return pub[:10]
    try:
        parsed = email.utils.parsedate_to_datetime(pub)
        return parsed.astimezone(TZ_OFFSET).date().isoformat()
    except Exception:
        pass
    return TODAY


def fetch_google_news(query, lang, gl, ceid, max_items=5):
    url = (
        f"https://news.google.com/rss/search"
        f"?q={quote(query)}&hl={lang}&gl={gl}&ceid={ceid}"
    )
    found = []
    try:
        feed = feedparser.parse(url)
        for entry in feed.entries[: max_items * 2]:
            title = entry.get("title", "").strip()
            link  = entry.get("link", "")
            if not title:
                continue
            found.append({
                "title":  title,
                "url":    link,
                "date":   parse_rss_date(entry),
                "source": "Google News",
            })
            if len(found) >= max_items:
                break
    except Exception as e:
        print(f"  [WARN] Google News 失敗 ({query[:30]}): {e}")
    return found


def collect_vip(vip):
    print(f"  [{vip['name']}] 搜尋中...")
    all_news   = []
    seen_titles = set()

    for q in vip.get("queries_tw", []):
        for item in fetch_google_news(q, "zh-TW", "TW", "TW:zh-Hant", max_items=5):
            if item["title"] not in seen_titles:
                seen_titles.add(item["title"])
                all_news.append(item)

    for q in vip.get("queries_en", []):
        for item in fetch_google_news(q, "en-US", "US", "US:en", max_items=5):
            if item["title"] not in seen_titles:
                seen_titles.add(item["title"])
                all_news.append(item)

    all_news.sort(key=lambda x: x.get("date", ""), reverse=True)
    print(f"    → {len(all_news)} 則新聞")

    return {
        "id":    vip["id"],
        "name":  vip["name"],
        "title": vip["title"],
        "icon":  vip["icon"],
        "news":  all_news[:8],
    }


def main():
    print(f"=== VIP 投資動向追蹤 {NOW.strftime('%Y-%m-%dT%H:%M')} ===")
    result = {
        "updated_at": NOW.strftime("%Y-%m-%dT%H:%M"),
        "vips": {},
    }
    for vip in VIP_CONFIG:
        result["vips"][vip["id"]] = collect_vip(vip)

    out_path = DATA_DIR / "vip_moves.json"
    out_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"[OK] 儲存完成：{out_path}")
    print("=== VIP 追蹤完成 ===")


if __name__ == "__main__":
    main()
