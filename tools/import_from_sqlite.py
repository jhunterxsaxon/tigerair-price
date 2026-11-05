# -*- coding: utf-8 -*-
"""把 1151022s 累積的 SQLite 歷史匯入本專案的 JSON 格式。

為什麼要做：那邊從 2026-10-29 一點一滴存了三萬多筆歷史，
砍掉就回不來了（官方 API 只給「現在」，不回溯）。
網頁上線第一天就有歷史，趨勢圖和「破紀錄」標示才有意義。

用法（在 1151022s-1 資料夾下）：
    python tools/import_from_sqlite.py
    python tools/import_from_sqlite.py --db ../1151022s/data/prices.db
"""
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from core import store
from core.fetcher import TW_STATIONS

DEFAULT_DB = os.path.join(os.path.dirname(os.path.dirname(
    os.path.dirname(os.path.abspath(__file__)))), "1151022s", "data", "prices.db")


def tw_of(origin, destination):
    """這筆資料算在哪個台灣站底下（去程看 origin、回程看 destination）。"""
    if origin in TW_STATIONS:
        return origin
    if destination in TW_STATIONS:
        return destination
    return None


def skip(o, d):
    return o.startswith("XX") or d.startswith("XX")


def main():
    db_path = DEFAULT_DB
    if "--db" in sys.argv:
        db_path = sys.argv[sys.argv.index("--db") + 1]
    if not os.path.exists(db_path):
        print(f"[X] 找不到資料庫：{db_path}")
        return 1
    print(f"來源：{db_path}")
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row

    # ---- 目前價格 ----
    cur = {st: [] for st in TW_STATIONS}
    updated = ""
    for r in con.execute("SELECT * FROM price_current ORDER BY origin, destination, pricing_date"):
        o, d = r["origin"], r["destination"]
        if skip(o, d):
            continue
        st = tw_of(o, d)
        if not st:
            continue
        cur[st].append((o, d, r["pricing_date"], float(r["amount"]),
                        (r["src_updated"] or "")[:16]))
        updated = max(updated, r["fetched_at"] or "")
    for st, rows in cur.items():
        if rows:
            store.save_latest(st, rows, updated or store.now_tw())
            print(f"  latest/{st}.json　{len(rows):,} 筆")

    # ---- 變動歷史（依抓取時間分批，正好對應新格式的 batches）----
    hist = {}           # (站, 月) -> {at: [rows]}
    total = 0
    for r in con.execute("SELECT * FROM price_history "
                         "ORDER BY fetched_at, origin, destination, pricing_date"):
        o, d = r["origin"], r["destination"]
        if skip(o, d):
            continue
        st = tw_of(o, d)
        if not st:
            continue
        at = (r["fetched_at"] or "")[:19]
        if not at:
            continue
        key = (st, at[:7])
        hist.setdefault(key, {}).setdefault(at, []).append(
            (o, d, r["pricing_date"], float(r["amount"])))
        total += 1
    con.close()

    for (st, month), batches in sorted(hist.items()):
        # append_history 一次寫一批，照時間順序逐批寫入
        for at in sorted(batches):
            store.append_history(st, batches[at], at)
        n = sum(len(v) for v in batches.values())
        print(f"  history/{st}/{month}.json　{n:,} 筆（{len(batches)} 批）")

    meta = store.load_meta()
    routes = set()
    for rows in cur.values():
        for o, d, *_ in rows:
            routes.add((o, d))
    meta["routes"] = sorted(list(r) for r in routes)
    rc = {}
    for rows in cur.values():
        for o, d, *_ in rows:
            rc[o + "|" + d] = rc.get(o + "|" + d, 0) + 1
    meta["route_counts"] = rc
    meta["counts"] = {st: len(rows) for st, rows in cur.items() if rows}
    meta["total_rows"] = sum(len(r) for r in cur.values())
    meta["updated"] = updated or store.now_tw()
    first_at = min((at for b in hist.values() for at in b), default="")
    meta["history_since"] = first_at
    meta["imported_from"] = "1151022s/data/prices.db"
    meta["history_months"] = {st: store.history_months(st)
                              for st in TW_STATIONS
                              if store.history_months(st)}
    store.save_meta(meta)

    print(f"\n完成：目前價格 {meta['total_rows']:,} 筆、歷史 {total:,} 筆、"
          f"航線 {len(routes)} 條，歷史起點 {first_at}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
