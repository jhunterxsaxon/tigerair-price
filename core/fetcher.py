# -*- coding: utf-8 -*-
"""抓取虎航官方票價 API —— **純標準庫版本**（給 GitHub Actions 用）。

和 1151022s 的差別：那邊用 Playwright 的 request context（因為當時是從瀏覽器
探測出這支 API 的，順手就沿用了）。2026-11-02 實測確認：這支 API
**連 header 都不用帶**，`urllib` 直接打就回 200，0.5 秒拿到 48KB。

對 GitHub Actions 來說這是關鍵差別：
  * 純 urllib → runner 不必 pip install 任何東西，整個 job 10 秒內跑完
  * Playwright → 每次都要下載 ~150MB 的 Chromium，多花 1~2 分鐘

還是會帶 referer 和 UA：禮貌性表明身分，也和官網自己的請求長得一樣，
比較不會被當成異常流量。
"""
import gzip
import io
import json
import time
import urllib.error
import urllib.request

API = "https://api-book.tigerairtw.com/api/cms/station-daily-prices/{station}/{currency}"
REFERER = "https://www.tigerairtw.com/"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36")

# 台灣四個出發站。抓這四站就涵蓋全部航線——虎航所有航線都是台灣進出，
# 而且抓 TPE 會同時帶回「從 TPE 出發」與「飛往 TPE」兩個方向。
TW_STATIONS = ["TPE", "KHH", "RMQ", "TNN"]


def fetch_station(station, currency="TWD", timeout=60, retry=2):
    """抓一個出發站的全部每日最低價。回傳 (rows, error)。

    rows 是 API 原樣的 dict list：
        {origin, destination, pricingCurrency, pricingDate, pricingAmount, updatedAt}
    """
    url = API.format(station=station, currency=currency)
    headers = {"User-Agent": UA, "referer": REFERER,
               "Accept": "application/json", "Accept-Encoding": "gzip"}
    last = ""
    for attempt in range(retry + 1):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                raw = resp.read()
                if resp.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.GzipFile(fileobj=io.BytesIO(raw)).read()
                data = json.loads(raw.decode("utf-8"))
            rows = data if isinstance(data, list) else (data.get("data") or [])
            if not rows:
                last = "回應裡沒有資料"
            else:
                return rows, ""
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
        except Exception as e:                      # 連線逾時、JSON 壞掉等
            last = f"{type(e).__name__}: {e}"
        if attempt < retry:
            time.sleep(3 * (attempt + 1))           # 退避重試，不要連續猛打
    return [], last


def tw_of(origin, destination):
    """這條航線算在哪個台灣站底下（去程看 origin、回程看 destination）。"""
    if origin in TW_STATIONS:
        return origin
    if destination in TW_STATIONS:
        return destination
    return ""


def dedupe(rows):
    """同一組合（航線＋出發日）只保留 updatedAt 最新的那一筆。

    官方 API 會回重複資料，其中一筆是過期價格（2026-10-29 那份 16,746 筆裡有 10 組）。
    照單全收會讓「目前價格」被舊值蓋掉，下一次抓取又被判定成價格變動，
    歷史就會出現一來一回的**假波動**。這個 bug 在 1151022s 吃過一次虧，別再犯。
    """
    best = {}
    for r in rows:
        key = (r.get("origin"), r.get("destination"), r.get("pricingDate"))
        old = best.get(key)
        if old is None or (r.get("updatedAt") or "") > (old.get("updatedAt") or ""):
            best[key] = r
    return list(best.values())


def normalize(rows):
    """把 API 的原始格式轉成程式內部用的 tuple：
    (origin, destination, pricing_date, amount, src_updated)

    順便濾掉 XX 開頭的**城市群組代碼**（如 XX2 北海道）：
    實測群組價與個別機場不同步（XX2 只有 83% 的日子等於札幌/函館的較低者，
    韓國 XX4 更只有 40%），訂票看的是個別機場，群組價留著只會誤導。
    """
    out = []
    for r in dedupe(rows):
        o, d = r.get("origin") or "", r.get("destination") or ""
        if not o or not d or o.startswith("XX") or d.startswith("XX"):
            continue
        try:
            amount = float(r.get("pricingAmount") or 0)
        except (TypeError, ValueError):
            continue
        if amount <= 0:
            continue
        date = (r.get("pricingDate") or "")[:10]
        if len(date) != 10:
            continue
        out.append((o, d, date, amount, (r.get("updatedAt") or "")[:16]))
    out.sort()
    return out
