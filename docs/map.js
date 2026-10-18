/* 한눈에 보기 탭: ① 거래량 × 가격 산점도  ② 섹터별 시장 지도(트리맵)
   app.js 의 state / fmt / $ / openDetail 을 그대로 사용 */
(function () {
  const P = {
    "1": { amt: "amount", amtLabel: "당일 거래대금", ret: "ret_1d", vr: "vol_ratio20", smart: "smart_net_5_pct", vrLabel: "오늘 거래량 ÷ 20일 평균", lim: 10, flow: "외+기 5일" },
    "5": { amt: "amount_avg5", amtLabel: "5일 평균 거래대금", ret: "ret_5", vr: "vr5", smart: "smart_net_5_pct", vrLabel: "최근 5일 평균 거래량 ÷ 직전 60일 평균", lim: 15, flow: "외+기 5일" },
    "20": { amt: "amount_avg20", amtLabel: "20일 평균 거래대금", ret: "ret_20", vr: "vr20", smart: "smart_net_20_pct", vrLabel: "최근 20일 평균 거래량 ÷ 직전 120일 평균", lim: 25, flow: "외+기 20일" },
  };
  const M = { period: "1", color: "smart", liquid: true };
  let ZOOM = null; // 시장 지도 확대 중인 업종
  try { Object.assign(M, JSON.parse(localStorage.getItem("map.v2") || "{}")); } catch (e) { /* 무시 */ }
  const saveM = () => { try { localStorage.setItem("map.v2", JSON.stringify(M)); } catch (e) { /* 무시 */ } };

  // 발산형 색: 파랑 ← 회색 → 빨강 (국내 관행: 상승 빨강)
  // 발산형 색 (파랑 ← 짙은 회색 → 빨강). 작은 변동도 보이도록 제곱근 스케일 + 오늘 분포 기준 한계값
  const STOPS = [
    [-1, [31, 95, 232]], [-0.5, [47, 85, 168]], [-0.15, [54, 69, 110]], [0, [61, 66, 80]],
    [0.15, [106, 60, 70]], [0.5, [178, 58, 64]], [1, [242, 51, 58]],
  ];
  function divColor(v, lim) {
    if (v == null || isNaN(v)) return "rgb(70,74,84)";
    let t = Math.min(1, Math.abs(v) / lim);
    t = Math.abs(v) < lim * 0.02 ? 0 : Math.sign(v) * Math.sqrt(t);
    let i = 0; while (i < STOPS.length - 2 && t > STOPS[i + 1][0]) i++;
    const [p0, c0] = STOPS[i], [p1, c1] = STOPS[i + 1], f = Math.max(0, Math.min(1, (t - p0) / (p1 - p0)));
    return `rgb(${c0.map((a, k) => Math.round(a + (c1[k] - a) * f))})`;
  }
  // 화면에 그려지는 종목들의 |값| 92분위를 한계값으로: 조용한 날도 색 차이가 보이게
  function autoLim(vals, floor) {
    const a = vals.filter(v => v != null && isFinite(v)).map(Math.abs).sort((x, y) => x - y);
    if (!a.length) return floor;
    return Math.max(floor, a[Math.floor(a.length * 0.92)]);
  }
  const textOn = () => "#fff";
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- 툴팁 ----------
  let tip;
  function showTip(e, r) {
    const p = P[M.period];
    tip.innerHTML = `<b>${esc(r.name)}</b> <span class="mut">${r.code} · ${esc(r.sector_name || "–")}</span>
      <div>등락(${M.period}일) <b class="${fmt.cls(r[p.ret])}">${fmt.pct(r[p.ret])}</b></div>
      <div>거래량 배수 <b>${r[p.vr] == null ? "–" : r[p.vr].toFixed(1) + "x"}</b></div>
      <div>${p.flow} 순매수 <b class="${fmt.cls(r[p.smart])}">${fmt.pct(r[p.smart], 2)}</b></div>
      <div>${p.amtLabel} <b>${fmt.won(r[p.amt])}</b> · 시총 <b>${fmt.won(r.marcap)}</b></div>`;
    tip.style.display = "block";
    const W = innerWidth, x = e.clientX, y = e.clientY;
    tip.style.left = Math.min(W - tip.offsetWidth - 8, x + 14) + "px";
    tip.style.top = (y + tip.offsetHeight + 20 > innerHeight ? y - tip.offsetHeight - 12 : y + 14) + "px";
  }
  const hideTip = () => { if (tip) tip.style.display = "none"; };

  // ---------- 컨트롤 ----------
  function controls() {
    const seg = (key, opts) => `<div class="seg" data-key="${key}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(M[key]) === v ? "on" : ""}">${l}</button>`).join("")}</div>`;
    $("#mapControls").innerHTML = `
      ${seg("period", [["1", "1일"], ["5", "5일"], ["20", "20일"]])}
      ${seg("color", [["ret", "색: 등락"], ["smart", "색: 외+기 수급"]])}
      <label class="chk"><input type="checkbox" id="mapLiquid" ${M.liquid ? "checked" : ""}> 거래대금 10억↑</label>`;
    $("#mapControls").querySelectorAll(".seg button").forEach(b => b.onclick = () => {
      M[b.parentElement.dataset.key] = b.dataset.v; saveM(); render();
    });
    $("#mapLiquid").onchange = e => { M.liquid = e.target.checked; saveM(); render(); };
  }

  // ---------- ① 산점도 ----------
  function scatter() {
    const p = P[M.period], el = $("#mapScatter");
    const holds = new Set((state.latest.watchlist || []).map(w => w.code));
    let rows = state.universe.filter(r => r[p.vr] > 0 && r[p.ret] != null && (!M.liquid || (r.amount_avg20 || 0) >= 1e9));
    const W = Math.max(320, el.clientWidth), H = Math.round(Math.max(360, Math.min(620, W * 0.62)));
    const m = { l: 44, r: 12, t: 14, b: 44 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
    const abs = rows.map(r => Math.abs(r[p.ret])).sort((a, b) => a - b);
    const raw = Math.max(p.lim, abs[Math.floor(abs.length * 0.995)] || p.lim);
    const step0 = raw <= 20 ? 5 : raw <= 40 ? 10 : raw <= 100 ? 20 : 50;
    const yl = Math.ceil(raw / step0) * step0;
    const vkey = M.period + "|" + M.liquid;
    if (VIEW && VIEW.key !== vkey) VIEW = null;
    const BASE = { lx0: Math.log(0.15), lx1: Math.log(40), ya: -yl, yb: yl };
    const D = VIEW || BASE, zoomed = !!VIEW;
    const cl = (v, a, b) => Math.max(a, Math.min(b, v));
    const X = v => m.l + ((zoomed ? Math.log(Math.max(1e-4, v)) : cl(Math.log(Math.max(1e-4, v)), BASE.lx0, BASE.lx1)) - D.lx0) / (D.lx1 - D.lx0) * iw;
    const Y = v => m.t + (1 - ((zoomed ? v : cl(v, -yl, yl)) - D.ya) / (D.yb - D.ya)) * ih;
    CUR = { m, iw, ih, D, BASE };
    const inView = r => { const x = X(r[p.vr]), y = Y(r[p.ret]); return x >= m.l - 20 && x <= m.l + iw + 20 && y >= m.t - 20 && y <= m.t + ih + 20; };
    // 버블 면적 ∝ 거래대금 (반지름 = 제곱근), 상한으로 대형주가 화면을 덮지 않게
    const R = r => Math.max(1.8, Math.min(W < 600 ? 11 : 18, Math.sqrt((r[p.amt] || 0) / 1e8) * (W < 600 ? 0.35 : 0.5)));
    const cKey = M.color === "ret" ? p.ret : p.smart;
    const cLim = autoLim(rows.map(r => r[cKey]), M.color === "ret" ? 1 : 0.05);
    const col = r => divColor(r[cKey], cLim);
    rows = rows.slice().sort((a, b) => (b[p.amt] || 0) - (a[p.amt] || 0)); // 큰 점 먼저 → 작은 점이 위
    const score = r => Math.log(Math.max(1, r[p.vr])) * Math.abs(r[p.ret]);
    const vis = zoomed ? rows.filter(inView) : rows;
    const top = (zoomed ? vis : vis.filter(r => r[p.vr] >= 3)).slice().sort((a, b) => score(b) - score(a)).slice(0, W < 600 ? 6 : (zoomed ? 18 : 12));
    const topSet = new Set(top.map(r => r.code));
    const XC = [0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 15, 20, 30, 50, 100, 200, 500];
    let xt = XC.filter(v => Math.log(v) >= D.lx0 && Math.log(v) <= D.lx1);
    while (xt.length > 11) xt = xt.filter((_, i) => i % 2 === 0 || xt[i] === 1 || xt[i] === 3);
    const span = D.yb - D.ya, rawStep = span / 6, mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(v => v >= rawStep);
    const yt = []; for (let v = Math.ceil(D.ya / step) * step; v <= D.yb + 1e-9; v += step) yt.push(+v.toFixed(6));
    const fmtY = v => (v > 0 ? "+" : "") + (step < 1 ? v.toFixed(step < 0.1 ? 2 : 1) : Math.round(v)) + "%";
    // 라벨 배치: 겹치면 아래로 밀고, 그래도 겹치면 생략
    const placed = [
      { x: X(3) + 4, y: m.t + 4, w: 104, h: 16 }, { x: X(3) + 4, y: m.t + ih - 20, w: 104, h: 16 }, { x: m.l + 4, y: m.t + 4, w: 70, h: 16 },
    ];
    const hit = b => placed.some(q => b.x < q.x + q.w && b.x + b.w > q.x && b.y < q.y + q.h && b.y + b.h > q.y);
    const place = (r, cls, fs, bold) => {
      const w = String(r.name).length * fs * (bold ? 1.02 : 0.95), cx = X(r[p.vr]), cy = Y(r[p.ret]), rr = R(r);
      const cands = [[rr + 4, -rr - 2], [rr + 4, rr + fs], [-w - rr - 4, -rr - 2], [-w - rr - 4, rr + fs], [rr + 4, fs * 0.35]];
      for (const [dx, dy] of cands) {
        let x = cx + dx, y = cy + dy;
        x = Math.max(m.l + 2, Math.min(W - m.r - w, x)); y = Math.max(m.t + fs, Math.min(m.t + ih - 2, y));
        const b = { x, y: y - fs, w, h: fs + 2 };
        if (!hit(b)) { placed.push(b); return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="${cls}">${esc(r.name)}</text>`; }
      }
      return "";
    };
    const holdRows = vis.filter(r => holds.has(r.code));
    let labels = holdRows.map(r => `<circle cx="${X(r[p.vr])}" cy="${Y(r[p.ret])}" r="${R(r) + 5}" class="m-hold"/>`).join("");
    labels += holdRows.map(r => place(r, "m-hlabel", 12, true)).join("");
    labels += top.filter(r => !holds.has(r.code)).map(r => place(r, "m-label", 10.5, false)).join("");
    const zx = Math.max(m.l, X(3)), zr = m.l + iw;
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="거래량 배수와 등락률 산점도" class="m-svg${zoomed ? " zoomed" : ""}">
      <defs><clipPath id="mclip"><rect x="${m.l}" y="${m.t}" width="${iw}" height="${ih}"/></clipPath></defs>
      ${zx < zr ? `<rect x="${zx}" y="${m.t}" width="${zr - zx}" height="${ih}" class="m-zone"/>` : ""}
      ${xt.map(v => `<line x1="${X(v)}" x2="${X(v)}" y1="${m.t}" y2="${m.t + ih}" class="m-grid${v === 1 ? " m-one" : ""}"/><text x="${X(v)}" y="${H - 26}" class="m-tick" text-anchor="middle">${v}x</text>`).join("")}
      ${yt.map(v => `<line x1="${m.l}" x2="${m.l + iw}" y1="${Y(v)}" y2="${Y(v)}" class="m-grid${v === 0 ? " m-zero" : ""}"/><text x="${m.l - 6}" y="${Y(v) + 4}" class="m-tick" text-anchor="end">${fmtY(v)}</text>`).join("")}
      <text x="${m.l + iw / 2}" y="${H - 6}" class="m-axis" text-anchor="middle">${p.vrLabel} (로그 축)</text>
      ${zx < zr - 110 ? `<text x="${zx + 6}" y="${m.t + 16}" class="m-zlabel">거래 폭발 + 상승</text>
      <text x="${zx + 6}" y="${m.t + ih - 8}" class="m-zlabel">거래 폭발 + 하락</text>` : ""}
      ${zoomed ? "" : `<text x="${m.l + 6}" y="${m.t + 16}" class="m-qlabel">조용히 상승</text>`}
      <g class="m-dots" clip-path="url(#mclip)">${rows.map((r, i) => zoomed && !inView(r) ? "" : `<circle data-i="${i}" cx="${X(r[p.vr]).toFixed(1)}" cy="${Y(r[p.ret]).toFixed(1)}" r="${R(r).toFixed(1)}" fill="${col(r)}"/>`).join("")}</g>
      <g clip-path="url(#mclip)">${labels}</g>
    </svg>
    <div class="m-zoom"><button data-z="in" title="확대">＋</button><button data-z="out" title="축소">−</button><button data-z="reset" title="원래대로" ${zoomed ? "" : "disabled"}>⟲</button></div>
    <div class="m-zhint">${zoomed ? "드래그 = 이동 · 휠/핀치 = 확대·축소 · 더블클릭 = 원래대로" : "마우스 휠·핀치로 확대, 드래그로 이동"}</div>`;
    el.innerHTML = svg;
    el.querySelectorAll(".m-zoom button").forEach(b => b.onclick = () => {
      if (b.dataset.z === "reset") { VIEW = null; render1(); return; }
      zoomAt(m.l + iw / 2, m.t + ih / 2, b.dataset.z === "in" ? 0.6 : 1 / 0.6);
    });
    bindZoom(el);
    el.querySelectorAll(".m-dots circle").forEach(c => {
      const r = rows[+c.dataset.i];
      c.addEventListener("mousemove", e => showTip(e, r));
      c.addEventListener("mouseleave", hideTip);
      c.addEventListener("click", () => { if (el._dragged) return; hideTip(); openDetail(r.code); });
    });
    // 이상 거래 상위 목록 (모바일에서 탭하기 쉽도록)
    const list = rows.filter(r => r[p.vr] >= 3).sort((a, b) => score(b) - score(a)).slice(0, 15);
    $("#mapOutliers").innerHTML = list.length ? `<div class="cg-h">거래량 3배↑ 중 움직임이 큰 종목 (${list.length})</div>
      <div class="ol">${list.map(r => `<button data-code="${r.code}"><span>${esc(r.name)}</span><span class="${fmt.cls(r[p.ret])}">${fmt.pct(r[p.ret])}</span><span class="mut">${r[p.vr].toFixed(1)}x</span><span class="${fmt.cls(r[p.smart])} small">수급 ${fmt.pct(r[p.smart], 2)}</span></button>`).join("")}</div>`
      : `<div class="mut small">이 기간에 거래량 3배 이상 종목이 없습니다</div>`;
    $("#mapOutliers").querySelectorAll("button").forEach(b => b.onclick = () => openDetail(b.dataset.code));
    $("#scatterLegend").innerHTML = legend(M.color === "ret" ? `등락(${M.period}일)` : `${p.flow} 순매수 / 발행주식`, cLim, M.color === "ret" ? 1 : 2)
      + `<span>점 크기 = ${p.amtLabel}</span><span><i class="ring"></i>보유 종목</span>`;
  }

  // ---------- 산점도 확대·이동 ----------
  let VIEW = null, CUR = null, raf = 0;
  const render1 = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { scatter(); }); };
  function setView(v) {
    const B = CUR.BASE, minX = 0.08, minY = 0.4; // 최소 표시 폭
    if (v.lx1 - v.lx0 < minX) { const c = (v.lx0 + v.lx1) / 2; v.lx0 = c - minX / 2; v.lx1 = c + minX / 2; }
    if (v.yb - v.ya < minY) { const c = (v.ya + v.yb) / 2; v.ya = c - minY / 2; v.yb = c + minY / 2; }
    const full = v.lx0 <= B.lx0 + 1e-6 && v.lx1 >= B.lx1 - 1e-6 && v.ya <= B.ya + 1e-6 && v.yb >= B.yb - 1e-6;
    VIEW = full ? null : Object.assign(v, { key: M.period + "|" + M.liquid });
    render1();
  }
  // 화면 좌표(px, py)를 중심으로 k배(0.6=확대) 범위 조정
  function zoomAt(px, py, k) {
    const { m, iw, ih, D } = CUR;
    const fx = Math.max(0, Math.min(1, (px - m.l) / iw)), fy = Math.max(0, Math.min(1, (py - m.t) / ih));
    const cx = D.lx0 + fx * (D.lx1 - D.lx0), cy = D.yb - fy * (D.yb - D.ya);
    setView({ lx0: cx - (cx - D.lx0) * k, lx1: cx + (D.lx1 - cx) * k, yb: cy + (D.yb - cy) * k, ya: cy - (cy - D.ya) * k });
  }
  function svgPt(el, e) {
    const svg = el.querySelector("svg"), r = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal;
    return [(e.clientX - r.left) * vb.width / r.width, (e.clientY - r.top) * vb.height / r.height];
  }
  function bindZoom(el) {
    if (el._zoomBound) return; el._zoomBound = true;
    const ptrs = new Map(); let start = null;
    el.addEventListener("wheel", e => {
      if (!e.target.closest("svg")) return;
      e.preventDefault(); hideTip();
      const [x, y] = svgPt(el, e);
      zoomAt(x, y, Math.exp(Math.max(-0.5, Math.min(0.5, e.deltaY * 0.0018))));
    }, { passive: false });
    el.addEventListener("dblclick", e => { if (e.target.closest("svg")) { VIEW = null; render1(); } });
    el.addEventListener("pointerdown", e => {
      if (!e.target.closest("svg")) return;
      ptrs.set(e.pointerId, svgPt(el, e)); el._dragged = false;
      start = { D: Object.assign({}, CUR.D), pts: new Map(ptrs) };
      if (ptrs.size === 1) el.setPointerCapture?.(e.pointerId);
    });
    el.addEventListener("pointermove", e => {
      if (!ptrs.has(e.pointerId) || !start) return;
      ptrs.set(e.pointerId, svgPt(el, e));
      const { iw, ih } = CUR, S = start.D;
      if (ptrs.size === 1 && start.pts.size === 1) {
        const [x0, y0] = [...start.pts.values()][0], [x1, y1] = ptrs.get(e.pointerId);
        if (!el._dragged && Math.hypot(x1 - x0, y1 - y0) < 4) return;
        el._dragged = true; hideTip();
        const dx = (x1 - x0) / iw * (S.lx1 - S.lx0), dy = (y1 - y0) / ih * (S.yb - S.ya);
        VIEW = { lx0: S.lx0 - dx, lx1: S.lx1 - dx, ya: S.ya + dy, yb: S.yb + dy, key: M.period + "|" + M.liquid };
        render1();
      } else if (ptrs.size === 2 && start.pts.size === 2) {
        const [a0, b0] = [...start.pts.values()], [a1, b1] = [...ptrs.values()];
        const d0 = Math.hypot(a0[0] - b0[0], a0[1] - b0[1]), d1 = Math.hypot(a1[0] - b1[0], a1[1] - b1[1]);
        if (d0 < 10) return;
        el._dragged = true;
        CUR.D = S; zoomAt((a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2, d0 / d1);
      }
    });
    const end = e => { ptrs.delete(e.pointerId); if (!ptrs.size) { start = null; setTimeout(() => { el._dragged = false; }, 0); } else start = { D: Object.assign({}, CUR.D), pts: new Map(ptrs) }; };
    el.addEventListener("pointerup", end); el.addEventListener("pointercancel", end);
  }

  function legend(title, lim, d) {
    const steps = [-1, -0.5, 0, 0.5, 1];
    const steps7 = [-1, -0.5, -0.15, 0, 0.15, 0.5, 1];
    return `<span>${title}</span><span class="lg">${steps7.map(s => `<i style="background:${divColor(Math.sign(s) * s * s * lim, lim)}"></i>`).join("")}</span><span class="mut">−${lim.toFixed(d)}% … +${lim.toFixed(d)}% (화면 종목 92%가 이 안, 작은 변동 강조)</span>`;
  }

  // ---------- ② 트리맵 ----------
  function squarify(vals, x, y, w, h) {
    const tot = vals.reduce((a, b) => a + b, 0) || 1, a = vals.map(v => v * w * h / tot), out = [];
    let i = 0;
    while (i < a.length) {
      const s0 = Math.min(w, h);
      const worst = r => { const s = r.reduce((p, q) => p + q, 0), mx = Math.max(...r), mn = Math.min(...r); return Math.max(s0 * s0 * mx / (s * s), (s * s) / (s0 * s0 * mn)); };
      let row = [a[i]], j = i + 1;
      while (j < a.length && worst(row.concat(a[j])) <= worst(row)) { row.push(a[j]); j++; }
      const s = row.reduce((p, q) => p + q, 0);
      if (w >= h) { const cw = s / h; let cy = y; for (const v of row) { out.push({ x, y: cy, w: cw, h: v / cw }); cy += v / cw; } x += cw; w -= cw; }
      else { const rh = s / w; let cx = x; for (const v of row) { out.push({ x: cx, y, w: v / rh, h: rh }); cx += v / rh; } y += rh; h -= rh; }
      i = j;
    }
    return out;
  }
  // 한글 폭 ≈ 글자 크기. 넘치면 말줄임
  function fit(t, w, fs) {
    t = String(t); const n = Math.floor(w / (fs * 0.98));
    return t.length <= n ? t : n <= 1 ? "" : t.slice(0, n - 1) + "…";
  }
  function treemap() {
    const p = P[M.period], el = $("#mapTree");
    const W = Math.max(320, el.clientWidth), small = W < 600, H = Math.round(small ? 560 : Math.max(480, W * 0.58));
    const N = small ? 150 : 400, SEC = small ? 10 : 18;
    const holds = new Set((state.latest.watchlist || []).map(w => w.code));
    let rows = state.universe.filter(r => r.marcap > 0 && r[p.ret] != null).sort((a, b) => b.marcap - a.marcap).slice(0, N);
    const bySec = {};
    rows.forEach(r => (bySec[r.sector_name || "기타 업종"] ||= []).push(r));
    let secs = Object.entries(bySec).map(([k, v]) => [k, v, v.reduce((s, r) => s + r.marcap, 0)]).sort((a, b) => b[2] - a[2]);
    if (secs.length > SEC) { const rest = secs.slice(SEC).flatMap(s => s[1]); secs = secs.slice(0, SEC).concat([["기타 업종", rest, rest.reduce((s, r) => s + r.marcap, 0)]]); }
    const val = r => M.color === "ret" ? r[p.ret] : r[p.smart];
    const lim = autoLim(rows.map(val), M.color === "ret" ? 1 : 0.05);
    const col = r => divColor(val(r), lim);
    let html = "", idx = [], BAR = 0;
    if (ZOOM) {
      const hit = secs.find(x => x[0] === ZOOM);
      const list = ZOOM === "기타 업종" && hit ? hit[1]
        : state.universe.filter(r => r.marcap > 0 && r[p.ret] != null && (r.sector_name || "기타 업종") === ZOOM);
      if (!list.length) ZOOM = null;
      else {
        BAR = 30;
        const sw = list.reduce((a, r) => a + r.marcap, 0), sv = list.reduce((a, r) => a + r.marcap * (val(r) || 0), 0) / (sw || 1);
        secs = [[ZOOM, list, sw]];
        html += `<g class="t-back" data-back="1"><rect x="0" y="0" width="${W}" height="${BAR - 2}" class="t-barbg"/>
          <text x="10" y="19" class="t-bar">◀ ${esc(ZOOM)} <tspan class="${sv >= 0 ? "t-up" : "t-dn"}">${sv >= 0 ? "+" : ""}${sv.toFixed(M.color === "ret" ? 1 : 2)}%</tspan> <tspan class="t-barsub">· ${list.length}종목 · 누르면 전체 업종으로</tspan></text></g>`;
      }
    }
    const outer = squarify(secs.map(s => s[2]), 0, BAR, W, H - BAR);
    secs.forEach(([name, list], si) => {
      const o = outer[si], hdr = !ZOOM && o.w > 70 && o.h > 44 ? 17 : 0, pad = 1.5;
      list.sort((a, b) => b.marcap - a.marcap);
      const inner = squarify(list.map(r => r.marcap), o.x + pad, o.y + pad + hdr, Math.max(1, o.w - 2 * pad), Math.max(1, o.h - 2 * pad - hdr));
      // 업종 시총가중 등락
      const sw = list.reduce((s, r) => s + r.marcap, 0), sv = list.reduce((s, r) => s + r.marcap * (val(r) || 0), 0) / (sw || 1);
      if (hdr) {
        const pctTxt = `${sv >= 0 ? "+" : ""}${sv.toFixed(M.color === "ret" ? 1 : 2)}%`;
        const full = name.length * 11 + pctTxt.length * 7 + 14 < o.w;
        const nm = fit(name, o.w - 10 - (full ? pctTxt.length * 7 + 4 : 0), 11);
        html += `<rect x="${o.x}" y="${o.y}" width="${o.w}" height="${hdr + 1}" class="t-hdr" data-sec="${esc(name)}"><title>${esc(name)} 확대</title></rect><text x="${o.x + 5}" y="${o.y + 13}" class="t-sec">${esc(nm)}${full ? ` <tspan class="${sv >= 0 ? "t-up" : "t-dn"}">${pctTxt}</tspan>` : ""}</text>`;
      }
      list.forEach((r, k) => {
        const q = inner[k]; idx.push(r);
        const i = idx.length - 1;
        html += `<rect data-i="${i}" x="${q.x.toFixed(1)}" y="${q.y.toFixed(1)}" width="${Math.max(0, q.w - 1).toFixed(1)}" height="${Math.max(0, q.h - 1).toFixed(1)}" fill="${col(r)}" class="t-cell${holds.has(r.code) ? " t-hold" : ""}"/>`;
        if (q.w > 44 && q.h > 26) {
          let fs = Math.max(9, Math.min(15, q.w / 7, q.h / 2.8));
          fs = Math.max(8.5, Math.min(fs, (q.w - 6) / (String(r.name).length * 0.98)));
          html += `<text x="${q.x + q.w / 2}" y="${q.y + q.h / 2 - fs * 0.15}" font-size="${fs}" fill="${textOn(val(r), lim)}" class="t-name" text-anchor="middle">${esc(fit(r.name, q.w - 6, fs))}</text>
            <text x="${q.x + q.w / 2}" y="${q.y + q.h / 2 + fs * 1.05}" font-size="${fs * 0.85}" fill="${textOn(val(r), lim)}" class="t-name" text-anchor="middle">${fmt.pct(val(r), M.color === "ret" ? 1 : 2)}</text>`;
        }
      });
    });
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="업종별 시가총액 트리맵">${html}</svg>`;
    el.querySelectorAll("rect.t-hdr").forEach(h => h.addEventListener("click", () => { hideTip(); ZOOM = h.dataset.sec; treemap(); }));
    const back = el.querySelector("[data-back]"); if (back) back.addEventListener("click", () => { ZOOM = null; treemap(); });
    el.querySelectorAll("rect.t-cell").forEach(c => {
      const r = idx[+c.dataset.i];
      c.addEventListener("mousemove", e => showTip(e, r));
      c.addEventListener("mouseleave", hideTip);
      c.addEventListener("click", () => { hideTip(); openDetail(r.code); });
    });
    $("#treeLegend").innerHTML = legend(M.color === "ret" ? `등락(${M.period}일)` : `${p.flow} 순매수 / 발행주식`, lim, M.color === "ret" ? 1 : 2)
      + `<span>${ZOOM ? `면적 = 시가총액 · ${esc(ZOOM)} 전 종목` : `면적 = 시가총액 · 시총 상위 ${N} · 업종 이름을 누르면 그 업종만 확대`} · 업종 숫자는 시총가중 평균</span><span><i class="ring"></i>보유 종목</span>`;
  }

  function render() {
    if (!state.latest || !$("#tab-map").classList.contains("on")) return;
    controls(); scatter(); treemap();
  }

  window.renderMap = render;
  document.addEventListener("DOMContentLoaded", () => { tip = document.createElement("div"); tip.className = "m-tip"; document.body.appendChild(tip); });
  if (document.readyState !== "loading") { tip = document.createElement("div"); tip.className = "m-tip"; document.body.appendChild(tip); }
  let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 200); });
})();
