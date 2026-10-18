"""수집 단계. 각 함수는 독립적으로 재실행 가능(멱등)."""
from __future__ import annotations

import logging
import time
import warnings
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta

import pandas as pd

from . import naver
from .config import BACKFILL_YEARS, INVESTOR_BACKFILL_DAYS, WORKERS
from .db import log, read_df, session, upsert

warnings.filterwarnings("ignore")
logger = logging.getLogger(__name__)

# 시간 예산(epoch). 설정되면 초과 시 남은 항목을 건너뛰고 BUDGET_HIT 를 올린다 → 재실행하면 이어서 진행
DEADLINE: float | None = None
BUDGET_HIT = False


def _parallel(fn, items, desc: str, workers: int = WORKERS):
    """items 각각에 fn 적용, 결과 yield. 실패는 로그만 남기고 계속. 배치 단위로 시간 예산 확인."""
    global BUDGET_HIT
    items = list(items)
    done = fail = 0
    batch = max(workers * 4, 8)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for i in range(0, len(items), batch):
            if DEADLINE and time.time() > DEADLINE:
                BUDGET_HIT = True
                logger.info("%s 시간 예산 초과 — %d/%d 처리, 나머지는 다음 실행에서", desc, i, len(items))
                break
            futs = {ex.submit(fn, it): it for it in items[i : i + batch]}
            for f in as_completed(futs):
                try:
                    yield futs[f], f.result()
                    done += 1
                except Exception as e:  # noqa: BLE001
                    fail += 1
                    logger.warning("%s 실패 %s: %r", desc, futs[f], e)
            if (i + batch) % 300 < batch:
                logger.info("%s 진행 %d/%d (실패 %d)", desc, min(i + batch, len(items)), len(items), fail)
    logger.info("%s 완료 %d (실패 %d)", desc, done, fail)


# ---------------- 종목 마스터 ----------------
def update_universe() -> pd.DataFrame:
    import FinanceDataReader as fdr

    df = fdr.StockListing("KRX")
    df = df[df["Market"].isin(["KOSPI", "KOSDAQ", "KOSDAQ GLOBAL"])].copy()
    # 우선주·스팩·리츠 등 제외: 보통주 ISIN은 끝자리 앞 '0' (KR7xxxxxx00x)
    df = df[df["ISU_CD"].str[9:11].eq("00")]
    df = df[~df["Name"].str.contains("스팩|제[0-9]+호", regex=True, na=False)]
    today = date.today().isoformat()
    rows = [
        {
            "code": r.Code,
            "isin": r.ISU_CD,
            "name": r.Name,
            "market": "KOSDAQ" if "KOSDAQ" in r.Market else r.Market,
            "marcap": int(r.Marcap) if pd.notna(r.Marcap) else None,
            "shares": int(r.Stocks) if pd.notna(r.Stocks) else None,
            "updated_at": today,
        }
        for r in df.itertuples()
    ]
    with session() as con:
        # sector 컬럼은 보존해야 하므로 UPDATE 우선
        for r in rows:
            con.execute(
                """INSERT INTO stocks(code,isin,name,market,marcap,shares,updated_at)
                   VALUES(:code,:isin,:name,:market,:marcap,:shares,:updated_at)
                   ON CONFLICT(code) DO UPDATE SET isin=excluded.isin,name=excluded.name,
                   market=excluded.market,marcap=excluded.marcap,shares=excluded.shares,
                   updated_at=excluded.updated_at""",
                r,
            )
        log(con, "universe", "ok", f"{len(rows)} stocks")
    logger.info("종목 마스터 %d개", len(rows))
    return df


def universe_codes(active_only: bool = True) -> list[str]:
    df = read_df("SELECT code FROM stocks ORDER BY marcap DESC")
    return df["code"].tolist()


# ---------------- 일봉 (KRX 정규장, 네이버 차트 API 직접 호출 — 타임아웃 있음) ----------------
def _fetch_prices(code: str, start: str) -> list[dict]:
    rows = naver.daily_chart(code, start)
    out, prev = [], None
    for r in rows:
        out.append(
            {
                "code": code,
                "date": r["date"],
                "venue": "KRX",
                "open": r["open"],
                "high": r["high"],
                "low": r["low"],
                "close": r["close"],
                "volume": r["volume"],
                "amount": r["close"] * r["volume"],  # 근사 거래대금
                "change": (r["close"] / prev - 1) if prev else None,
            }
        )
        prev = r["close"]
    return out


def update_prices(codes: list[str] | None = None, full: bool = False) -> None:
    codes = codes or universe_codes()
    with session() as con:
        last = dict(con.execute("SELECT code, MAX(date) FROM prices WHERE venue='KRX' GROUP BY code"))
    default_start = (date.today() - timedelta(days=365 * BACKFILL_YEARS + 60)).isoformat()

    if full:
        codes = [c for c in codes if c not in last] + [c for c in codes if c in last]

    def job(code):
        start = default_start if code not in last else last[code]
        return _fetch_prices(code, start)

    n = 0
    with session() as con:
        for _, rows in _parallel(job, codes, "일봉", workers=min(WORKERS, 4)):
            n += upsert(con, "prices", rows)
        log(con, "prices", "ok", f"{n} rows / {len(codes)} codes")


# ---------------- 투자자별 수급 ----------------
def update_investor(codes: list[str] | None = None, full: bool = False) -> None:
    codes = codes or universe_codes()
    calls = max(1, -(-INVESTOR_BACKFILL_DAYS // 60)) if full else 1
    page_size = 60 if full else 20
    if full:
        with session() as con:
            have = dict(con.execute("SELECT code, COUNT(*) FROM investor GROUP BY code"))
        codes = [c for c in codes if have.get(c, 0) < INVESTOR_BACKFILL_DAYS * 0.8]

    def job(code):
        rows, before = [], None
        for _ in range(calls):
            got = naver.trend(code, before=before, page_size=page_size)
            rows += got
            if len(got) < page_size:
                break
            before = got[-1]["date"]
        return rows

    n = 0
    with session() as con:
        for _, rows in _parallel(job, codes, "수급"):
            n += upsert(con, "investor", rows)
        log(con, "investor", "ok", f"{n} rows")


# ---------------- 펀더멘털 스냅샷 + NXT 애프터마켓 종가 ----------------
def update_fundamentals(codes: list[str] | None = None) -> None:
    codes = codes or universe_codes()
    today = date.today().isoformat()
    with session() as con:
        done = {r[0] for r in con.execute("SELECT code FROM fundamentals WHERE date=?", (today,))}
    codes = [c for c in codes if c not in done]

    def job(code):
        f = naver.integration(code) or {"code": code}
        b = naver.basic(code) or {}
        f["nxt_close"] = b.get("nxt_close")
        f["nxt_change_pct"] = b.get("nxt_change_pct")
        f["date"] = today
        return f

    n = 0
    with session() as con:
        for _, f in _parallel(job, codes, "펀더멘털"):
            ind = f.pop("industry_code", None)
            if ind:
                con.execute("UPDATE stocks SET sector_code=? WHERE code=?", (ind, f["code"]))
            n += upsert(con, "fundamentals", [f])
        log(con, "fundamentals", "ok", f"{n} rows")


# ---------------- 업종 ----------------
def update_sectors() -> None:
    groups = naver.industry_groups()
    today = date.today().isoformat()
    members = []
    for g in groups:
        for c in naver.industry_members(g["sector_code"]):
            members.append({"sector_code": g["sector_code"], "code": c})
        g["updated_at"] = today
    with session() as con:
        con.execute("DELETE FROM sector_members")
        upsert(con, "sectors", groups)
        upsert(con, "sector_members", members)
        con.execute(
            """UPDATE stocks SET sector_code=(SELECT sector_code FROM sector_members m WHERE m.code=stocks.code),
               sector_name=(SELECT s.sector_name FROM sector_members m JOIN sectors s USING(sector_code) WHERE m.code=stocks.code)"""
        )
        log(con, "sectors", "ok", f"{len(groups)} sectors, {len(members)} members")
    logger.info("업종 %d개, 매핑 %d건", len(groups), len(members))


# ---------------- 요약 재무 (분기/연간) ----------------
def update_finance(codes: list[str] | None = None, resume: bool = False) -> None:
    codes = codes or universe_codes()
    if resume:
        with session() as con:
            have = {r[0] for r in con.execute("SELECT DISTINCT code FROM finance")}
        codes = [c for c in codes if c not in have]

    def job(code):
        return naver.finance(code, "quarter") + naver.finance(code, "annual")

    n = 0
    with session() as con:
        for _, rows in _parallel(job, codes, "재무"):
            n += upsert(con, "finance", rows)
        log(con, "finance", "ok", f"{n} rows")


# ---------------- 과거 확장 (백필 기간을 늘렸을 때 앞쪽만 채움) ----------------
def extend_prices(codes: list[str] | None = None) -> None:
    codes = codes or universe_codes()
    target = (date.today() - timedelta(days=365 * BACKFILL_YEARS + 30)).isoformat()
    with session() as con:
        first = dict(con.execute("SELECT code, MIN(date) FROM prices WHERE venue='KRX' GROUP BY code"))
    todo = [c for c in codes if first.get(c) and first[c] > target
            and (date.fromisoformat(first[c]) - date.fromisoformat(target)).days > 20]
    # 상장일이 target 이후인 종목은 계속 todo 에 남지 않도록 표시 테이블 사용
    with session() as con:
        con.execute("CREATE TABLE IF NOT EXISTS backfill_done (kind TEXT, code TEXT, PRIMARY KEY(kind, code))")
        done = {r[0] for r in con.execute("SELECT code FROM backfill_done WHERE kind='prices'")}
    todo = [c for c in todo if c not in done]
    logger.info("일봉 과거 확장 대상 %d종목 (목표 시작일 %s)", len(todo), target)

    def job(code):
        end = (date.fromisoformat(first[code]) - timedelta(days=1)).isoformat()
        rows = naver.daily_chart(code, target, end)
        return [
            {"code": code, "date": r["date"], "venue": "KRX", "open": r["open"], "high": r["high"], "low": r["low"],
             "close": r["close"], "volume": r["volume"], "amount": r["close"] * r["volume"], "change": None}
            for r in rows
        ]

    n = 0
    with session() as con:
        for code, rows in _parallel(job, todo, "일봉 과거"):
            n += upsert(con, "prices", rows)
            con.execute("INSERT OR IGNORE INTO backfill_done VALUES ('prices', ?)", (code,))
        log(con, "extend_prices", "ok", f"{n} rows")


def extend_investor(codes: list[str] | None = None) -> None:
    codes = codes or universe_codes()
    target = (date.today() - timedelta(days=int(INVESTOR_BACKFILL_DAYS * 1.46))).isoformat()
    with session() as con:
        con.execute("CREATE TABLE IF NOT EXISTS backfill_done (kind TEXT, code TEXT, PRIMARY KEY(kind, code))")
        first = dict(con.execute("SELECT code, MIN(date) FROM investor GROUP BY code"))
        done = {r[0] for r in con.execute("SELECT code FROM backfill_done WHERE kind='investor'")}
    todo = [c for c in codes if c not in done and (c not in first or first[c] > target)]
    logger.info("수급 과거 확장 대상 %d종목 (목표 시작일 %s)", len(todo), target)

    def job(code):
        rows, before = [], (first.get(code) or date.today().isoformat())
        while before > target:
            got = naver.trend(code, before=before, page_size=60)
            if not got:
                break
            rows += got
            if len(got) < 60:
                break
            before = got[-1]["date"]
        return rows

    n = 0
    with session() as con:
        for code, rows in _parallel(job, todo, "수급 과거"):
            n += upsert(con, "investor", rows)
            con.execute("INSERT OR IGNORE INTO backfill_done VALUES ('investor', ?)", (code,))
            con.commit()
        log(con, "extend_investor", "ok", f"{n} rows")


# ---------------- 종목 설명 (주 1회) ----------------
def update_profiles(codes: list[str] | None = None, only_missing: bool = False) -> None:
    codes = codes or universe_codes()
    today = date.today().isoformat()
    if only_missing:
        with session() as con:
            have = {r[0] for r in con.execute("SELECT code FROM profiles WHERE description IS NOT NULL")}
        codes = [c for c in codes if c not in have]

    def job(code):
        return naver.company_description(code)

    n = 0
    with session() as con:
        for code, desc in _parallel(job, codes, "종목 설명"):
            if desc:
                con.execute("INSERT OR REPLACE INTO profiles VALUES (?,?,?)", (code, desc, today))
                n += 1
        log(con, "profiles", "ok", f"{n} rows")
