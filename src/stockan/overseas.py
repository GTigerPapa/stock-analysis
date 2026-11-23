"""해외 보유종목 (네이버 해외주식 API, 키 불필요).

presets/overseas.json 의 종목만 가져와 보유 탭 카드용 요약을 만든다.
- api.stock.naver.com/stock/{reutersCode}/basic       현재가·전일비·시간외
- api.stock.naver.com/chart/foreign/item/{code}/day   일봉 (1년+)
- m.stock.naver.com/front-api/marketIndex/prices      원/달러 환율
비공식 API라 실패해도 전체 파이프라인은 멈추지 않는다(빈 목록 반환).
"""
from __future__ import annotations

import json
import logging
from datetime import date, timedelta

from . import naver
from .config import PRESET_DIR

logger = logging.getLogger(__name__)
API = "https://api.stock.naver.com"


def load_overseas() -> list[dict]:
    p = PRESET_DIR / "overseas.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else []


def _f(v):
    try:
        return float(str(v).replace(",", ""))
    except (TypeError, ValueError):
        return None


def usdkrw() -> dict | None:
    j = naver.get("https://m.stock.naver.com/front-api/marketIndex/prices",
                  {"category": "exchange", "reutersCode": "FX_USDKRW", "page": 1, "pageSize": 10})
    try:
        r = j["result"][0]
        return {"rate": _f(r["closePrice"]), "date": r["localTradedAt"]}
    except (TypeError, KeyError, IndexError):
        return None


def _ma(c: list[float], n: int):
    return sum(c[-n:]) / n if len(c) >= n else None


def _pct(a, b):
    return round((a / b - 1) * 100, 2) if a and b else None


def item(w: dict) -> dict | None:
    code = w["code"]
    b = naver.get(f"{API}/stock/{code}/basic")
    end = date.today() + timedelta(days=1)
    rows = naver.get(f"{API}/chart/foreign/item/{code}/day",
                     {"startDateTime": f"{end - timedelta(days=400):%Y%m%d}0000", "endDateTime": f"{end:%Y%m%d}0000"})
    if not b or not rows:
        logger.warning("해외 종목 %s 데이터 없음", code)
        return None
    rows = [r for r in rows if r.get("closePrice")]
    c = [float(r["closePrice"]) for r in rows]
    y = rows[-250:]
    hi = max(float(r["highPrice"]) for r in y)
    lo = min(float(r["lowPrice"]) for r in y)
    close = _f(b.get("closePrice")) or c[-1]
    ov = b.get("overMarketPriceInfo") or {}
    m50, m200 = _ma(c, 50), _ma(c, 200)
    return {
        "code": code, "symbol": b.get("symbolCode") or code.split(".")[0],
        "name": w.get("name") or b.get("stockName"), "note": w.get("note", ""),
        "exchange": b.get("stockExchangeName"), "asof": (b.get("localTradedAt") or "")[:10],
        "close": close, "ret_1d": _f(b.get("fluctuationsRatio")),
        "after": {"session": ov.get("tradingSessionType"), "price": _f(ov.get("overPrice")),
                  "ret": _f(ov.get("fluctuationsRatio"))} if ov.get("overPrice") else None,
        "high52": hi, "low52": lo, "dd_52w": _pct(close, hi), "from_low52": _pct(close, lo),
        "ret_20": _pct(close, c[-21]) if len(c) > 21 else None,
        "ret_60": _pct(close, c[-61]) if len(c) > 61 else None,
        "ma50_gap": _pct(close, m50), "ma200_gap": _pct(close, m200),
        # 보유 탭 sparkline 호환: [date, o, h, l, c]
        "prices": [[r["localDate"], r.get("openPrice"), r.get("highPrice"), r.get("lowPrice"), r["closePrice"]] for r in rows[-120:]],
    }


def export_block() -> dict:
    out = []
    for w in load_overseas():
        try:
            it = item(w)
            if it:
                out.append(it)
        except Exception as e:  # noqa: BLE001 — 해외 데이터 실패가 export 전체를 막지 않게
            logger.warning("해외 종목 %s 실패: %s", w.get("code"), e)
    return {"fx": usdkrw() if out else None, "items": out}
