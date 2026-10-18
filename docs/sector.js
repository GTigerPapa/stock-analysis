/* 섹터 탭: 업종별 N일 변동률 시계열 + 업종 drawer (업종 차트 + 종목 순위 → 종목 상세 → 돌아가기) */
(function () {
  const PERIODS = [[1, "1일"], [5, "5일"], [20, "20일"], [60, "60일"], [120, "120일"]];
  const HOT = ["#ff5c5c", "#ff9f40", "#f06595", "#cc5de8", "#ffd43b"];   // 상위 5
  const COLD = ["#4dabf7", "#38d9a9", "#748ffc", "#66d9e8", "#a9e34b"];  // 하위 5
  const PCOL = { 1: "#8a94a3", 5: "#ffa94d", 20: "#ff6b6b", 60: "#4dabf7", 120: "#b197fc" };
  let S = null, N = 20, chart = null, lines = {}, hlSet = {}, dChart = null;
  try { N = +(localStorage.getItem("sec.n") || 20) || 20; } catch (e) { /* 무시 */ }
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const isDark = () => matchMedia("(prefers-color-scheme: dark)").matches;
  const roll = (a, n) => a.map((v, i) => (i < n || v == null || a[i - n] == null) ? null : (v / a[i - n] - 1) * 100);

  async function load() {
    if (S) return S;
    try { const r = await fetch("data/series.json", { cache: "no-store" }); S = r.ok ? await r.json() : null; } catch (e) { S = null; }
    return S;
  }
  function opts() {
    const dark = isDark();
    return {
      layout: { background: { color: "transparent" }, textColor: dark ? "#9aa3ad" : "#6b7280", fontFamily: "inherit", fontSize: 11 },
      grid: { vertLines: { color: dark ? "#22272c" : "#f0efeb" }, horzLines: { color: dark ? "#22272c" : "#f0efeb" } },
      rightPriceScale: { borderVisible: false, minimumWidth: 60 },
      timeScale: { borderVisible: false, rightOffset: 0, fixLeftEdge: true, fixRightEdge: true },
      crosshair: { mode: 0 }, handleScroll: true, handleScale: true, autoSize: true,
      localization: { locale: "ko-KR", priceFormatter: v => (v > 0 ? "+" : "") + v.toFixed(1) + "%" },
    };
  }
  const dim = () => isDark() ? "rgba(150,160,170,.18)" : "rgba(120,125,135,.18)";

  // ---------- 섹터 탭 메인 차트 ----------
  async function renderTab() {
    if (!$("#tab-sector")?.classList.contains("on")) return;
    await load();
    const box = $("#secChart");
    if (!S || !S.sector) { box.innerHTML = `<div class="empty">업종 시계열 데이터가 없습니다</div>`; return; }
    $("#secPeriods").innerHTML = PERIODS.map(([n, l]) => `<button data-n="${n}" class="${n === N ? "on" : ""}">${l}</button>`).join("");
    $("#secPeriods").querySelectorAll("button").forEach(b => b.onclick = () => {
      N = +b.dataset.n; try { localStorage.setItem("sec.n", N); } catch (e) { /* 무시 */ } renderTab();
    });
    if (chart) { chart.remove(); chart = null; }
    chart = LightweightCharts.createChart(box, opts()); lines = {}; hlSet = {};
    const dates = S.dates;
    const cnt = {}; state.universe.forEach(r => { if (r.sector_name) cnt[r.sector_name] = (cnt[r.sector_name] || 0) + 1; });
    const small = Object.keys(S.sector).filter(k => (cnt[k] || 0) < 3);
    const data = Object.entries(S.sector).filter(([name]) => (cnt[name] || 0) >= 3).map(([name, idx]) => {
      const r = roll(idx, N); let last = null;
      for (let i = r.length - 1; i >= 0; i--) if (r[i] != null) { last = r[i]; break; }
      return { name, r, last };
    }).filter(x => x.last != null).sort((a, b) => b.last - a.last);
    data.slice(0, 5).forEach((x, i) => hlSet[x.name] = HOT[i]);
    data.slice(-5).reverse().forEach((x, i) => hlSet[x.name] = COLD[i]);
    // 회색 먼저, 강조선은 나중에(위에) 그린다
    const order = [...data.filter(x => !hlSet[x.name]), ...data.filter(x => hlSet[x.name])];
    order.forEach(x => {
      const c = hlSet[x.name];
      const s = chart.addLineSeries({ color: c || dim(), lineWidth: c ? 2 : 1, priceLineVisible: false, lastValueVisible: !!c, crosshairMarkerVisible: false, title: "" });
      s.setData(dates.map((t, i) => x.r[i] == null ? { time: t } : { time: t, value: x.r[i] }));
      lines[x.name] = s;
    });
    const zero = Object.values(lines)[0];
    zero?.createPriceLine({ price: 0, color: isDark() ? "#5b636c" : "#b9b9b4", lineWidth: 1, lineStyle: 0, axisLabelVisible: false });
    const n = dates.length;
    chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 250), to: n - 1 });
    // 순위 목록
    $("#secRank").innerHTML = `<div class="sr-h">${N}일 변동률 순위 <span class="mut">${data.length}개 업종</span></div>` +
      data.map((x, i) => `<div class="sr-row" data-sec="${esc(x.name)}"><span class="sr-i">${i + 1}</span>
        <i class="sr-dot" style="background:${hlSet[x.name] || "transparent"}"></i><span class="sr-n">${esc(x.name)}</span>
        <b class="${fmt.cls(x.last)}">${fmt.pct(x.last)}</b></div>`).join("");
    $("#secRank").querySelectorAll(".sr-row").forEach(r => {
      r.onmouseenter = () => highlight(r.dataset.sec);
      r.onmouseleave = () => highlight(null);
      r.onclick = () => window.openSector(r.dataset.sec);
    });
    $("#secLegend").innerHTML = `<span>선 = 업종 동일가중 지수의 ${N}일 변동률 (그날 기준 ${N}거래일 전 대비)</span><span>색 = 최근 상위 5 / 하위 5, 나머지 회색</span><span class="mut">오른쪽 목록에 마우스를 올리면 강조, 누르면 업종 상세 · 3종목 미만 업종 ${small.length}개 제외(아래 표에서 열기)</span>`;
  }
  function highlight(name) {
    Object.entries(lines).forEach(([k, s]) => {
      if (!name) s.applyOptions({ color: hlSet[k] || dim(), lineWidth: hlSet[k] ? 2 : 1, lastValueVisible: !!hlSet[k] });
      else if (k === name) s.applyOptions({ color: hlSet[k] || (isDark() ? "#ffffff" : "#1f2328"), lineWidth: 3, lastValueVisible: true });
      else s.applyOptions({ color: dim(), lineWidth: 1, lastValueVisible: false });
    });
  }

  // ---------- 업종 drawer ----------
  let listN = null;
  window.openSector = async function (name) {
    await load();
    if (dChart) { dChart.remove(); dChart = null; }
    $("#detail").classList.add("on"); $("#scrim").classList.add("on"); $("#detail").setAttribute("aria-hidden", "false");
    $("#detail").scrollTop = 0;
    listN = listN || N;
    const row = (state.latest.sectors || []).find(r => r.sector_name === name) || {};
    const info = (S && S.info && S.info[name]) || "";
    const body = $("#detailBody");
    body.innerHTML = `
      <div class="sec-banner"><b>${esc(name)}</b> ${esc(info)}</div>
      <div class="dh"><div class="meta">업종 · ${row.n || (S?.count || {})[name] || "–"}종목 · 시총 ${fmt.won(row.marcap)} · 거래대금(20일) ${fmt.won(row.amount_avg20)}</div><h2>${esc(name)}</h2></div>
      <div class="kv sec-kv">
        ${[["1일", row.ret_1d], ["5일", row.ret_5], ["20일", row.ret_20], ["60일", row.ret_60], ["120일", row.ret_120]].map(([l, v]) => `<div><span class="k">${l}</span><span class="v ${fmt.cls(v)}">${fmt.pct(v)}</span></div>`).join("")}
        <div><span class="k">RS 60 / 120</span><span class="v">${fmt.n(row.rs_60)} / ${fmt.n(row.rs_120)}</span></div>
        <div><span class="k">200일선 위 종목</span><span class="v">${fmt.n(row.breadth_ma200)}%</span></div>
        <div><span class="k">외+기 60일 중앙값</span><span class="v ${fmt.cls(row.frgn_60_pct)}">${fmt.pct(row.frgn_60_pct, 2)}</span></div>
      </div>
      <div class="sec"><h4>기간별 변동률 추이 <span class="mut">업종 동일가중 지수 · 선 = 그날 기준 N거래일 전 대비</span></h4>
        <div class="chart mid2" id="secDChart"></div>
        <div class="legend">${PERIODS.map(([n, l]) => `<span><i style="background:${PCOL[n]}"></i>${l}</span>`).join("")}</div></div>
      <div class="sec"><h4>종목 순위 <span class="seg mini" id="secListSeg">${PERIODS.map(([n, l]) => `<button data-n="${n}" class="${n === listN ? "on" : ""}">${l}</button>`).join("")}</span>
        <span class="mut">상승률 높은 순 · 누르면 종목 상세</span></h4><div id="secList"></div></div>`;
    // 업종 차트
    const idx = S && S.sector && S.sector[name];
    if (idx) {
      dChart = LightweightCharts.createChart($("#secDChart"), opts());
      let first = null;
      [120, 60, 20, 5, 1].forEach(n => {
        const r = roll(idx, n);
        const s = dChart.addLineSeries({ color: PCOL[n], lineWidth: n === 1 ? 1 : 2, priceLineVisible: false, lastValueVisible: true });
        s.setData(S.dates.map((t, i) => r[i] == null ? { time: t } : { time: t, value: r[i] }));
        first = first || s;
      });
      first.createPriceLine({ price: 0, color: isDark() ? "#5b636c" : "#b9b9b4", lineWidth: 1, lineStyle: 0, axisLabelVisible: false });
      const n = S.dates.length; dChart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - 250), to: n - 1 });
    } else $("#secDChart").innerHTML = `<div class="empty">업종 시계열 없음</div>`;
    drawList(name);
    $("#secListSeg").querySelectorAll("button").forEach(b => b.onclick = () => {
      listN = +b.dataset.n; $("#secListSeg").querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b)); drawList(name);
    });
  };
  function drawList(name) {
    const key = { 1: "ret_1d", 5: "ret_5", 20: "ret_20", 60: "ret_60", 120: "ret_120" }[listN];
    const rows = state.universe.filter(r => r.sector_name === name).sort((a, b) => (b[key] ?? -1e9) - (a[key] ?? -1e9));
    const holds = new Set((state.latest.watchlist || []).map(w => w.code));
    $("#secList").innerHTML = `<table class="fin sec-tbl"><thead><tr><th>#</th><th>종목</th><th>${listN}일</th><th>종가</th><th>외+기 20일</th><th>거래대금20</th><th>시총</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr data-code="${r.code}"><td class="mut">${i + 1}</td><td class="nm">${esc(r.name)}${holds.has(r.code) ? ` <span class="badge st-good">보유</span>` : ""}<small>${r.code} · ${r.market}</small></td>
        <td class="${fmt.cls(r[key])}"><b>${fmt.pct(r[key])}</b></td><td>${fmt.n(r.close)}</td>
        <td class="${fmt.cls(r.smart_net_20_pct)}">${fmt.pct(r.smart_net_20_pct, 2)}</td><td>${fmt.won(r.amount_avg20)}</td><td>${fmt.won(r.marcap)}</td></tr>`).join("")}</tbody></table>`;
    $("#secList").querySelectorAll("tbody tr").forEach(tr => tr.onclick = () => window.openDetail(tr.dataset.code, { back: name }));
  }

  // 종목 상세로 넘어가거나 닫을 때 업종 차트 정리
  const _open = window.openDetail;
  window.openDetail = function (code, o) { if (dChart) { dChart.remove(); dChart = null; } $("#detail").scrollTop = 0; return _open(code, o); };
  const _close = window.closeDetail;
  window.closeDetail = function () { if (dChart) { dChart.remove(); dChart = null; } return _close && _close(); };
  document.addEventListener("DOMContentLoaded", () => { const b = $("#closeDetail"); if (b) b.onclick = window.closeDetail; const sc = $("#scrim"); if (sc) sc.onclick = window.closeDetail; });

  window.renderSectorTab = renderTab;
  let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { if ($("#tab-sector")?.classList.contains("on")) renderTab(); }, 250); });
})();
