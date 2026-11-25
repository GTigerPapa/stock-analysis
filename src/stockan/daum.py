"""다음 금융 일봉 — KRX 정규장 공식 OHLCV.

네이버 차트 API(api.stock.naver.com/chart)의 일봉 종가·고가·저가는 NXT 애프터마켓(~20:00)까지
합친 '마지막 체결가'라서, 장 마감 후 크게 움직인 날 KRX 공식 종가(다음 날 기준가)와 어긋난다.
  예) 삼성전자 2026-11-24  네이버 182,900 / KRX 공식 189,400
다음 금융 /api/quote/{A코드}/days 는 KRX 정규장 기준 시·고·저·종가·거래량·거래대금을 준다.
비공식 API라 실패하면 빈 목록을 돌려주고, 호출부가 네이버로 대체한다.
"""
from __future__ import annotations

import threading
import time
from typing import Any

import requests

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
    "Accept": "application/json",
}
_local = threading.local()
_lock = threading.Lock()
_last = [0.0]
MIN_INTERVAL = 0.1  # 다음은 보수적으로 초당 10회 이하


def _session() -> requests.Session:
    s = getattr(_local, "s", None)
    if s is None:
        s = requests.Session()
        s.headers.update(_HEADERS)
        _local.s = s
    return s


def _get(url: str, params: dict, referer: str, retries: int = 3) -> Any:
    for i in range(retries):
        with _lock:
            wait = MIN_INTERVAL - (time.time() - _last[0])
            if wait > 0:
                time.sleep(wait)
            _last[0] = time.time()
        try:
            r = _session().get(url, params=params, headers={"Referer": referer}, timeout=15)
            if r.status_code == 200:
                return r.json()
            if r.status_code in (400, 404):
                return None
            if r.status_code == 429:
                time.sleep(2 + 3 * i)
                continue
        except (requests.RequestException, ValueError):
            pass
        time.sleep(0.5 * (i + 1))
    return None


def daily(code: str, start: str, per_page: int = 100, max_pages: int = 20) -> list[dict]:
    """start('YYYY-MM-DD') 이후 KRX 정규장 일봉. 오래된 날짜순으로 반환."""
    sym = f"A{code}"
    out: list[dict] = []
    for page in range(1, max_pages + 1):
        j = _get(f"https://finance.daum.net/api/quote/{sym}/days",
                 {"symbolCode": sym, "page": page, "perPage": per_page, "pagination": "true"},
                 referer=f"https://finance.daum.net/quotes/{sym}")
        data = (j or {}).get("data") if isinstance(j, dict) else None
        if not data:
            break
        stop = False
        for r in data:
            d = (r.get("date") or "")[:10]
            c = r.get("tradePrice")
            if not d or c is None:
                continue
            if d < start:
                stop = True
                break
            chg = r.get("changePrice")
            prev = r.get("prevClosingPrice") or (c - chg if chg is not None and r.get("change") != "EVEN" else None)
            if prev is None and r.get("change") == "EVEN":
                prev = c
            out.append({
                "date": d,
                "open": float(r.get("openingPrice") or c),
                "high": float(r.get("highPrice") or c),
                "low": float(r.get("lowPrice") or c),
                "close": float(c),
                "volume": int(r.get("accTradeVolume") or 0),
                "amount": float(r["accTradePrice"]) if r.get("accTradePrice") else None,
                "prev_close": float(prev) if prev else None,
            })
        if stop or len(data) < per_page:
            break
    out.sort(key=lambda x: x["date"])
    return out
