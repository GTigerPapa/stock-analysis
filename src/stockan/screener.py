"""프리셋(JSON) 기반 스크리너.

프리셋 형식 (presets/screen_*.json)
{
  "name": "추세 지속형", "description": "...", "top_n": 30,
  "filters": [ {"f": "amount_avg20", "op": ">=", "v": 5e9}, ... ],     # 모두 만족해야 통과
  "score":   [ {"f": "slope_120", "w": 0.3}, {"f": "dd_52w", "w": 0.15}, ... ]
}
score: 필터 통과 종목 내 백분위(0~100)에 가중치를 곱해 합산. w<0 이면 '낮을수록 좋음'.
"""
from __future__ import annotations

import operator

import numpy as np
import pandas as pd

OPS = {">": operator.gt, ">=": operator.ge, "<": operator.lt, "<=": operator.le, "==": operator.eq, "!=": operator.ne}


def apply_filters(df: pd.DataFrame, filters: list[dict]) -> pd.DataFrame:
    mask = pd.Series(True, index=df.index)
    for flt in filters:
        f, op, v = flt["f"], flt.get("op", ">="), flt["v"]
        if f not in df.columns:
            mask &= False
            continue
        col = df[f]
        if op == "in":
            mask &= col.isin(v)
        elif op == "notnull":
            mask &= col.notna()
        else:
            mask &= OPS[op](col, v).fillna(False)
    return df[mask]


def score(df: pd.DataFrame, terms: list[dict]) -> pd.Series:
    if df.empty:
        return pd.Series(dtype=float)
    total = pd.Series(0.0, index=df.index)
    wsum = 0.0
    for t in terms:
        f, w = t["f"], float(t["w"])
        if f not in df.columns:
            continue
        col = df[f]
        if col.notna().sum() < 3:
            continue
        pct = col.rank(pct=True, ascending=(w > 0)) * 100
        # 결측은 중립(50)
        total += pct.fillna(50) * abs(w)
        wsum += abs(w)
    return (total / wsum) if wsum else total


def run_preset(df: pd.DataFrame, preset: dict) -> pd.DataFrame:
    sub = apply_filters(df, preset.get("filters", []))
    sub = sub.assign(score=score(sub, preset.get("score", [])))
    sub = sub.sort_values("score", ascending=False)
    sub["rank"] = np.arange(1, len(sub) + 1)
    return sub.head(int(preset.get("top_n", 30)))


def run_all(df: pd.DataFrame, presets: list[dict]) -> dict[str, pd.DataFrame]:
    return {p["id"]: run_preset(df, p) for p in presets}
