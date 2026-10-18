"""경로·환경 설정. 프로젝트 루트는 이 파일 기준으로 역산한다."""
from __future__ import annotations

import json
import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
load_dotenv(ROOT / ".env")
# STOCKAN_DATA_DIR 로 DB 위치 변경 가능 (기본: 프로젝트/data)
DATA_DIR = Path(os.getenv("STOCKAN_DATA_DIR", ROOT / "data")).expanduser()
LOG_DIR = Path(os.getenv("STOCKAN_LOG_DIR", ROOT / "logs")).expanduser()
DOCS_DIR = ROOT / "docs"
DOCS_DATA = DOCS_DIR / "data"
PRESET_DIR = ROOT / "presets"
DB_PATH = DATA_DIR / "market.db"

for d in (DATA_DIR, LOG_DIR, DOCS_DATA):
    d.mkdir(parents=True, exist_ok=True)

WORKERS = int(os.getenv("STOCKAN_WORKERS", "6"))
KIS_APP_KEY = os.getenv("KIS_APP_KEY", "")
KIS_APP_SECRET = os.getenv("KIS_APP_SECRET", "")

# 백필 기간 (영업일 기준 ~3년 + 지표 워밍업 여유)
BACKFILL_YEARS = 3
# 투자자별 수급 백필 깊이 (영업일). 네이버 trend API 1페이지 = 최대 100행
INVESTOR_BACKFILL_DAYS = 250


def load_watchlist() -> list[dict]:
    p = PRESET_DIR / "watchlist.json"
    if not p.exists():
        return []
    return json.loads(p.read_text(encoding="utf-8"))


def load_presets() -> list[dict]:
    out = []
    for p in sorted(PRESET_DIR.glob("screen_*.json")):
        d = json.loads(p.read_text(encoding="utf-8"))
        d.setdefault("id", p.stem.replace("screen_", ""))
        out.append(d)
    return out
