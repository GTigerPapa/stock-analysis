"""네이버 증권 모바일 API 클라이언트 (로그인 불필요).

엔드포인트
- /api/stock/{code}/trend            투자자별 일별 순매수 (외국인/기관/개인, 보유율)
- /api/stock/{code}/integration      PER/PBR/52주/컨센서스/업종코드/NXT 애프터마켓가
- /api/stocks/industry               업종 목록,  /api/stocks/industry/{no} 구성종목
- /api/stock/{code}/finance/{annual|quarter}  요약 재무
비공식 API이므로 스키마 변경에 대비해 모든 파싱은 관대하게(없으면 None) 처리한다.
"""
from __future__ import annotations

import os
import re
import threading
import time
from typing import Any

import requests

BASE = "https://m.stock.naver.com/api"
_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
    "Accept": "application/json",
    "Referer": "https://m.stock.naver.com/",
}
_local = threading.local()
_lock = threading.Lock()
_last_call = [0.0]
MIN_INTERVAL = float(os.getenv("STOCKAN_MIN_INTERVAL", "0.08"))  # 전역 최소 호출 간격(초). 0.08 ≈ 12 req/s


def _session() -> requests.Session:
    s = getattr(_local, "s", None)
    if s is None:
        s = requests.Session()
        s.headers.update(_HEADERS)
        _local.s = s
    return s


def get(path: str, params: dict | None = None, retries: int = 3) -> Any:
    url = path if path.startswith("http") else f"{BASE}{path}"
    for i in range(retries):
        with _lock:
            wait = MIN_INTERVAL - (time.time() - _last_call[0])
            if wait > 0:
                time.sleep(wait)
            _last_call[0] = time.time()
        try:
            r = _session().get(url, params=params, timeout=15)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (404, 400):
                return None
            if r.status_code == 429:
                time.sleep(2 + 3 * i)
                continue
        except (requests.RequestException, ValueError):
            pass
        time.sleep(0.5 * (i + 1))
    return None


# ---------- 파싱 헬퍼 ----------
_num_re = re.compile(r"[-+]?\d[\d,]*\.?\d*")


def num(v: Any) -> float | None:
    """'1,234', '+279,868', '81.81배', '9.28%', '15조 2,080억' → float (조/억 단위는 원 환산)."""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip()
    if not s or s in ("-", "N/A", "null"):
        return None
    if "조" in s or "억" in s:
        total = 0.0
        m = re.search(r"([-\d,\.]+)조", s)
        if m:
            total += float(m.group(1).replace(",", "")) * 1e12
        m = re.search(r"([-\d,\.]+)억", s)
        if m:
            total += float(m.group(1).replace(",", "")) * 1e8
        return total if total else None
    m = _num_re.search(s.replace("−", "-"))
    if not m:
        return None
    try:
        return float(m.group(0).replace(",", ""))
    except ValueError:
        return None


# ---------- 엔드포인트 ----------
def trend(code: str, before: str | None = None, page_size: int = 60) -> list[dict]:
    """최근 page_size일(최대 60). before='YYYYMMDD' 를 주면 그 날짜 이전 60일 (페이지 파라미터는 무시됨)."""
    params = {"page": 1, "pageSize": min(page_size, 60)}
    if before:
        params["bizdate"] = before.replace("-", "")
    j = get(f"/stock/{code}/trend", params)
    if not isinstance(j, list):
        return []
    out = []
    for r in j:
        d = r.get("bizdate")
        if not d:
            continue
        out.append(
            {
                "code": code,
                "date": f"{d[:4]}-{d[4:6]}-{d[6:]}",
                "foreign_net": num(r.get("foreignerPureBuyQuant")),
                "inst_net": num(r.get("organPureBuyQuant")),
                "indiv_net": num(r.get("individualPureBuyQuant")),
                "foreign_ratio": num(r.get("foreignerHoldRatio")),
                "close": num(r.get("closePrice")),
                "volume": num(r.get("accumulatedTradingVolume")),
            }
        )
    return out


def integration(code: str) -> dict | None:
    j = get(f"/stock/{code}/integration")
    if not isinstance(j, dict):
        return None
    info = {x.get("code"): x.get("value") for x in j.get("totalInfos", []) if isinstance(x, dict)}
    cons = j.get("consensusInfo") or {}
    return {
        "code": code,
        "industry_code": str(j.get("industryCode") or "") or None,
        "per": num(info.get("per")),
        "eps": num(info.get("eps")),
        "pbr": num(info.get("pbr")),
        "bps": num(info.get("bps")),
        "cns_per": num(info.get("cnsPer")),
        "cns_eps": num(info.get("cnsEps")),
        "div_yield": num(info.get("dividendYieldRatio")),
        "foreign_rate": num(info.get("foreignRate")),
        "marcap": num(info.get("marketValue")),
        "high52": num(info.get("highPriceOf52Weeks")),
        "low52": num(info.get("lowPriceOf52Weeks")),
        "target_price": num(cons.get("priceTargetMean")),
        "recomm": num(cons.get("recommMean")),
    }


def basic(code: str) -> dict | None:
    """NXT 애프터마켓(overMarketPriceInfo) 가격 스냅샷 포함."""
    j = get(f"/stock/{code}/basic")
    if not isinstance(j, dict):
        return None
    over = j.get("overMarketPriceInfo") or {}
    return {
        "code": code,
        "close": num(j.get("closePrice")),
        "change_pct": num(j.get("fluctuationsRatio")),
        "traded_at": j.get("localTradedAt"),
        "nxt_close": num(over.get("overPrice")),
        "nxt_change_pct": num(over.get("fluctuationsRatio")),
        "nxt_traded_at": over.get("localTradedAt"),
        "nxt_session": over.get("tradingSessionType"),
    }


def daily_chart(code: str, start: str, end: str | None = None) -> list[dict]:
    """일봉 OHLCV (api.stock.naver.com/chart). start/end: 'YYYY-MM-DD' 또는 'YYYYMMDD'. 타임아웃 적용."""
    import datetime as _dt

    end = end or _dt.date.today().isoformat()
    j = get(
        f"https://api.stock.naver.com/chart/domestic/item/{code}/day",
        {"startDateTime": start.replace("-", ""), "endDateTime": end.replace("-", "")},
    )
    if not isinstance(j, list):
        return []
    out = []
    for r in j:
        d = r.get("localDate")
        c = r.get("closePrice")
        if not d or c is None:
            continue
        out.append(
            {
                "date": f"{d[:4]}-{d[4:6]}-{d[6:]}",
                "open": float(r.get("openPrice") or c),
                "high": float(r.get("highPrice") or c),
                "low": float(r.get("lowPrice") or c),
                "close": float(c),
                "volume": int(r.get("accumulatedTradingVolume") or 0),
                "foreign_ratio": r.get("foreignRetentionRate"),
            }
        )
    return out


def industry_groups() -> list[dict]:
    j = get("/stocks/industry", {"page": 1, "pageSize": 100})
    groups = (j or {}).get("groups", []) if isinstance(j, dict) else []
    return [
        {"sector_code": str(g["no"]), "sector_name": g.get("name"), "member_count": g.get("totalCount")}
        for g in groups
        if "no" in g
    ]


def industry_members(sector_code: str) -> list[str]:
    codes: list[str] = []
    page = 1
    while True:
        j = get(f"/stocks/industry/{sector_code}", {"page": page, "pageSize": 100})
        stocks = (j or {}).get("stocks", []) if isinstance(j, dict) else []
        codes += [s.get("itemCode") for s in stocks if s.get("itemCode")]
        if len(stocks) < 100:
            break
        page += 1
    return codes


def finance(code: str, period_type: str = "quarter") -> list[dict]:
    j = get(f"/stock/{code}/finance/{period_type}")
    fi = (j or {}).get("financeInfo") if isinstance(j, dict) else None
    if not fi:
        return []
    cons = {t["key"]: t.get("isConsensus") == "Y" for t in fi.get("trTitleList", []) if "key" in t}
    rows = []
    for row in fi.get("rowList", []):
        item = row.get("title")
        for period, cell in (row.get("columns") or {}).items():
            v = num((cell or {}).get("value"))
            if v is None:
                continue
            rows.append(
                {
                    "code": code,
                    "period_type": period_type,
                    "period": period,
                    "item": item,
                    "value": v,
                    "is_consensus": int(cons.get(period, False)),
                }
            )
    return rows


def company_description(code: str) -> str | None:
    """WiseReport(네이버 기업정보 제공처) 기업개요 문단."""
    import re as _re

    url = f"https://navercomp.wisereport.co.kr/v2/company/c1010001.aspx?cmp_cd={code}"
    for i in range(2):
        try:
            r = _session().get(url, timeout=15, headers={"Accept": "text/html"})
            if r.status_code != 200:
                return None
            m = _re.search(r'<div class="cmp_comment">(.*?)</div>', r.text, _re.S)
            if not m:
                return None
            txt = _re.sub(r"<[^>]+>", " ", m.group(1))
            txt = _re.sub(r"\s+", " ", txt).strip()
            return txt or None
        except requests.RequestException:
            time.sleep(1 + i)
    return None
