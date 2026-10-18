"""일일 파이프라인 오케스트레이터.

사용법
  python -m stockan.run_daily --init        # 최초: 마스터+업종+3년 일봉 백필+수급 250일+펀더멘털+재무
  python -m stockan.run_daily               # 매일 20:30: 증분 수집 → 지표 → export
  python -m stockan.run_daily --only prices,features   # 단계 선택 실행
  python -m stockan.run_daily --codes 272210,267260 --only prices,investor   # 특정 종목만
단계: universe, sectors, prices, investor, fundamentals, finance, profiles, features, export (+ history: 과거 확장)
"""
from __future__ import annotations

import argparse
import logging
import socket
import sys
import time
from datetime import date

from . import collect
from .config import LOG_DIR
from .db import init_schema, read_df, session, log
from .export import export_all
from .indicators import build_features

ALL_STEPS = ["universe", "sectors", "prices", "investor", "fundamentals", "finance", "profiles", "features", "export"]
# 매일 돌릴 필요 없는 단계: 업종은 주 1회(월), 재무는 주 1회(금) — --init 또는 --only 로 강제 가능
WEEKLY = {"sectors": 0, "finance": 4, "profiles": 5}


def setup_logging() -> None:
    LOG_DIR.mkdir(exist_ok=True)
    fmt = "%(asctime)s %(levelname)s %(name)s: %(message)s"
    logging.basicConfig(
        level=logging.INFO,
        format=fmt,
        handlers=[logging.StreamHandler(sys.stdout), logging.FileHandler(LOG_DIR / f"run_{date.today():%Y%m}.log", encoding="utf-8")],
    )


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--init", action="store_true", help="최초 백필")
    ap.add_argument("--only", help="쉼표 구분 단계 목록")
    ap.add_argument("--codes", help="쉼표 구분 종목코드(테스트용)")
    ap.add_argument("--top", type=int, help="시총 상위 N종목만(테스트용)")
    ap.add_argument("--budget", type=int, help="초 단위 시간 예산. 초과 시 남은 수집은 건너뛰고 종료코드 3 (재실행하면 이어서)")
    args = ap.parse_args(argv)
    setup_logging()
    socket.setdefaulttimeout(30)  # 타임아웃 없는 외부 라이브러리 호출(FDR 등)이 영원히 매달리지 않도록
    init_schema()
    t0 = time.time()
    if args.budget:
        collect.DEADLINE = t0 + args.budget

    steps = args.only.split(",") if args.only else ALL_STEPS
    if not args.only and not args.init:
        wd = date.today().weekday()
        steps = [s for s in steps if s not in WEEKLY or WEEKLY[s] == wd]
    codes = args.codes.split(",") if args.codes else None
    full = args.init
    ok = True
    for step in steps:
        ts = time.time()
        try:
            if step == "universe":
                collect.update_universe()
            if codes is None and args.top:
                codes = collect.universe_codes()[: args.top]
            if step == "sectors":
                collect.update_sectors()
            elif step == "prices":
                collect.update_prices(codes, full=full)
            elif step == "investor":
                collect.update_investor(codes, full=full)
            elif step == "fundamentals":
                collect.update_fundamentals(codes)
            elif step == "history":
                collect.extend_prices(codes)
                collect.extend_investor(codes)
            elif step == "profiles":
                collect.update_profiles(codes, only_missing=full)
            elif step == "finance":
                collect.update_finance(codes, resume=full)
            elif step == "features":
                df = build_features()
                if df.empty:
                    raise RuntimeError("features 비어 있음 — 일봉 수집 확인")
            elif step == "export":
                df = build_features() if "features" not in steps else df  # noqa: F821
                export_all(df)
            logging.info("[%s] 완료 %.0fs", step, time.time() - ts)
        except Exception as e:  # noqa: BLE001
            ok = False
            logging.exception("[%s] 실패: %r", step, e)
            with session() as con:
                log(con, step, "fail", repr(e))
    logging.info("전체 %s %.0fs%s", "성공" if ok else "일부 실패", time.time() - t0, " (예산 초과, 재실행 필요)" if collect.BUDGET_HIT else "")
    if not ok:
        return 1
    return 3 if collect.BUDGET_HIT else 0


if __name__ == "__main__":
    sys.exit(main())
