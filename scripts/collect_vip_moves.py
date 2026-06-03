"""
投資情報雷達 — VIP 投資動向追蹤
追蹤：巴菲特、黃仁勳、川普、魏哲家
每次 Actions 更新時執行，存入 data/vip_moves.json
標題全部翻譯為繁體中文（Gemini 批次翻譯）
"""

import json
import os
import re
import datetime
import email.utils
import feedparser
import requests
from pathlib import Path
from urllib.parse import quote

BASE      = Path(__file__).parent.parent
DATA_DIR  = BASE / "data"
TZ_OFFSET = datetime.timezone(datetime.timedelta(hours=8))
NOW       = datetime.datetime.now(TZ_OFFSET)
TODAY     = NOW.date().isoformat()

GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    f"gemini-2.5-flash:generateContent?key={GEMINI_KEY}"
)

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
    {
        "id":    "su",
        "name":  "蘇姿丰",
        "title": "AMD CEO",
        "icon":  "🔴",
        "queries_tw": ["蘇姿丰 AMD 持股 申報 股票"],
        "queries_en": [
            "Lisa Su AMD insider transaction stock 2026",
            "Lisa Su AMD investment stock sale 2026",
        ],
    },
    {
        "id":    "musk",
        "name":  "馬斯克",
        "title": "Tesla / SpaceX / X",
        "icon":  "🚀",
        "queries_tw": ["馬斯克 特斯拉 持股 賣出 申報 股票"],
        "queries_en": [
            "Elon Musk Tesla TSLA stock sale SEC filing 2026",
            "Elon Musk investment holdings 2026",
        ],
    },
]


# ── 判斷標題是否需要翻譯（無中文字元視為英文）──────────────────
def _needs_translation(title: str) -> bool:
    return not re.search(r"[一-鿿㐀-䶿]", title)


# ── Gemini 批次翻譯 ────────────────────────────────────────────
def translate_titles(titles: list[str]) -> list[str]:
    """輸入英文標題清單，回傳繁體中文翻譯清單（等長）"""
    if not GEMINI_KEY or not titles:
        return titles

    numbered = "\n".join(f"{i+1}. {t}" for i, t in enumerate(titles))
    prompt = (
        "以下是新聞標題，請翻譯成繁體中文（台灣用語）。\n"
        "規則：\n"
        "1. 保留公司名稱、人名、股票代號不翻譯（如 Berkshire、NVDA、DJT）\n"
        "2. 每行一個翻譯，格式為「序號. 翻譯內容」，不加任何說明\n"
        "3. 保持簡潔，符合新聞標題風格\n\n"
        f"{numbered}"
    )
    try:
        r = requests.post(
            GEMINI_URL,
            json={"contents": [{"parts": [{"text": prompt}]}]},
            timeout=30,
        )
        text = r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
        result = []
        for line in text.splitlines():
            m = re.match(r"^\d+\.\s*(.+)$", line.strip())
            if m:
                result.append(m.group(1).strip())
        if len(result) == len(titles):
            return result
        print(f"  [WARN] 翻譯行數不符：預期 {len(titles)}，得到 {len(result)}")
    except Exception as e:
        print(f"  [WARN] Gemini 翻譯失敗：{e}")
    return titles  # 失敗時回傳原文


# ── 對全部 VIP 新聞進行批次翻譯 ───────────────────────────────
def translate_all_vips(vips: dict) -> None:
    """就地（in-place）翻譯所有 VIP 新聞標題"""
    # 收集需要翻譯的標題索引
    to_translate = []  # list of (vip_id, news_index, original_title)
    for vip_id, vdata in vips.items():
        for i, news in enumerate(vdata.get("news", [])):
            if _needs_translation(news["title"]):
                to_translate.append((vip_id, i, news["title"]))

    if not to_translate:
        print("  所有標題已是中文，跳過翻譯")
        return

    print(f"  翻譯 {len(to_translate)} 則英文標題...")
    originals  = [t[2] for t in to_translate]
    translated = translate_titles(originals)

    for (vip_id, news_idx, _), new_title in zip(to_translate, translated):
        vips[vip_id]["news"][news_idx]["title"] = new_title

    print("  翻譯完成")


# ── RSS 解析 ──────────────────────────────────────────────────
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
    all_news    = []
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

    # 批次翻譯所有英文標題
    translate_all_vips(result["vips"])

    out_path = DATA_DIR / "vip_moves.json"
    out_path.write_text(
        json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(f"[OK] 儲存完成：{out_path}")
    print("=== VIP 追蹤完成 ===")


if __name__ == "__main__":
    main()
