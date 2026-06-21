"""
收盤市值更新
台股：台灣時間 13:40（收盤後）；美股：台灣時間 05:30（美股收盤後）
抓現價（Yahoo Finance，台股美股通用、免 token）→ 更新「台股庫存／美股庫存」現價欄
（市值 H=股數×現價 為公式，自動重算）→ 蓋更新時間戳
"""
import os
import json
import datetime
import time
import requests
import gspread
from google.oauth2.service_account import Credentials

SHEET_ID = "176WPGDd1_PTZwaVKMdvWFVS5HnIvatvyWNniCrS_uoM"
TZ       = datetime.timezone(datetime.timedelta(hours=8))
NOW      = datetime.datetime.now(TZ)
SA_ENV   = os.environ.get("GOOGLE_SERVICE_ACCOUNT", "")
SA_FILE  = "D:/Claude Code/MCP/google-credentials/service-account.json"
SCOPES   = ["https://www.googleapis.com/auth/spreadsheets"]
HEADERS  = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}


def get_client():
    if SA_ENV.strip():
        creds = Credentials.from_service_account_info(json.loads(SA_ENV), scopes=SCOPES)
    else:
        creds = Credentials.from_service_account_file(SA_FILE, scopes=SCOPES)
    return gspread.authorize(creds)


def fetch_price(code, market):
    """Yahoo Finance 現價；台股試 .TW 再 .TWO，美股用原代號。失敗回 None"""
    if market == "TW":
        candidates = [code.upper() + ".TW", code.upper() + ".TWO"]
    else:
        candidates = [code.upper()]
    for yf in candidates:
        try:
            url = f"https://query1.finance.yahoo.com/v8/finance/chart/{yf}"
            data = requests.get(url, headers=HEADERS, timeout=12).json()
            result = (data.get("chart") or {}).get("result") or []
            if not result:
                continue
            price = result[0]["meta"].get("regularMarketPrice") or 0
            if price:
                return round(float(price), 2)
        except Exception as e:
            print(f"  [WARN] 取價失敗 {yf}: {e}")
    return None


def update_tab(sh, tab, market, nrows, stamp_cell):
    ws = sh.worksheet(tab)
    codes = ws.get(f"C2:C{1+nrows}")
    updated, skipped = 0, []
    for i, row in enumerate(codes):
        rownum = i + 2
        code = (row[0] if row else "").strip()
        if not code:
            continue
        price = fetch_price(code, market)
        if price is None:
            skipped.append(code)
            continue
        ws.update_acell(f"F{rownum}", price)  # 現價 → 市值欄公式自動算
        ws.update_acell(f"O{rownum}", NOW.date().isoformat())  # 更新日期
        print(f"  [{tab}] {code} 現價 = {price}")
        updated += 1
        time.sleep(0.4)
    stamp = NOW.strftime("%Y-%m-%d %H:%M")
    ws.update_acell(stamp_cell, f"市值最後更新：{stamp}（Yahoo 現價）")
    print(f"[OK] {tab}：更新 {updated} 檔，跳過 {skipped}")


def main():
    gc = get_client()
    sh = gc.open_by_key(SHEET_ID)
    update_tab(sh, "台股庫存", "TW", 10, "A14")
    update_tab(sh, "美股庫存", "US", 4, "A7")
    print(f"全部完成：{NOW.strftime('%Y-%m-%d %H:%M')}")


if __name__ == "__main__":
    main()
