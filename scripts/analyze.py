"""
投資情報雷達 — AI 分析腳本
讀取今日 JSON，用 Gemini 判斷每支股票的關注等級
"""

import json
import os
import time
import datetime
import requests
from pathlib import Path

BASE        = Path(__file__).parent.parent
REPORTS_DIR = BASE / "data" / "reports"
TZ_OFFSET   = datetime.timezone(datetime.timedelta(hours=8))
TODAY       = datetime.datetime.now(TZ_OFFSET).date().isoformat()

GEMINI_KEY = os.environ.get("GEMINI_API_KEY", "")
GEMINI_URL = (
    "https://generativelanguage.googleapis.com/v1beta/models/"
    f"gemini-2.0-flash:generateContent?key={GEMINI_KEY}"
)

SIGNAL_TYPES_TW = [
    "法說前", "法說後", "財報佳", "財報差", "外資買超", "外資賣超",
    "投信買超", "重大訊息", "題材炒作", "技術突破", "技術破位",
    "供應鏈消息", "突發利多", "突發利空", "無特殊"
]
SIGNAL_TYPES_US = [
    "Earnings前", "Earnings後", "財報佳", "財報差",
    "題材炒作", "技術突破", "技術破位",
    "供應鏈消息", "突發利多", "突發利空", "無特殊"
]


def analyze_stock(code: str, data: dict) -> dict:
    name       = data.get("name", code)
    market     = data.get("market", "TW")
    is_us      = market in ("NASDAQ", "NYSE")
    price_info = data.get("price", {})
    inst_info  = data.get("institutional", {})
    news_list  = data.get("news", [])

    pct    = price_info.get("change_pct", 0)
    f_net  = inst_info.get("foreign_net", None)
    t_net  = inst_info.get("trust_net", None)

    news_text = "\n".join(
        f"- [{n.get('source','')}] {n.get('title','')}" for n in news_list[:10]
    ) or "（今日無新聞）"

    if is_us:
        signal_types = SIGNAL_TYPES_US
        inst_text    = "（美股無三大法人揭露）"
        role         = "美股投資分析師"
        currency     = "USD"
    else:
        signal_types = SIGNAL_TYPES_TW
        inst_text = ""
        if f_net is not None:
            inst_text += f"外資買賣超：{f_net:+}張  "
        if t_net is not None:
            inst_text += f"投信買賣超：{t_net:+}張"
        role     = "台股投資分析師"
        currency = "NTD"

    prompt = f"""你是{role}。請根據以下資訊，評估今天是否需要特別關注此個股。

股票：{code} {name}（{currency}計價）
今日漲跌：{pct:+.2f}%
{inst_text}

今日相關新聞：
{news_text}

請用繁體中文回傳 JSON（只回 JSON，不要其他文字）：
{{
  "attention_score": 整數1~5（1=無特殊，3=值得注意，5=今日必看），
  "signal_type": 從此清單選最符合的一項：{signal_types},
  "attention_reason": "30字以內，說明今天最值得關注的具體原因（若無特殊則說明近況）",
  "news_summary": "40字以內，今日新聞重點整理"
}}"""

    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.1, "maxOutputTokens": 400},
    }

    try:
        r    = requests.post(GEMINI_URL, json=payload, timeout=25)
        text = r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
        # 移除 markdown code block
        text = text.lstrip("```json").lstrip("```").rstrip("```").strip()
        result = json.loads(text)
        # 確保欄位存在
        return {
            "attention_score":  int(result.get("attention_score", 1)),
            "signal_type":      str(result.get("signal_type", "無特殊")),
            "attention_reason": str(result.get("attention_reason", "")),
            "news_summary":     str(result.get("news_summary", "")),
        }
    except Exception as e:
        print(f"  [WARN] Gemini 分析失敗 {code}: {e}")
        return {
            "attention_score":  1,
            "signal_type":      "無特殊",
            "attention_reason": "（AI分析失敗）",
            "news_summary":     "",
        }


def main():
    if not GEMINI_KEY:
        print("[SKIP] 未設定 GEMINI_API_KEY，跳過 AI 分析")
        return

    report_path = REPORTS_DIR / f"{TODAY}.json"
    if not report_path.exists():
        print(f"[ERROR] 找不到今日資料：{report_path}")
        return

    report = json.loads(report_path.read_text(encoding="utf-8"))
    stocks = report.get("stocks", {})

    print(f"=== AI 分析開始：{len(stocks)} 支個股 ===")

    top_attention = []
    for code, data in stocks.items():
        name = data.get("name", code)
        print(f"  分析 {code} {name}...")
        result = analyze_stock(code, data)
        data.update(result)
        print(f"    評分={result['attention_score']}  類型={result['signal_type']}")
        if result["attention_score"] >= 4:
            top_attention.append((code, result["attention_score"]))
        time.sleep(1)  # 避免 API rate limit

    # 依評分排序
    top_attention.sort(key=lambda x: -x[1])
    report["top_attention"] = [code for code, _ in top_attention]
    report["analyzed_at"]   = datetime.datetime.now(TZ_OFFSET).strftime("%Y-%m-%dT%H:%M")

    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n✓ AI 分析完成，今日特別關注：{report['top_attention'] or ['無']}")
    print("=== 分析完成 ===")


if __name__ == "__main__":
    main()
