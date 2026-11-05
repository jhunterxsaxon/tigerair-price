/* 台灣虎航票價追蹤 — 網頁端邏輯。
 *
 * 資料全部是靜態 JSON（由 GitHub Actions 定時抓好 commit 進 repo），
 * 網頁只負責讀檔、算、畫。**瀏覽器不會去打虎航**：
 * 一來跨網域會被擋，二來每個訪客都去抓的話，很快就超過每天 500 次的自我約束。
 *
 * 載入策略：meta 很小一開始就載；latest 依「台灣站」分檔，選了航線才載；
 * history 只有要看歷史最低或趨勢時才載。
 */
(function () {
  'use strict';

  var TW = ['TPE', 'KHH', 'RMQ', 'TNN'];
  var COUNTRY = { TW: '台灣', JP: '日本', KR: '南韓', TH: '泰國', VN: '越南' };
  var ORDER = { TW: 0, JP: 1, KR: 2, TH: 3, VN: 4 };
  var WD = '日一二三四五六';

  var S = {
    meta: null, st: {}, routes: [],
    latest: {},        // tw -> {byKey, byRoute}
    lows: {},          // tw -> {key -> {low, n, at}}　查詢只需要這個
    hist: {},          // tw -> {key -> [[at, amount], ...]}　只有變動頁與趨勢圖要
    histP: {},         // tw -> Promise，避免同時觸發兩次下載
    ctx: null,         // 最近一次查詢的條件
    changesReady: false,
    statusText: ''
  };

  var $ = function (id) { return document.getElementById(id); };
  var money = function (n) { return Chart.money(n); };

  function getJSON(path) {
    return fetch(path).then(function (r) {
      if (!r.ok) throw new Error(path + ' → HTTP ' + r.status);
      return r.json();
    });
  }

  function ver() { return encodeURIComponent((S.meta && S.meta.updated) || '0'); }
  function parseDate(s) {
    var p = s.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]);      // 用本地時間，避免 UTC 位移跨日
  }
  function parseAt(s) { return new Date(s.replace(' ', 'T')); }
  function iso(d) {
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) +
           '-' + ('0' + d.getDate()).slice(-2);
  }
  function addDays(d, n) { var x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function wd(dateStr) { return WD[parseDate(dateStr).getDay()]; }
  function name(code) { return (S.st[code] && S.st[code].name) || code; }
  function label(code) { return name(code) + ' (' + code + ')'; }
  function routeLabel(o, d) { return label(o) + ' → ' + label(d); }
  function twOf(o, d) { return TW.indexOf(o) >= 0 ? o : d; }

  /* ---------------- 資料載入 ---------------- */
  function loadLatest(tw) {
    if (S.latest[tw]) return Promise.resolve(S.latest[tw]);
    return getJSON('data/latest/' + tw + '.json?v=' + ver()).then(function (d) {
      var byRoute = {};
      (d.rows || []).forEach(function (r) {
        var k = r[0] + '|' + r[1];
        (byRoute[k] || (byRoute[k] = [])).push({ date: r[2], amount: r[3], src: r[4] || '' });
      });
      Object.keys(byRoute).forEach(function (k) {
        byRoute[k].sort(function (a, b) { return a.date < b.date ? -1 : 1; });
      });
      S.latest[tw] = { byRoute: byRoute, updated: d.updated };
      return S.latest[tw];
    });
  }

  /* 預先算好的「每個出發日的歷史最低」。查詢只靠這個檔，
     大小固定在 650KB 左右（航線數×出發日數），不隨累積時間成長。 */
  function loadLows(tw) {
    if (S.lows[tw]) return Promise.resolve(S.lows[tw]);
    return getJSON('data/lows/' + tw + '.json?v=' + ver()).then(function (d) {
      var ats = d.ats || [], idx = {};
      (d.rows || []).forEach(function (r) {
        idx[r[0] + '|' + r[1] + '|' + r[2]] =
          { low: r[3], n: r[4], at: ats[r[5]] || '' };
      });
      S.lows[tw] = idx;
      return idx;
    });
  }

  /* 完整歷史。會隨時間一直長大，所以**只有**價格變動頁和趨勢圖才載，
     而且是切到那一頁時才載，不在查詢時擋著。 */
  function loadHist(tw) {
    if (S.hist[tw]) return Promise.resolve(S.hist[tw]);
    if (S.histP[tw]) return S.histP[tw];          // 同時被叫兩次不要下載兩遍
    var months = (S.meta.history_months || {})[tw] || [];
    S.histP[tw] = Promise.all(months.map(function (m) {
      return getJSON('data/history/' + tw + '/' + m + '.json?v=' + ver())
        .catch(function () { return null; });
    })).then(function (files) {
      var idx = {};
      var batches = [];
      files.forEach(function (f) {
        if (f && f.batches) batches = batches.concat(f.batches);
      });
      batches.sort(function (a, b) { return a.at < b.at ? -1 : 1; });
      batches.forEach(function (b) {
        (b.rows || []).forEach(function (r) {
          var k = r[0] + '|' + r[1] + '|' + r[2];
          (idx[k] || (idx[k] = [])).push([b.at, r[3]]);
        });
      });
      S.hist[tw] = idx;
      return idx;
    });
    return S.histP[tw];
  }

  /* ---------------- 查詢計算 ---------------- */
  function queryOneWay(o, d, from, to) {
    var tw = twOf(o, d);
    var all = (S.latest[tw].byRoute[o + '|' + d]) || [];
    var lows = S.lows[tw] || {};
    return all.filter(function (r) { return r.date >= from && r.date <= to; })
      .map(function (r) {
        var L = lows[o + '|' + d + '|' + r.date];
        var low = L ? L.low : null;
        return {
          date: r.date, weekday: wd(r.date), amount: r.amount, src: r.src,
          histLow: low, histN: L ? L.n : 0, histLowAt: L ? L.at : '',
          // 只抓過一次時「現在＝歷史最低」是理所當然的，不標才不會整欄都是雜訊
          isRecord: low !== null && L.n > 1 && r.amount <= low,
          diff: low === null ? null : r.amount - low
        };
      });
  }

  /* 區間裡「查不到價格」的日子，並判斷是哪一種。
   *
   * 2026-11-05 實測確認：官方 API 只回「還買得到的最低價」，一天之內同一個
   * 出發日會消失也會冒出來（50 分鐘內就有 12 個冒出、6 個消失），而且冒出來時
   * 價格常是該航線中位數的 2～5 倍。那是**便宜艙等賣完**、後來又釋出最貴艙等，
   * 不是「沒有航班」。
   *
   * API 不會告訴我們是哪一種，但可以從星期幾推：
   *   這條線平常有飛那個星期幾 → 多半是賣完了
   *   平常就不飛那個星期幾     → 本來就沒有航班
   * 實測 11,770 個缺口裡，98.8% 屬於後者。
   */
  function missingInfo(o, d, from, to) {
    var tw = twOf(o, d);
    var all = (S.latest[tw] && S.latest[tw].byRoute[o + '|' + d]) || [];
    if (!all.length) return [];
    var has = {};
    all.forEach(function (r) { has[r.date] = 1; });

    // 用整個開賣範圍（不只查詢區間）統計每個星期幾飛不飛，樣本才夠
    var fly = [0, 0, 0, 0, 0, 0, 0], tot = [0, 0, 0, 0, 0, 0, 0];
    var c = parseDate(all[0].date), last = parseDate(all[all.length - 1].date);
    while (c <= last) {
      var w = c.getDay();
      tot[w]++;
      if (has[iso(c)]) fly[w]++;
      c = addDays(c, 1);
    }

    var out = [];
    var cur = parseDate(from), end = parseDate(to);
    while (cur <= end) {
      var k = iso(cur);
      if (!has[k] && k >= all[0].date && k <= all[all.length - 1].date) {
        var ww = cur.getDay();
        out.push({ date: k, weekday: wd(k),
                   soldOut: tot[ww] > 0 && fly[ww] / tot[ww] >= 0.5 });
      }
      cur = addDays(cur, 1);
    }
    return out;
  }

  function cheapest(rows) {
    if (!rows.length) return [];
    var lo = Math.min.apply(null, rows.map(function (r) { return r.amount; }));
    return rows.filter(function (r) { return r.amount === lo; });
  }

  function roundTrip(out, ret, stayMin, stayMax, top) {
    var combos = [];
    out.forEach(function (a) {
      var ad = parseDate(a.date);
      ret.forEach(function (b) {
        var stay = Math.round((parseDate(b.date) - ad) / 86400000);
        if (stay < 0 || stay < stayMin) return;
        if (stayMax !== null && stay > stayMax) return;
        var histTotal = (a.histLow !== null && b.histLow !== null) ? a.histLow + b.histLow : null;
        var enough = a.histN > 1 && b.histN > 1;
        combos.push({
          out: a, ret: b, stay: stay, total: a.amount + b.amount,
          histTotal: histTotal,
          isRecord: enough && histTotal !== null && (a.amount + b.amount) <= histTotal
        });
      });
    });
    combos.sort(function (x, y) {
      return x.total - y.total || (x.out.date < y.out.date ? -1 : 1);
    });
    return { list: combos.slice(0, top), n: combos.length };
  }

  function changesOf(o, d, from, to) {
    var hist = S.hist[twOf(o, d)] || {};
    var out = [];
    Object.keys(hist).forEach(function (k) {
      var p = k.split('|');
      if (p[0] !== o || p[1] !== d) return;
      if (p[2] < from || p[2] > to) return;
      var seq = hist[k];
      for (var i = 1; i < seq.length; i++) {
        out.push({ at: seq[i][0], date: p[2], before: seq[i - 1][1], after: seq[i][1] });
      }
    });
    out.sort(function (a, b) { return a.at < b.at ? 1 : (a.at > b.at ? -1 : 0); });
    return out;
  }

  /* ---------------- 畫圖 ---------------- */
  function rangeChart(boxId, legendId, rows, missing) {
    var box = $(boxId);
    if (!rows.length) { box.innerHTML = '<p class="empty">這個區間沒有資料。</p>';
                        $(legendId).innerHTML = ''; return; }
    var lo = Math.min.apply(null, rows.map(function (r) { return r.amount; }));
    var segs = [], cur = [], prev = null;
    rows.forEach(function (r) {
      var t = parseDate(r.date);
      if (prev && Math.round((t - prev) / 86400000) !== 1) { segs.push(cur); cur = []; }
      cur.push({ x: +t, y: r.amount });
      prev = t;
    });
    if (cur.length) segs.push(cur);

    var dots = [];
    rows.forEach(function (r) {
      var day = parseDate(r.date).getDay();
      var kind = r.amount === lo ? 'low' : ((day === 0 || day === 6) ? 'weekend' : 'weekday');
      var tip = r.date + '（' + r.weekday + '）　TWD ' + money(r.amount);
      if (r.histLow !== null && r.histN > 1) tip += '　｜ 歷史最低 ' + money(r.histLow);
      if (r.isRecord) tip += '　★ 破紀錄';
      dots.push({ x: +parseDate(r.date), y: r.amount, kind: kind, tip: tip });
      if (r.histLow !== null && r.histN > 1 && r.histLow < r.amount) {
        dots.push({ x: +parseDate(r.date), y: r.histLow, kind: 'hist',
                    tip: r.date + ' 曾經低到 TWD ' + money(r.histLow) });
      }
    });

    var sold = (missing || []).filter(function (m) { return m.soldOut; });
    var marks = sold.map(function (m) {
      return { x: +parseDate(m.date),
               tip: m.date + '（' + m.weekday + '）查不到價格。這條線平常有飛這天，'
                    + '多半是便宜艙等賣完了' };
    });

    Chart.draw(box, { segments: segs, dots: dots, marks: marks, xType: 'date',
                      xTitle: '出發日', yTitle: '票價 (TWD)', height: 330 });
    $(legendId).innerHTML =
      '<b style="color:#1b5fa5">●</b> 平日　<b style="color:#e67e22">●</b> 週六日　' +
      '<b style="color:#1e8449">●</b> 區間最低　<b style="color:#9aa7b4">●</b> 歷史更低價' +
      (marks.length ? '　<b style="color:#c0392b">▌</b> 可能售完' : '') +
      '　｜　滑鼠移到點或標記上看明細。折線中斷＝那幾天查不到價格，'
      + '多數是那天本來就沒有航班。';
  }

  /* 切到「價格變動」頁時才載完整歷史，並把表格補上。 */
  function ensureChanges() {
    var c = S.ctx;
    if (!c || S.changesReady) return Promise.resolve();
    var prev = S.statusText;
    status('載入完整歷史中…');
    return loadHist(twOf(c.o, c.d)).then(function () {
      S.changesReady = true;
      var ch = changesOf(c.o, c.d, c.f, c.t);
      $('head-changes').innerHTML = routeLabel(c.o, c.d) +
        '<span class="sub">　' + c.f + ' ～ ' + c.t + '　共 ' +
        ch.length.toLocaleString('en-US') + ' 筆變動　｜　歷史自 ' +
        (S.meta.history_since || '—').slice(0, 16) +
        '　｜　在「每日票價」點任一列可看該出發日走勢</span>';
      changesTable(ch);
      status(prev);
    }).catch(function (e) { status('載入歷史失敗：' + e.message); });
  }

  function showTrend(o, d, date) {
    $('trend-box').hidden = false;
    var head0 = routeLabel(o, d) + '　出發日 ' + date + '（' + wd(date) + '）';
    if (!S.hist[twOf(o, d)]) {
      $('chart-trend').innerHTML = '<p class="empty">' + head0 + '　載入歷史中…</p>';
    }
    loadHist(twOf(o, d)).then(function () { drawTrend(o, d, date); })
      .catch(function (e) {
        $('chart-trend').innerHTML = '<p class="empty">載入歷史失敗：' + e.message + '</p>';
      });
  }

  function drawTrend(o, d, date) {
    var seq = (S.hist[twOf(o, d)] || {})[o + '|' + d + '|' + date] || [];
    var head = routeLabel(o, d) + '　出發日 ' + date + '（' + wd(date) + '）';
    if (seq.length < 1) {
      $('chart-trend').innerHTML = '<p class="empty">' + head + ' 還沒有歷史紀錄。</p>';
      $('legend-trend').innerHTML = '';
      return;
    }
    var pts = seq.map(function (p) { return { x: +parseAt(p[0]), y: p[1] }; });
    // 最後再延伸到「現在」，表示到目前為止都還是這個價
    var nowMs = S.meta.updated ? +parseAt(S.meta.updated) : Date.now();
    var segs = [pts.concat(nowMs > pts[pts.length - 1].x
                           ? [{ x: nowMs, y: pts[pts.length - 1].y }] : [])];
    var amounts = seq.map(function (p) { return p[1]; });

    /* 可疑尖刺：比自己上一筆暴漲一倍以上。
     *
     * 2026-11-05 查證：便宜艙等賣完時，那個出發日會整個從 API 上消失；
     * 之後釋出座位重新出現時只剩最貴的艙等（實測 ICN→TPE 2026-11-07
     * 從 3,799 變成 11,199）。我們不記錄「消失」，所以這在歷史裡
     * 長得像一次暴漲——其實不是漲價。
     *
     * 判斷標準刻意用「和自己上一筆比」而不是「和航線中位數比」：
     * 春節、連假的票本來就貴，用中位數會把 1,945 個正常的旺季價格誤標成異常；
     * 用「一步漲一倍」只剩 17 個，而且每一個都是近期出發日的熱門航線。
     */
    var nSpike = 0;
    var dots = seq.map(function (p, i) {
      var spike = i > 0 && p[1] >= seq[i - 1][1] * 2;
      if (spike) nSpike++;
      return { x: +parseAt(p[0]), y: p[1], kind: spike ? 'spike' : 'weekday',
               tip: p[0].slice(5, 16) + '　TWD ' + money(p[1])
                    + (spike ? '　⚠ 一次漲到前一筆的 '
                               + (p[1] / seq[i - 1][1]).toFixed(1)
                               + ' 倍，可能是賣完後釋出的高價艙等，不是漲價' : '') };
    });
    Chart.draw($('chart-trend'), { segments: segs, dots: dots, xType: 'time',
                                   stepped: true, xTitle: '抓取時間',
                                   yTitle: '票價 (TWD)', height: 300 });
    $('legend-trend').innerHTML =
      '<b>' + head + '</b>　｜　目前 TWD ' + money(amounts[amounts.length - 1]) +
      '　｜　期間最低 <b style="color:#1e8449">' + money(Math.min.apply(null, amounts)) +
      '</b>　｜　最高 <b style="color:#c0392b">' + money(Math.max.apply(null, amounts)) +
      '</b>　｜　共 ' + seq.length + ' 個紀錄點。折線是階梯狀，因為只有價格變動時才留紀錄。' +
      (nSpike ? '<br><b style="color:#b9770e">⚠ 有 ' + nSpike +
                ' 個點一次漲到前一筆的兩倍以上（橘色）</b>——便宜艙等賣完時，' +
                '這個出發日會整個從官方資料消失，之後釋出座位重新出現時只剩最貴的艙等。' +
                '看起來像暴漲，實際上不是漲價。' : '');
    $('trend-box').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ---------------- 表格 ---------------- */
  function dailyTable(tblId, rows, o, d, missing) {
    var cheap = {};
    cheapest(rows).forEach(function (r) { cheap[r.date] = 1; });
    // 只把「可能售完」插進表裡。「本來就沒航班」的日子不插——
    // 一週只飛兩天的航線會多出兩百多列空白，反而看不到有價格的那些。
    var sold = {};
    (missing || []).forEach(function (m) { if (m.soldOut) sold[m.date] = m; });
    var merged = rows.slice();
    Object.keys(sold).forEach(function (k) { merged.push(sold[k]); });
    merged.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    rows = merged;
    var h = '<thead><tr><th>出發日</th><th>星期</th><th class="num">目前票價</th>' +
            '<th class="num">歷史最低</th><th class="num">與歷史差</th>' +
            '<th>歷史最低時間</th><th>資料更新</th></tr></thead><tbody>';
    rows.forEach(function (r) {
      if (r.soldOut) {                       // 查不到價格的那幾天
        h += '<tr class="soldout" data-date="' + r.date + '">' +
             '<td>' + r.date + '</td><td>' + r.weekday + '</td>' +
             '<td class="num">查不到</td>' +
             '<td colspan="4">這條線平常有飛這天，多半是便宜艙等賣完了</td></tr>';
        return;
      }
      var cls = r.isRecord ? 'record' : (cheap[r.date] ? 'cheap' : '');
      var diff = (r.diff === null || r.histN < 2) ? '—'
               : (r.diff <= 0 ? '最低' : '+' + money(r.diff));
      h += '<tr class="' + cls + '" data-date="' + r.date + '">' +
           '<td>' + (r.isRecord ? '★ ' : '') + r.date + '</td><td>' + r.weekday + '</td>' +
           '<td class="num">' + money(r.amount) + '</td>' +
           '<td class="num">' + (r.histLow === null ? '—' : money(r.histLow)) + '</td>' +
           '<td class="num">' + diff + '</td>' +
           '<td>' + (r.histLowAt ? r.histLowAt.slice(0, 16) : '—') + '</td>' +
           '<td>' + (r.src || '—') + '</td></tr>';
    });
    var t = $(tblId);
    t.innerHTML = h + '</tbody>';
    t.querySelectorAll('tbody tr').forEach(function (tr) {
      tr.style.cursor = 'pointer';
      tr.title = '點一下看這個出發日的價格走勢';
      tr.onclick = function () {
        tab('changes'); ensureChanges(); showTrend(o, d, tr.dataset.date);
      };
    });
  }

  function comboTable(list) {
    var h = '<thead><tr><th>去程</th><th>星期</th><th class="num">去程價</th>' +
            '<th>回程</th><th>星期</th><th class="num">回程價</th>' +
            '<th class="num">停留</th><th class="num">總價</th></tr></thead><tbody>';
    list.forEach(function (c, i) {
      h += '<tr class="' + (c.isRecord ? 'record' : (i === 0 ? 'cheap' : '')) + '">' +
           '<td>' + c.out.date + '</td><td>' + c.out.weekday + '</td>' +
           '<td class="num">' + money(c.out.amount) + '</td>' +
           '<td>' + c.ret.date + '</td><td>' + c.ret.weekday + '</td>' +
           '<td class="num">' + money(c.ret.amount) + '</td>' +
           '<td class="num">' + c.stay + ' 天</td>' +
           '<td class="num"><b>' + money(c.total) + '</b></td></tr>';
    });
    $('tbl-combo').innerHTML = h + '</tbody>';
  }

  function changesTable(list) {
    var h = '<thead><tr><th>抓到的時間</th><th>出發日</th><th class="num">變動前</th>' +
            '<th class="num">變動後</th><th class="num">漲跌</th></tr></thead><tbody>';
    list.slice(0, 500).forEach(function (c) {
      var diff = c.after - c.before;
      h += '<tr><td>' + c.at.slice(0, 16) + '</td><td>' + c.date +
           '（' + wd(c.date) + '）</td>' +
           '<td class="num">' + money(c.before) + '</td>' +
           '<td class="num">' + money(c.after) + '</td>' +
           '<td class="num ' + (diff > 0 ? 'up' : 'down') + '">' +
           (diff > 0 ? '+' : '') + money(diff) + '</td></tr>';
    });
    $('tbl-changes').innerHTML = h + '</tbody>';
  }

  /* ---------------- 查詢流程 ---------------- */
  function run() {
    var o = $('origin').value, d = $('dest').value;
    if (!o || !d) return;
    var isRet = $('trip').value === 'return';
    var f = $('out-from').value, t = $('out-to').value;
    if (!f || !t || f > t) { status('去程日期範圍不正確。'); return; }

    status('讀取資料中…');
    // 查詢只要 latest ＋ 預先算好的歷史最低，不載完整歷史（那個會愈來愈大）
    var need = [loadLatest(twOf(o, d)), loadLows(twOf(o, d))];
    if (isRet) { need.push(loadLatest(twOf(d, o))); need.push(loadLows(twOf(d, o))); }

    Promise.all(need).then(function () {
      var rows = queryOneWay(o, d, f, t);
      var miss = missingInfo(o, d, f, t);
      S.ctx = { o: o, d: d, f: f, t: t };
      $('head-out').innerHTML = (isRet ? '✈ 去程　' : '✈ ') + routeLabel(o, d) +
        '<span class="sub">　' + f + ' ～ ' + t + '　' +
        spanText(f, t, rows.length, miss) + '</span>';
      dailyTable('tbl-out', rows, o, d, miss);
      rangeChart('chart-out', 'legend-out', rows, miss);

      if (isRet) {
        var rf = $('ret-from').value, rt = $('ret-to').value;
        var ret = queryOneWay(d, o, rf, rt);
        var missR = missingInfo(d, o, rf, rt);
        $('head-ret').innerHTML = '✈ 回程　' + routeLabel(d, o) +
          '<span class="sub">　' + rf + ' ～ ' + rt + '　' +
          spanText(rf, rt, ret.length, missR) + '</span>';
        dailyTable('tbl-ret', ret, d, o, missR);
        rangeChart('chart-ret', 'legend-ret', ret, missR);

        var any = $('stay-any').checked;
        var smin = any ? 0 : +$('stay-min').value;
        var smax = any ? null : +$('stay-max').value;
        var rr = roundTrip(rows, ret, smin, smax, +$('top').value);
        $('head-combo').innerHTML = '⇄ 來回　' + routeLabel(o, d) +
          '<span class="sub">　去程 ' + f + '～' + t + '　｜　回程 ' + rf + '～' + rt +
          '　｜　' + (any ? '不限停留天數' : '停留 ' + smin + '～' + smax + ' 天') +
          '　｜　共 ' + rr.n.toLocaleString('en-US') + ' 種組合</span>';
        comboTable(rr.list);
        if (rr.list.length) {
          var b = rr.list[0];
          status('最便宜組合：去程 ' + b.out.date + '(' + b.out.weekday + ') ' +
                 money(b.out.amount) + ' ＋ 回程 ' + b.ret.date + '(' + b.ret.weekday + ') ' +
                 money(b.ret.amount) + ' ＝ 總價 TWD ' + money(b.total) +
                 '　停留 ' + b.stay + ' 天');
        } else {
          status('這個停留天數範圍內沒有可行的組合。');
        }
      } else {
        status(summary(rows));
      }

      // 價格變動頁要完整歷史，資料量大得多，所以切到那一頁時才載
      S.changesReady = false;
      $('head-changes').innerHTML = routeLabel(o, d) +
        '<span class="sub">　' + f + ' ～ ' + t + '　點開這一頁才會載入完整歷史</span>';
      changesTable([]);
      $('trend-box').hidden = true;
      save();
    }).catch(function (e) {
      status('讀取資料失敗：' + e.message);
    });
  }

  function spanText(from, to, n, missing) {
    var span = Math.round((parseDate(to) - parseDate(from)) / 86400000) + 1;
    var miss = span - n;
    if (miss <= 0) return '有價格 ' + n + ' 天';
    var sold = (missing || []).filter(function (m) { return m.soldOut; }).length;
    var none = miss - sold;
    var parts = [];
    if (none > 0) parts.push('無航班 ' + none + ' 天');
    if (sold > 0) parts.push('可能售完 ' + sold + ' 天');
    return '有價格 ' + n + ' 天（' + (parts.join('、') || miss + ' 天無資料') + '）';
  }

  function summary(rows) {
    if (!rows.length) return '這個航線與日期範圍沒有資料。';
    var best = cheapest(rows);
    var days = best.slice(0, 6).map(function (r) {
      return r.date + '(' + r.weekday + ')';
    }).join('、');
    return '本次最便宜 TWD ' + money(best[0].amount) + '：' + days +
           (best.length > 6 ? ' 等 ' + best.length + ' 天' : '');
  }

  function status(msg) { S.statusText = msg; $('status').textContent = msg; }

  /* ---------------- 介面 ---------------- */
  function fillOrigins() {
    var codes = {};
    S.routes.forEach(function (r) { codes[r[0]] = 1; });
    fillGrouped($('origin'), Object.keys(codes));
  }

  function fillDests(o) {
    var codes = S.routes.filter(function (r) { return r[0] === o; })
                        .map(function (r) { return r[1]; });
    var had = $('dest').value;
    fillGrouped($('dest'), codes);
    // 沒有指定過目的地時，預設挑資料最完整的那條航線，
    // 不然會落在字母序第一的冷門航線（秋田），第一眼看起來像沒資料
    if (!had || codes.indexOf(had) < 0) {
      var rc = S.meta.route_counts || {};
      var best = codes[0], bn = -1;
      codes.forEach(function (c) {
        var n = rc[o + '|' + c] || 0;
        if (n > bn) { bn = n; best = c; }
      });
      if (best) $('dest').value = best;
    }
  }

  function fillGrouped(sel, codes) {
    var keep = sel.value;
    var byCountry = {};
    codes.forEach(function (c) {
      var cc = (S.st[c] && S.st[c].country) || '';
      (byCountry[cc] || (byCountry[cc] = [])).push(c);
    });
    var order = Object.keys(byCountry).sort(function (a, b) {
      return (ORDER[a] === undefined ? 9 : ORDER[a]) - (ORDER[b] === undefined ? 9 : ORDER[b]);
    });
    sel.innerHTML = '';
    order.forEach(function (cc) {
      var g = document.createElement('optgroup');
      g.label = COUNTRY[cc] || cc || '其他';
      byCountry[cc].sort(function (a, b) {
        if (cc === 'TW') return TW.indexOf(a) - TW.indexOf(b);
        return a < b ? -1 : 1;
      }).forEach(function (c) {
        var op = document.createElement('option');
        op.value = c; op.textContent = label(c);
        g.appendChild(op);
      });
      sel.appendChild(g);
    });
    if (keep && codes.indexOf(keep) >= 0) sel.value = keep;
  }

  function tab(nameId) {
    document.querySelectorAll('.tab').forEach(function (s) {
      s.classList.toggle('on', s.id === 'tab-' + nameId);
    });
    document.querySelectorAll('#tabs button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.tab === nameId);
    });
  }

  function syncTrip() {
    var isRet = $('trip').value === 'return';
    document.querySelectorAll('.ret-only').forEach(function (e) {
      e.style.display = isRet ? '' : 'none';
    });
    $('lbl-out').textContent = isRet ? '去程日期' : '出發日期';
    if (!isRet && $('tab-combo').classList.contains('on')) tab('daily');
  }

  function syncRetDates() {
    if (!$('ret-from').value && $('out-from').value) {
      var any = $('stay-any').checked;
      var smin = any ? 3 : +$('stay-min').value;
      var smax = any ? 10 : +$('stay-max').value;
      $('ret-from').value = iso(addDays(parseDate($('out-from').value), smin));
      $('ret-to').value = iso(addDays(parseDate($('out-to').value), smax));
    }
  }

  function save() {
    try {
      localStorage.setItem('tigerfare', JSON.stringify({
        o: $('origin').value, d: $('dest').value, trip: $('trip').value,
        stayMin: $('stay-min').value, stayMax: $('stay-max').value
      }));
    } catch (e) { /* 無痕模式會丟例外，不影響功能 */ }
  }

  function restore() {
    try {
      var v = JSON.parse(localStorage.getItem('tigerfare') || '{}');
      if (v.o) { $('origin').value = v.o; fillDests(v.o); }
      if (v.d) $('dest').value = v.d;
      if (v.trip) $('trip').value = v.trip;
      if (v.stayMin) $('stay-min').value = v.stayMin;
      if (v.stayMax) $('stay-max').value = v.stayMax;
    } catch (e) { /* 同上 */ }
  }

  /* ---------------- 啟動 ---------------- */
  function boot() {
    Promise.all([
      getJSON('data/meta.json?t=' + Date.now()),      // meta 一定要新鮮，不能吃快取
      getJSON('data/stations.json')
    ]).then(function (r) {
      S.meta = r[0];
      (r[1].stations || []).forEach(function (s) { S.st[s.code] = s; });
      S.routes = S.meta.routes || [];

      var m = S.meta;
      $('meta-line').textContent =
        '最後更新 ' + (m.updated || '—') + '　｜　' +
        (m.total_rows || 0).toLocaleString('en-US') + ' 筆價格、' +
        (m.routes || []).length + ' 條航線　｜　歷史自 ' +
        (m.history_since || '—').slice(0, 16);
      $('about-meta').textContent =
        '資料檔最後更新：' + (m.updated || '—') +
        '　｜　抓取站別：' + (m.stations_fetched || TW).join('、') +
        '　｜　歷史起點：' + (m.history_since || '—');

      fillOrigins();
      var first = $('origin').value;
      fillDests(first);
      restore();

      var tomorrow = addDays(new Date(), 1);
      $('out-from').value = iso(tomorrow);
      $('out-to').value = iso(addDays(tomorrow, 90));
      syncTrip();
      syncRetDates();
      run();                                    // 一打開就有東西看，不用先按查詢
    }).catch(function (e) {
      $('meta-line').textContent = '資料載入失敗：' + e.message;
    });
  }

  /* 事件 */
  $('go').onclick = run;
  $('origin').onchange = function () { fillDests(this.value); };
  $('trip').onchange = function () { syncTrip(); syncRetDates(); };
  $('out-from').onchange = $('out-to').onchange = function () {
    $('ret-from').value = ''; syncRetDates();
  };
  $('stay-any').onchange = function () {
    $('stay-min').disabled = $('stay-max').disabled = this.checked;
  };
  document.querySelectorAll('#tabs button').forEach(function (b) {
    b.onclick = function () {
      tab(b.dataset.tab);
      if (b.dataset.tab === 'changes') ensureChanges();
    };
  });
  var rt;
  window.addEventListener('resize', function () {          // 視窗變寬時重畫，圖才不會糊
    clearTimeout(rt);
    rt = setTimeout(function () { if (S.ctx) run(); }, 300);
  });

  boot();
})();
