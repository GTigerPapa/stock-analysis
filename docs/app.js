/* 국내 종목 정량분석 대시보드 — 정적 JSON(data/) 기반 */
const $ = (s, el = document) => el.querySelector(s);
const state = { latest: null, universe: [], preset: null, sort: {}, sector: "", detail: null };

// ---------- 포맷 ----------
const fmt = {
  n: (v, d = 0) => (v == null || isNaN(v)) ? "–" : Number(v).toLocaleString("ko-KR", { maximumFractionDigits: d, minimumFractionDigits: d }),
  pct: (v, d = 1) => (v == null || isNaN(v)) ? "–" : (v > 0 ? "+" : "") + Number(v).toFixed(d) + "%",
  won: (v) => {
    if (v == null) return "–";
    if (Math.abs(v) >= 1e12) return (v / 1e12).toFixed(1) + "조";
    if (Math.abs(v) >= 1e8) return Math.round(v / 1e8).toLocaleString() + "억";
    return fmt.n(v);
  },
  cls: (v) => v == null ? "mut" : v > 0 ? "up" : v < 0 ? "down" : "",
};
const td = (html, cls = "") => `<td class="${cls}">${html}</td>`;
const pctTd = (v, d = 1) => td(fmt.pct(v, d), fmt.cls(v));

// ---------- 컬럼 정의 (표 공통) ----------
const COLS = {
  name: { h: "종목", f: r => `<span>${r.name}</span><small>${r.code} · ${r.sector_name || "–"} · ${r.market}</small>`, cls: "name", sortKey: "name", str: true },
  close: { h: "종가", f: r => fmt.n(r.close) },
  ret_1d: { h: "1일", f: r => fmt.pct(r.ret_1d), c: r => fmt.cls(r.ret_1d) },
  ret_20: { h: "20일", f: r => fmt.pct(r.ret_20), c: r => fmt.cls(r.ret_20) },
  ret_60: { h: "60일", f: r => fmt.pct(r.ret_60), c: r => fmt.cls(r.ret_60) },
  ret_120: { h: "120일", f: r => fmt.pct(r.ret_120), c: r => fmt.cls(r.ret_120) },
  ret_250: { h: "1년", f: r => fmt.pct(r.ret_250), c: r => fmt.cls(r.ret_250) },
  slope_120: { h: "추세120", f: r => fmt.pct(r.slope_120, 0), c: r => fmt.cls(r.slope_120), tip: "120일 로그가격 회귀 기울기(연율화)" },
  r2_120: { h: "R²", f: r => r.r2_120 == null ? "–" : r.r2_120.toFixed(2), tip: "추세의 매끄러움(1에 가까울수록 직선적)" },
  dd_52w: { h: "52주낙폭", f: r => fmt.pct(r.dd_52w), c: r => fmt.cls(r.dd_52w) },
  close_vs_ma200: { h: "vs200일선", f: r => fmt.pct(r.close_vs_ma200), c: r => fmt.cls(r.close_vs_ma200) },
  smart_net_60_pct: { h: "외+기60", f: r => fmt.pct(r.smart_net_60_pct, 2), c: r => fmt.cls(r.smart_net_60_pct), tip: "외국인+기관 60일 순매수 / 발행주식수" },
  frgn_net_60_pct: { h: "외인60", f: r => fmt.pct(r.frgn_net_60_pct, 2), c: r => fmt.cls(r.frgn_net_60_pct) },
  excess_60: { h: "섹터대비60", f: r => fmt.pct(r.excess_60), c: r => fmt.cls(r.excess_60), tip: "종목 60일 수익률 − 업종 중앙값" },
  sector_rs_60: { h: "업종RS", f: r => fmt.n(r.sector_rs_60), tip: "업종 60일 상대강도 백분위" },
  per: { h: "PER", f: r => fmt.n(r.per, 1) },
  pbr: { h: "PBR", f: r => fmt.n(r.pbr, 2) },
  op_qoq: { h: "영익QoQ", f: r => fmt.pct(r.op_qoq, 0), c: r => fmt.cls(r.op_qoq) },
  op_yoy: { h: "영익YoY", f: r => fmt.pct(r.op_yoy, 0), c: r => fmt.cls(r.op_yoy) },
  vol_ratio20: { h: "거래량비", f: r => r.vol_ratio20 == null ? "–" : r.vol_ratio20.toFixed(1) + "x" },
  amount_avg20: { h: "거래대금20", f: r => fmt.won(r.amount_avg20) },
  marcap: { h: "시총", f: r => fmt.won(r.marcap) },
  nxt_gap: { h: "NXT갭", f: r => fmt.pct(r.nxt_gap, 2), c: r => fmt.cls(r.nxt_gap), tip: "NXT 애프터마켓 종가 − KRX 종가" },
  score: { h: "점수", f: r => `<span class="score">${fmt.n(r.score, 1)}</span>` },
  rank: { h: "#", f: r => `<span class="rank">${r.rank}</span>`, cls: "l" },
};
const SCREEN_COLS = ["rank", "name", "close", "ret_1d", "ret_60", "ret_120", "slope_120", "r2_120", "dd_52w", "smart_net_60_pct", "excess_60", "per", "score"];
const ALL_COLS = ["name", "close", "ret_1d", "ret_20", "ret_60", "ret_120", "ret_250", "slope_120", "r2_120", "dd_52w", "close_vs_ma200", "smart_net_60_pct", "frgn_net_60_pct", "excess_60", "sector_rs_60", "per", "pbr", "op_qoq", "vol_ratio20", "amount_avg20", "marcap", "nxt_gap"];

function renderTable(el, rows, cols, key) {
  const srt = state.sort[key];
  if (srt) {
    const c = COLS[srt.col];
    const k = c.sortKey || srt.col;
    rows = [...rows].sort((a, b) => {
      const x = a[k], y = b[k];
      if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1;
      return c.str ? String(x).localeCompare(String(y), "ko") * (srt.dir) : (x - y) * srt.dir;
    });
  }
  const head = cols.map(c => `<th data-col="${c}" class="${srt && srt.col === c ? "on" : ""} ${c === "name" ? "name-h" : ""}" title="${COLS[c].tip || ""}">${COLS[c].h}${srt && srt.col === c ? (srt.dir > 0 ? " ↑" : " ↓") : ""}</th>`).join("");
  const body = rows.length ? rows.map(r => `<tr data-code="${r.code}">${cols.map(c => {
    const d = COLS[c]; return `<td class="${d.cls || ""} ${d.c ? d.c(r) : ""}">${d.f(r)}</td>`;
  }).join("")}</tr>`).join("") : `<tr><td colspan="${cols.length}" class="empty">조건을 만족하는 종목이 없습니다</td></tr>`;
  el.innerHTML = `<thead><tr>${head}</tr></thead><tbody>${body}</tbody>`;
  el.querySelectorAll("th").forEach(th => th.onclick = () => {
    const col = th.dataset.col, cur = state.sort[key];
    state.sort[key] = cur && cur.col === col ? { col, dir: -cur.dir } : { col, dir: COLS[col].str ? 1 : -1 };
    renderTable(el, rows, cols, key);
  });
  el.querySelectorAll("tbody tr[data-code]").forEach(tr => tr.onclick = () => openDetail(tr.dataset.code));
}

// ---------- 시장 요약 ----------
function renderMarket() {
  const m = state.latest.market || {};
  $("#market").innerHTML = Object.entries(m).map(([k, v]) => `
    <div class="tile"><div class="k">${k} · ${v.n}종목</div>
      <div class="v"><span class="up">${v.adv}</span> <span class="mut">/</span> <span class="down">${v.dec}</span></div>
      <div class="s">200일선 위 ${v.above_ma200_pct}% · 정배열 ${v.ma_align_pct}% · 60일 중앙값 ${fmt.pct(v.med_ret_60)}</div></div>`).join("")
    + `<div class="tile"><div class="k">기준일</div><div class="v">${state.latest.asof}</div><div class="s">생성 ${state.latest.generated_at} · 유니버스 ${state.latest.universe_size}</div></div>`;
}

// ---------- 스크리너 ----------
function renderPresets() {
  const ps = state.latest.presets;
  if (!state.preset) state.preset = ps[0]?.id;
  $("#presetChips").innerHTML = ps.map(p => `<button data-id="${p.id}" class="${p.id === state.preset ? "on" : ""}">${p.name} <span class="mut">${p.n_pass}</span></button>`).join("");
  $("#presetChips").querySelectorAll("button").forEach(b => b.onclick = () => { state.preset = b.dataset.id; renderPresets(); });
  const p = ps.find(x => x.id === state.preset);
  if (!p) return;
  const rules = p.filters.map(f => `${f.f} ${f.op} ${typeof f.v === "number" && Math.abs(f.v) >= 1e8 ? fmt.won(f.v) : f.v ?? ""}`).join(" · ");
  const w = p.score.map(s => `${s.f}${s.w < 0 ? "↓" : ""} ${Math.round(Math.abs(s.w) * 100)}%`).join(" · ");
  $("#presetDesc").innerHTML = `${p.description}<div class="rules">필터: ${rules}<br>점수: ${w}</div>`;
  renderTable($("#screenTable"), p.rows, SCREEN_COLS, "screen:" + p.id);
}

// ---------- 관심종목 ----------
function sparkline(prices) {
  if (!prices || prices.length < 2) return "";
  const c = prices.slice(-120).map(p => p[4]);
  const min = Math.min(...c), max = Math.max(...c), w = 300, h = 46;
  const pts = c.map((v, i) => `${(i / (c.length - 1) * w).toFixed(1)},${(h - (v - min) / (max - min || 1) * (h - 4) - 2).toFixed(1)}`).join(" ");
  const color = c[c.length - 1] >= c[0] ? "var(--up)" : "var(--down)";
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline fill="none" stroke="${color}" stroke-width="1.5" points="${pts}"/></svg>`;
}
function verdict(f) {
  if (!f) return "";
  const good = [], bad = [];
  (f.slope_120 > 0 ? good : bad).push(`120일 추세 ${fmt.pct(f.slope_120, 0)}/년`);
  (f.close_vs_ma200 > 0 ? good : bad).push(`200일선 ${f.close_vs_ma200 > 0 ? "위" : "아래"} (${fmt.pct(f.close_vs_ma200)})`);
  (f.smart_net_60_pct > 0 ? good : bad).push(`외+기 60일 ${fmt.pct(f.smart_net_60_pct, 2)}`);
  if (f.excess_60 != null) (f.excess_60 > 0 ? good : bad).push(`업종 대비 ${fmt.pct(f.excess_60)}`);
  if (f.op_qoq != null) (f.op_qoq > 0 ? good : bad).push(`영업이익 QoQ ${fmt.pct(f.op_qoq, 0)}`);
  return `<div class="verdict"><b>긍정 ${good.length}</b> · ${good.join(", ") || "없음"}<br><b>부정 ${bad.length}</b> · ${bad.join(", ") || "없음"}</div>`;
}
async function renderWatch() {
  const ws = state.latest.watchlist || [];
  const el = $("#watchCards");
  el.innerHTML = ws.map(w => `<div class="card" data-code="${w.code}" id="wc-${w.code}"><h3>${w.name}<small>${w.code}</small></h3><div class="sub">불러오는 중…</div></div>`).join("") || `<div class="empty">presets/watchlist.json 에 종목을 추가하세요</div>`;
  for (const w of ws) {
    const f = w.features; const card = $("#wc-" + w.code);
    if (!f) { card.querySelector(".sub").textContent = "데이터 없음 (상장폐지·거래정지?)"; continue; }
    let d = null; try { d = await loadStock(w.code); } catch (e) { /* 상세 없음 */ }
    card.innerHTML = `
      <h3>${w.name}<small>${w.code} · ${f.sector_name || ""}</small></h3>
      <div class="price">${fmt.n(f.close)} <span class="${fmt.cls(f.ret_1d)}" style="font-size:14px">${fmt.pct(f.ret_1d)}</span></div>
      <div class="sub">${w.note || ""} ${f.nxt_gap ? `· NXT ${fmt.pct(f.nxt_gap, 2)}` : ""}</div>
      <div class="spark">${sparkline(d?.prices)}</div>
      <div class="kv">
        <div><span class="k">60일</span><span class="v ${fmt.cls(f.ret_60)}">${fmt.pct(f.ret_60)}</span></div>
        <div><span class="k">120일</span><span class="v ${fmt.cls(f.ret_120)}">${fmt.pct(f.ret_120)}</span></div>
        <div><span class="k">1년</span><span class="v ${fmt.cls(f.ret_250)}">${fmt.pct(f.ret_250)}</span></div>
        <div><span class="k">52주 낙폭</span><span class="v ${fmt.cls(f.dd_52w)}">${fmt.pct(f.dd_52w)}</span></div>
        <div><span class="k">외+기 60일</span><span class="v ${fmt.cls(f.smart_net_60_pct)}">${fmt.pct(f.smart_net_60_pct, 2)}</span></div>
        <div><span class="k">외인 지분</span><span class="v">${fmt.n(f.foreign_ratio, 1)}% <small class="${fmt.cls(f.foreign_ratio_chg_60)}">${f.foreign_ratio_chg_60 != null ? (f.foreign_ratio_chg_60 > 0 ? "+" : "") + f.foreign_ratio_chg_60.toFixed(2) + "p" : ""}</small></span></div>
        <div><span class="k">PER / PBR</span><span class="v">${fmt.n(f.per, 1)} / ${fmt.n(f.pbr, 2)}</span></div>
        <div><span class="k">목표가 괴리</span><span class="v ${fmt.cls(f.target_upside)}">${fmt.pct(f.target_upside, 0)}</span></div>
        <div><span class="k">업종 RS60</span><span class="v">${fmt.n(f.sector_rs_60)}</span></div>
      </div>
      ${verdict(f)}`;
    card.onclick = () => openDetail(w.code);
  }
}

// ---------- 섹터 ----------
function renderSectors() {
  const rows = state.latest.sectors || [];
  const maxAbs = Math.max(...rows.map(r => Math.abs(r.ret_60 || 0)), 1);
  const bar = (v) => `<div class="bar"><i style="width:${Math.abs(v || 0) / maxAbs * 100}%"></i><span class="${fmt.cls(v)}">${fmt.pct(v)}</span></div>`;
  $("#sectorTable").innerHTML = `<thead><tr><th>업종</th><th>종목수</th><th>1일</th><th>5일</th><th>20일</th><th>60일</th><th>120일</th><th>RS60</th><th>RS120</th><th>200일선 위</th><th>외+기60 중앙값</th><th>거래대금20</th></tr></thead>
  <tbody>${rows.map(r => `<tr data-sec="${r.sector_name}"><td class="name">${r.sector_name}</td><td>${r.n}</td>${pctTd(r.ret_1d)}${pctTd(r.ret_5)}${pctTd(r.ret_20)}<td>${bar(r.ret_60)}</td>${pctTd(r.ret_120)}<td>${fmt.n(r.rs_60)}</td><td>${fmt.n(r.rs_120)}</td><td>${fmt.n(r.breadth_ma200)}%</td>${pctTd(r.frgn_60_pct, 2)}<td>${fmt.won(r.amount_avg20)}</td></tr>`).join("")}</tbody>`;
  $("#sectorTable").querySelectorAll("tbody tr").forEach(tr => tr.onclick = () => {
    $("#secSel").value = tr.dataset.sec; state.sector = tr.dataset.sec; switchTab("all"); renderAll();
  });
}

// ---------- 전체 ----------
function renderAll() {
  const q = $("#q").value.trim().toLowerCase(), mkt = $("#mkt").value, sec = $("#secSel").value, liq = $("#liquid").checked;
  let rows = state.universe.filter(r =>
    (!q || r.name.toLowerCase().includes(q) || r.code.includes(q)) &&
    (!mkt || r.market === mkt) && (!sec || r.sector_name === sec) && (!liq || (r.amount_avg20 || 0) >= 3e9));
  $("#allCount").textContent = `${rows.length}종목`;
  if (!state.sort.all) state.sort.all = { col: "marcap", dir: -1 };
  renderTable($("#allTable"), rows.slice(0, 500), ALL_COLS, "all");
}

// ---------- 상세 ----------
const cache = {};
async function loadStock(code) {
  if (cache[code]) return cache[code];
  const r = await fetch(`data/stock/${code}.json`, { cache: "no-store" });
  if (!r.ok) throw new Error("no detail");
  return cache[code] = await r.json();
}
const F = (k, label, fn) => ({ k, label, fn });
const GROUPS = [
  ["추세", [F("slope_60", "추세60(연율)", v => fmt.pct(v, 0)), F("slope_120", "추세120(연율)", v => fmt.pct(v, 0)), F("slope_250", "추세250(연율)", v => fmt.pct(v, 0)), F("r2_120", "R²120", v => v?.toFixed(2)), F("close_vs_ma200", "vs 200일선", v => fmt.pct(v)), F("ma_align", "정배열", v => v ? "예" : "아니오"), F("pos_52w", "52주 위치", v => fmt.n(v) + "%"), F("dd_52w", "52주 낙폭", v => fmt.pct(v)), F("mdd_1y", "1년 MDD", v => fmt.pct(v)), F("vol_ann_60", "변동성60(연)", v => fmt.n(v) + "%"), F("rsi14", "RSI14", v => fmt.n(v))]],
  ["수급", [F("smart_net_20_pct", "외+기 20일", v => fmt.pct(v, 2)), F("smart_net_60_pct", "외+기 60일", v => fmt.pct(v, 2)), F("smart_net_120_pct", "외+기 120일", v => fmt.pct(v, 2)), F("frgn_net_60_pct", "외국인 60일", v => fmt.pct(v, 2)), F("inst_net_60_pct", "기관 60일", v => fmt.pct(v, 2)), F("foreign_ratio", "외인 지분율", v => fmt.n(v, 2) + "%"), F("foreign_ratio_chg_60", "지분율 60일 변화", v => (v > 0 ? "+" : "") + fmt.n(v, 2) + "p"), F("smart_buy_streak", "연속 순매수", v => v + "일")]],
  ["밸류·실적", [F("per", "PER", v => fmt.n(v, 1)), F("cns_per", "컨센 PER", v => fmt.n(v, 1)), F("pbr", "PBR", v => fmt.n(v, 2)), F("div_yield", "배당수익률", v => fmt.n(v, 2) + "%"), F("target_upside", "목표가 괴리", v => fmt.pct(v, 0)), F("recomm", "투자의견(5만점)", v => fmt.n(v, 2)), F("op_qoq", "영업이익 QoQ", v => fmt.pct(v, 0)), F("op_yoy", "영업이익 YoY", v => fmt.pct(v, 0)), F("rev_yoy", "매출 YoY", v => fmt.pct(v, 0)), F("op_margin_q", "영업이익률", v => fmt.n(v, 1) + "%"), F("roe", "ROE", v => fmt.n(v, 1) + "%"), F("debt_ratio", "부채비율", v => fmt.n(v, 0) + "%")]],
  ["섹터", [F("sector_ret_60", "업종 60일", v => fmt.pct(v)), F("excess_60", "업종 대비 60일", v => fmt.pct(v)), F("excess_120", "업종 대비 120일", v => fmt.pct(v)), F("sector_rs_60", "업종 RS60", v => fmt.n(v)), F("rank_in_sector_60", "업종 내 순위(60일)", v => fmt.n(v)), F("ret_60_pct_rank", "시장 백분위(60일)", v => fmt.n(v))]],
  ["거래·단기", [F("amount_avg20", "거래대금 20일평균", v => fmt.won(v)), F("vol_ratio20", "거래량/20일평균", v => v?.toFixed(2) + "x"), F("turnover_20", "20일 회전율", v => fmt.n(v, 1) + "%"), F("pv_eff_20", "회전율당 가격변화", v => fmt.n(v, 2)), F("obv_chg20", "OBV 20일", v => fmt.pct(v, 0)), F("atr14_pct", "ATR14", v => fmt.n(v, 1) + "%"), F("gap", "당일 갭", v => fmt.pct(v)), F("nxt_close", "NXT 애프터 종가", v => fmt.n(v)), F("nxt_gap", "NXT 갭", v => fmt.pct(v, 2))]],
];
let charts = [];
async function openDetail(code) {
  const u = state.universe.find(r => r.code === code) || {};
  $("#detail").classList.add("on"); $("#scrim").classList.add("on"); $("#detail").setAttribute("aria-hidden", "false");
  const body = $("#detailBody");
  body.innerHTML = `<div class="dh"><div class="meta">${code}</div><h2>${u.name || ""}</h2><div class="empty">불러오는 중…</div></div>`;
  let d; try { d = await loadStock(code); } catch (e) {
    body.innerHTML = `<div class="dh"><div class="meta">${code} · ${u.sector_name || ""}</div><h2>${u.name || ""}</h2><div class="px">${fmt.n(u.close)}<small class="${fmt.cls(u.ret_1d)}">${fmt.pct(u.ret_1d)}</small></div></div>
      <p class="hint" style="margin-top:12px">이 종목은 상세 데이터(차트·수급)가 아직 내보내지지 않았습니다. 관심종목이나 프리셋 상위에 들어오면 다음 실행 때 생성됩니다.</p>${featureGrid(u)}`;
    return;
  }
  const f = d.features;
  body.innerHTML = `
    <div class="dh"><div class="meta">${code} · ${f.market} · ${f.sector_name || "–"} · 시총 ${fmt.won(f.marcap)}</div><h2>${f.name}</h2>
      <div class="px">${fmt.n(f.close)}<small class="${fmt.cls(f.ret_1d)}">${fmt.pct(f.ret_1d)}</small>${f.nxt_close && f.nxt_close !== f.close ? `<small class="mut">NXT ${fmt.n(f.nxt_close)} (${fmt.pct(f.nxt_gap, 2)})</small>` : ""}</div></div>
    ${verdict(f)}
    <div class="sec"><h4>가격 · 이동평균 (최근 1년)</h4><div class="chart" id="chPx"></div>
      <div class="legend"><span><i style="background:#e0a100"></i>MA20</span><span><i style="background:#2f6f6a"></i>MA60</span><span><i style="background:#7c3aed"></i>MA120</span><span><i style="background:#64748b"></i>MA200</span></div></div>
    <div class="sec"><h4>외국인·기관 누적 순매수 (주, 최근 120일)</h4><div class="chart sm" id="chInv"></div>
      <div class="legend"><span><i style="background:#c0392b"></i>외국인</span><span><i style="background:#2563eb"></i>기관</span></div></div>
    <div class="sec"><h4>분기 실적 (억원)</h4>${finTable(d.finance)}</div>
    ${featureGrid(f)}`;
  drawCharts(d);
}
function featureGrid(f) {
  return GROUPS.map(([g, items]) => `<div class="sec"><h4>${g}</h4><div class="fgrid">${items.map(it => {
    const v = f[it.k]; return `<div><div class="k">${it.label}</div><div class="v ${/pct|ret|slope|excess|gap|qoq|yoy|dd_|upside|net/.test(it.k) ? fmt.cls(v) : ""}">${v == null ? "–" : it.fn(v)}</div></div>`;
  }).join("")}</div></div>`).join("");
}
function finTable(rows) {
  if (!rows?.length) return `<div class="empty">재무 데이터 없음</div>`;
  const items = ["매출액", "영업이익", "영업이익률", "당기순이익", "ROE"];
  return `<table class="fin"><thead><tr><th>항목</th>${rows.map(r => `<th class="${r.consensus ? "cns" : ""}">${r.period.slice(0, 4)}.${r.period.slice(4)}${r.consensus ? "E" : ""}</th>`).join("")}</tr></thead>
    <tbody>${items.map(it => `<tr><td>${it}</td>${rows.map(r => `<td class="${r.consensus ? "cns" : ""} ${it === "영업이익" ? fmt.cls(r[it]) : ""}">${r[it] == null ? "–" : fmt.n(r[it], /률|ROE/.test(it) ? 1 : 0)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}
function drawCharts(d) {
  charts.forEach(c => c.remove()); charts = [];
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const base = { layout: { background: { color: "transparent" }, textColor: dark ? "#9aa3ad" : "#6b7280", fontFamily: "inherit" },
    grid: { vertLines: { color: dark ? "#23282d" : "#f0efeb" }, horzLines: { color: dark ? "#23282d" : "#f0efeb" } },
    rightPriceScale: { borderVisible: false }, timeScale: { borderVisible: false, timeVisible: false },
    crosshair: { mode: 0 }, handleScroll: true, handleScale: true, autoSize: true,
    localization: { locale: "ko-KR", priceFormatter: v => Math.round(v).toLocaleString("ko-KR") } };
  const px = d.prices.slice(-260);
  const c1 = LightweightCharts.createChart($("#chPx"), base); charts.push(c1);
  const cs = c1.addCandlestickSeries({ upColor: "#c0392b", downColor: "#2563eb", borderVisible: false, wickUpColor: "#c0392b", wickDownColor: "#2563eb" });
  cs.setData(px.map(p => ({ time: p[0], open: p[1], high: p[2], low: p[3], close: p[4] })));
  const vs = c1.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", color: dark ? "#334155" : "#d9ded6" });
  c1.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  vs.setData(px.map(p => ({ time: p[0], value: p[5] })));
  const all = d.prices.map(p => p[4]);
  const ma = (n, color) => {
    const s = c1.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const data = [];
    for (let i = Math.max(n - 1, d.prices.length - 260); i < d.prices.length; i++) {
      let sum = 0; for (let j = i - n + 1; j <= i; j++) sum += all[j];
      data.push({ time: d.prices[i][0], value: sum / n });
    }
    s.setData(data);
  };
  ma(20, "#e0a100"); ma(60, "#2f6f6a"); ma(120, "#7c3aed"); ma(200, "#64748b");
  c1.timeScale().fitContent();
  // 수급 누적
  const inv = d.investor.slice(-120);
  if (inv.length) {
    const c2 = LightweightCharts.createChart($("#chInv"), base); charts.push(c2);
    let cf = 0, ci = 0;
    const fs = c2.addLineSeries({ color: "#c0392b", lineWidth: 2, priceLineVisible: false }), is = c2.addLineSeries({ color: "#2563eb", lineWidth: 2, priceLineVisible: false });
    fs.setData(inv.map(r => ({ time: r[0], value: (cf += r[1] || 0) })));
    is.setData(inv.map(r => ({ time: r[0], value: (ci += r[2] || 0) })));
    c2.timeScale().fitContent();
  } else $("#chInv").innerHTML = `<div class="empty">수급 데이터 없음</div>`;
}
function closeDetail() { $("#detail").classList.remove("on"); $("#scrim").classList.remove("on"); $("#detail").setAttribute("aria-hidden", "true"); }

// ---------- 탭·초기화 ----------
function switchTab(id) {
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("on", b.dataset.tab === id));
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("on", t.id === "tab-" + id));
  try { localStorage.setItem("tab", id); } catch (e) { /* 무시 */ }
}
async function init() {
  $("#tabs").onclick = e => { const b = e.target.closest("button"); if (b) switchTab(b.dataset.tab); };
  $("#closeDetail").onclick = closeDetail; $("#scrim").onclick = closeDetail;
  addEventListener("keydown", e => { if (e.key === "Escape") closeDetail(); });
  ["q", "mkt", "secSel", "liquid"].forEach(id => $("#" + id).addEventListener("input", renderAll));
  try {
    const [l, u] = await Promise.all([fetch("data/latest.json", { cache: "no-store" }), fetch("data/universe.json", { cache: "no-store" })]);
    if (!l.ok || !u.ok) throw new Error("데이터 파일 없음");
    state.latest = await l.json(); state.universe = (await u.json()).rows;
  } catch (e) {
    $("#asof").textContent = "데이터를 불러오지 못했습니다 — 파이프라인이 아직 실행되지 않았거나 docs/data 가 비어 있습니다.";
    return;
  }
  $("#asof").textContent = `기준일 ${state.latest.asof} · ${state.latest.universe_size}종목 · 생성 ${state.latest.generated_at}`;
  const secs = [...new Set(state.universe.map(r => r.sector_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
  $("#secSel").innerHTML += secs.map(s => `<option>${s}</option>`).join("");
  renderMarket(); renderPresets(); renderWatch(); renderSectors(); renderAll();
  let t = "screen"; try { t = localStorage.getItem("tab") || t; } catch (e) { /* 무시 */ }
  switchTab(t);
}
init();
