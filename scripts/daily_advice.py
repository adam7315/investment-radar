"""
每日操作建議
台股：台灣 08:00（台股開盤前）　美股：台灣 20:30（美股開盤前）
讀「台股庫存／美股庫存」持股 + 最新 report 新聞 → Gemini（內嵌判斷框架）
→ 產生「買幾張/賣幾張+停損」→ 寫「每日建議紀錄」分頁（最新置頂）+ data/daily-advice.json
環境變數 ADVICE_MARKET = TW / US / ALL（預設 ALL）
"""
import os
import re
import time
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

TABS = {"TW": "台股庫存", "US": "美股庫存"}


def get_client():
    if SA_ENV.strip():
        creds = Credentials.from_service_account_info(json.loads(SA_ENV), scopes=SCOPES)
    else:
        creds = Credentials.from_service_account_file(SA_FILE, scopes=SCOPES)
    return gspread.authorize(creds)


def read_holdings(sh, market):
    """動態讀取全部持股：從第2列讀到「合計」或空白為止，不再寫死筆數。
    買新股 → 自動納入；某檔賣到 0 股（移除列或股數=0）→ 自動不給建議。"""
    ws = sh.worksheet(TABS[market])
    data = ws.get("A2:K60")
    out = []
    for r in data:
        r = r + [""] * (11 - len(r))
        a, name = str(r[0]).strip(), str(r[1]).strip()
        if a == "合計" or a.startswith("市值最後更新"):
            break
        if not name:
            continue
        try:
            shares = float(str(r[3]).replace(",", "") or 0)
        except ValueError:
            shares = 0
        if shares == 0:
            continue  # 已無持股，不給建議
        out.append({"name": name, "code": r[2].strip(), "shares": r[3],
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
    return f"""你是 Adam 的專屬{mkt}操盤手，要拿出資深分析師等級的判斷力，給出開盤前可以直接執行的操作建議。

【第一步：先上網查最新消息】
針對下面每一檔持股，務必用 Google 搜尋查「最近 1~3 天」的即時消息：法說會、財報、外資/投信買賣超、內部人申報、訂單與題材、分析師目標價調整。不要只靠系統摘要（那可能過時），一定要找到當下的催化劑再下判斷。

【Adam 的判斷框架，務必嚴格遵守】
1. 催化劑分層：把催化劑分成「已反映的已知催化劑」與「尚未定價的催化劑」；股價突破常是後者兌現。每檔都要判斷現在還有沒有未定價催化劑。
2. 目標價不是天花板：到了分析師目標價，若仍有未定價催化劑，不可單純因「到價」就建議全賣。目標價是起點不是終點。
3. 賣出決策：賣出前先問「買進核心邏輯是否被否定？未定價催化劑是否已全兌現？內部人是否申報賣出？」核心邏輯沒被否定的套牢不輕易停損。
4. 內部人/籌碼：大股東「主動加碼」（非股利再投資）是強訊號，權重高於外資買超；閉鎖型家族公司加碼意義最大。
5. 部位紀律：單一個股不超過該市場部位 2 成，不過度集中。
6. 重大財報前（記憶體/AI 股）可「觀望」等財報表態，但要寫明等哪一場財報、大約哪一天。

【決斷力要求──這是重點，違反就是失職】
- 不准全部寫「續抱」交差。每一檔都要依查到的即時催化劑給出明確判斷。
- 只要有明確催化劑或籌碼訊號，就要給可執行動作：買／賣／加碼／減碼。
- 凡是「買／賣／加碼／減碼」，qty（張數或股數）、price（進出場價）、stop（停損價）三者都必須填，不可留空。
- 真的沒有動作才用「續抱／觀望／觀察」，且 reason 要寫明「為什麼現在不動、要等什麼訊號或哪一天」。
- reason 要具體點出催化劑或籌碼，不准寫「核心邏輯未變」「趨勢向上」這種空話。
- {unit}。

【Adam 的{mkt}持股】
{chr(10).join(lines)}

只輸出繁體中文 JSON，不要任何其他文字、不要 markdown 圍欄：
{{
  "market_note": "30字內，開盤前大盤與操作節奏提醒",
  "items": [
    {{"code":"代號","name":"股票名稱","action":"買/賣/加碼/減碼/續抱/觀望/觀察 擇一",
      "qty":"如 1張 或 30股；續抱/觀望類留空","price":"建議價格數字字串；無則空",
      "stop":"停損價數字字串；無則空","reason":"45字內，必須點出具體催化劑或籌碼訊號"}}
  ]
}}
items 需涵蓋每一檔{mkt}持股，順序同上。"""


def ask_gemini(prompt, retries=3):
    # 開啟 Google Search grounding（查即時催化劑）+ 讓模型思考（不再 thinkingBudget=0）
    payload = {"contents": [{"parts": [{"text": prompt}]}],
               "tools": [{"google_search": {}}],
               "generationConfig": {"temperature": 0.3, "maxOutputTokens": 8192}}
    last_err = None
    for attempt in range(1, retries + 1):
        try:
            r = requests.post(GEMINI_URL, json=payload, timeout=120)
            data = r.json()
            if "candidates" not in data:
                raise RuntimeError(f"無 candidates：{str(data.get('error', data))[:200]}")
            parts = data["candidates"][0].get("content", {}).get("parts", [])
            text = "".join(p.get("text", "") for p in parts if "text" in p).strip()
            if not text:
                raise RuntimeError("回應為空")
            text = re.sub(r'^```(?:json)?\s*', '', text)
            text = re.sub(r'\s*```$', '', text).strip()
            # grounding 可能夾帶說明文字，擷取第一個 { 到最後一個 }
            m = re.search(r'\{.*\}', text, re.S)
            if m:
                text = m.group(0)
            return json.loads(text)
        except Exception as e:
            last_err = e
            print(f"  [WARN] Gemini 第 {attempt} 次失敗：{e}")
            if attempt < retries:
                time.sleep(8 * attempt)
    raise RuntimeError(f"Gemini 連 {retries} 次失敗：{last_err}")


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
