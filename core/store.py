# -*- coding: utf-8 -*-
"""JSON 資料存取（取代 1151022s 的 SQLite）。

為什麼不用 SQLite：GitHub Pages 只會送靜態檔，網頁端沒辦法查資料庫。
改成 JSON，Actions 寫、網頁直接 fetch 讀。

檔案配置
--------
data/latest/TPE.json        TPE 進出所有航線的「目前價格」（每次覆寫）
data/history/TPE/2026-11.json   TPE 的價格**變動**紀錄，一個月一檔（append）
data/meta.json              最後更新時間、站名、航線清單、抓取紀錄

三個刻意的設計
--------------
1. **只存變動**：每次抓回來 2.7 萬筆，全存的話一年上千萬筆。
   實測一天的變動量只有 1,500 筆左右，所以 history 只記「價格和上次不同」的。
2. **一列一行**：JSON 寫成每筆資料獨占一行。compact 單行檔每次更新會讓整個
   檔案變成一行 diff，git 存不了 delta、repo 很快就肥；一列一行後
   git 只會記下真正變動的那幾行。
3. **同一次抓取的時間戳只存一次**：history 以「一次抓取」為單位分組，
   不在每筆資料上重複寫 fetched_at，省掉大量重複字串。
"""
import json
import os
from datetime import datetime, timedelta, timezone

_HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(_HERE)
DATA = os.path.join(ROOT, "data")

TW = timezone(timedelta(hours=8))          # 一律用台灣時間，Actions 跑在 UTC
LATEST_FIELDS = ["origin", "destination", "date", "amount", "src_updated"]
HIST_FIELDS = ["origin", "destination", "date", "amount"]
LOWS_FIELDS = ["origin", "destination", "date", "low", "n", "at_index"]


def now_tw():
    return datetime.now(TW).strftime("%Y-%m-%d %H:%M:%S")


def _read(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def _write_rows(path, head, rows):
    """寫出 {...head, "rows":[...]}，rows 每筆一行（git diff 友善）。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    parts = ["{"]
    for k, v in head.items():
        parts.append(f"{json.dumps(k, ensure_ascii=False)}: "
                     f"{json.dumps(v, ensure_ascii=False)},")
    parts.append('"rows": [')
    body = [json.dumps(r, ensure_ascii=False, separators=(",", ":")) for r in rows]
    parts.append(",\n".join(body))
    parts.append("]}")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(parts) + "\n")
    os.replace(tmp, path)                   # 原子寫入，中途失敗不會留下半個檔


# ---------------- 目前價格 ----------------
def latest_path(station):
    return os.path.join(DATA, "latest", f"{station}.json")


def load_latest(station):
    """回傳 {(origin, destination, date): (amount, src_updated)}"""
    d = _read(latest_path(station), None)
    out = {}
    if not d:
        return out
    for r in d.get("rows", []):
        if len(r) >= 4:
            out[(r[0], r[1], r[2])] = (r[3], r[4] if len(r) > 4 else "")
    return out


def save_latest(station, rows, updated):
    """rows：normalize() 產生的 (o, d, date, amount, src) list。"""
    _write_rows(latest_path(station),
                {"station": station, "updated": updated,
                 "currency": "TWD", "fields": LATEST_FIELDS},
                [list(r) for r in rows])


# ---------------- 價格變動歷史 ----------------
def history_path(station, month):
    return os.path.join(DATA, "history", station, f"{month}.json")


def append_history(station, changes, at):
    """把這一次抓到的變動（o, d, date, amount）記成一個批次。"""
    if not changes:
        return 0
    month = at[:7]
    path = history_path(station, month)
    old = _read(path, {}) or {}
    batches = old.get("batches", [])
    batches.append({"at": at, "n": len(changes),
                    "rows": [list(c) for c in changes]})
    # batches 自己有巢狀 rows，不走 _write_rows，改手工排版維持一列一行
    os.makedirs(os.path.dirname(path), exist_ok=True)
    parts = ['{"station": %s, "month": %s, "fields": %s,' % (
        json.dumps(station), json.dumps(month),
        json.dumps(HIST_FIELDS, ensure_ascii=False)), '"batches": [']
    blocks = []
    for b in batches:
        body = ",\n".join(json.dumps(r, ensure_ascii=False,
                                     separators=(",", ":")) for r in b["rows"])
        blocks.append('{"at": %s, "n": %d, "rows": [\n%s\n]}'
                      % (json.dumps(b["at"]), b.get("n", len(b["rows"])), body))
    parts.append(",\n".join(blocks))
    parts.append("]}")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(parts) + "\n")
    os.replace(tmp, path)
    return len(changes)


def diff_changes(old, rows):
    """找出價格和上次不同的（含這次才出現的新航線/新日期）。"""
    changes = []
    for o, d, date, amount, _src in rows:
        prev = old.get((o, d, date))
        if prev is None or prev[0] != amount:
            changes.append((o, d, date, amount))
    return changes


def history_months(station):
    """這個站有哪幾個月的歷史檔（網頁靠 meta 裡的這份清單決定要載哪些檔）。"""
    d = os.path.join(DATA, "history", station)
    try:
        return sorted(f[:-5] for f in os.listdir(d) if f.endswith(".json"))
    except OSError:
        return []


# ---------------- 歷史最低（預先算好給網頁用） ----------------
def lows_path(station):
    return os.path.join(DATA, "lows", f"{station}.json")


def build_lows(station, rows):
    """掃過這一站的全部歷史，算出每個（航線＋出發日）的歷史最低價、紀錄筆數，
    以及最低價是哪一次抓到的。回傳 (ats, lows)。

    **為什麼要先算好：** 網頁本來是把整站的歷史全部載下來自己算，
    而歷史是會隨時間無限成長的（估半年 10～15 MB、約 50 萬列），
    手機上光 JSON.parse 加建索引就會卡住。

    這個檔的列數等於 latest 的列數——航線數×出發日數是固定的，
    **不隨累積時間成長**，所以網頁不管跑幾年都一樣快。

    時間戳不寫在每一列：同一輪抓取共用一個時間，改成 ats 清單＋索引，
    省掉上萬次重複（一年的時間戳也才約 1,100 個）。
    """
    live = set((o, d, date) for o, d, date, _amount, _src in rows)
    best = {}
    for month in history_months(station):
        data = _read(history_path(station, month), {}) or {}
        for b in data.get("batches", []):
            at = b.get("at", "")
            for r in b.get("rows", []):
                if len(r) < 4:
                    continue
                key = (r[0], r[1], r[2])
                if key not in live:     # 已經不賣的組合不必留在查詢用的檔裡
                    continue
                cur = best.get(key)
                if cur is None:
                    best[key] = [r[3], 1, at]
                else:
                    cur[1] += 1
                    if r[3] < cur[0]:   # 同價時保留較早的那次，和 GUI 版一致
                        cur[0] = r[3]
                        cur[2] = at
    ats = sorted(set(v[2] for v in best.values()))
    idx = {a: i for i, a in enumerate(ats)}
    lows = [[k[0], k[1], k[2], v[0], v[1], idx[v[2]]]
            for k, v in sorted(best.items())]
    return ats, lows


def save_lows(station, rows, updated):
    ats, lows = build_lows(station, rows)
    path = lows_path(station)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    parts = ['{"station": %s, "updated": %s, "fields": %s,'
             % (json.dumps(station), json.dumps(updated),
                json.dumps(LOWS_FIELDS, ensure_ascii=False)),
             '"ats": [',
             ",\n".join(json.dumps(a) for a in ats),
             '],',
             '"rows": [',
             ",\n".join(json.dumps(r, ensure_ascii=False,
                                   separators=(",", ":")) for r in lows),
             ']}']
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(parts) + "\n")
    os.replace(tmp, path)
    return len(lows)


# ---------------- meta ----------------
def meta_path():
    return os.path.join(DATA, "meta.json")


def load_meta():
    return _read(meta_path(), {})


def save_meta(meta):
    os.makedirs(DATA, exist_ok=True)
    tmp = meta_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1, sort_keys=True)
        f.write("\n")
    os.replace(tmp, meta_path())
