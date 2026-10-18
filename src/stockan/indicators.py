"""지표 엔진. 최신 영업일 기준 종목별 feature 벡터를 만든다.

설계 원칙
- 장기(6개월+) 관점의 지표를 1급으로: 120/250일 회귀 추세, 수급 누적, 섹터 상대강도, 재무 추세
- 단기 지표(일중 변동, 거래량 급증)는 보조로 보관
- 모든 비율은 % 단위, 기울기는 연율화(%/년)로 통일해 프리셋에서 읽기 쉽게
"""
from __future__ import annotations

import json
import logging

import numpy as np
import pandas as pd

from .db import read_df, session, upsert

logger = logging.getLogger(__name__)

WINDOWS_TREND = (60, 120, 250)
WINDOWS_RET = (5, 20, 60, 120, 250)


def _reg(y: np.ndarray) -> tuple[float, float]:
    """log 가격 선형회귀 → (연율화 기울기 %, R²)."""
    n = len(y)
    if n < 10 or np.any(~np.isfinite(y)) or np.any(y <= 0):
        return np.nan, np.nan
    ly = np.log(y)
    t = np.arange(n, dtype=float)
    tm, ym = t.mean(), ly.mean()
    sxx = ((t - tm) ** 2).sum()
    if sxx == 0:
        return np.nan, np.nan
    slope = ((t - tm) * (ly - ym)).sum() / sxx
    resid = ly - (ym + slope * (t - tm))
    sst = ((ly - ym) ** 2).sum()
    r2 = 1 - (resid**2).sum() / sst if sst > 0 else np.nan
    return float((np.exp(slope * 250) - 1) * 100), float(r2)


def _rsi(close: pd.Series, n: int = 14) -> float:
    d = close.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    rs = up / dn.replace(0, np.nan)
    v = 100 - 100 / (1 + rs)
    return float(v.iloc[-1]) if len(v) else np.nan


def stock_features(px: pd.DataFrame, shares: float | None) -> dict:
    """px: 한 종목의 일봉(date 오름차순, 컬럼 open high low close volume amount)."""
    px = px.dropna(subset=["close"]).tail(300)
    if len(px) < 30:
        return {}
    c, v = px["close"].astype(float), px["volume"].astype(float)
    f: dict = {"date": px["date"].iloc[-1], "n_days": int(len(px))}
    last = px.iloc[-1]
    prev_close = c.iloc[-2]
    f.update(
        close=float(last.close),
        open=float(last.open),
        high=float(last.high),
        low=float(last.low),
        volume=int(last.volume),
        amount=float(last.amount),
        ret_1d=(last.close / prev_close - 1) * 100,
        gap=(last.open / prev_close - 1) * 100,
        range_pct=(last.high - last.low) / last.close * 100,
    )
    for w in WINDOWS_RET:
        f[f"ret_{w}"] = (c.iloc[-1] / c.iloc[-w - 1] - 1) * 100 if len(c) > w else np.nan
    for w in (20, 60, 120, 200):
        f[f"ma{w}"] = c.tail(w).mean() if len(c) >= w else np.nan
    f["close_vs_ma200"] = (c.iloc[-1] / f["ma200"] - 1) * 100 if f.get("ma200") else np.nan
    f["close_vs_ma60"] = (c.iloc[-1] / f["ma60"] - 1) * 100 if f.get("ma60") else np.nan
    f["ma_align"] = int(f["ma20"] > f["ma60"] > f["ma120"] > f["ma200"]) if f.get("ma200") else 0
    # 200일선 상향 돌파 여부 (최근 20일 내)
    if len(c) >= 220:
        above = (c.tail(220) > c.rolling(200).mean().tail(220)).astype(int)
        f["cross_ma200_20d"] = int(above.iloc[-1] == 1 and above.iloc[-20:].min() == 0)
    for w in WINDOWS_TREND:
        s, r2 = _reg(c.tail(w).to_numpy()) if len(c) >= w else (np.nan, np.nan)
        f[f"slope_{w}"], f[f"r2_{w}"] = s, r2
    # 52주 위치·낙폭
    yr = px.tail(250)
    hi, lo = yr["high"].max(), yr["low"].min()
    f["high52"], f["low52"] = float(hi), float(lo)
    f["pos_52w"] = (c.iloc[-1] - lo) / (hi - lo) * 100 if hi > lo else np.nan
    f["dd_52w"] = (c.iloc[-1] / hi - 1) * 100
    roll_max = c.tail(250).cummax()
    f["mdd_1y"] = float(((c.tail(250) / roll_max) - 1).min() * 100)
    # 변동성
    tr = pd.concat([px.high - px.low, (px.high - c.shift()).abs(), (px.low - c.shift()).abs()], axis=1).max(axis=1)
    f["atr14_pct"] = float(tr.tail(14).mean() / c.iloc[-1] * 100)
    f["vol_ann_60"] = float(c.pct_change().tail(60).std() * np.sqrt(250) * 100)
    # 거래량·거래대금
    f["vol_avg20"] = float(v.tail(20).mean())
    f["vol_ratio20"] = float(v.iloc[-1] / f["vol_avg20"]) if f["vol_avg20"] else np.nan
    # 기간별 거래량 배수: 최근 5일 평균 ÷ 직전 60일 평균, 최근 20일 평균 ÷ 직전 120일 평균
    if len(v) >= 65:
        base = v.iloc[-65:-5].mean()
        f["vr5"] = float(v.tail(5).mean() / base) if base else np.nan
    if len(v) >= 140:
        base = v.iloc[-140:-20].mean()
        f["vr20"] = float(v.tail(20).mean() / base) if base else np.nan
    f["amount_avg20"] = float(px["amount"].tail(20).mean())
    f["amount_avg60"] = float(px["amount"].tail(60).mean())
    obv = (np.sign(c.diff()).fillna(0) * v).cumsum()
    f["obv_chg20"] = float((obv.iloc[-1] - obv.iloc[-21]) / v.tail(20).sum() * 100) if len(obv) > 21 else np.nan
    if shares:
        f["turnover_20"] = float(v.tail(20).sum() / shares * 100)  # 20일 누적 회전율 %
        # 회전율 1%당 가격 변화: 적은 손바뀜으로 많이 오르면 큼(보유 성향·매물 소화)
        f["pv_eff_20"] = f["ret_20"] / f["turnover_20"] if f["turnover_20"] else np.nan
    f["rsi14"] = _rsi(c)
    return {k: (None if (isinstance(x, float) and not np.isfinite(x)) else x) for k, x in f.items()}


def investor_features(inv: pd.DataFrame, shares: float | None) -> dict:
    inv = inv.dropna(subset=["foreign_net"]).tail(130)
    if inv.empty:
        return {}
    f = {}
    for w in (5, 20, 60, 120):
        sub = inv.tail(w)
        if len(sub) < w * 0.8:
            continue
        fn, inn = float(sub.foreign_net.sum()), float(sub.inst_net.sum())
        f[f"frgn_net_{w}"], f[f"inst_net_{w}"] = fn, inn
        if shares:
            f[f"frgn_net_{w}_pct"] = fn / shares * 100
            f[f"inst_net_{w}_pct"] = inn / shares * 100
            f[f"smart_net_{w}_pct"] = (fn + inn) / shares * 100
    fr = inv.foreign_ratio.dropna()
    if len(fr):
        f["foreign_ratio"] = float(fr.iloc[-1])
        if len(fr) >= 60:
            f["foreign_ratio_chg_60"] = float(fr.iloc[-1] - fr.iloc[-60])
    # 외국인·기관 연속 순매수 일수
    s = (inv.foreign_net + inv.inst_net) > 0
    streak = 0
    for val in s[::-1]:
        if not val:
            break
        streak += 1
    f["smart_buy_streak"] = streak
    return f


def finance_features(fin: pd.DataFrame) -> dict:
    """분기 재무 → 영업이익 QoQ/YoY, 매출 YoY, 영업이익률 (실적치만, 컨센서스 제외)."""
    q = fin[(fin.period_type == "quarter") & (fin.is_consensus == 0)]
    if q.empty:
        return {}
    piv = q.pivot_table(index="period", columns="item", values="value").sort_index()
    f = {}
    rev, op, ni = piv.get("매출액"), piv.get("영업이익"), piv.get("당기순이익")
    if rev is not None and op is not None and len(piv) >= 2:
        f["op_income_q"] = float(op.iloc[-1])
        f["op_margin_q"] = float(op.iloc[-1] / rev.iloc[-1] * 100) if rev.iloc[-1] else None
        prev = op.iloc[-2]
        f["op_qoq"] = float((op.iloc[-1] - prev) / abs(prev) * 100) if prev else None
        f["op_turnaround"] = int(prev <= 0 < op.iloc[-1])
        if len(piv) >= 5:
            yo, yr_ = op.iloc[-5], rev.iloc[-5]
            f["op_yoy"] = float((op.iloc[-1] - yo) / abs(yo) * 100) if yo else None
            f["rev_yoy"] = float((rev.iloc[-1] - yr_) / abs(yr_) * 100) if yr_ else None
        # 최근 4분기 영업이익 추세(분기당 증가율의 회귀 기울기 부호)
        tail = op.tail(4).to_numpy(dtype=float)
        if len(tail) == 4 and np.all(np.isfinite(tail)):
            f["op_trend_4q"] = float(np.polyfit(np.arange(4), tail, 1)[0] / (abs(tail).mean() or 1) * 100)
        f["fin_period"] = str(piv.index[-1])
    # ROE 등 비율 항목이 있으면 그대로
    for item, key in (("ROE(%)", "roe"), ("부채비율(%)", "debt_ratio"), ("ROE", "roe"), ("부채비율", "debt_ratio")):
        if item in piv.columns and pd.notna(piv[item].iloc[-1]):
            f[key] = float(piv[item].iloc[-1])
    return f


def build_features() -> pd.DataFrame:
    stocks = read_df("SELECT * FROM stocks").set_index("code")
    px = read_df(
        """SELECT code,date,open,high,low,close,volume,amount FROM prices
           WHERE venue='KRX' AND date >= date((SELECT MAX(date) FROM prices),'-450 day') ORDER BY code,date"""
    )
    inv = read_df("SELECT * FROM investor ORDER BY code,date")
    fnd = read_df("SELECT * FROM fundamentals WHERE date=(SELECT MAX(date) FROM fundamentals)").set_index("code")
    fin = read_df("SELECT * FROM finance")
    latest = px["date"].max()

    rows = []
    inv_g = {k: g for k, g in inv.groupby("code")} if not inv.empty else {}
    fin_g = {k: g for k, g in fin.groupby("code")} if not fin.empty else {}
    for code, g in px.groupby("code"):
        if code not in stocks.index:
            continue
        if g["date"].iloc[-1] != latest:
            continue  # 거래정지 등 최신일 데이터 없는 종목 제외
        st = stocks.loc[code]
        shares = st.shares if pd.notna(st.shares) else None
        f = stock_features(g, shares)
        if not f:
            continue
        f.update(investor_features(inv_g[code], shares) if code in inv_g else {})
        f.update(finance_features(fin_g[code]) if code in fin_g else {})
        if code in fnd.index:
            r = fnd.loc[code]
            for k in ("per", "pbr", "div_yield", "foreign_rate", "target_price", "recomm", "nxt_close", "nxt_change_pct", "cns_per"):
                val = r.get(k)
                f[k] = float(val) if pd.notna(val) else None
            if f.get("target_price") and f["close"]:
                f["target_upside"] = (f["target_price"] / f["close"] - 1) * 100
            if f.get("nxt_close") and f["close"]:
                f["nxt_gap"] = (f["nxt_close"] / f["close"] - 1) * 100
        f.update(code=code, name=st["name"], market=st.market, sector_code=st.sector_code, sector_name=st.sector_name,
                 marcap=float(st.marcap) if pd.notna(st.marcap) else None)
        rows.append(f)
    df = pd.DataFrame(rows)
    if df.empty:
        return df
    df = add_sector_features(df)
    # 시장 전체 대비 수익률 백분위
    for w in (20, 60, 120, 250):
        df[f"ret_{w}_pct_rank"] = df[f"ret_{w}"].rank(pct=True) * 100
    # 저장
    with session() as con:
        upsert(
            con, "features",
            [{"code": r["code"], "date": latest, "payload": json.dumps(_clean(r), ensure_ascii=False)} for r in df.to_dict("records")],
        )
    logger.info("features %d종목 (%s)", len(df), latest)
    return df


def add_sector_features(df: pd.DataFrame) -> pd.DataFrame:
    """업종 집계(시총가중 수익률·거래대금)와 종목의 섹터 대비 초과수익/업종 내 순위."""
    df = df.copy()
    has = df["sector_code"].notna()
    w = df["marcap"].fillna(0)
    for n in (5, 20, 60, 120):
        col = f"ret_{n}"
        grp = df[has].groupby("sector_code")
        wret = grp.apply(lambda g: np.average(g[col].fillna(0), weights=(g["marcap"].fillna(0) + 1)))
        med = grp[col].median()
        df[f"sector_ret_{n}"] = df["sector_code"].map(wret)
        df[f"sector_med_ret_{n}"] = df["sector_code"].map(med)
        df[f"excess_{n}"] = df[col] - df[f"sector_med_ret_{n}"]
        # 업종 상대강도 순위(백분위, 높을수록 강한 업종)
        rank = wret.rank(pct=True) * 100
        df[f"sector_rs_{n}"] = df["sector_code"].map(rank)
        df[f"rank_in_sector_{n}"] = df[has].groupby("sector_code")[col].rank(ascending=False, method="min")
    df["sector_size"] = df["sector_code"].map(df[has].groupby("sector_code").size())
    return df


def sector_table(df: pd.DataFrame) -> pd.DataFrame:
    has = df["sector_code"].notna()
    g = df[has].groupby(["sector_code", "sector_name"])
    out = g.agg(
        n=("code", "size"),
        marcap=("marcap", "sum"),
        amount_avg20=("amount_avg20", "sum"),
        ret_1d=("sector_ret_5", "first"),
        ret_5=("sector_ret_5", "first"),
        ret_20=("sector_ret_20", "first"),
        ret_60=("sector_ret_60", "first"),
        ret_120=("sector_ret_120", "first"),
        rs_60=("sector_rs_60", "first"),
        rs_120=("sector_rs_120", "first"),
        breadth_ma200=("close_vs_ma200", lambda s: float((s > 0).mean() * 100)),
        frgn_60_pct=("frgn_net_60_pct", "median"),
    ).reset_index()
    out["ret_1d"] = df[has].groupby("sector_code").apply(
        lambda g: np.average(g["ret_1d"].fillna(0), weights=(g["marcap"].fillna(0) + 1))
    ).reindex(out["sector_code"]).to_numpy()
    return out.sort_values("ret_60", ascending=False)


def _clean(d: dict) -> dict:
    out = {}
    for k, v in d.items():
        if isinstance(v, (np.floating, float)):
            out[k] = None if not np.isfinite(v) else round(float(v), 4)
        elif isinstance(v, (np.integer,)):
            out[k] = int(v)
        elif v is pd.NaT or (isinstance(v, float) and pd.isna(v)):
            out[k] = None
        else:
            out[k] = v
    return out
