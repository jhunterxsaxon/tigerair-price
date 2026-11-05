# -*- coding: utf-8 -*-
"""抓取虎航票價並更新 data/ 下的 JSON —— GitHub Actions 每次排程就跑這支。

用法：
    python fetch.py                # 抓台灣四站
    python fetch.py TPE KHH        # 只抓指定的站
    python fetch.py --dry-run      # 只抓不寫檔（驗證用）

設計原則：
* **任何一站失敗都不中斷**，其餘照抓；失敗記在 meta.json 的 fetch_log，
  網頁上看得到「上次有沒有抓成功」。
* 全部失敗時以 exit code 1 結束，GitHub 才會把那次排程標成紅色（才會知道壞了）。
* 連線次數：一次執行 = 站數（預設 4 次）。使用者要求對 tigerairtw.com
  **一天不得超過 500 次**，排程一天 3 回＝12 次，離上限很遠。
"""
import sys
import time

from core import fetcher, store

MAX_FETCH_LOG = 60          # meta 裡保留最近幾次紀錄（約 20 天份）


def run(stations, dry_run=False):
    at = store.now_tw()
    meta = store.load_meta()
    log = []
    totals = {"rows": 0, "changed": 0, "ok": 0}
    routes = set(tuple(r) for r in meta.get("routes", []))
    route_counts = dict(meta.get("route_counts", {}))

    for i, st in enumerate(stations):
        if i:
            time.sleep(2)                   # 站與站之間喘口氣，別連續猛打
        t0 = time.time()
        raw, err = fetcher.fetch_station(st)
        if err:
            print(f"[X]  {st}: {err}")
            log.append({"at": at, "station": st, "ok": False, "note": err})
            continue

        rows = fetcher.normalize(raw)
        old = store.load_latest(st)
        changes = store.diff_changes(old, rows)
        secs = time.time() - t0
        print(f"[OK] {st}: {len(rows):,} 筆（原始 {len(raw):,}）"
              f"　變動 {len(changes):,} 筆　{secs:.1f}s")

        if not dry_run:
            store.save_latest(st, rows, at)
            store.append_history(st, changes, at)
        # 這一站的航線筆數重算（網頁靠它決定預設要顯示哪條航線）
        for k in [k for k in route_counts
                  if fetcher.tw_of(*k.split("|")) == st]:
            del route_counts[k]
        for o, d, _date, _a, _s in rows:
            routes.add((o, d))
            key = o + "|" + d
            route_counts[key] = route_counts.get(key, 0) + 1

        totals["rows"] += len(rows)
        totals["changed"] += len(changes)
        totals["ok"] += 1
        log.append({"at": at, "station": st, "ok": True,
                    "rows": len(rows), "changed": len(changes),
                    "secs": round(secs, 1)})

    if not dry_run:
        meta["updated"] = at
        meta["stations_fetched"] = stations
        meta["routes"] = sorted(list(r) for r in routes)
        meta["route_counts"] = route_counts
        meta["counts"] = {**meta.get("counts", {}),
                          **{e["station"]: e.get("rows", 0) for e in log if e["ok"]}}
        meta["total_rows"] = totals["rows"] or meta.get("total_rows", 0)
        meta.setdefault("history_since", at)
        meta["history_months"] = {st: store.history_months(st)
                                  for st in fetcher.TW_STATIONS
                                  if store.history_months(st)}
        meta["fetch_log"] = (meta.get("fetch_log", []) + log)[-MAX_FETCH_LOG:]
        store.save_meta(meta)

    print(f"\n完成：{totals['ok']}/{len(stations)} 站成功，"
          f"{totals['rows']:,} 筆價格、{totals['changed']:,} 筆變動"
          + ("（--dry-run，沒有寫檔）" if dry_run else ""))
    return totals["ok"]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    dry = "--dry-run" in sys.argv
    stations = [a.upper() for a in args] or fetcher.TW_STATIONS
    ok = run(stations, dry)
    # 一站都沒成功才算失敗，讓 GitHub 的排程亮紅燈
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
