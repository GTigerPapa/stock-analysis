"""보유 종목 점검표.

스크리너가 "새로 살 만한가"를 묻는다면, 점검표는 "보유 근거가 아직 유효한가, 무엇이 바뀌었나"를 묻는다.
- 각 항목은 good / warn / bad 3단계
- 전일 대비 상태가 바뀐 항목을 '신호 변화'로 표시 (holdings_history.json 에 누적)
매수가·수량은 공개 저장소에 올라가지 않도록 여기서 다루지 않는다(웹앱이 브라우저에만 저장).
"""
from __future__ import annotations

from typing import Callable


def _grade(v, good: Callable, warn: Callable | None = None) -> str | None:
    if v is None:
        return None
    if good(v):
        return "good"
    if warn and warn(v):
        return "warn"
    return "bad"


def _p(v, d=1):
    return "–" if v is None else f"{v:+.{d}f}%"


# (그룹, id, 라벨, 값 함수, 등급 함수, 설명)
CHECKS = [
    ("추세", "ma200", "200일선 대비", lambda f: f.get("close_vs_ma200"),
     lambda v: _grade(v, lambda x: x > 0, lambda x: x > -10), "위면 장기 추세 유지, -10% 이내는 회복 시도 구간"),
    ("추세", "ma60", "60일선 대비", lambda f: f.get("close_vs_ma60"),
     lambda v: _grade(v, lambda x: x > 0), "중기 추세 회복의 첫 관문"),
    ("추세", "slope60", "60일 추세(연율)", lambda f: f.get("slope_60"),
     lambda v: _grade(v, lambda x: x > 0, lambda x: x > -30), "하락 기울기가 완만해지는지"),
    ("추세", "pos52", "52주 범위 내 위치", lambda f: f.get("pos_52w"),
     lambda v: _grade(v, lambda x: x >= 25, lambda x: x >= 10), "10% 미만이면 신저가권"),
    ("수급", "smart20", "외+기 20일 순매수", lambda f: f.get("smart_net_20_pct"),
     lambda v: _grade(v, lambda x: x > 0), "발행주식 대비 %. 최근 방향"),
    ("수급", "smart60", "외+기 60일 순매수", lambda f: f.get("smart_net_60_pct"),
     lambda v: _grade(v, lambda x: x > 0), "중기 누적 방향"),
    ("수급", "frgn_ratio", "외인 지분율 60일 변화", lambda f: f.get("foreign_ratio_chg_60"),
     lambda v: _grade(v, lambda x: x > 0, lambda x: x > -0.5), "%p. 외국인 이탈 여부"),
    ("실적", "op_yoy", "영업이익 YoY", lambda f: f.get("op_yoy"),
     lambda v: _grade(v, lambda x: x > 0), "최근 분기 vs 전년 동기"),
    ("실적", "op_qoq", "영업이익 QoQ", lambda f: f.get("op_qoq"),
     lambda v: _grade(v, lambda x: x > 0, lambda x: x > -20), "직전 분기 대비"),
    ("실적", "target", "컨센서스 목표가 괴리", lambda f: f.get("target_upside"),
     lambda v: _grade(v, lambda x: x > 20, lambda x: x > 0), "음수면 시장 기대치가 현재가 아래"),
    ("섹터", "excess60", "업종 대비 60일 초과수익", lambda f: f.get("excess_60"),
     lambda v: _grade(v, lambda x: x > 0, lambda x: x > -10), "종목 문제인지 업종 문제인지 구분"),
    ("섹터", "sector_rs", "업종 상대강도(60일)", lambda f: f.get("sector_rs_60"),
     lambda v: _grade(v, lambda x: x >= 50, lambda x: x >= 25), "업종 자체가 시장 대비 강한지(0~100)"),
]

FMT = {
    "pos52": lambda v: "–" if v is None else f"{v:.0f}%",
    "frgn_ratio": lambda v: "–" if v is None else f"{v:+.2f}p",
    "sector_rs": lambda v: "–" if v is None else f"{v:.0f}",
    "smart20": lambda v: _p(v, 2),
    "smart60": lambda v: _p(v, 2),
    "slope60": lambda v: _p(v, 0),
    "op_yoy": lambda v: _p(v, 0),
    "op_qoq": lambda v: _p(v, 0),
    "target": lambda v: _p(v, 0),
}


def evaluate(f: dict | None) -> dict:
    if not f:
        return {"checks": [], "summary": {}}
    checks = []
    for group, cid, label, val, grade, desc in CHECKS:
        v = val(f)
        g = grade(v)
        checks.append(
            {"group": group, "id": cid, "label": label, "value": v,
             "text": FMT.get(cid, _p)(v), "status": g, "desc": desc}
        )
    s = {k: sum(1 for c in checks if c["status"] == k) for k in ("good", "warn", "bad")}
    # 그룹별 요약: 그룹 내 good 비율
    groups = {}
    for c in checks:
        if c["status"] is None:
            continue
        g = groups.setdefault(c["group"], {"good": 0, "n": 0})
        g["n"] += 1
        g["good"] += c["status"] == "good"
    return {"checks": checks, "summary": s, "groups": groups}


def diff(prev: dict | None, cur: dict) -> list[dict]:
    """전일 상태 대비 바뀐 항목. prev: {check_id: status}"""
    if not prev:
        return []
    rank = {"bad": 0, "warn": 1, "good": 2}
    out = []
    for c in cur["checks"]:
        a, b = prev.get(c["id"]), c["status"]
        if a and b and a != b:
            out.append({"id": c["id"], "label": c["label"], "from": a, "to": b,
                        "direction": "up" if rank[b] > rank[a] else "down", "text": c["text"]})
    return out
