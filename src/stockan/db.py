"""SQLite 스키마와 얇은 헬퍼. 모든 테이블은 (code, date) 또는 code 단위 upsert."""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from typing import Iterable

import pandas as pd

from .config import DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS stocks (
    code TEXT PRIMARY KEY,
    isin TEXT, name TEXT, market TEXT,
    marcap INTEGER, shares INTEGER,
    sector_code TEXT, sector_name TEXT,
    updated_at TEXT
);
-- venue: KRX(정규장) / UNI(KRX+NXT 통합, KIS 연동 후) / NXT(애프터마켓 종가 스냅샷)
CREATE TABLE IF NOT EXISTS prices (
    code TEXT, date TEXT, venue TEXT DEFAULT 'KRX',
    open REAL, high REAL, low REAL, close REAL,
    volume INTEGER, amount REAL, change REAL,
    PRIMARY KEY (code, date, venue)
);
CREATE INDEX IF NOT EXISTS idx_prices_date ON prices(date);
CREATE TABLE IF NOT EXISTS investor (
    code TEXT, date TEXT,
    foreign_net INTEGER, inst_net INTEGER, indiv_net INTEGER,
    foreign_ratio REAL, close REAL, volume INTEGER,
    PRIMARY KEY (code, date)
);
CREATE TABLE IF NOT EXISTS fundamentals (
    code TEXT, date TEXT,
    per REAL, eps REAL, pbr REAL, bps REAL, cns_per REAL, cns_eps REAL,
    div_yield REAL, foreign_rate REAL, marcap REAL,
    high52 REAL, low52 REAL, target_price REAL, recomm REAL,
    nxt_close REAL, nxt_change_pct REAL,
    PRIMARY KEY (code, date)
);
CREATE TABLE IF NOT EXISTS sectors (
    sector_code TEXT PRIMARY KEY, sector_name TEXT, member_count INTEGER, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS sector_members (
    sector_code TEXT, code TEXT, PRIMARY KEY (sector_code, code)
);
CREATE TABLE IF NOT EXISTS finance (
    code TEXT, period_type TEXT, period TEXT, item TEXT, value REAL, is_consensus INTEGER,
    PRIMARY KEY (code, period_type, period, item)
);
CREATE TABLE IF NOT EXISTS features (
    code TEXT, date TEXT, payload TEXT,
    PRIMARY KEY (code, date)
);
CREATE TABLE IF NOT EXISTS profiles (
    code TEXT PRIMARY KEY, description TEXT, updated_at TEXT
);
CREATE TABLE IF NOT EXISTS run_log (
    run_at TEXT, step TEXT, status TEXT, detail TEXT
);
"""


def connect() -> sqlite3.Connection:
    con = sqlite3.connect(DB_PATH, timeout=60)
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=NORMAL")
    return con


def init_schema() -> None:
    with connect() as con:
        con.executescript(SCHEMA)


@contextmanager
def session():
    con = connect()
    try:
        yield con
        con.commit()
    finally:
        con.close()


def upsert(con: sqlite3.Connection, table: str, rows: Iterable[dict]) -> int:
    rows = list(rows)
    if not rows:
        return 0
    cols = list(rows[0].keys())
    sql = f"INSERT OR REPLACE INTO {table} ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})"
    con.executemany(sql, [tuple(r.get(c) for c in cols) for r in rows])
    return len(rows)


def read_df(sql: str, params: tuple = ()) -> pd.DataFrame:
    with connect() as con:
        return pd.read_sql_query(sql, con, params=params)


def last_price_date(con: sqlite3.Connection, code: str, venue: str = "KRX") -> str | None:
    r = con.execute("SELECT MAX(date) FROM prices WHERE code=? AND venue=?", (code, venue)).fetchone()
    return r[0] if r else None


def log(con: sqlite3.Connection, step: str, status: str, detail: str = "") -> None:
    con.execute(
        "INSERT INTO run_log VALUES (datetime('now','localtime'),?,?,?)", (step, status, detail[:2000])
    )
