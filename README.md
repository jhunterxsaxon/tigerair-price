# 台灣虎航票價追蹤

追蹤台灣虎航每日最低票價，把每次抓到的價格存下來，
用來回看「某個出發日的價格怎麼變」以及「現在是不是歷史低點」。

**網站：** https://<你的帳號>.github.io/<repo 名稱>/

## 它怎麼運作

```
GitHub Actions（每天 09:00 / 15:30 / 22:00 台灣時間）
   └─ python fetch.py          抓官方公開票價 API（純標準庫，10 秒內）
        └─ 更新 data/*.json 並自動 commit
                 ↓
GitHub Pages 的靜態網頁讀同一份 JSON，在瀏覽器端計算與繪圖
```

**網頁不會去打虎航。** 一來瀏覽器跨網域會被擋，二來每個訪客都去抓的話
很快就會超過「一天 500 次連線」的自我約束。

## 資料說明

* 顯示的是**單人未稅起價**，而且是「目前還買得到的最低級距」，會隨訂位狀況浮動。
  實際結帳金額會再加上稅費與手續費。
* 官方 API 只給「現在」，**不會回溯**，所以歷史必須自己一天天累積。
* `price_history` 的概念沿用到 JSON：**只記錄價格有變動的那幾筆**。
  每次抓回來一萬多筆，全存的話一年上千萬筆；實測一天的變動量只有 1,500 筆左右。
* 城市群組代碼（XX2 北海道之類）已排除——實測群組價與個別機場不同步，訂票要看個別機場。

## 檔案

| 路徑 | 用途 |
|---|---|
| `index.html` / `app.js` / `chart.js` / `style.css` | 網頁（圖表是純 SVG，沒有任何外部函式庫）|
| `fetch.py` | 抓取並更新資料，GitHub Actions 每次排程就跑這支 |
| `core/fetcher.py` | 打官方 API、去重、過濾群組代碼 |
| `core/store.py` | JSON 讀寫（latest / history / meta）|
| `core/stations.py` | 站碼與中文站名對照 |
| `tools/import_from_sqlite.py` | 從舊版 GUI 的 SQLite 匯入既有歷史 |
| `data/` | 資料檔（由 Actions 自動更新）|

## 本機執行

```bash
python fetch.py --dry-run     # 只抓不寫檔，驗證連得到
python fetch.py               # 實際更新 data/
python -m http.server 8765    # 然後開 http://127.0.0.1:8765/
```

## 聲明

資料來自台灣虎航公開票價 API，僅供參考，實際票價以官網為準。
本專案為個人興趣專案，與台灣虎航無關。
