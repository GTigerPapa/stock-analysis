/* 종목 상세 drawer (전 종목). app.js 의 state / fmt / $ / verdict / featureGrid / loadPos 를 사용하고
   openDetail · loadStock 을 이 파일의 구현으로 교체한다. */
(function () {
  const CACHE = {};
  let SERIES = null;
  let charts = [];
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const css = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const isDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
  const UP = "#d1453b", DN = "#2f6fe0";
  const UPa = a => `rgba(209,69,59,${a})`, DNa = a => `rgba(47,111,224,${a})`;
  const FR = () => css("--frgn") || "#2dd4bf", IN = () => css("--inst") || "#fbbf24";
  const rgba = (hex, a) => { const h = hex.replace("#", ""); const n = parseInt(h.length === 3 ? h.split("").map(c => c + c).join("") : h, 16); return `rgba(${n >> 16 & 255},${n >> 8 & 255},${n & 255},${a})`; };

  window.loadStock = async function (code) {
    if (CACHE[code]) return CACHE[code];
    const r = await fetch(`data/stock/${code}.json`, { cache: "no-store" });
    if (!r.ok) throw new Error("no detail");
    const j = await r.json();
    j.prices = j.d; // 보유 탭 스파크라인 호환
    return CACHE[code] = j;
  };
  async function loadSeries() {
    if (SERIES) return SERIES;
    try { const r = await fetch("data/series.json", { cache: "no-store" }); SERIES = r.ok ? await r.json() : {}; } catch (e) { SERIES = {}; }
    return SERIES;
  }

  // ---------- 공통 계산 ----------
  const sma = (a, n) => a.map((_, i) => i < n - 1 ? null : a.slice(i - n + 1, i + 1).reduce((s, v) => s + v, 0) / n);
  function stages(close) {
    const m150 = sma(close, 150), out = []; let prev = 1;
    for (let i = 0; i < close.length; i++) {
      if (m150[i] == null || m150[i - 20] == null) { out.push(null); continue; }
      const up = m150[i] > m150[i - 20];
      let s;
      if (close[i] > m150[i] && up) s = 2; else if (close[i] < m150[i] && !up) s = 4; else s = (prev === 4 || prev === 1) ? 1 : 3;
      out.push(s); prev = s;
    }
    return out;
  }
  const STAGE = { 1: ["1단계 바닥", "rgba(140,150,165,.13)"], 2: ["2단계 상승", "rgba(47,140,120,.16)"], 3: ["3단계 천장", "rgba(214,160,60,.16)"], 4: ["4단계 하락", "rgba(209,69,59,.12)"] };

  // ---------- drawer ----------
  window.openDetail = async function (code, o) {
    const back = o && o.back ? `<button class="back-btn" id="backBtn">← ${esc(o.back)}</button>` : "";
    const bindBack = () => { const b = $("#backBtn"); if (b) b.onclick = () => window.openSector(o.back); };
    const u = state.universe.find(r => r.code === code) || {};
    $("#detail").classList.add("on"); $("#scrim").classList.add("on"); $("#detail").setAttribute("aria-hidden", "false");
    const body = $("#detailBody");
    body.innerHTML = `${back}<div class="dh"><div class="meta">${code}</div><h2>${esc(u.name || "")}</h2><div class="empty">불러오는 중…</div></div>`; bindBack();
    let d;
    try { d = await window.loadStock(code); } catch (e) {
      body.innerHTML = `${back}<div class="dh"><h2>${esc(u.name || code)}</h2><p class="hint">상세 데이터가 아직 없습니다. 다음 일일 실행에서 생성됩니다.</p></div>${featureGrid(u)}`; bindBack();
      return;
    }
    await loadSeries();
    const f = d.f || {};
    const closes = d.d.map(r => r[4]);
    const st = stages(closes), curStage = st[st.length - 1];
    const dart = `https://dart.fss.or.kr/dsab007/main.do?option=corp&textCrpNm=${encodeURIComponent(d.name)}`;
    const naverUrl = `https://m.stock.naver.com/domestic/stock/${code}/total`;
    body.innerHTML = `${back}
      ${d.sector_name ? `<div class="sec-banner"><b>${esc(d.sector_name)}</b> ${esc(d.sector_desc || "")}</div>` : ""}
      <div class="dh"><div class="meta">${code} · ${esc(d.market || "")} · 시총 ${fmt.won(f.marcap)}</div><h2>${esc(d.name)}
        ${curStage ? `<span class="stage-badge s${curStage}">${STAGE[curStage][0]}</span>` : ""}</h2>
        <div class="px">${fmt.n(f.close)}<small class="${fmt.cls(f.ret_1d)}">${fmt.pct(f.ret_1d)}</small>${f.nxt_close && f.nxt_close !== f.close ? `<small class="mut">NXT ${fmt.n(f.nxt_close)} (${fmt.pct(f.nxt_gap, 2)})</small>` : ""}</div></div>
      <div class="desc">${d.desc ? esc(d.desc) : `<span class="mut">종목 설명이 아직 수집되지 않았습니다(주 1회 갱신).</span>`}
        <div class="links"><a href="${dart}" target="_blank" rel="noopener">DART 공시·사업보고서 ↗</a><a href="${naverUrl}" target="_blank" rel="noopener">네이버 증권 ↗</a></div></div>
      ${verdict(f)}

      <div class="sec"><h4>가격 · 추세 단계 <span class="mut">배경 = Weinstein 단계(150일선 기준) · 아래 거래량 = 빨강 상승일(매수 우위) / 파랑 하락일(매도 우위)</span></h4>
        <div class="chart tall" id="chPx"></div><div class="chart vol" id="chVol"></div>
        <div class="legend"><span><i style="background:#e0a100"></i>MA20</span><span><i style="background:#2f8c78"></i>MA60</span><span><i style="background:#8b5cf6"></i>MA120</span><span><i style="background:#8a94a3"></i>MA200</span>
          ${[1, 2, 3, 4].map(s => `<span><i class="sw" style="background:${STAGE[s][1].replace(/[\d.]+\)$/, ".7)")}"></i>${STAGE[s][0]}</span>`).join("")}</div></div>

      <div class="sec"><h4><span class="c-frgn">외국인</span>·<span class="c-inst">기관</span> 일별 순매수 <span class="mut">0선 위 = 순매수, 아래 = 순매도 (천 주) · 극단값 상위 2%는 축 밖으로 잘림</span>
        <label class="chk inline"><input type="checkbox" id="flowSmooth"> 5일 평균</label></h4>
        <div class="chart mid" id="chFlow"></div>
        <div class="legend"><span><i style="background:${FR()}"></i>외국인</span><span><i style="background:${IN()}"></i>기관</span></div>
        <div class="flow-sum" id="flowSum"></div></div>

      <div class="sec"><h4>거래량 배수 <span class="mut">그날 거래량 ÷ 20·60·120일 평균 (로그 축, 1x = 평소)</span>
        <label class="chk inline"><input type="checkbox" id="vrSmooth"> 5일 평활</label></h4>
        <div class="chart mid" id="chVr"></div>
        <div class="legend"><span><i style="background:#e0a100"></i>÷20일 평균</span><span><i style="background:#2f8c78"></i>÷60일 평균</span><span><i style="background:#8b5cf6"></i>÷120일 평균</span></div></div>

      <div class="grid2">
        <div class="sec"><h4>매물대 <span class="mut">최근 1년 가격대별 거래량</span></h4><div id="vp" class="svgbox"></div></div>
        <div class="sec"><h4>상대강도 <span class="mut">기간 시작 = 100</span>
          <span class="seg mini" id="rsSeg">${[["63", "3M"], ["126", "6M"], ["250", "1Y"], ["500", "2Y"]].map(([v, l]) => `<button data-v="${v}" class="${v === "250" ? "on" : ""}">${l}</button>`).join("")}</span></h4>
          <div class="chart sm2" id="chRs"></div><div class="legend" id="rsLegend"></div></div>
      </div>

      <div class="sec"><h4>업종 내 위치 <span class="mut">회색 = 같은 업종 종목 · ◆ = 업종 평균 · ● = 이 종목 · 오른쪽일수록 업종 내 상위</span></h4><div id="peer" class="svgbox"></div></div>

      <div class="sec"><h4>실적 <span class="seg mini" id="finSeg"><button data-v="fq" class="on">분기</button><button data-v="fa">연간</button></span>
        <span class="mut">억원 · 점선 = 컨센서스</span></h4><div id="finChart" class="svgbox"></div><div id="finTbl"></div></div>

      <div class="sec"><h4>수급 캘린더 <span class="mut">하루 1칸 · 색 = 순매수 ÷ 20일 평균 거래량</span></h4><div id="cal" class="svgbox"></div></div>

      <div class="sec"><h4>월별 Trend <span class="mut">연초 첫 거래일 종가 대비 각 달 말 종가 · 연도별 선, 점 = 한 달</span></h4><div id="mon" class="svgbox"></div></div>

      <details class="sec"><summary>전체 지표 보기</summary>${featureGrid(f)}</details>`;

    bindBack();
    drawMain(d, st);
    drawVolumeProfile(d);
    drawRS(d, 250);
    $("#rsSeg").querySelectorAll("button").forEach(b => b.onclick = () => {
      $("#rsSeg").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); drawRS(d, +b.dataset.v);
    });
    drawPeers(d);
    drawFin(d, "fq");
    $("#finSeg").querySelectorAll("button").forEach(b => b.onclick = () => {
      $("#finSeg").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); drawFin(d, b.dataset.v);
    });
    drawCalendar(d);
    drawMonthly(d);
  };

  // ---------- 가격 + 수급 + 거래량배수 (가로축 동기화) ----------
  function baseOpts() {
    const dark = isDark();
    return {
      layout: { background: { color: "transparent" }, textColor: dark ? "#9aa3ad" : "#6b7280", fontFamily: "inherit", fontSize: 11 },
      grid: { vertLines: { color: dark ? "#22272c" : "#f0efeb" }, horzLines: { color: dark ? "#22272c" : "#f0efeb" } },
      rightPriceScale: { borderVisible: false, minimumWidth: 74 },
      timeScale: { borderVisible: false, rightOffset: 0, fixLeftEdge: true, fixRightEdge: true, lockVisibleTimeRangeOnResize: true },
      crosshair: { mode: 0 }, handleScroll: true, handleScale: true, autoSize: true,
      localization: { locale: "ko-KR", priceFormatter: v => Math.round(v).toLocaleString("ko-KR") },
    };
  }
  function drawMain(d, st) {
    charts.forEach(c => c.remove()); charts = [];
    const dates = d.d.map(r => r[0]), close = d.d.map(r => r[4]), vol = d.d.map(r => r[5]);
    const N = dates.length;
    // 가격
    const c1 = LightweightCharts.createChart($("#chPx"), baseOpts()); charts.push(c1);
    const bg = c1.addHistogramSeries({ priceScaleId: "bg", lastValueVisible: false, priceLineVisible: false });
    c1.priceScale("bg").applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
    bg.setData(dates.map((t, i) => st[i] ? { time: t, value: 1, color: STAGE[st[i]][1] } : { time: t }));
    const cs = c1.addCandlestickSeries({ upColor: UP, downColor: DN, borderVisible: false, wickUpColor: UP, wickDownColor: DN });
    cs.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.04 } });
    cs.setData(d.d.map(r => ({ time: r[0], open: r[1], high: r[2], low: r[3], close: r[4] })));
    // 거래량: 별도 패널 (가격 축이 음수로 늘어나지 않게, 막대가 잘 보이게)
    const cV = LightweightCharts.createChart($("#chVol"), Object.assign(baseOpts(), {
      localization: { locale: "ko-KR", priceFormatter: v => v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? Math.round(v / 1e3) + "K" : Math.round(v) },
    })); charts.push(cV);
    const vs = cV.addHistogramSeries({ lastValueVisible: false, priceLineVisible: false });
    vs.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0 } });
    vs.setData(d.d.map((r, i) => ({ time: r[0], value: r[5], color: (i && r[4] < close[i - 1]) ? DNa(.75) : UPa(.75) })));
    [[20, "#e0a100"], [60, "#2f8c78"], [120, "#8b5cf6"], [200, "#8a94a3"]].forEach(([n, color]) => {
      const m = sma(close, n), s = c1.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      s.setData(dates.map((t, i) => m[i] == null ? { time: t } : { time: t, value: m[i] }));
    });

    // 수급: 외국인·기관 일별 순매수를 한 축(같은 0선, 같은 눈금)에 겹친 라인
    const invMap = new Map((d.inv || []).map(r => [r[0], r]));
    const c2 = LightweightCharts.createChart($("#chFlow"), Object.assign(baseOpts(), {
      localization: { locale: "ko-KR", priceFormatter: v => (v > 0 ? "+" : "") + Math.round(v / 1000).toLocaleString("ko-KR") + "K" },
    })); charts.push(c2);
    const lineOpt = color => ({ color, lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerRadius: 3 });
    const fS = c2.addLineSeries(lineOpt(FR())), iS = c2.addLineSeries(lineOpt(IN()));
    fS.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.06 } });
    const rawF = dates.map(t => { const r = invMap.get(t); return r && r[1] != null ? r[1] : null; });
    const rawI = dates.map(t => { const r = invMap.get(t); return r && r[2] != null ? r[2] : null; });
    const ma5 = a => a.map((_, i) => { const w = a.slice(Math.max(0, i - 4), i + 1).filter(x => x != null); return w.length === 5 ? w.reduce((s, x) => s + x, 0) / 5 : null; });
    const zc = isDark() ? "#5b636c" : "#b9b9b4";
    fS.createPriceLine({ price: 0, color: zc, lineWidth: 1, lineStyle: 0, axisLabelVisible: false });
    const setFlow = smooth => {
      const F = smooth ? ma5(rawF) : rawF, I = smooth ? ma5(rawI) : rawI;
      // 0을 가운데 둔 대칭 눈금. 상위 2% 극단값은 제외 (튀는 하루가 나머지를 납작하게 만들지 않게)
      const absV = F.concat(I).filter(x => x != null).map(Math.abs).sort((a, b) => a - b);
      const mxv = Math.max(1, (absV[Math.floor(absV.length * 0.98)] || 1) * 1.1);
      const sym = () => ({ priceRange: { minValue: -mxv, maxValue: mxv } });
      fS.applyOptions({ autoscaleInfoProvider: sym }); iS.applyOptions({ autoscaleInfoProvider: sym });
      fS.setData(dates.map((t, i) => F[i] == null ? { time: t } : { time: t, value: F[i] }));
      iS.setData(dates.map((t, i) => I[i] == null ? { time: t } : { time: t, value: I[i] }));
    };
    setFlow(false);
    $("#flowSmooth").onchange = e => setFlow(e.target.checked);
    const sumN = n => { const rs = (d.inv || []).slice(-n); return [rs.reduce((s, r) => s + (r[1] || 0), 0), rs.reduce((s, r) => s + (r[2] || 0), 0)]; };
    const [f20, i20] = sumN(20), [f60, i60] = sumN(60);
    const k = v => `<b>${v > 0 ? "+" : ""}${Math.round(v / 1000).toLocaleString()}천 주</b> ${v >= 0 ? "순매수" : "순매도"}`;
    $("#flowSum").innerHTML = `<span><span class="c-frgn">외국인</span> 20일 ${k(f20)} · 60일 ${k(f60)}</span><span><span class="c-inst">기관</span> 20일 ${k(i20)} · 60일 ${k(i60)}</span>`;

    // 거래량 배수
    const c3 = LightweightCharts.createChart($("#chVr"), Object.assign(baseOpts(), {
      rightPriceScale: { borderVisible: false, minimumWidth: 74, mode: 1 },
      localization: { locale: "ko-KR", priceFormatter: v => (v < 10 ? v.toFixed(1) : Math.round(v)) + "x" },
    })); charts.push(c3);
    const vrSeries = [[20, "#e0a100"], [60, "#2f8c78"], [120, "#8b5cf6"]].map(([n, color]) => [n, c3.addLineSeries({ color, lineWidth: 1.5, priceLineVisible: false, lastValueVisible: true })]);
    const one = vrSeries[0][1].createPriceLine({ price: 1, color: isDark() ? "#5b636c" : "#b9b9b4", lineWidth: 1, lineStyle: 2, axisLabelVisible: false });
    const setVr = smooth => vrSeries.forEach(([n, s]) => {
      const m = sma(vol, n);
      let r = vol.map((v, i) => m[i] ? v / m[i] : null);
      if (smooth) r = r.map((_, i) => { const w = r.slice(Math.max(0, i - 4), i + 1).filter(x => x != null); return w.length === 5 ? w.reduce((a, b) => a + b, 0) / 5 : null; });
      s.setData(dates.map((t, i) => r[i] == null || r[i] <= 0 ? { time: t } : { time: t, value: Math.max(0.05, r[i]) }));
    });
    setVr(false);
    $("#vrSmooth").onchange = e => setVr(e.target.checked);

    // 동기화: 보이는 범위 + 십자선
    const all = [c1, cV, c2, c3];
    let syncing = false;
    all.forEach(src => src.timeScale().subscribeVisibleLogicalRangeChange(rg => {
      if (syncing || !rg) return; syncing = true;
      all.forEach(dst => dst !== src && dst.timeScale().setVisibleLogicalRange(rg)); syncing = false;
    }));
    const firstSeries = new Map([[c1, cs], [cV, vs], [c2, fS], [c3, vrSeries[0][1]]]);
    all.forEach(src => src.subscribeCrosshairMove(p => {
      all.forEach(dst => {
        if (dst === src) return;
        if (!p || !p.time) dst.clearCrosshairPosition?.();
        else dst.setCrosshairPosition?.(0, p.time, firstSeries.get(dst));
      });
    }));
    c1.timeScale().setVisibleLogicalRange({ from: Math.max(0, N - 250), to: N - 1 });
  }

  // ---------- 매물대 ----------
  function drawVolumeProfile(d) {
    const rows = d.d.slice(-250), el = $("#vp");
    if (rows.length < 20) { el.innerHTML = `<div class="empty">데이터 부족</div>`; return; }
    const lo = Math.min(...rows.map(r => r[3])), hi = Math.max(...rows.map(r => r[2])), B = 28, step = (hi - lo) / B || 1;
    const vol = new Array(B).fill(0);
    rows.forEach(r => {
      const a = Math.max(0, Math.floor((r[3] - lo) / step)), b = Math.min(B - 1, Math.floor((r[2] - lo) / step));
      for (let i = a; i <= b; i++) vol[i] += r[5] / (b - a + 1);
    });
    const cur = rows[rows.length - 1][4];
    let avg = 0; try { avg = +((typeof loadPos === "function" ? loadPos() : {})[d.code]?.avg || 0); } catch (e) { /* 무시 */ }
    const W = 360, H = 260, L = 52, R = 8, T = 6, Bm = 18, mx = Math.max(...vol);
    const y = p => T + (1 - (p - lo) / (hi - lo)) * (H - T - Bm);
    const over = vol.reduce((s, v, i) => s + (lo + (i + .5) * step > cur ? v : 0), 0) / vol.reduce((s, v) => s + v, 0) * 100;
    let s = `<svg viewBox="0 0 ${W} ${H}" class="vp">`;
    vol.forEach((v, i) => {
      const p0 = lo + i * step, mid = p0 + step / 2, w = v / mx * (W - L - R);
      s += `<rect x="${L}" y="${y(p0 + step) + .5}" width="${w.toFixed(1)}" height="${Math.max(1, y(p0) - y(p0 + step) - 1).toFixed(1)}" class="${mid > cur ? "vp-over" : "vp-under"}"/>`;
    });
    [lo, (lo + hi) / 2, hi].forEach(p => s += `<text x="${L - 4}" y="${y(p) + 4}" class="ax" text-anchor="end">${fmt.n(p)}</text>`);
    s += `<line x1="${L}" x2="${W - R}" y1="${y(cur)}" y2="${y(cur)}" class="vp-cur"/><text x="${W - R}" y="${y(cur) - 4}" class="vp-t" text-anchor="end">현재 ${fmt.n(cur)}</text>`;
    if (avg > lo * 0.7 && avg < hi * 1.3) {
      const ya = y(Math.min(hi, Math.max(lo, avg)));
      s += `<line x1="${L}" x2="${W - R}" y1="${ya}" y2="${ya}" class="vp-avg"/><text x="${W - R}" y="${ya - 4}" class="vp-ta" text-anchor="end">내 평단 ${fmt.n(avg)}</text>`;
    }
    s += `<text x="${W - R}" y="${H - 4}" class="vp-ta" text-anchor="end">현재가 위 매물 ${over.toFixed(0)}%</text></svg>`;
    el.innerHTML = s + (avg ? "" : `<div class="mut small">보유 탭에 평단을 입력하면 여기에 표시됩니다</div>`);
  }

  // ---------- 상대강도 ----------
  let rsChart = null;
  function drawRS(d, n) {
    if (rsChart) { rsChart.remove(); charts = charts.filter(c => c !== rsChart); }
    const el = $("#chRs"), S = SERIES || {};
    const dates = S.dates || [], idx = new Map(dates.map((t, i) => [t, i]));
    const px = d.d.slice(-(n + 1)), t0 = px[0][0], base = px[0][4];
    const mk = (S.market || {})[d.market], sc = (S.sector || {})[d.sector_name];
    const rebase = arr => { if (!arr) return null; const i0 = idx.get(t0); if (i0 == null) return null; const b = arr[i0]; return px.map(r => { const i = idx.get(r[0]); return i == null ? { time: r[0] } : { time: r[0], value: arr[i] / b * 100 }; }); };
    rsChart = LightweightCharts.createChart(el, Object.assign(baseOpts(), { localization: { locale: "ko-KR", priceFormatter: v => v.toFixed(0) } })); charts.push(rsChart);
    const lines = [
      [d.name, px.map(r => ({ time: r[0], value: r[4] / base * 100 })), isDark() ? "#e7e9ec" : "#1f2328", 2],
      [`업종(${d.sector_name || "–"})`, rebase(sc), "#2f8c78", 1.5],
      [`시장(${d.market})`, rebase(mk), "#8a94a3", 1.5],
    ];
    const leg = [];
    lines.forEach(([name, data, color, w]) => {
      if (!data) return;
      const s = rsChart.addLineSeries({ color, lineWidth: w, priceLineVisible: false, lastValueVisible: true });
      s.setData(data);
      const last = [...data].reverse().find(x => x.value != null);
      leg.push(`<span><i style="background:${color}"></i>${esc(name)} <b class="${fmt.cls(last.value - 100)}">${fmt.pct(last.value - 100, 0)}</b></span>`);
    });
    rsChart.timeScale().fitContent();
    $("#rsLegend").innerHTML = leg.join("") + `<span class="mut">업종·시장 = 동일가중 평균</span>`;
  }

  // ---------- 업종 내 위치 ----------
  function drawPeers(d) {
    const el = $("#peer"), peers = state.universe.filter(r => r.sector_name && r.sector_name === d.sector_name);
    if (peers.length < 3) { el.innerHTML = `<div class="empty">비교할 동종 종목이 부족합니다</div>`; return; }
    const me = peers.find(r => r.code === d.code) || d.f;
    const M = [
      ["ret_60", "60일 수익률", 1, v => fmt.pct(v)], ["ret_250", "1년 수익률", 1, v => fmt.pct(v)], ["slope_120", "120일 추세", 1, v => fmt.pct(v, 0)],
      ["smart_net_20_pct", "외+기 수급 20일", 1, v => fmt.pct(v, 2)], ["smart_net_60_pct", "외+기 수급 60일", 1, v => fmt.pct(v, 2)],
      ["frgn_net_60_pct", "외국인 60일", 1, v => fmt.pct(v, 2)], ["inst_net_60_pct", "기관 60일", 1, v => fmt.pct(v, 2)],
      ["op_yoy", "영업이익 YoY", 1, v => fmt.pct(v, 0)], ["per", "PER (낮을수록 오른쪽)", -1, v => fmt.n(v, 1) + "배"], ["pbr", "PBR (낮을수록 오른쪽)", -1, v => fmt.n(v, 2) + "배"],
    ];
    const W = 720, rowH = 30, L = 150, R = 110, H = M.length * rowH + 26;
    const X = p => L + p / 100 * (W - L - R);
    let s = `<svg viewBox="0 0 ${W} ${H}" class="peer">`;
    [0, 25, 50, 75, 100].forEach(p => s += `<line x1="${X(p)}" x2="${X(p)}" y1="4" y2="${H - 20}" class="pg"/><text x="${X(p)}" y="${H - 6}" class="ax" text-anchor="middle">${p === 0 ? "하위" : p === 100 ? "상위" : p}</text>`);
    M.forEach(([k, label, dir, f], i) => {
      const vals = peers.map(r => r[k]).filter(v => v != null && isFinite(v) && !(dir < 0 && v <= 0));
      const y = 16 + i * rowH;
      s += `<text x="${L - 10}" y="${y + 4}" class="pl" text-anchor="end">${label}</text>`;
      if (vals.length < 3) { s += `<text x="${X(50)}" y="${y + 4}" class="ax" text-anchor="middle">데이터 부족</text>`; return; }
      const sorted = [...vals].sort((a, b) => dir * (a - b));
      const pct = v => { const n = sorted.filter(x => dir * (x - v) < 0).length; return n / (sorted.length - 1 || 1) * 100; };
      vals.forEach(v => s += `<circle cx="${X(pct(v)).toFixed(1)}" cy="${y}" r="3.2" class="pd"/>`);
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length, mp = X(pct(mean));
      s += `<path d="M${mp} ${y - 7} L${mp + 6} ${y} L${mp} ${y + 7} L${mp - 6} ${y} Z" class="pm"><title>업종 평균 ${f(mean)}</title></path>`;
      const v = me[k];
      if (v != null && isFinite(v) && !(dir < 0 && v <= 0)) {
        s += `<circle cx="${X(pct(v))}" cy="${y}" r="6.5" class="pme"><title>${f(v)}</title></circle>`;
        s += `<text x="${W - R + 8}" y="${y + 4}" class="pv">${f(v)} <tspan class="pmv">평균 ${f(mean)}</tspan></text>`;
      } else s += `<text x="${W - R + 8}" y="${y + 4}" class="pmv">– · 평균 ${f(mean)}</text>`;
    });
    el.innerHTML = s + `</svg><div class="mut small">${esc(d.sector_name)} ${peers.length}개 종목 기준. PER·PBR은 적자(음수) 종목 제외.</div>`;
  }

  // ---------- 실적 ----------
  function drawFin(d, kind) {
    const rows = (d[kind] || []).filter(r => r["매출액"] != null || r["영업이익"] != null).slice(kind === "fq" ? -8 : -6);
    const el = $("#finChart");
    if (!rows.length) { el.innerHTML = `<div class="empty">재무 데이터 없음</div>`; $("#finTbl").innerHTML = ""; return; }
    const W = 720, H = 230, L = 10, R = 10, gap = 18, colW = (W - L - R) / rows.length;
    const items = [["매출액", 0.42], ["영업이익", 0.42]];
    let s = `<svg viewBox="0 0 ${W} ${H}" class="fin-svg">`;
    items.forEach(([item, frac], k) => {
      const vals = rows.map(r => r[item] ?? 0), mx = Math.max(...vals.map(Math.abs), 1);
      const top = 18 + k * (H / 2), h = H / 2 - 40, zero = top + h * (Math.min(...vals) < 0 ? mx / (mx + Math.abs(Math.min(...vals))) : 1);
      const sc = h / (mx + Math.max(0, -Math.min(...vals)));
      s += `<text x="${L}" y="${top - 6}" class="pl">${item}</text>`;
      rows.forEach((r, i) => {
        const v = r[item] ?? 0, x = L + i * colW + gap / 2, w = colW - gap, bh = Math.abs(v) * sc;
        const cls = r.consensus ? "fb-c" : v < 0 ? "fb-n" : k === 0 ? "fb-r" : "fb-o";
        s += `<rect x="${x}" y="${v >= 0 ? zero - bh : zero}" width="${w}" height="${Math.max(1, bh)}" rx="2" class="${cls}"/>`;
        let lab = fmt.n(v);
        if (k === 1 && r["영업이익률"] != null) lab += ` (${r["영업이익률"].toFixed(1)}%)`;
        s += `<text x="${x + w / 2}" y="${v >= 0 ? zero - bh - 4 : zero + bh + 12}" class="fv" text-anchor="middle">${lab}</text>`;
        if (k === 1) s += `<text x="${x + w / 2}" y="${H - 4}" class="ax" text-anchor="middle">${kind === "fq" ? r.period.slice(2, 4) + "." + r.period.slice(4) : r.period.slice(0, 4)}${r.consensus ? "E" : ""}</text>`;
      });
    });
    el.innerHTML = s + "</svg>";
    $("#finTbl").innerHTML = `<details><summary>표로 보기</summary>${finTable(rows)}</details>`;
  }

  // ---------- 수급 캘린더 ----------
  function drawCalendar(d) {
    const el = $("#cal"), inv = (d.inv || []).slice(-250);
    if (!inv.length) { el.innerHTML = `<div class="empty">수급 데이터 없음</div>`; return; }
    const vol = new Map(d.d.map(r => [r[0], r[5]]));
    const vs = d.d.map(r => r[5]), m20 = sma(vs, 20), avg = new Map(d.d.map((r, i) => [r[0], m20[i]]));
    const t0 = new Date(inv[0][0]), cell = 11, gapW = 2;
    const wk = t => Math.floor((new Date(t) - t0) / 864e5 / 7 + (t0.getDay() - 1) / 7);
    const weeks = wk(inv[inv.length - 1][0]) + 1;
    const W = 40 + weeks * (cell + gapW), rowsH = 5 * (cell + gapW);
    const gray = isDark() ? "150,156,168" : "95,100,112";
    const colorOf = (hex) => r => { const a = Math.min(1, Math.abs(r) / 0.25); return r > 0 ? rgba(hex, .15 + .85 * a) : r < 0 ? `rgba(${gray},${.12 + .7 * a})` : "rgba(140,140,140,.12)"; };
    const COL = { 1: colorOf(FR()), 2: colorOf(IN()) };
    let s = `<svg viewBox="0 0 ${W} ${rowsH * 2 + 50}" class="cal">`;
    [["외국인", 1, 14], ["기관", 2, 14 + rowsH + 22]].forEach(([lab, col, y0]) => {
      s += `<text x="0" y="${y0 + rowsH / 2 + 3}" class="pl" style="fill:${col === 1 ? FR() : IN()};font-weight:700">${lab}</text>`;
      inv.forEach(r => {
        const dt = new Date(r[0]), dw = dt.getDay() - 1; if (dw < 0 || dw > 4) return;
        const a = avg.get(r[0]); const v = r[col]; if (v == null || !a) return;
        const x = 40 + wk(r[0]) * (cell + gapW), y = y0 + dw * (cell + gapW);
        s += `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" rx="2" fill="${COL[col](v / a)}"><title>${r[0]} ${lab} ${v > 0 ? "+" : ""}${Math.round(v).toLocaleString()}주 (평균 거래량의 ${(v / a * 100).toFixed(0)}%)</title></rect>`;
      });
    });
    let lastM = "";
    inv.forEach(r => { const m = r[0].slice(0, 7); if (m !== lastM && new Date(r[0]).getDate() <= 7) { lastM = m; s += `<text x="${40 + wk(r[0]) * (cell + gapW)}" y="8" class="ax">${m.slice(2).replace("-", ".")}</text>`; } });
    el.innerHTML = s + `</svg><div class="legend"><span>순매도</span><span class="lg">${[-1, -.5, 0].map(v => `<i style="background:${COL[1](v * .25)}"></i>`).join("")}</span><span>순매수</span><span class="lg">${[.5, 1].map(v => `<i style="background:${COL[1](v * .25)}"></i>`).join("")}${[.5, 1].map(v => `<i style="background:${COL[2](v * .25)}"></i>`).join("")}</span><span class="mut">순매수 = 고유색 진하게(<span class="c-frgn">외국인</span>/<span class="c-inst">기관</span>) · 순매도 = 회색 진하게 · 평균 거래량의 ±25%에서 가장 진함</span></div>`;
  }

  // ---------- 월별 Trend (연초 대비 누적) ----------
  // 각 점 = 그 달 말 종가 ÷ 그해 첫 거래일 종가 − 1. 선은 연초(0%)에서 출발
  function drawMonthly(d) {
    const el = $("#mon"), mo = d.mo || [];
    if (mo.length < 3) { el.innerHTML = `<div class="empty">데이터 부족</div>`; return; }
    // 연초 기준가: 첫 거래일 종가(y0). 없으면 일봉에서 찾고, 그래도 없으면 전년 12월 말 종가로 대신
    const base = {}, late = {};
    (d.y0 || []).forEach(([y, dt, c]) => { if (c) { base[y] = c; if (dt.slice(5) > "01-15") late[y] = dt; } });
    (d.d || []).forEach(r => { const y = r[0].slice(0, 4); if (!(y in base) && r[4]) base[y] = r[4]; });
    mo.forEach(([ym, c], i) => { const y = String(+ym.slice(0, 4) + 1); if (ym.slice(5) === "12" && !(y in base) && c) base[y] = c; });
    const byY = {};
    mo.forEach(([ym, c]) => { const y = ym.slice(0, 4); if (base[y] && c) (byY[y] ||= { 0: 0 })[+ym.slice(5)] = (c / base[y] - 1) * 100; });
    const years = Object.keys(byY).filter(y => Object.keys(byY[y]).length > 1).sort().slice(-5);
    if (!years.length) { el.innerHTML = `<div class="empty">데이터 부족</div>`; return; }
    const vals = years.flatMap(y => Object.values(byY[y]));
    const rawLo = Math.min(0, ...vals), rawHi = Math.max(0, ...vals);
    const span = Math.max(20, rawHi - rawLo), step = [5, 10, 20, 25, 50, 100, 200].find(v => span / v <= 6) || 500;
    const lo = Math.min(-step, Math.floor(rawLo / step) * step), hi = Math.max(step, Math.ceil(rawHi / step) * step);
    const W = 720, H = 280, L = 48, R = 70, T = 12, B = 26;
    const X = m => L + m / 12 * (W - L - R), Y = v => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const pal = ["#b9c2cc", "#93a3b5", "#6f86a3", "#2f8c78", isDark() ? "#f2f2f0" : "#1f2328"];
    const cols = years.map((_, i) => pal[pal.length - years.length + i]);
    let s = `<svg viewBox="0 0 ${W} ${H}" class="mon">`;
    for (let v = lo; v <= hi + 1e-9; v += step) s += `<line x1="${L}" x2="${W - R}" y1="${Y(v)}" y2="${Y(v)}" class="${v === 0 ? "mz" : "pg"}"/><text x="${L - 6}" y="${Y(v) + 4}" class="ax" text-anchor="end">${v > 0 ? "+" : ""}${v}%</text>`;
    s += `<text x="${X(0)}" y="${H - 6}" class="ax" text-anchor="middle">연초</text>`;
    for (let m = 1; m <= 12; m++) s += `<text x="${X(m)}" y="${H - 6}" class="ax" text-anchor="middle">${m}월</text>`;
    years.forEach((y, i) => {
      const pts = Object.entries(byY[y]).map(([m, v]) => [+m, v]).sort((a, b) => a[0] - b[0]);
      const last = i === years.length - 1, w = last ? 2.4 : 1.4;
      for (let j = 1; j < pts.length; j++) if (pts[j][0] === pts[j - 1][0] + 1)
        s += `<line x1="${X(pts[j - 1][0])}" y1="${Y(pts[j - 1][1])}" x2="${X(pts[j][0])}" y2="${Y(pts[j][1])}" stroke="${cols[i]}" stroke-width="${w}"/>`;
      pts.forEach(([m, v]) => { if (m) s += `<circle cx="${X(m)}" cy="${Y(v)}" r="${last ? 4 : 3}" fill="${cols[i]}" class="mp"><title>${y}년 ${m}월 말 · 연초 대비 ${v > 0 ? "+" : ""}${v.toFixed(1)}%</title></circle>`; });
      const e = pts[pts.length - 1];
      s += `<text x="${X(e[0]) + 7}" y="${Y(e[1]) + 4}" fill="${cols[i]}" class="ml">${y}</text>`;
    });
    // 연간 수익률 = 마지막 월말 ÷ 연초 첫 거래일
    const yr = years.map(y => { const ks = Object.keys(byY[y]).map(Number); return byY[y][Math.max(...ks)]; });
    const cy = String(new Date().getFullYear());
    el.innerHTML = s + `</svg><div class="legend">${years.map((y, i) => `<span><i style="background:${cols[i]}"></i>${y} <b class="${fmt.cls(yr[i])}">${fmt.pct(yr[i], 0)}</b>${y === cy ? " (연초 이후)" : late[y] ? ` (${late[y].slice(5).replace("-", "/")} 상장 후)` : ""}</span>`).join("")}</div>`;
  }

  // 닫을 때 차트 정리
  const _close = window.closeDetail;
  window.closeDetail = function () { charts.forEach(c => c.remove()); charts = []; rsChart = null; _close && _close(); };
  document.addEventListener("DOMContentLoaded", () => { const b = $("#closeDetail"); if (b) b.onclick = window.closeDetail; const sc = $("#scrim"); if (sc) sc.onclick = window.closeDetail; });
})();
