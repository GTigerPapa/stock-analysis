/* 한눈에 보기 탭: ① 거래량 × 가격 산점도  ② 섹터별 시장 지도(트리맵)
   app.js 의 state / fmt / $ / openDetail 을 그대로 사용 */
(function () {
  const P = {
    "1": { ret: "ret_1d", vr: "vol_ratio20", smart: "smart_net_5_pct", vrLabel: "오늘 거래량 ÷ 20일 평균", lim: 10, flow: "외+기 5일" },
    "5": { ret: "ret_5", vr: "vr5", smart: "smart_net_5_pct", vrLabel: "최근 5일 평균 거래량 ÷ 직전 60일 평균", lim: 15, flow: "외+기 5일" },
    "20": { ret: "ret_20", vr: "vr20", smart: "smart_net_20_pct", vrLabel: "최근 20일 평균 거래량 ÷ 직전 120일 평균", lim: 25, flow: "외+기 20일" },
  };
  const M = { period: "1", color: "ret", liquid: true };
  try { Object.assign(M, JSON.parse(localStorage.getItem("map.v1") || "{}")); } catch (e) { /* 무시 */ }
  const saveM = () => { try { localStorage.setItem("map.v1", JSON.stringify(M)); } catch (e) { /* 무시 */ } };

  // 발산형 색: 파랑 ← 회색 → 빨강 (국내 관행: 상승 빨강)
  const STOPS = [[37, 99, 235], [157, 183, 234], [214, 214, 210], [230, 164, 156], [192, 57, 43]];
  function divColor(v, lim) {
    if (v == null || isNaN(v)) return "rgb(200,200,196)";
    const t = (Math.max(-lim, Math.min(lim, v)) / lim + 1) / 2 * (STOPS.length - 1);
    const i = Math.min(STOPS.length - 2, Math.floor(t)), f = t - i;
    const c = STOPS[i].map((a, k) => Math.round(a + (STOPS[i + 1][k] - a) * f));
    return `rgb(${c})`;
  }
  const textOn = (v, lim) => Math.abs(v || 0) > lim * 0.45 ? "#fff" : "#1b1b1b";
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // ---------- 툴팁 ----------
  let tip;
  function showTip(e, r) {
    const p = P[M.period];
    tip.innerHTML = `<b>${esc(r.name)}</b> <span class="mut">${r.code} · ${esc(r.sector_name || "–")}</span>
      <div>등락(${M.period}일) <b class="${fmt.cls(r[p.ret])}">${fmt.pct(r[p.ret])}</b></div>
      <div>거래량 배수 <b>${r[p.vr] == null ? "–" : r[p.vr].toFixed(1) + "x"}</b></div>
      <div>${p.flow} 순매수 <b class="${fmt.cls(r[p.smart])}">${fmt.pct(r[p.smart], 2)}</b></div>
      <div>거래대금(20일 평균) <b>${fmt.won(r.amount_avg20)}</b> · 시총 <b>${fmt.won(r.marcap)}</b></div>`;
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
    const x0 = Math.log(0.15), x1 = Math.log(40);
    const abs = rows.map(r => Math.abs(r[p.ret])).sort((a, b) => a - b);
    const raw = Math.max(p.lim, abs[Math.floor(abs.length * 0.995)] || p.lim);
    const step = raw <= 20 ? 5 : raw <= 40 ? 10 : raw <= 100 ? 20 : 50;
    const yl = Math.ceil(raw / step) * step;
    const X = v => m.l + (Math.log(Math.max(0.15, Math.min(40, v))) - x0) / (x1 - x0) * iw;
    const Y = v => m.t + (1 - (Math.max(-yl, Math.min(yl, v)) + yl) / (2 * yl)) * ih;
    const R = r => Math.max(2, Math.min(W < 600 ? 8 : 12, Math.sqrt((r.amount_avg20 || 0) / 1e8) * (W < 600 ? 0.45 : 0.6)));
    const col = r => M.color === "ret" ? divColor(r[p.ret], p.lim) : divColor(r[p.smart], 1.5);
    rows = rows.slice().sort((a, b) => (b.amount_avg20 || 0) - (a.amount_avg20 || 0)); // 큰 점 먼저 → 작은 점이 위
    const score = r => Math.log(Math.max(1, r[p.vr])) * Math.abs(r[p.ret]);
    const top = rows.filter(r => r[p.vr] >= 3).sort((a, b) => score(b) - score(a)).slice(0, W < 600 ? 6 : 12);
    const topSet = new Set(top.map(r => r.code));
    const xt = [0.2, 0.5, 1, 2, 3, 5, 10, 20];
    const yt = []; for (let v = -yl; v <= yl + 1e-9; v += step) yt.push(v);
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
    const holdRows = rows.filter(r => holds.has(r.code));
    let labels = holdRows.map(r => `<circle cx="${X(r[p.vr])}" cy="${Y(r[p.ret])}" r="${R(r) + 5}" class="m-hold"/>`).join("");
    labels += holdRows.map(r => place(r, "m-hlabel", 12, true)).join("");
    labels += top.filter(r => !holds.has(r.code)).map(r => place(r, "m-label", 10.5, false)).join("");
    let svg = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="거래량 배수와 등락률 산점도">
      <rect x="${X(3)}" y="${m.t}" width="${X(40) - X(3)}" height="${ih}" class="m-zone"/>
      ${xt.map(v => `<line x1="${X(v)}" x2="${X(v)}" y1="${m.t}" y2="${m.t + ih}" class="m-grid${v === 1 ? " m-one" : ""}"/><text x="${X(v)}" y="${H - 26}" class="m-tick" text-anchor="middle">${v}x</text>`).join("")}
      ${yt.map(v => `<line x1="${m.l}" x2="${m.l + iw}" y1="${Y(v)}" y2="${Y(v)}" class="m-grid${v === 0 ? " m-zero" : ""}"/><text x="${m.l - 6}" y="${Y(v) + 4}" class="m-tick" text-anchor="end">${v > 0 ? "+" : ""}${Math.round(v)}%</text>`).join("")}
      <text x="${m.l + iw / 2}" y="${H - 6}" class="m-axis" text-anchor="middle">${p.vrLabel} (로그 축)</text>
      <text x="${X(3) + 6}" y="${m.t + 16}" class="m-zlabel">거래 폭발 + 상승</text>
      <text x="${X(3) + 6}" y="${m.t + ih - 8}" class="m-zlabel">거래 폭발 + 하락</text>
      <text x="${m.l + 6}" y="${m.t + 16}" class="m-qlabel">조용히 상승</text>
      <g class="m-dots">${rows.map((r, i) => `<circle data-i="${i}" cx="${X(r[p.vr]).toFixed(1)}" cy="${Y(r[p.ret]).toFixed(1)}" r="${R(r).toFixed(1)}" fill="${col(r)}"/>`).join("")}</g>
      ${labels}
    </svg>`;
    el.innerHTML = svg;
    el.querySelectorAll(".m-dots circle").forEach(c => {
      const r = rows[+c.dataset.i];
      c.addEventListener("mousemove", e => showTip(e, r));
      c.addEventListener("mouseleave", hideTip);
      c.addEventListener("click", () => { hideTip(); openDetail(r.code); });
    });
    // 이상 거래 상위 목록 (모바일에서 탭하기 쉽도록)
    const list = rows.filter(r => r[p.vr] >= 3).sort((a, b) => score(b) - score(a)).slice(0, 15);
    $("#mapOutliers").innerHTML = list.length ? `<div class="cg-h">거래량 3배↑ 중 움직임이 큰 종목 (${list.length})</div>
      <div class="ol">${list.map(r => `<button data-code="${r.code}"><span>${esc(r.name)}</span><span class="${fmt.cls(r[p.ret])}">${fmt.pct(r[p.ret])}</span><span class="mut">${r[p.vr].toFixed(1)}x</span><span class="${fmt.cls(r[p.smart])} small">수급 ${fmt.pct(r[p.smart], 2)}</span></button>`).join("")}</div>`
      : `<div class="mut small">이 기간에 거래량 3배 이상 종목이 없습니다</div>`;
    $("#mapOutliers").querySelectorAll("button").forEach(b => b.onclick = () => openDetail(b.dataset.code));
    $("#scatterLegend").innerHTML = legend(M.color === "ret" ? `등락(${M.period}일)` : `${p.flow} 순매수 / 발행주식`, M.color === "ret" ? p.lim : 1.5, M.color === "ret" ? 0 : 1)
      + `<span>점 크기 = 평소 거래대금</span><span><i class="ring"></i>보유 종목</span>`;
  }

  function legend(title, lim, d) {
    const steps = [-1, -0.5, 0, 0.5, 1];
    return `<span>${title}</span><span class="lg">${steps.map(s => `<i style="background:${divColor(s * lim, lim)}"></i>`).join("")}</span><span class="mut">−${lim.toFixed(d)}% … +${lim.toFixed(d)}%</span>`;
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
    const col = r => M.color === "ret" ? divColor(r[p.ret], p.lim) : divColor(r[p.smart], 1.5);
    const val = r => M.color === "ret" ? r[p.ret] : r[p.smart];
    const lim = M.color === "ret" ? p.lim : 1.5;
    const outer = squarify(secs.map(s => s[2]), 0, 0, W, H);
    let html = "", idx = [];
    secs.forEach(([name, list], si) => {
      const o = outer[si], hdr = o.w > 70 && o.h > 44 ? 17 : 0, pad = 1.5;
      list.sort((a, b) => b.marcap - a.marcap);
      const inner = squarify(list.map(r => r.marcap), o.x + pad, o.y + pad + hdr, Math.max(1, o.w - 2 * pad), Math.max(1, o.h - 2 * pad - hdr));
      // 업종 시총가중 등락
      const sw = list.reduce((s, r) => s + r.marcap, 0), sv = list.reduce((s, r) => s + r.marcap * (val(r) || 0), 0) / (sw || 1);
      if (hdr) {
        const pctTxt = `${sv >= 0 ? "+" : ""}${sv.toFixed(M.color === "ret" ? 1 : 2)}%`;
        const full = name.length * 11 + pctTxt.length * 7 + 14 < o.w;
        const nm = fit(name, o.w - 10 - (full ? pctTxt.length * 7 + 4 : 0), 11);
        html += `<text x="${o.x + 5}" y="${o.y + 13}" class="t-sec">${esc(nm)}${full ? ` <tspan class="${sv >= 0 ? "t-up" : "t-dn"}">${pctTxt}</tspan>` : ""}</text>`;
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
    el.querySelectorAll("rect.t-cell").forEach(c => {
      const r = idx[+c.dataset.i];
      c.addEventListener("mousemove", e => showTip(e, r));
      c.addEventListener("mouseleave", hideTip);
      c.addEventListener("click", () => { hideTip(); openDetail(r.code); });
    });
    $("#treeLegend").innerHTML = legend(M.color === "ret" ? `등락(${M.period}일)` : `${p.flow} 순매수 / 발행주식`, lim, M.color === "ret" ? 0 : 1)
      + `<span>면적 = 시가총액 · 시총 상위 ${N} · 업종 옆 숫자는 시총가중 평균</span><span><i class="ring"></i>보유 종목</span>`;
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
