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
    hist: {},          // tw -> {key -> [[at, amount], ...]}
    ctx: null          // 最近一次查詢的結果
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

  function loadHist(tw) {
    if (S.hist[tw]) return Promise.resolve(S.hist[tw]);
    var months = (S.meta.history_months || {})[tw] || [];
    return Promise.all(months.map(function (m) {
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
  }

  /* ---------------- 查詢計算 ---------------- */
  function queryOneWay(o, d, from, to) {
    var tw = twOf(o, d);
    var all = (S.latest[tw].byRoute[o + '|' + d]) || [];
    var hist = S.hist[tw] || {};
    return all.filter(function (r) { return r.date >= from && r.date <= to; })
      .map(function (r) {
        var seq = hist[o + '|' + d + '|' + r.date] || [];
        var low = null, lowAt = '';
        seq.forEach(function (p) {
          if (low === null || p[1] < low) { low = p[1]; lowAt = p[0]; }
        });
        return {
          date: r.date, weekday: wd(r.date), amount: r.amount, src: r.src,
          histLow: low, histN: seq.length, histLowAt: lowAt,
          // 只抓過一次時「現在＝歷史最低」是理所當然的，不標才不會整欄都是雜訊
          isRecord: low !== null && seq.length > 1 && r.amount <= low,
          diff: low === null ? null : r.amount - low
        };
      });
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
  function rangeChart(boxId, legendId, rows) {
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

    Chart.draw(box, { segments: segs, dots: dots, xType: 'date',
                      xTitle: '出發日', yTitle: '票價 (TWD)', height: 330 });
    $(legendId).innerHTML =
      '<b style="color:#1b5fa5">●</b> 平日　<b style="color:#e67e22">●</b> 週六日　' +
      '<b style="color:#1e8449">●</b> 區間最低　<b style="color:#9aa7b4">●</b> 歷史更低價　' +
      '｜　滑鼠移到點上看當天明細；折線中斷代表那幾天沒有資料（未開賣或無航班）。';
  }

  function showTrend(o, d, date) {
    var seq = (S.hist[twOf(o, d)] || {})[o + '|' + d + '|' + date] || [];
    $('trend-box').hidden = false;
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
    var dots = seq.map(function (p) {
      return { x: +parseAt(p[0]), y: p[1], kind: 'weekday',
               tip: p[0].slice(5, 16) + '　TWD ' + money(p[1]) };
    });
    Chart.draw($('chart-trend'), { segments: segs, dots: dots, xType: 'time',
                                   stepped: true, xTitle: '抓取時間',
                                   yTitle: '票價 (TWD)', height: 300 });
    $('legend-trend').innerHTML =
      '<b>' + head + '</b>　｜　目前 TWD ' + money(amounts[amounts.length - 1]) +
      '　｜　期間最低 <b style="color:#1e8449">' + money(Math.min.apply(null, amounts)) +
      '</b>　｜　最高 <b style="color:#c0392b">' + money(Math.max.apply(null, amounts)) +
      '</b>　｜　共 ' + seq.length + ' 個紀錄點。折線是階梯狀，因為只有價格變動時才留紀錄。';
    $('trend-box').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  /* ---------------- 表格 ---------------- */
  function dailyTable(tblId, rows, o, d) {
    var cheap = {};
    cheapest(rows).forEach(function (r) { cheap[r.date] = 1; });
    var h = '<thead><tr><th>出發日</th><th>星期</th><th class="num">目前票價</th>' +
            '<th class="num">歷史最低</th><th class="num">與歷史差</th>' +
            '<th>歷史最低時間</th><th>資料更新</th></tr></thead><tbody>';
    rows.forEach(function (r) {
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
      tr.onclick = function () { tab('changes'); showTrend(o, d, tr.dataset.date); };
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
    var need = [loadLatest(twOf(o, d)), loadHist(twOf(o, d))];
    if (isRet) { need.push(loadLatest(twOf(d, o))); need.push(loadHist(twOf(d, o))); }

    Promise.all(need).then(function () {
      var rows = queryOneWay(o, d, f, t);
      S.ctx = { o: o, d: d, f: f, t: t };
      $('head-out').innerHTML = (isRet ? '✈ 去程　' : '✈ ') + routeLabel(o, d) +
        '<span class="sub">　' + f + ' ～ ' + t + '　' + spanText(f, t, rows.length) + '</span>';
      dailyTable('tbl-out', rows, o, d);
      rangeChart('chart-out', 'legend-out', rows);

      if (isRet) {
        var rf = $('ret-from').value, rt = $('ret-to').value;
        var ret = queryOneWay(d, o, rf, rt);
        $('head-ret').innerHTML = '✈ 回程　' + routeLabel(d, o) +
          '<span class="sub">　' + rf + ' ～ ' + rt + '　' + spanText(rf, rt, ret.length) + '</span>';
        dailyTable('tbl-ret', ret, d, o);
        rangeChart('chart-ret', 'legend-ret', ret);

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

      var ch = changesOf(o, d, f, t);
      $('head-changes').innerHTML = routeLabel(o, d) +
        '<span class="sub">　' + f + ' ～ ' + t + '　共 ' + ch.length.toLocaleString('en-US') +
        ' 筆變動　｜　歷史自 ' + (S.meta.history_since || '—').slice(0, 16) +
        '　｜　在「每日票價」點任一列可看該出發日走勢</span>';
      changesTable(ch);
      $('trend-box').hidden = true;
      save();
    }).catch(function (e) {
      status('讀取資料失敗：' + e.message);
    });
  }

  function spanText(from, to, n) {
    var span = Math.round((parseDate(to) - parseDate(from)) / 86400000) + 1;
    var miss = span - n;
    return '有價格 ' + n + ' 天' + (miss > 0 ? '（' + miss + ' 天無資料）' : '');
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

  function status(msg) { $('status').textContent = msg; }

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
    b.onclick = function () { tab(b.dataset.tab); };
  });
  var rt;
  window.addEventListener('resize', function () {          // 視窗變寬時重畫，圖才不會糊
    clearTimeout(rt);
    rt = setTimeout(function () { if (S.ctx) run(); }, 300);
  });

  boot();
})();
