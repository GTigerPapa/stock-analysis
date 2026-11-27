"""피터 린치식 분류 · 적정가 구간 · 스토리 카드 (데이터로 만들 수 있는 부분만).

- 6분류: 저성장주 / 대형우량주 / 고성장주 / 경기순환주 / 회생주 / 자산주  (『전설로 떠나는 월가의 영웅』)
- 린치 지표 = (이익 성장률 + 배당수익률) ÷ PER.  2 이상 매력, 1.5 양호, 1 미만 부족
- 적정가 = 예상 EPS × 성장률 (PER = 성장률일 때의 가격).  매수 구간 0.8·0.65·0.5배, 매도 구간 1.2·1.5배
- 스토리 카드는 숫자로 자동 작성한 '초안'이다. 사업 내용·경쟁력·경영진 판단은 사람이 한다.
한계: 연간 실적은 실적 3년 + 컨센서스 1년뿐이라 성장률은 2년 연평균과 컨센서스 중 낮은 쪽을 쓴다.
"""
from __future__ import annotations

import logging
from datetime import date, timedelta

import numpy as np
import pandas as pd

from .dart import REPRT_ORDER
from .db import read_df

logger = logging.getLogger(__name__)

CATS = {0: "분류 불가", 1: "저성장주", 2: "대형우량주", 3: "고성장주", 4: "경기순환주", 5: "회생주", 6: "자산주"}
CYCLICAL = {
    "반도체와반도체장비", "화학", "철강", "비철금속", "조선", "해운사", "건설", "건축자재", "자동차", "자동차부품",
    "석유와가스", "디스플레이패널", "디스플레이장비및부품", "기계", "항공사", "증권", "에너지장비및서비스", "종이와목재",
}
FINANCIAL = {"은행", "증권", "생명보험", "손해보험", "카드", "기타금융", "창업투자"}
BUY_K, SELL_K = (0.8, 0.65, 0.5), (1.2, 1.5)
ZONES = {3: "매수 3차", 2: "매수 2차", 1: "매수 1차", 0: "관망", -1: "매도 1차", -2: "매도 2차"}
G_CAP = 30.0  # 린치: 연 30%를 넘는 성장은 오래가기 어렵다 → 지표·적정가 계산에는 30%까지만 인정
FIELDS = ["lynch_cat", "lynch_cat_n", "lynch_g", "lynch_rev_g", "lynch_per", "lynch_peg", "lynch_ratio", "lynch_fair", "lynch_gap",
          "lynch_zone", "lynch_zone_n", "inv_gap", "cash_mcap", "insider_net_6m", "buyback_12m_pct", "lynch_bad"]


def _f(v):
    try:
        v = float(v)
        return v if np.isfinite(v) else None
    except (TypeError, ValueError):
        return None


class Ctx:
    """분석에 쓰는 원자료 묶음 (finance + DART 보조 테이블). 테이블이 없으면 빈 값으로 동작."""

    def __init__(self):
        fin = read_df("SELECT code,period_type,period,item,value,is_consensus FROM finance WHERE item IN ('EPS','매출액','영업이익','주당배당금')")
        self.fin = {k: g for k, g in fin.groupby("code")} if not fin.empty else {}
        self.shares = dict(read_df("SELECT code,shares FROM stocks").values.tolist())
        self.dfin, self.ins, self.bb = {}, {}, {}
        for name, sql, attr in (
            ("dart_fin", "SELECT * FROM dart_fin WHERE fs_div!='NONE'", "dfin"),
            ("insider", "SELECT * FROM insider ORDER BY date", "ins"),
            ("buyback", "SELECT * FROM buyback ORDER BY date", "bb"),
        ):
            try:
                t = read_df(sql)
                setattr(self, attr, {k: g for k, g in t.groupby("code")} if not t.empty else {})
            except Exception:  # noqa: BLE001 — 테이블 없음(아직 수집 전)
                logger.debug("%s 없음", name)


def _annual_eps(fin: pd.DataFrame | None):
    if fin is None:
        return [], None
    a = fin[(fin.period_type == "annual") & (fin.item == "EPS")].sort_values("period")
    act = [(r.period, _f(r.value)) for r in a[a.is_consensus == 0].itertuples() if _f(r.value) is not None]
    con = [(r.period, _f(r.value)) for r in a[a.is_consensus == 1].itertuples() if _f(r.value) is not None]
    return act, (con[0] if con else None)


def _annual_rev_cagr(fin: pd.DataFrame | None) -> float | None:
    """연간 매출(실적치)의 연평균 성장률(%)."""
    if fin is None:
        return None
    a = fin[(fin.period_type == "annual") & (fin.item == "매출액") & (fin.is_consensus == 0)].sort_values("period")
    v = [_f(x) for x in a.value]
    v = [x for x in v if x is not None]
    if len(v) >= 2 and v[0] > 0 and v[-1] > 0:
        return ((v[-1] / v[0]) ** (1 / (len(v) - 1)) - 1) * 100
    return None


def _quarters(fin: pd.DataFrame | None):
    """분기 매출 YoY(%) 목록과 영업이익률(%) 목록 (실적치만, 오래된 순)."""
    if fin is None:
        return [], []
    q = fin[(fin.period_type == "quarter") & (fin.is_consensus == 0) & fin.item.isin(["매출액", "영업이익"])]
    if q.empty:
        return [], []
    piv = q.pivot_table(index="period", columns="item", values="value").sort_index()
    if "매출액" not in piv or "영업이익" not in piv:
        return [], []
    rev, op = piv["매출액"], piv["영업이익"]
    yoy = [float((rev.iloc[i] / rev.iloc[i - 4] - 1) * 100) for i in range(4, len(rev)) if rev.iloc[i - 4] and rev.iloc[i - 4] > 0 and pd.notna(rev.iloc[i])]
    mg = [float(o / r * 100) for o, r in zip(op, rev) if pd.notna(o) and pd.notna(r) and r > 0]
    return yoy, mg


def _dart_block(code: str, rec: dict, ctx: Ctx, today: date) -> dict:
    out: dict = {"inv_gap": None, "cash_mcap": None, "cfo": None, "insider_net_6m": None, "buyback_12m_pct": None,
                 "insiders": [], "buybacks": [], "fin_asof": None}
    g = ctx.dfin.get(code)
    if g is not None and len(g):
        g = g.assign(o=g.reprt.map(REPRT_ORDER)).sort_values(["year", "o"])
        last = g.iloc[-1]
        out["fin_asof"] = f"{int(last.year)}년 {['', '1분기', '반기', '3분기', '사업'][int(last.o)]}보고서"
        out["cfo"] = _f(last.cfo)
        prev = g[(g.year == last.year - 1) & (g.reprt == last.reprt)]
        if len(prev):
            p = prev.iloc[0]
            iv, ip, rv, rp = _f(last.inventory), _f(p.inventory), _f(last.revenue), _f(p.revenue)
            if iv and ip and rv and rp and ip > 0 and rp > 0:
                out["inv_yoy"] = float((iv / ip - 1) * 100)
                out["rev_yoy_cum"] = float((rv / rp - 1) * 100)
                out["inv_gap"] = out["inv_yoy"] - out["rev_yoy_cum"]
        if _f(last.cash) and rec.get("marcap"):
            out["cash_mcap"] = float(last.cash) / float(rec["marcap"]) * 100
    sh = _f(ctx.shares.get(code))
    i = ctx.ins.get(code)
    if i is not None and len(i):
        cut = (today - timedelta(days=180)).isoformat()
        r6 = i[i.date >= cut]
        chg = r6.shares_chg.fillna(0)
        if len(r6) and sh:
            out["insider_net_6m"] = round(float(chg.sum()) / sh * 100, 3)
        out["insider_n"] = [int((chg > 0).sum()), int((chg < 0).sum())]
        out["insiders"] = [{"date": r.date, "name": r.name, "pos": r.position, "chg": _f(r.shares_chg)}
                           for r in i[i.shares_chg.fillna(0) != 0].tail(8).iloc[::-1].itertuples()]
    b = ctx.bb.get(code)
    if b is not None and len(b):
        cut = (today - timedelta(days=365)).isoformat()
        r12 = b[b.date.fillna("") >= cut]
        if len(r12) and rec.get("marcap"):
            out["buyback_12m_pct"] = round(float(r12.amount.fillna(0).sum()) / rec["marcap"] * 100, 2)
        out["buybacks"] = [{"date": r.date, "amount": _f(r.amount), "purpose": r.purpose} for r in b.tail(5).iloc[::-1].itertuples()]
    return out


def analyze(rec: dict, ctx: Ctx, today: date | None = None) -> tuple[dict, dict]:
    """한 종목 → (features 에 넣을 숫자 필드, 스토리 카드 dict)."""
    today = today or date.today()
    code, close = rec.get("code"), _f(rec.get("close"))
    fin = ctx.fin.get(code)
    act, con = _annual_eps(fin)
    sector = rec.get("sector_name") or ""
    div, pbr, marcap, debt = _f(rec.get("div_yield")) or 0.0, _f(rec.get("pbr")), _f(rec.get("marcap")), _f(rec.get("debt_ratio"))
    out = {k: None for k in FIELDS}
    eps_last = act[-1][1] if act else None
    eps_con = con[1] if con else None

    g_hist = g_fwd = None
    if len(act) >= 2 and act[0][1] > 0 and act[-1][1] > 0:
        g_hist = ((act[-1][1] / act[0][1]) ** (1 / (len(act) - 1)) - 1) * 100
    if eps_con and eps_con > 0 and eps_last and eps_last > 0:
        yrs = max(1, int(con[0][:4]) - int(act[-1][0][:4]))
        g_fwd = ((eps_con / eps_last) ** (1 / yrs) - 1) * 100
    gs = [x for x in (g_hist, g_fwd) if x is not None]
    g = min(gs) if gs else None
    rev_g = _annual_rev_cagr(fin)
    out["lynch_rev_g"] = round(rev_g, 1) if rev_g is not None else None
    turnaround = bool((eps_last is not None and eps_last <= 0 and eps_con and eps_con > 0)
                      or (len(act) >= 2 and act[-2][1] <= 0 < act[-1][1]))
    eps_base = eps_con if (eps_con and eps_con > 0) else (eps_last if eps_last and eps_last > 0 else None)
    per = close / eps_base if (close and eps_base) else None

    # ---- 6분류 ----
    if turnaround:
        cat = 5
    elif eps_base is None or g is None:
        cat = 6 if (pbr and pbr <= 0.5 and eps_base) else 0
    elif g < 0:
        cat = 0  # 이익 감소 중
    elif sector in CYCLICAL:
        cat = 4
    elif g >= 20 and (rev_g is None or rev_g >= 10):
        cat = 3  # 이익과 매출이 함께 크는 경우만 고성장주
    elif pbr and pbr <= 0.5:
        cat = 6
    elif g >= 8:
        cat = 2
    else:
        cat = 1
    out["lynch_cat_n"], out["lynch_cat"] = cat, CATS[cat]

    # ---- 린치 지표 · 적정가 ----
    zones = None
    if per and g is not None and cat != 5:
        g_use = float(np.clip(g, -50, G_CAP))
        out["lynch_g"], out["lynch_per"] = round(g, 1), round(per, 1)
        out["lynch_ratio"] = round((g_use + div) / per, 2)
        if g_use >= 5:
            out["lynch_peg"] = round(per / g_use, 2)
            fair = eps_base * g_use
            out["lynch_fair"] = round(fair)
            out["lynch_gap"] = round((close / fair - 1) * 100, 1)
            k = close / fair
            zn = 3 if k <= BUY_K[2] else 2 if k <= BUY_K[1] else 1 if k <= BUY_K[0] else 0 if k < SELL_K[0] else -1 if k < SELL_K[1] else -2
            out["lynch_zone_n"], out["lynch_zone"] = zn, ZONES[zn]
            zones = {"fair": round(fair), "buy": [round(fair * x) for x in BUY_K], "sell": [round(fair * x) for x in SELL_K]}

    dx = _dart_block(code, rec, ctx, today)
    for k in ("inv_gap", "cash_mcap", "insider_net_6m", "buyback_12m_pct"):
        out[k] = round(dx[k], 2) if dx.get(k) is not None else None

    # ---- 점검 항목 ----
    checks = []

    def ck(label, status, text, desc=""):
        checks.append({"label": label, "status": status, "text": text, "desc": desc})

    r = out["lynch_ratio"]
    if r is not None:
        ck("린치 지표", "good" if r >= 1.5 else "warn" if r >= 1 else "bad", f"{r:.2f}",
           "(성장률+배당수익률)÷PER. 2 이상 매력, 1.5 양호, 1 미만 부족")
    if g is not None and g >= 15 and rev_g is not None:
        weak = g > 3 * max(rev_g, 5)
        ck("이익 성장의 질", "bad" if (weak and rev_g < 10) else "warn" if weak else "good", f"EPS {g:+.0f}%/년 vs 매출 {rev_g:+.0f}%/년",
           "이익만 급증하고 매출이 따라오지 않으면 기저효과·일회성일 수 있어 지속성이 낮다")
    if debt is not None and sector not in FINANCIAL:
        ck("부채비율", "good" if debt <= 100 else "warn" if debt <= 200 else "bad", f"{debt:.0f}%", "린치: 부채가 적은 회사는 망하기 어렵다")
    if dx.get("inv_gap") is not None:
        ig = dx["inv_gap"]
        ck("재고 vs 매출", "good" if ig <= 0 else "warn" if ig <= 10 else "bad",
           f"재고 {dx['inv_yoy']:+.0f}% / 매출 {dx['rev_yoy_cum']:+.0f}%", f"재고가 매출보다 빨리 늘면 경고 ({dx['fin_asof']}, 전년 같은 시점 대비)")
    if dx.get("cfo") is not None:
        ck("영업현금흐름", "good" if dx["cfo"] > 0 else "bad", "플러스" if dx["cfo"] > 0 else "마이너스", f"{dx['fin_asof']} 누적")
    if dx.get("cash_mcap") is not None:
        ck("현금성자산/시총", "good" if dx["cash_mcap"] >= 20 else "na", f"{dx['cash_mcap']:.0f}%", "차입금은 빼지 않은 값(순현금 아님)")
    if dx.get("insider_n"):
        nb, ns = dx["insider_n"]
        if nb or ns:
            ck("임원·주요주주 6개월", "good" if nb > ns else "warn" if ns > nb else "na", f"증가 {nb}건 / 감소 {ns}건",
               "DART 소유상황보고. 증가에는 상여·행사·상속도 포함되므로 장내매수인지는 공시 원문 확인")
    if dx.get("buyback_12m_pct"):
        ck("자사주 취득 결정 12개월", "good" if dx["buyback_12m_pct"] >= 0.5 else "na", f"시총의 {dx['buyback_12m_pct']:.1f}%", "취득 목적(소각/보상)은 공시 확인")

    yoy, mg = _quarters(fin)
    if cat == 3 and len(yoy) >= 6:
        recent, base = yoy[-2:], float(np.mean(yoy[-6:-2]))
        broke = base > 0 and all(x < base / 2 for x in recent)
        ck("성장 둔화", "bad" if broke else "good", f"최근 2분기 매출 {recent[0]:+.0f}%·{recent[1]:+.0f}% (직전 4분기 평균 {base:+.0f}%)",
           "고성장주는 성장률이 직전 추세의 절반 아래로 2분기 연속 떨어지면 스토리 훼손")
    if cat == 4 and len(mg) >= 12:
        pct = float((np.array(mg[:-1]) <= mg[-1]).mean() * 100)
        ck("이익률 위치", "warn" if pct >= 90 else "good" if pct <= 40 else "na", f"영업이익률 {mg[-1]:.1f}% (과거 대비 상위 {100 - pct:.0f}%)",
           "경기순환주는 이익이 정점이라 PER이 가장 낮아 보일 때가 위험, 이익이 바닥일 때가 기회")
    if cat == 1:
        ck("배당수익률", "good" if div >= 3 else "na", f"{div:.1f}%", "저성장주는 배당이 보유 이유")
    out["lynch_bad"] = sum(1 for c in checks if c["status"] == "bad")

    # ---- 2분 설명 (자동 초안) ----
    eps_txt = " → ".join(f"{p[:4]}년 {v:,.0f}원" for p, v in act[-3:]) + (f" → {con[0][:4]}년(예상) {eps_con:,.0f}원" if eps_con else "")
    why = {
        1: "성장은 느리지만 배당을 주는 성숙 기업. 배당이 유지되는 한 보유하고, 큰 시세차익은 기대하지 않는다.",
        2: "연 8~20% 성장하는 우량 기업. 30~50% 오르면 일부 정리하고 다시 싸지면 사는 순환 매매 대상.",
        3: "연 20% 이상 성장하는 기업. 성장이 이어지는 동안 보유하는 것이 핵심이고, 성장률 대비 PER이 과하지 않아야 한다.",
        4: "경기에 따라 이익이 크게 출렁이는 업종. 매수·매도 시점이 전부이며, 낮은 PER을 싸다고 해석하면 안 된다.",
        5: "적자에서 벗어나는 중인 기업. 살아남을 현금과 부채 구조, 실제 흑자 전환 여부가 핵심이다.",
        6: "이익보다 보유 자산이 주가보다 큰 기업. 자산 가치가 실제로 드러날 계기가 있는지가 핵심이다.",
        0: ("이익이 줄고 있어 린치의 어느 유형에도 넣기 어렵다. 감소가 일시적인지(회생 후보) 구조적인지부터 확인해야 한다."
            if (g is not None and g < 0) else "이익이 없거나 성장률을 계산할 수 없어 린치 기준으로 평가하기 어렵다."),
    }[cat]
    need = {
        1: "배당이 줄지 않고 배당성향이 감당 가능한 수준일 것",
        2: "이익 성장률이 꾸준히 이어지고 PER이 성장률 근처로 내려올 것",
        3: "매출·이익 성장률이 유지되고, 재고와 부채가 매출보다 빨리 늘지 않을 것",
        4: "업황이 바닥을 지나 재고가 줄고 가격·가동률이 돌아설 것",
        5: "분기 영업이익이 흑자로 돌아서고 부채 부담이 줄어들 것",
        6: "자산 매각·분할·주주환원처럼 숨은 가치가 드러나는 사건",
        0: "이익이 다시 늘어나는 것이 실적으로 확인될 것",
    }[cat]
    sell = {
        1: "배당 삭감, 시장 점유율 하락",
        2: "PER이 성장률을 크게 넘어서거나, 신사업 다각화로 이익의 질이 나빠질 때",
        3: "성장률이 꺾일 때, 점포·시장 확장이 한계에 닿을 때, PER이 성장률의 1.5배를 넘을 때",
        4: "이익률이 과거 정점에 근접하고 재고가 쌓이기 시작할 때 (PER이 가장 낮아 보이는 시점)",
        5: "회생이 완료되어 누구나 아는 정상 기업이 되고 PER이 시장 평균만큼 올라왔을 때",
        6: "자산 가치가 주가에 반영됐을 때, 또는 회사가 자산을 낭비하기 시작할 때",
        0: "–",
    }[cat]
    card = {
        "cat": CATS[cat], "cat_n": cat, "why": why, "need": need, "sell": sell, "eps": eps_txt or None,
        "g_hist": round(g_hist, 1) if g_hist is not None else None, "g_fwd": round(g_fwd, 1) if g_fwd is not None else None,
        "g": out["lynch_g"], "rev_g": out["lynch_rev_g"], "g_cap": G_CAP, "per": out["lynch_per"], "peg": out["lynch_peg"], "ratio": out["lynch_ratio"], "div": round(div, 2),
        "zones": zones, "zone": out["lynch_zone"], "gap": out["lynch_gap"], "checks": checks,
        "insiders": dx["insiders"], "buybacks": dx["buybacks"], "fin_asof": dx["fin_asof"],
        "zone_note": ("경기순환주·자산주는 PER 기반 적정가가 잘 맞지 않는다. 참고만 할 것." if cat in (4, 6) else None),
    }
    return out, card


def add_lynch(df: pd.DataFrame) -> pd.DataFrame:
    """features df 에 린치 필드 추가 (스크리너·표에서 사용)."""
    try:
        ctx = Ctx()
    except Exception as e:  # noqa: BLE001
        logger.warning("린치 분석 건너뜀: %s", e)
        return df
    rows = []
    for rec in df.replace({np.nan: None}).to_dict("records"):
        try:
            rows.append(analyze(rec, ctx)[0])
        except Exception as e:  # noqa: BLE001
            logger.debug("린치 %s 실패: %s", rec.get("code"), e)
            rows.append({k: None for k in FIELDS})
    add = pd.DataFrame(rows, index=df.index)
    df = df.drop(columns=[c for c in FIELDS if c in df.columns]).join(add)
    logger.info("린치 분류: %s", df.lynch_cat.value_counts().to_dict())
    return df
