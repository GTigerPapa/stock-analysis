"""OpenDART 클라이언트 + 지분 시계열 가공 (최대주주·국민연금).

- 인증키는 .env 의 DART_API_KEY (없으면 이 모듈을 쓰는 단계는 조용히 건너뜀)
- majorstock (주식등의 대량보유상황보고, 5% 룰): 회사당 1회 호출로 보고자별 지분율 이력
  · 5% 이상 주주만 보고 의무 → 국민연금이 5% 아래로 내려가면 그 뒤 값은 알 수 없음(마지막 보고값 유지)
  · 최대주주 보고의 지분율은 특수관계인 합산
- 일일 한도 20,000건. 전 종목(약 2,700) 주 1회 호출이면 여유.
"""
from __future__ import annotations

import io
import os
import threading
import time
import zipfile
from typing import Any
from xml.etree import ElementTree as ET

import requests

BASE = "https://opendart.fss.or.kr/api"
MIN_INTERVAL = float(os.getenv("DART_MIN_INTERVAL", "0.12"))  # ≈ 8 req/s (권장 한도 분당 1,000건 이내)
_lock = threading.Lock()
_last = [0.0]
NPS = "국민연금"


class DartError(RuntimeError):
    """키 오류·한도 초과처럼 계속 호출해도 소용없는 상태."""


def api_key() -> str:
    return os.getenv("DART_API_KEY", "").strip()


def _throttle() -> None:
    with _lock:
        wait = MIN_INTERVAL - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        _last[0] = time.time()


def get(op: str, params: dict | None = None, retries: int = 3) -> list[dict]:
    """JSON 엔드포인트 호출 → list 반환. 데이터 없음(013)은 빈 리스트."""
    q = {"crtfc_key": api_key(), **(params or {})}
    for i in range(retries):
        _throttle()
        try:
            r = requests.get(f"{BASE}/{op}.json", params=q, timeout=20)
            j: Any = r.json()
        except (requests.RequestException, ValueError):
            time.sleep(1 + i)
            continue
        st = str(j.get("status", ""))
        if st == "000":
            return j.get("list") or []
        if st == "013":
            return []
        if st in ("010", "011", "012", "020", "901"):
            raise DartError(f"DART {st}: {j.get('message')}")
        time.sleep(1 + i)
    return []


def corp_codes() -> dict[str, str]:
    """종목코드 → DART 고유번호(8자리). corpCode.xml(zip) 1회 호출."""
    _throttle()
    r = requests.get(f"{BASE}/corpCode.xml", params={"crtfc_key": api_key()}, timeout=60)
    if r.content[:2] != b"PK":
        raise DartError(f"corpCode 응답이 zip 이 아님: {r.text[:120]}")
    zf = zipfile.ZipFile(io.BytesIO(r.content))
    root = ET.fromstring(zf.read(zf.namelist()[0]))
    out = {}
    for el in root.iter("list"):
        sc = (el.findtext("stock_code") or "").strip()
        cc = (el.findtext("corp_code") or "").strip()
        if len(sc) == 6 and cc:
            out[sc] = cc
    return out


def _num(s) -> float | None:
    try:
        return float(str(s).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def majorstock_rows(code: str, corp_code: str) -> list[dict]:
    """대량보유 보고 이력 → ownership 테이블 행."""
    rows = []
    for r in get("majorstock", {"corp_code": corp_code}):
        pct = _num(r.get("stkrt"))
        d = (r.get("rcept_dt") or "").strip()
        if pct is None or len(d) != 10:
            continue
        rows.append(
            {
                "code": code,
                "rcept_no": r.get("rcept_no"),
                "date": d,
                "holder": (r.get("repror") or "").strip(),
                "pct": pct,
                "chg": _num(r.get("stkrt_irds")),
                "report_tp": r.get("report_tp"),
            }
        )
    return rows


# ---------------- 가공: 보고 이력 → 차트용 계단 시계열 ----------------
def _steps(rows: list[dict]) -> dict:
    """한 보고자의 이력 → {"p0": 첫 보고 이전 지분율(첫 보고의 증감으로 역산), "s": [[date, pct], ...]}"""
    rows = sorted(rows, key=lambda r: (r["date"], r.get("rcept_no") or ""))
    s: list[list] = []
    for r in rows:
        if s and s[-1][0] == r["date"]:
            s[-1][1] = round(r["pct"], 2)  # 같은 날 정정 보고 → 나중 것
        else:
            s.append([r["date"], round(r["pct"], 2)])
    first = rows[0]
    p0 = first["pct"] - first["chg"] if first.get("chg") is not None else first["pct"]
    # 신규 보고(이전 0%)가 아니면 첫 보고 이전 값으로 사용. 음수·100 초과 등 이상값은 첫 보고값으로 대체
    if not (0 <= p0 <= 100):
        p0 = first["pct"]
    return {"p0": round(p0, 2), "s": s}


def holder_series(rows: list[dict]) -> dict:
    """한 종목의 ownership 행들 → {"mj": {"n": 이름, "p0", "s"}, "np": {"p0", "s"}} (없는 쪽은 생략).

    최대주주 = 국민연금이 아닌 보고자 중 최근 지분율이 가장 큰 보고자 (5% 룰 보고는 특수관계인 합산).
    """
    by: dict[str, list[dict]] = {}
    for r in rows:
        if r.get("holder") and r.get("pct") is not None:
            by.setdefault(r["holder"], []).append(r)
    out: dict = {}
    nps = [h for h in by if NPS in h]
    if nps:
        merged = [r for h in nps for r in by[h]]
        out["np"] = _steps(merged)
    others = {h: sorted(v, key=lambda r: (r["date"], r.get("rcept_no") or "")) for h, v in by.items() if NPS not in h}
    if others:
        name = max(others, key=lambda h: others[h][-1]["pct"])
        out["mj"] = {"n": name, **_steps(others[name])}
    return out


# ---------------- 린치 점검용: 재고·현금·영업현금흐름 / 임원·주요주주 지분 / 자사주 취득 ----------------
# 보고서 코드 → (분기 순서, 제출 마감 월·일). 사업보고서(11011)는 다음 해 3월 말 제출.
REPRT_ORDER = {"11013": 1, "11012": 2, "11014": 3, "11011": 4}
_REPRT_DUE = {"11013": (0, 5, 16), "11012": (0, 8, 15), "11014": (0, 11, 15), "11011": (1, 4, 1)}


def due_periods(since_year: int = 2025, today=None) -> list[tuple[int, str, int]]:
    """제출 기한이 지난 (사업연도, 보고서코드, 기한 경과 일수) 목록. 12월 결산 기준."""
    import datetime as _dt

    today = today or _dt.date.today()
    out = []
    for y in range(since_year, today.year + 1):
        for rc, (dy, m, d) in _REPRT_DUE.items():
            due = _dt.date(y + dy, m, d)
            if due <= today:
                out.append((y, rc, (today - due).days))
    return out


def _acct(rows: list[dict], sj: tuple[str, ...], ids: tuple[str, ...], names: tuple[str, ...], cum: bool = False) -> float | None:
    """재무제표 행에서 계정 하나 찾기: 표준 계정 ID 우선, 없으면 계정명 일치."""
    def val(r):
        v = _num(r.get("thstrm_add_amount")) if cum else None
        return v if v is not None else _num(r.get("thstrm_amount"))

    cand = [r for r in rows if r.get("sj_div") in sj]
    for r in cand:
        if r.get("account_id") in ids and val(r) is not None:
            return val(r)
    for r in cand:
        if (r.get("account_nm") or "").replace(" ", "") in names and val(r) is not None:
            return val(r)
    return None


def fin_summary(corp_code: str, year: int, reprt: str) -> dict | None:
    """단일회사 전체 재무제표 → 재고자산·현금성자산·영업활동현금흐름(누적)·매출(누적). 연결 우선, 없으면 별도."""
    for fs in ("CFS", "OFS"):
        rows = get("fnlttSinglAcntAll", {"corp_code": corp_code, "bsns_year": str(year), "reprt_code": reprt, "fs_div": fs})
        if not rows:
            continue
        return {
            "fs_div": fs,
            "rcept_no": rows[0].get("rcept_no"),
            "inventory": _acct(rows, ("BS",), ("ifrs-full_Inventories",), ("재고자산",)),
            "cash": _acct(rows, ("BS",), ("ifrs-full_CashAndCashEquivalents",), ("현금및현금성자산",)),
            "cfo": _acct(rows, ("CF",), ("ifrs-full_CashFlowsFromUsedInOperatingActivities",),
                         ("영업활동현금흐름", "영업활동으로인한현금흐름", "영업활동순현금흐름")),
            "revenue": _acct(rows, ("IS", "CIS"), ("ifrs-full_Revenue",), ("매출액", "수익(매출액)", "영업수익", "매출"), cum=True),
        }
    return None


def insider_rows(code: str, corp_code: str, since: str = "2025-01-01") -> list[dict]:
    """임원ㆍ주요주주 특정증권등 소유상황보고. 증감에는 장내매수 외 상여·행사·상속 등도 포함된다."""
    out = []
    for r in get("elestock", {"corp_code": corp_code}):
        d = (r.get("rcept_dt") or "").strip()
        if len(d) != 10 or d < since:
            continue
        out.append({
            "code": code, "rcept_no": r.get("rcept_no"), "date": d,
            "name": (r.get("repror") or "").strip(),
            "position": next((v for v in ((r.get("isu_exctv_ofcps") or "").strip(), (r.get("isu_main_shrholdr") or "").strip()) if v and v != "-"), ""),
            "shares_after": _num(r.get("sp_stock_lmp_cnt")),
            "shares_chg": _num(r.get("sp_stock_lmp_irds_cnt")),
        })
    return out


def _kdate(s: str | None) -> str | None:
    import re as _re

    m = _re.match(r"\s*(\d{4})\D+(\d{1,2})\D+(\d{1,2})", s or "")
    return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}" if m else None


def buyback_rows(code: str, corp_code: str, since: str = "2025-01-01") -> list[dict]:
    """자기주식 취득 결정(주요사항보고서)."""
    import datetime as _dt

    out = []
    for r in get("tsstkAqDecsn", {"corp_code": corp_code, "bgn_de": since.replace("-", ""), "end_de": _dt.date.today().strftime("%Y%m%d")}):
        rno = r.get("rcept_no") or ""
        out.append({
            "code": code, "rcept_no": rno,
            "date": _kdate(r.get("aq_dd")) or (f"{rno[:4]}-{rno[4:6]}-{rno[6:8]}" if len(rno) >= 8 else None),
            "shares": (_num(r.get("aqpln_stk_ostk")) or 0) + (_num(r.get("aqpln_stk_estk")) or 0),
            "amount": (_num(r.get("aqpln_prc_ostk")) or 0) + (_num(r.get("aqpln_prc_estk")) or 0),
            "purpose": (r.get("aq_pp") or "").strip(),
        })
    return out
