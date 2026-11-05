/* 折線圖（純 SVG，沒有任何外部函式庫）。
 *
 * 為什麼自己畫不用 Chart.js：這張圖要的東西很固定（折線＋分色散點＋斷線），
 * 自己畫大約兩百行，換來零依賴、零 CDN、載入秒開，網頁掛掉的可能性也少一個。
 *
 * 兩張圖共用這支：
 *   區間價格圖 ── X 軸是出發日
 *   單日趨勢圖 ── X 軸是抓取時間，stepped:true（價格沒變時是水平的）
 */
(function (global) {
  'use strict';

  var PAD = { top: 14, right: 16, bottom: 34, left: 68 };
  var COLORS = {
    line: '#1b5fa5', weekday: '#1b5fa5', weekend: '#e67e22',
    low: '#1e8449', hist: '#9aa7b4', grid: '#e6ebf0', axis: '#6b7a89',
    soldout: '#c0392b',      // 查不到價格、但這條線平常有飛 → 多半是賣完了
    spike: '#b9770e'         // 貴到不合理，多半是艙位釋出而非漲價
  };

  function money(n) { return Math.round(n).toLocaleString('en-US'); }

  /* 好讀的刻度間距：讓圖上大約 5~9 條格線 */
  function niceStep(span) {
    var cands = [50, 100, 200, 250, 500, 1000, 1500, 2000, 2500, 3000, 5000, 10000];
    for (var i = 0; i < cands.length; i++) {
      if (span / cands[i] <= 10) return cands[i];
    }
    return 20000;
  }

  function el(tag, attrs, text) {
    var n = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) {
      n.setAttribute(k, attrs[k]);
    }
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function fmtX(ms, type) {
    var d = new Date(ms);
    var md = pad2(d.getMonth() + 1) + '/' + pad2(d.getDate());
    if (type === 'time') return md + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return md;
  }

  /* opts = {segments, dots, xType, stepped, height, yTitle, xTitle} */
  function draw(box, opts) {
    box.innerHTML = '';
    var all = [];
    (opts.segments || []).forEach(function (s) { all = all.concat(s); });
    (opts.dots || []).forEach(function (d) { all.push(d); });
    if (!all.length) {
      box.innerHTML = '<p class="empty">沒有可以畫的資料。</p>';
      return;
    }

    var W = Math.max(320, box.clientWidth || box.parentNode.clientWidth || 900);
    var H = opts.height || 340;
    var xs = all.map(function (p) { return p.x; });
    var ys = all.map(function (p) { return p.y; });
    var x0 = opts.xMin !== undefined ? opts.xMin : Math.min.apply(null, xs);
    var x1 = opts.xMax !== undefined ? opts.xMax : Math.max.apply(null, xs);
    if (x1 === x0) { x0 -= 43200000; x1 += 43200000; }   // 只有一個點時給它半天寬度
    var lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys);
    var pad = Math.max(200, (hi - lo) * 0.12);
    var step = niceStep(hi - lo + 2 * pad);
    var yLo = Math.max(0, Math.floor((lo - pad) / step) * step);
    var yHi = Math.ceil((hi + pad) / step) * step;
    if (yHi === yLo) yHi = yLo + step;

    var iw = W - PAD.left - PAD.right, ih = H - PAD.top - PAD.bottom;
    function X(v) { return PAD.left + (v - x0) / (x1 - x0) * iw; }
    function Y(v) { return PAD.top + (yHi - v) / (yHi - yLo) * ih; }

    var svg = el('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H,
                          role: 'img' });

    /* 橫向格線與 Y 軸刻度 */
    for (var v = yLo; v <= yHi + 0.5; v += step) {
      svg.appendChild(el('line', { x1: PAD.left, y1: Y(v), x2: W - PAD.right, y2: Y(v),
                                   stroke: COLORS.grid }));
      svg.appendChild(el('text', { x: PAD.left - 8, y: Y(v) + 4, fill: COLORS.axis,
                                   'font-size': 12, 'text-anchor': 'end' }, money(v)));
    }

    /* X 軸刻度（等距取樣，避免標籤擠在一起） */
    var ticks = Math.max(2, Math.min(9, Math.floor(iw / 95)));
    for (var i = 0; i < ticks; i++) {
      var xv = x0 + (x1 - x0) * i / (ticks - 1);
      var anchor = i === 0 ? 'start' : (i === ticks - 1 ? 'end' : 'middle');
      svg.appendChild(el('line', { x1: X(xv), y1: PAD.top, x2: X(xv), y2: H - PAD.bottom,
                                   stroke: COLORS.grid }));
      svg.appendChild(el('text', { x: X(xv), y: H - PAD.bottom + 16, fill: COLORS.axis,
                                   'font-size': 12, 'text-anchor': anchor },
                         fmtX(xv, opts.xType)));
    }
    svg.appendChild(el('text', { x: PAD.left + iw / 2, y: H - 3, fill: COLORS.axis,
                                 'font-size': 12, 'text-anchor': 'middle' },
                       opts.xTitle || ''));
    svg.appendChild(el('text', { x: 15, y: PAD.top + ih / 2, fill: COLORS.axis,
                                 'font-size': 12, 'text-anchor': 'middle',
                                 transform: 'rotate(-90 15 ' + (PAD.top + ih / 2) + ')' },
                       opts.yTitle || ''));

    /* 折線：一段一條 path，中斷代表那幾天沒有資料 */
    (opts.segments || []).forEach(function (seg) {
      if (!seg.length) return;
      var d = '';
      seg.forEach(function (p, i) {
        if (i === 0) { d += 'M' + X(p.x) + ' ' + Y(p.y); return; }
        if (opts.stepped) d += 'H' + X(p.x);     // 價格沒變 → 水平走到新時間點
        d += (opts.stepped ? 'V' + Y(p.y) : 'L' + X(p.x) + ' ' + Y(p.y));
      });
      svg.appendChild(el('path', { d: d, fill: 'none', stroke: COLORS.line,
                                   'stroke-width': 2, 'stroke-linejoin': 'round' }));
    });

    /* 散點。點太密時（手機上 90 幾天擠在 300px）自動縮小，
       不然會糊成一條粗帶、連折線都看不見。 */
    var dots = opts.dots || [];
    var gap = dots.length ? iw / dots.length : 99;
    var tight = gap < 8;
    var hit = [];
    dots.forEach(function (p) {
      var c = COLORS[p.kind] || COLORS.weekday;
      var r = p.kind === 'low' ? 6.5 : (p.kind === 'hist' ? 3.5 : 4.2);
      if (tight) r = p.kind === 'low' ? 4.5 : 2.2;
      svg.appendChild(el('circle', { cx: X(p.x), cy: Y(p.y), r: r, fill: c,
                                     stroke: '#fff',
                                     'stroke-width': tight ? 0.5 : 1.5 }));
      if (p.tip) hit.push({ px: X(p.x), py: Y(p.y), tip: p.tip });
    });

    /* 底部標記：那一天「沒有價格」，所以畫不出點，只能在 X 軸上立一根短豎線。
       不要硬給它一個 y 值假裝有價格——那是編造資料。 */
    (opts.marks || []).forEach(function (m) {
      var x = X(m.x);
      if (x < PAD.left - 1 || x > W - PAD.right + 1) return;
      svg.appendChild(el('line', {
        x1: x, y1: H - PAD.bottom, x2: x, y2: H - PAD.bottom - 11,
        stroke: COLORS.soldout, 'stroke-width': 2
      }));
      if (m.tip) hit.push({ px: x, py: H - PAD.bottom - 6, tip: m.tip });
    });

    box.appendChild(svg);
    bindTip(svg, hit);
  }

  /* 滑鼠靠近某個點就顯示明細（找最近的，不必精準命中小圓點） */
  function bindTip(svg, hit) {
    var tip = document.getElementById('tip');
    if (!tip || !hit.length) return;
    svg.addEventListener('mousemove', function (e) {
      var r = svg.getBoundingClientRect();
      var sx = (e.clientX - r.left) * (svg.viewBox.baseVal.width / r.width);
      var sy = (e.clientY - r.top) * (svg.viewBox.baseVal.height / r.height);
      var best = null, bd = 1e9;
      for (var i = 0; i < hit.length; i++) {
        var dx = hit[i].px - sx, dy = hit[i].py - sy, d = dx * dx + dy * dy;
        if (d < bd) { bd = d; best = hit[i]; }
      }
      if (best && bd < 900) {
        tip.textContent = best.tip;
        tip.classList.add('on');
        tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 10) + 'px';
        tip.style.top = (e.clientY - 34) + 'px';
      } else {
        tip.classList.remove('on');
      }
    });
    svg.addEventListener('mouseleave', function () { tip.classList.remove('on'); });
  }

  global.Chart = { draw: draw, money: money, COLORS: COLORS };
})(window);
