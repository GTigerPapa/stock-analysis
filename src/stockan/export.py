"""features → 웹앱이 읽는 정적 JSON (docs/data/)."""
from __future__ import annotations

import json
import logging
from datetime import datetime

import numpy as np
import pandas as pd

from .config import DOCS_DATA, load_presets, load_watchlist
from .db import read_df
from .holdings import diff as holdings_diff, evaluate as holdings_eval
from .indicators import sector_table
from .screener import run_all

logger = logging.getLogger(__name__)

UNIVERSE_COLS = [
    "code", "name", "market", "sector_name", "marcap", "close", "ret_1d", "ret_5", "ret_20", "ret_60", "ret_120", "ret_250",
    "slope_60", "slope_120", "slope_250", "r2_120", "close_vs_ma200", "ma_align", "dd_52w", "pos_52w", "vol_ann_60",
    "amount_avg20", "vol_ratio20", "turnover_20", "pv_eff_20", "smart_net_20_pct", "smart_net_60_pct", "smart_net_120_pct",
    "frgn_net_60_pct", "inst_net_60_pct", "foreign_ratio", "foreign_ratio_chg_60", "smart_buy_streak",
    "per", "pbr", "div_yield", "target_upside", "op_qoq", "op_yoy", "rev_yoy", "op_margin_q",
    "excess_60", "excess_120", "sector_rs_60", "rank_in_sector_60", "sector_size", "nxt_close", "nxt_gap", "rsi14",
    "vr5", "vr20", "smart_net_5_pct", "ret_250_pct_rank",
]
PRESET_COLS = ["rank", "score"] + UNIVERSE_COLS


def _records(df: pd.DataFrame, cols: list[str]) -> list[dict]:
    cols = [c for c in cols if c in df.columns]
    out = df[cols].replace({np.nan: None}).to_dict("records")
    for r in out:
        for k, v in r.items():
            if isinstance(v, float):
                r[k] = round(v, 3)
    return out


def _dump(name: str, obj) -> None:
    p = DOCS_DATA / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def _stock_detail(code: str, feat: dict) -> dict:
    px = read_df(
        "SELECT date,open,high,low,close,volume FROM prices WHERE code=? AND venue='KRX' ORDER BY date DESC LIMIT 500", (code,)
    ).iloc[::-1]
    inv = read_df(
        "SELECT date,foreign_net,inst_net,indiv_net,foreign_ratio FROM investor WHERE code=? ORDER BY date DESC LIMIT 250", (code,)
    ).iloc[::-1]
    fin = read_df(
        "SELECT period,item,value,is_consensus FROM finance WHERE code=? AND period_type='quarter' ORDER BY period", (code,)
    )
    fin_rows = {}
    for r in fin.itertuples():
        fin_rows.setdefault(r.period, {"period": r.period, "consensus": bool(r.is_consensus)})[r.item] = r.value
    return {
        "code": code,
        "name": feat.get("name"),
        "features": feat,
        "prices": px.values.tolist(),
        "investor": inv.replace({np.nan: None}).values.tolist(),
        "finance": list(fin_rows.values()),
    }


def _watch_with_checks(watch: list[dict], byc: dict, asof: str) -> list[dict]:
    """관심(보유) 종목 점검표 + 상태 변화 이력(holdings_history.json, 날짜별 항목 상태)."""
    hp = DOCS_DATA / "holdings_history.json"
    hist = json.loads(hp.read_text(encoding="utf-8")) if hp.exists() else {}
    prev_dates = sorted(d for d in hist if d < asof)
    out = []
    today_states = {}
    for w in watch:
        f = byc.get(w["code"])
        ev = holdings_eval(f)
        today_states[w["code"]] = {c["id"]: c["status"] for c in ev["checks"]}
        prev = hist[prev_dates[-1]].get(w["code"]) if prev_dates else None
        changes_today = holdings_diff(prev, ev)
        # 최근 20거래일 변화 로그
        log = []
        seq = prev_dates[-20:] + [asof]
        for a, b in zip(seq, seq[1:]):
            pa = hist.get(a, {}).get(w["code"]) if a != asof else None
            pb = today_states[w["code"]] if b == asof else hist.get(b, {}).get(w["code"])
            if pa and pb:
                for cid, st in pb.items():
                    if pa.get(cid) and st and pa[cid] != st:
                        lab = next((c["label"] for c in ev["checks"] if c["id"] == cid), cid)
                        log.append({"date": b, "label": lab, "from": pa[cid], "to": st})
        out.append(dict(w, features=f, checks=ev["checks"], summary=ev["summary"], groups=ev.get("groups", {}),
                        changes_today=changes_today, change_log=log[::-1]))
    hist[asof] = today_states
    _dump("holdings_history.json", hist)
    return out


def export_all(df: pd.DataFrame) -> None:
    asof = str(df["date"].max())
    presets = load_presets()
    results = run_all(df, presets)
    watch = load_watchlist()
    wcodes = [w["code"] for w in watch]
    byc = {r["code"]: r for r in df.replace({np.nan: None}).to_dict("records")}

    # 시장 요약
    mk = {}
    for m, g in df.groupby("market"):
        mk[m] = {
            "n": int(len(g)),
            "adv": int((g.ret_1d > 0).sum()),
            "dec": int((g.ret_1d < 0).sum()),
            "above_ma200_pct": round(float((g.close_vs_ma200 > 0).mean() * 100), 1),
            "ma_align_pct": round(float(g.ma_align.mean() * 100), 1),
            "med_ret_20": round(float(g.ret_20.median()), 2),
            "med_ret_60": round(float(g.ret_60.median()), 2),
        }

    latest = {
        "asof": asof,
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "universe_size": int(len(df)),
        "market": mk,
        "presets": [
            {
                "id": p["id"], "name": p["name"], "description": p.get("description", ""),
                "filters": p.get("filters", []), "score": p.get("score", []),
                "n_pass": int(len(results[p["id"]])),
                "rows": _records(results[p["id"]], PRESET_COLS),
            }
            for p in presets
        ],
        "watchlist": _watch_with_checks(watch, byc, asof),
        "sectors": _records(sector_table(df), None or list(sector_table(df).columns)),
    }
    _dump("latest.json", latest)
    _dump("universe.json", {"asof": asof, "rows": _records(df, UNIVERSE_COLS)})

    # 종목 상세: 관심종목 + 프리셋 상위 전부
    detail_codes = set(wcodes)
    for r in results.values():
        detail_codes |= set(r["code"].tolist())
    (DOCS_DATA / "stock").mkdir(exist_ok=True)  # 이전 파일은 덮어쓰기(삭제 불필요)
    for c in detail_codes:
        if c in byc:
            _dump(f"stock/{c}.json", _stock_detail(c, byc[c]))
    # 히스토리(일별 프리셋 상위 10 기록 → 나중에 백테스트·추적용)
    hist_p = DOCS_DATA / "history.json"
    hist = json.loads(hist_p.read_text(encoding="utf-8")) if hist_p.exists() else {}
    hist[asof] = {pid: r.head(10)[["code", "name", "close", "score"]].to_dict("records") for pid, r in results.items()}
    _dump("history.json", hist)
    logger.info("export 완료: %s, 상세 %d종목", asof, len(detail_codes))
