"""
每日操作建議
台股：台灣 08:00（台股開盤前）　美股：台灣 20:30（美股開盤前）
讀「台股庫存／美股庫存」持股 + 最新 report 新聞 → Gemini（內嵌判斷框架）
→ 產生「買幾張/賣幾張+停損」→ 寫「每日建議紀錄」分頁（最新置頂）+ data/daily-advice.json
環境變數 ADVICE_MARKET = TW / US / ALL（預設 ALL）
"""
import os
import re
import json
import datetime
from pathlib import Path
import requests
import gspread
from google.oauth2.service_account import Credentials

BASE        = Path(__file__).parent.parent
REPORTS_DIR = BASE / "data" / "reports"
OUT_JSON    = BASE / "data" / "daily-advice.json"
SHEET_ID    = "176WPGDd1_PTZwaVKMdvWFVS5HnIvatvyWNniCrS_uoM"
TZ          = datetime.timezone(datetime.timedelta(hours=8))
NOW         = datetime.datetime.now(TZ)
GEMINI_KEY  = os.environ.get("GEMINI_API_KEY", "")
GEMINI_URL  = ("https://generativelanguage.googleapis.com/v1beta/models/"
               f"gemini-2.5-flash:generateContent?key={GEMINI_KEY}")
MARKET      = os.environ.get("ADVICE_MARKET", "ALL").upper()
SA_ENV      = os.environ.get("GOOGLE_SERVICE_ACCOUNT", "")
SA_FILE     = "D:/Claude Code/MCP/google-credentials/service-account.json"
SCOPES      = ["https://www.googleapis.com/auth/spreadsheets"]

TABS = {"TW": ("台股庫存", 10), "US": ("美股庫存", 4)}


def get_client():
    if SA_ENV.strip():
        creds = Credentials.from_service_account_info(json.loads(SA_ENV), scopes=SCOPES)
    else:
        creds = Credentials.from_service_account_file(SA_FILE, scopes=SCOPES)
    return gspread.authorize(creds)


def read_holdings(sh, market):
    tab, rows = TABS[market]
    ws = sh.worksheet(tab)
    data = ws.get(f"A2:K{1+rows}")
    out = []
    for r in data:
        r = r + [""] * (11 - len(r))
        if not r[1].strip():
            continue
        out.append({"name": r[1].strip(), "code": r[2].strip(), "shares": r[3],
                    "cost": r[4], "price": r[5], "pl": r[8], "roi": r[9], "be": r[10]})
    return out


def load_latest_report():
    try:
        idx = json.loads((REPORTS_DIR / "index.json").read_text(encoding="utf-8"))
        latest = idx.get("latest")
        rep = json.loads((REPORTS_DIR / f"{latest}.json").read_text(encoding="utf-8"))
        return latest, rep.get("stocks", {})
    except Exception as e:
        print(f"  [WARN] 讀 report 失敗: {e}")
        return None, {}


def build_prompt(market, holdings, stocks):
    lines = []
    for h in holdings:
        s = stocks.get(h["code"], {})
        news = "；".join(n.get("title", "") for n in s.get("news", [])[:3]) or "（無）"
        lines.append(f"- {h['name']}({h['code']}) 股數{h['shares']} 均價{h['cost']} "
                     f"現價{h['price']} 損益{h['pl']}({h['roi']}) 損益平衡{h['be']} "
                     f"| 近期：{s.get('attention_reason','')}｜{news}")
    unit = "台股以「張」為單位（1 張=1000 股），零股用「股」" if market == "TW" else "美股以「股」為單位"
    mkt  = "台股" if market == "TW" else "美股"
    return f"""你是專業的{mkt}操盤手，依「持股現況＋最新消息」給出開盤前的具體操作建議。

【我的判斷框架，務必遵守】
1. 催化劑分層：區分「已反映的已知催化劑」與「尚未定價的催化劑」；股價突破常是後者兌現。
2. 目標價不是天花板：給賣出建議時，若仍有未定價催化劑，不可單純因「到目標價」就全賣。
3. 賣出前先問：買進核心邏輯是否被否定？沒被否定的套牢不輕易停損。
4. 部位紀律：單一個股不超過該市場部位 2 成；不過度集中。
5. 重大財報前（記憶體/AI股）建議「觀望」，等財報表態。
6. {unit}。建議要具體可執行、保守為上；不確定就「續抱」或「觀望」。

【我的{mkt}持股】
{chr(10).join(lines)}

請回傳繁體中文 JSON（只回 JSON）：
{{
  "market_note": "30字內，開盤前大盤/操作節奏提醒",
  "items": [
    {{"code":"代號","name":"股票名稱","action":"買/賣/加碼/減碼/續抱/觀望/觀察 擇一",
      "qty":"如 1張 或 30股；續抱/觀望留空","price":"建議價格數字字串；無則空",
      "stop":"停損價數字字串；無則空","reason":"40字內理由"}}
  ]
}}
items 需涵蓋每一檔{mkt}持股。"""


def ask_gemini(prompt):
    payload = {"contents": [{"parts": [{"text": prompt}]}],
               "generationConfig": {"temperature": 0.2, "maxOutputTokens": 4096,
                                    "thinkingConfig": {"thinkingBudget": 0}}}
    r = requests.post(GEMINI_URL, json=payload, timeout=60)
    text = r.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
    text = re.sub(r'^```(?:json)?\s*', '', text)
    text = re.sub(r'\s*```$', '', text).strip()
    return json.loads(text)


def write_sheet(sh, items, date_str, src):
    ws = sh.worksheet("每日建議紀錄")
    rows = [[date_str, it.get("name", ""), it.get("code", ""), it.get("price_now", ""),
             it.get("action", ""), it.get("qty", ""), it.get("price", ""),
             it.get("stop", ""), it.get("reason", ""), src, ""] for it in items]
    if not rows:
        return
    ws.insert_rows(rows, row=2, value_input_option="USER_ENTERED")
    try:
        ws.format(f"A2:K{1+len(rows)}", {"horizontalAlignment": "CENTER",
                  "verticalAlignment": "MIDDLE", "wrapStrategy": "WRAP"})
    except Exception as e:
        print(f"  [WARN] 套格式失敗: {e}")


def process(sh, market, stocks):
    holdings = read_holdings(sh, market)
    print(f"[{market}] 讀到 {len(holdings)} 檔持股")
    result = ask_gemini(build_prompt(market, holdings, stocks))
    items = result.get("items", [])
    pmap = {h["code"]: h["price"] for h in holdings}
    for it in items:
        it["price_now"] = pmap.get(it.get("code", ""), "")
        it["market"] = market
    src = f"GitHub Actions(Gemini)-{'台股08:00' if market=='TW' else '美股20:30'}"
    write_sheet(sh, items, NOW.date().isoformat(), src)
    return {"updated_at": NOW.strftime("%Y-%m-%d %H:%M"),
            "date": NOW.date().isoformat(),
            "market_note": result.get("market_note", ""), "items": items}


def main():
    if not GEMINI_KEY:
        print("[SKIP] 無 GEMINI_API_KEY")
        return
    gc = get_client()
    sh = gc.open_by_key(SHEET_ID)
    _, stocks = load_latest_report()

    # 載入既有 JSON，只更新對應市場區塊
    blob = {}
    if OUT_JSON.exists():
        try:
            blob = json.loads(OUT_JSON.read_text(encoding="utf-8"))
        except Exception:
            blob = {}

    markets = ["TW", "US"] if MARKET == "ALL" else [MARKET]
    for m in markets:
        blob[m.lower()] = process(sh, m, stocks)
        print(f"[OK] [{m}] 完成 {len(blob[m.lower()]['items'])} 檔")

    OUT_JSON.write_text(json.dumps(blob, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"全部完成：{NOW.strftime('%Y-%m-%d %H:%M')}  市場={markets}")


if __name__ == "__main__":
    main()
