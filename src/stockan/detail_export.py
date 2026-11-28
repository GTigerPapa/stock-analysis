"""전 종목 상세 JSON (docs/data/stock/{code}.json) + 업종/시장 지수 시계열 (docs/data/series.json).

상세 파일 구조 (키를 짧게 해서 용량 절약)
  d   : 최근 520거래일 일봉  [date, open, high, low, close, volume]
  inv : 최근 520거래일 수급  [date, 외국인, 기관, 개인] (주)
  mo  : 월말 종가 (최대 6년) [YYYY-MM, close]
  y0  : 연도별 첫 거래일 종가 [YYYY, 날짜, close]
  own : 지분 구성 추이 {fr: [[date, 외국인 지분율%]] (주 1점), mj: {n: 최대주주명, p0, s: [[보고일, %]]}, np: {p0, s}}
        mj·np 는 DART 대량보유 보고(5% 룰) 기준 계단 시계열. p0 = 첫 보고 이전 지분율
  fq / fa : 분기 / 연간 실적  {period, consensus, 항목: 값}
  desc: 종목 설명, sector_desc: 업종 설명, f: 지표 전체
"""
from __future__ import annotations

import json
import logging
from datetime import date, timedelta

import numpy as np
import pandas as pd

from .config import DOCS_DATA
from .dart import holder_series
from .db import read_df
from .sector_info import SECTOR_INFO

logger = logging.getLogger(__name__)
DAILY_N = 520


def _r(v, nd=2):
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return None
    return round(float(v), nd)


def _dump(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def export_details(df: pd.DataFrame) -> int:
    """df: build_features 결과(종목별 feature). 전 종목 상세 파일 생성."""
    start_d = (date.today() - timedelta(days=int(DAILY_N * 1.5) + 30)).isoformat()
    start_m = (date.today() - timedelta(days=365 * 6)).isoformat()
    px = read_df(
        "SELECT code,date,open,high,low,close,volume FROM prices WHERE venue='KRX' AND date>=? ORDER BY code,date", (start_d,)
    )
    mo = read_df("SELECT code,date,close FROM prices WHERE venue='KRX' AND date>=? ORDER BY code,date", (start_m,))
    inv = read_df("SELECT code,date,foreign_net,inst_net,indiv_net,foreign_ratio FROM investor WHERE date>=? ORDER BY code,date", (start_d,))
    try:
        own = read_df("SELECT code,rcept_no,date,holder,pct,chg FROM ownership ORDER BY code,date")
        og = {k: g.replace({np.nan: None}).to_dict("records") for k, g in own.groupby("code")}
    except Exception:  # noqa: BLE001  (테이블 없음 등 → 외국인 지분율만 표시)
        og = {}
    fin = read_df("SELECT code,period_type,period,item,value,is_consensus FROM finance")
    try:
        prof = dict(read_df("SELECT code,description FROM profiles").values.tolist())
    except Exception:  # noqa: BLE001
        prof = {}

    mo["ym"] = mo["date"].str[:7]
    mlast = mo.groupby(["code", "ym"]).close.last().reset_index()
    # 연도별 첫 거래일 종가 (월별 Trend의 연초 기준가)
    mo["y"] = mo["date"].str[:4]
    yfirst = mo.groupby(["code", "y"]).agg(d0=("date", "first"), c0=("close", "first")).reset_index()
    yg = {k: g for k, g in yfirst.groupby("code")}
    pg = {k: g for k, g in px.groupby("code")}
    mg = {k: g for k, g in mlast.groupby("code")}
    ig = {k: g for k, g in inv.groupby("code")}
    fg = {k: g for k, g in fin.groupby("code")}

    def own_block(code, i):
        """외국인 지분율(주 1점, 마지막 날 포함) + DART 최대주주·국민연금 계단 시계열."""
        out = {"fr": []}
        if i is not None:
            fr = i.tail(DAILY_N)[["date", "foreign_ratio"]].dropna()
            if len(fr):
                fr = fr.iloc[::-1].iloc[::5].iloc[::-1]
                out["fr"] = [[r.date, _r(r.foreign_ratio)] for r in fr.itertuples()]
        if code in og:
            out.update(holder_series(og[code]))
        return out

    def fin_rows(g, kind):
        if g is None:
            return []
        g = g[g.period_type == kind]
        rows = {}
        for r in g.itertuples():
            rows.setdefault(r.period, {"period": r.period, "consensus": bool(r.is_consensus)})[r.item] = _r(r.value)
        return [rows[k] for k in sorted(rows)]

    try:
        from . import lynch
        lctx = lynch.Ctx()
    except Exception as e:  # noqa: BLE001
        logger.warning("린치 카드 건너뜀: %s", e)
        lynch, lctx = None, None

    # 린치 추이: 과거(실적 기준, 주 1점) + 실시간 기록(features 에 매일 저장된 컨센서스 반영 값)
    mo_g = {k: g for k, g in mo.groupby("code")}
    try:
        lv = read_df("""SELECT code, date, json_extract(payload,'$.lynch_cat_n') AS c, json_extract(payload,'$.lynch_ratio') AS r,
                               json_extract(payload,'$.lynch_gap') AS g, json_extract(payload,'$.lynch_gap_op') AS go FROM features
                        WHERE json_extract(payload,'$.lynch_cat_n') IS NOT NULL ORDER BY code, date""")
        live_g = {k: [[r.date, int(r.c), _r(r.r), _r(r.g, 1), _r(r.go, 1)] for r in g.itertuples()] for k, g in lv.groupby("code")}
    except Exception:  # noqa: BLE001
        live_g = {}

    def lynch_hist(code, rec):
        if lctx is None:
            return None
        try:
            h = lynch.history(mo_g.get(code), fg.get(code), rec.get("sector_name") or "", shares=lctx.shares.get(code))
            h = [[r[0], r[1], _r(r[2]), _r(r[3], 1), _r(r[4], 1)] for r in h]
        except Exception:  # noqa: BLE001
            h = []
        return {"h": h, "live": live_g.get(code, [])}

    def lynch_card(rec):
        if lctx is None:
            return None
        try:
            return lynch.analyze(rec, lctx)[1]
        except Exception:  # noqa: BLE001
            return None

    n = 0
    sd = DOCS_DATA / "stock"
    for rec in df.replace({np.nan: None}).to_dict("records"):
        code = rec["code"]
        p = pg.get(code)
        if p is None or p.empty:
            continue
        p = p.tail(DAILY_N)
        i = ig.get(code)
        out = {
            "code": code,
            "name": rec.get("name"),
            "market": rec.get("market"),
            "sector_name": rec.get("sector_name"),
            "sector_desc": SECTOR_INFO.get(rec.get("sector_name") or "", None),
            "desc": prof.get(code),
            "f": {k: (_r(v, 4) if isinstance(v, float) else v) for k, v in rec.items()},
            "d": [[r.date, _r(r.open, 0), _r(r.high, 0), _r(r.low, 0), _r(r.close, 0), int(r.volume or 0)] for r in p.itertuples()],
            "inv": [] if i is None else [[r.date, _r(r.foreign_net, 0), _r(r.inst_net, 0), _r(r.indiv_net, 0)] for r in i.tail(DAILY_N).itertuples()],
            "mo": [] if code not in mg else [[r.ym, _r(r.close, 0)] for r in mg[code].itertuples()],
            "y0": [] if code not in yg else [[r.y, r.d0, _r(r.c0, 0)] for r in yg[code].itertuples()],
            "own": own_block(code, i),
            "lynch": lynch_card(rec),
            "lyh": lynch_hist(code, rec),
            "fq": fin_rows(fg.get(code), "quarter"),
            "fa": fin_rows(fg.get(code), "annual"),
        }
        _dump(sd / f"{code}.json", out)
        n += 1
    logger.info("상세 파일 %d종목", n)
    return n


def export_series(df: pd.DataFrame) -> None:
    """업종·시장 동일가중 지수 (최근 520거래일). 일간 수익률은 ±30%로 잘라 이상치 영향 제한."""
    start_d = (date.today() - timedelta(days=int(DAILY_N * 1.5) + 30)).isoformat()
    px = read_df("SELECT code,date,close FROM prices WHERE venue='KRX' AND date>=?", (start_d,))
    piv = px.pivot(index="date", columns="code", values="close").sort_index().tail(DAILY_N + 1)
    ret = piv.pct_change(fill_method=None).clip(-0.3, 0.3).iloc[1:]
    meta = df.set_index("code")[["market", "sector_name"]]

    def index_of(cols):
        cols = [c for c in cols if c in ret.columns]
        if not cols:
            return None
        r = ret[cols].mean(axis=1).fillna(0)
        return [round(float(v), 2) for v in (1 + r).cumprod() * 100]

    out = {
        "dates": list(ret.index),
        "market": {
            "KOSPI": index_of(meta.index[meta.market == "KOSPI"]),
            "KOSDAQ": index_of(meta.index[meta.market == "KOSDAQ"]),
        },
        "sector": {},
        "info": SECTOR_INFO,
        "count": {k: int(v) for k, v in meta.groupby("sector_name").size().items()},
    }
    for sec, g in meta.groupby("sector_name"):
        v = index_of(g.index)
        if v:
            out["sector"][sec] = v
    _dump(DOCS_DATA / "series.json", out)
    logger.info("지수 시계열: 업종 %d개", len(out["sector"]))
