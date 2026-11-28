/* 한눈에 보기 맨 위: 린치 지도 (가로 = 린치 지표, 세로 = 적정가 대비)
   점에 마우스 → 강조 + 툴팁, 누르면 종목 상세. app.js 의 state / fmt / $ / openDetail 사용 */
(function () {
  const CAT = { 0: ["분류 불가", "#b8bcc2"], 1: ["저성장주", "#8f98a3"], 2: ["대형우량주", "#2f6f6a"], 3: ["고성장주", "#2e9e5b"],
    4: ["경기순환주", "#d08a2e"], 5: ["회생주", "#7b61c9"], 6: ["자산주", "#3b82c4"] };
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const L = { liquid: true };
  try { Object.assign(L, JSON.parse(localStorage.getItem("lmap.v1") || "{}")); } catch (e) { /* 무시 */ }
  const save = () => { try { localStorage.setItem("lmap.v1", JSON.stringify(L)); } catch (e) { /* 무시 */ } };
  let tip;
  const XMAX = 10, YMIN = -100, YMAX = 150;  // 가로는 제곱근 눈금(0~3 구간을 넓게), 범위 밖 값은 가장자리에 빈 원으로

  function showTip(e, r) {
    const z = r.lynch_zone ? `<span class="badge ${r.lynch_zone_n > 0 ? "st-good" : r.lynch_zone_n < 0 ? "st-bad" : "st-na"}">${esc(r.lynch_zone)}</span>` : "";
    tip.innerHTML = `<b>${esc(r.name)}</b> <span class="mut">${r.code} · ${esc(r.sector_name || "–")}</span>
      <div><span class="lm-cat" style="background:${CAT[r.lynch_cat_n ?? 0][1]}"></span>${esc(r.lynch_cat || "–")} ${z}</div>
      <div>현재가 <b>${fmt.n(r.close)}</b> <b class="${fmt.cls(r.ret_1d)}">${fmt.pct(r.ret_1d)}</b> <span class="mut">전일 종가 대비</span></div>
      <div>린치 지표 <b>${r.lynch_ratio == null ? "–" : r.lynch_ratio.toFixed(2)}</b> · 적정가 대비 <b>${fmt.pct(r.lynch_gap, 0)}</b></div>
      <div>이익 성장 <b>${fmt.pct(r.lynch_g, 0)}</b>/년 · 예상 PER <b>${fmt.n(r.lynch_per, 1)}</b></div>
      <div>시총 <b>${fmt.won(r.marcap)}</b> · 20일 거래대금 <b>${fmt.won(r.amount_avg20)}</b></div>`;
    tip.style.display = "block";
    const x = e.clientX, y = e.clientY;
    tip.style.left = Math.max(8, Math.min(innerWidth - tip.offsetWidth - 8, x + 14)) + "px";
    tip.style.top = (y + tip.offsetHeight + 20 > innerHeight ? y - tip.offsetHeight - 12 : y + 14) + "px";
  }
  const hideTip = () => { if (tip) tip.style.display = "none"; };

  function render() {
    const el = $("#lynchMap");
    if (!el || !state.universe) return;
    const holds = new Set((state.latest.watchlist || []).map(w => w.code));
    const all = state.universe.filter(r => (!L.liquid || (r.amount_avg20 || 0) >= 1e9));
    let rows = all.filter(r => r.lynch_ratio != null && r.lynch_gap != null);
    const W = Math.max(320, el.clientWidth), H = Math.round(Math.max(340, Math.min(560, W * 0.55)));
    const m = { l: 62, r: 14, t: 14, b: 40 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
    const xmax = XMAX, cl = (v, a, b) => Math.max(a, Math.min(b, v));
    const X = v => m.l + Math.sqrt(cl(v, 0, xmax)) / Math.sqrt(xmax) * iw;
    const Y = v => m.t + (1 - (cl(v, YMIN, YMAX) - YMIN) / (YMAX - YMIN)) * ih;
    const mc = rows.map(r => r.marcap || 0).sort((a, b) => a - b);
    const R = r => Math.max(2.2, Math.min(W < 600 ? 9 : 14, Math.sqrt((r.marcap || 0) / 1e11) * (W < 600 ? 1.1 : 1.6)));
    rows = rows.slice().sort((a, b) => (b.marcap || 0) - (a.marcap || 0));  // 큰 점 먼저 → 작은 점이 위
    const xt = [0, 0.5, 1, 1.5, 2, 3, 5, 10], yt = [-50, -35, -20, 0, 20, 50, 100, 150];
    const ref = (v, axis) => axis === "x"
      ? `<line x1="${X(v)}" x2="${X(v)}" y1="${m.t}" y2="${m.t + ih}" class="${v === 1 ? "lm-main" : "m-grid"}"/>`
      : `<line x1="${m.l}" x2="${m.l + iw}" y1="${Y(v)}" y2="${Y(v)}" class="${v === 0 ? "lm-main" : "m-grid"}"/>`;
    // 라벨: 보유 종목 + '싸고 성장' 구역의 대형주 몇 개
    const placed = [];
    const hit = b => placed.some(q => b.x < q.x + q.w && b.x + b.w > q.x && b.y < q.y + q.h && b.y + b.h > q.y);
    const place = (r, cls, fs) => {
      const w = String(r.name).length * fs * 0.98, cx = X(r.lynch_ratio), cy = Y(r.lynch_gap), rr = R(r);
      for (const [dx, dy] of [[rr + 4, -rr - 2], [rr + 4, rr + fs], [-w - rr - 4, -rr - 2], [-w - rr - 4, rr + fs]]) {
        const x = cl(cx + dx, m.l + 2, W - m.r - w), y = cl(cy + dy, m.t + fs, m.t + ih - 2), b = { x, y: y - fs, w, h: fs + 2 };
        if (!hit(b)) { placed.push(b); return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" class="${cls}">${esc(r.name)}</text>`; }
      }
      return "";
    };
    const holdRows = rows.filter(r => holds.has(r.code));
    const good = rows.filter(r => !holds.has(r.code) && r.lynch_ratio >= 1.5 && r.lynch_gap <= -20).slice(0, W < 600 ? 5 : 10);
    let labels = holdRows.map(r => `<circle cx="${X(r.lynch_ratio)}" cy="${Y(r.lynch_gap)}" r="${R(r) + 5}" class="m-hold"/>`).join("");
    labels += holdRows.map(r => place(r, "m-hlabel", 12)).join("") + good.map(r => place(r, "m-label", 10.5)).join("");
    const gx = X(1.5), gy = Y(-20), bx = X(1), by = Y(20);
    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="m-svg" role="img" aria-label="린치 지표와 적정가 대비 산점도">
      <defs><clipPath id="lmclip"><rect x="${m.l}" y="${m.t}" width="${iw}" height="${ih}"/></clipPath></defs>
      <rect x="${gx}" y="${gy}" width="${m.l + iw - gx}" height="${m.t + ih - gy}" class="lm-good"/>
      <rect x="${m.l}" y="${m.t}" width="${bx - m.l}" height="${by - m.t}" class="lm-bad"/>
      ${xt.map(v => ref(v, "x") + `<text x="${X(v)}" y="${H - 22}" class="m-tick" text-anchor="middle">${v}</text>`).join("")}
      ${yt.map(v => ref(v, "y") + `<text x="${m.l - 6}" y="${Y(v) + 4}" class="m-tick" text-anchor="end">${v > 0 ? "+" : ""}${v}%</text>`).join("")}
      <text x="${m.l + iw / 2}" y="${H - 4}" class="m-axis" text-anchor="middle">린치 지표 → (오른쪽일수록 성장·배당에 비해 쌈, 1 = 적정 · 제곱근 눈금)</text>
      <text transform="translate(12 ${m.t + ih / 2}) rotate(-90)" class="m-axis" text-anchor="middle">적정가 대비 (아래일수록 쌈)</text>
      <text x="${m.l + iw - 6}" y="${m.t + ih - 8}" class="m-zlabel" text-anchor="end">싸고 성장 (지표 1.5↑ · 적정가 −20%↓)</text>
      <text x="${m.l + 6}" y="${m.t + 16}" class="m-zlabel">성장에 비해 비쌈</text>
      <g class="m-dots lm-dots" clip-path="url(#lmclip)">${rows.map((r, i) => `<circle data-i="${i}" cx="${X(r.lynch_ratio).toFixed(1)}" cy="${Y(r.lynch_gap).toFixed(1)}" r="${R(r).toFixed(1)}" fill="${CAT[r.lynch_cat_n ?? 0][1]}"${r.lynch_ratio > xmax || r.lynch_ratio < 0 || r.lynch_gap > YMAX || r.lynch_gap < YMIN ? ` class="lm-clip" stroke="${CAT[r.lynch_cat_n ?? 0][1]}"` : ""}/>`).join("")}</g>
      <g clip-path="url(#lmclip)">${labels}</g>
      <g class="lm-hi" pointer-events="none"></g>
    </svg>`;
    el.querySelectorAll(".lm-dots circle").forEach(c => {
      const r = rows[+c.dataset.i], r0 = c.getAttribute("r");
      // 강조는 맨 위 별도 층에 겹쳐 그린다 (점 자체를 옮기면 클릭이 끊김)
      c.addEventListener("mouseenter", () => { el.querySelector(".lm-hi").innerHTML = `<circle cx="${c.getAttribute("cx")}" cy="${c.getAttribute("cy")}" r="${(+r0 + 3).toFixed(1)}" fill="${c.getAttribute("fill")}" class="lm-hic"/>`; });
      c.addEventListener("mousemove", e => showTip(e, r));
      c.addEventListener("mouseleave", () => { el.querySelector(".lm-hi").innerHTML = ""; hideTip(); });
      c.addEventListener("click", () => { hideTip(); openDetail(r.code); });
    });
    const used = [...new Set(rows.map(r => r.lynch_cat_n ?? 0))].sort();
    const noGap = all.filter(r => r.lynch_ratio != null && r.lynch_gap == null).length;
    $("#lynchLegend").innerHTML = used.map(c => `<span><i style="background:${CAT[c][1]}"></i>${CAT[c][0]}</span>`).join("")
      + `<span>점 크기 = 시가총액</span><span><i class="ring"></i>보유 종목</span>`
      + `<span class="mut">${rows.length}종목 표시 · 이익 감소·성장률 5% 미만 등으로 적정가가 없는 ${noGap}종목은 제외 · 빈 원 = 축 범위(지표 10, 적정가 +150%) 밖이라 가장자리에 표시</span>`;
    // 모바일에서 누르기 쉬운 목록: 싸고 성장 구역
    const list = rows.filter(r => r.lynch_ratio >= 1.5 && r.lynch_gap <= -20).sort((a, b) => b.lynch_ratio - a.lynch_ratio).slice(0, 15);
    $("#lynchList").innerHTML = list.length ? `<div class="cg-h">싸고 성장 구역 (${list.length}) <span class="mut">린치 지표 높은 순 · 컨센서스가 낡았을 수 있으니 확인 필요</span></div>
      <div class="ol">${list.map(r => `<button data-code="${r.code}"><span>${esc(r.name)}</span><span><b>${r.lynch_ratio.toFixed(2)}</b></span><span class="${r.lynch_gap < 0 ? "fl-up" : "fl-dn"}">${fmt.pct(r.lynch_gap, 0)}</span><span class="mut small">${esc(r.lynch_cat || "")}</span></button>`).join("")}</div>` : "";
    $("#lynchList").querySelectorAll("button").forEach(b => b.onclick = () => openDetail(b.dataset.code));
    const cb = $("#lmLiquid"); if (cb) { cb.checked = L.liquid; cb.onchange = e => { L.liquid = e.target.checked; save(); render(); }; }
  }

  const _r = window.renderMap;
  window.renderMap = function () { if (_r) _r(); if ($("#tab-map")?.classList.contains("on")) render(); };
  const mk = () => { if (!tip) { tip = document.createElement("div"); tip.className = "m-tip"; document.body.appendChild(tip); } };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mk); else mk();
  let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if ($("#tab-map")?.classList.contains("on")) render(); }, 200); });
})();
