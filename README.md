# stock-analysis — 국내 종목 일일 정량분석

매일 20:30 KST에 KOSPI/KOSDAQ 전 종목(약 2,650개)의 일봉·수급·업종·펀더멘털·분기실적을 수집해
장기 투자 관점의 지표를 계산하고, JSON 프리셋으로 정의한 스크리너 결과를 정적 웹앱(GitHub Pages)으로 보여준다.

```
[launchd 20:30] scripts/run_daily.sh
   └ python -m stockan.run_daily
        collect  (네이버 증권 API + FDR)  → data/market.db (SQLite, 로컬 전용)
        features (지표 엔진)              → features 테이블
        export   (스크리너·섹터·관심종목)  → docs/data/*.json
   └ git commit docs/data && git push     → GitHub Pages (docs/)
```

## 처음 설치 (맥 터미널, 1회)

```bash
cd ~/Desktop/stock_analysis
bash scripts/setup_mac.sh          # .venv 생성, 패키지 설치, launchd 20:30 등록
bash scripts/run_daily.sh && tail -20 logs/launchd_*.log   # 수동 1회 실행으로 확인
```
`data/market.db`(2026-10-16 기준, 3년 일봉·250일 수급·업종·재무 포함)가 이미 들어 있으므로 `--init` 백필은 필요 없다.
DB를 새로 만들어야 할 때만: `PYTHONPATH=src .venv/bin/python -m stockan.run_daily --init` (약 30~40분).

GitHub 연결(1회):
```bash
git init -b main
git remote add origin https://github.com/GTigerPapa/stock-analysis.git
git add -A && git commit -m "init: stock analysis pipeline"
git push -u origin main
```
GitHub → Settings → Pages → Source: `Deploy from a branch`, Branch: `main` / `/docs` 로 설정하면
`https://gtigerpapa.github.io/stock-analysis/` 에서 열린다.
※ 무료 개인 계정은 **public 저장소에서만 Pages가 동작**한다. private 유지가 필요하면 GitHub Pro 또는 Cloudflare Pages/Netlify(무료, private repo 가능)로 배포.

## 매일 돌아가는 것

| 단계 | 소스 | 주기 | 내용 |
|---|---|---|---|
| universe | FDR(KRX 상장목록) | 매일 | 보통주만(우선주·스팩 제외), 시총·주식수 |
| prices | 네이버 차트 API(FDR) | 매일 증분 | KRX 정규장 일봉 OHLCV |
| investor | 네이버 `/stock/{code}/trend` | 매일 | 외국인·기관·개인 순매수, 외인 보유율 |
| fundamentals | 네이버 `/integration`, `/basic` | 매일 | PER/PBR/52주/컨센서스/목표가, **NXT 애프터마켓 종가** |
| sectors | 네이버 `/stocks/industry` | 월요일 | 79개 업종 분류 및 구성종목 |
| finance | 네이버 `/finance/quarter|annual` | 금요일 | 매출·영업이익·순이익·ROE·부채비율 (분기/연간) |
| features | — | 매일 | 아래 지표 계산 |
| export | — | 매일 | docs/data/latest.json, universe.json, stock/{code}.json, history.json |

수동 실행: `PYTHONPATH=src .venv/bin/python -m stockan.run_daily --only prices,features,export` (스크립트 `scripts/run_daily.sh`는 PYTHONPATH를 자동 설정)
특정 종목만: `--codes 272210,267260`  시간 예산(재개 가능): `--budget 150`

## 지표 (features)

- **추세**: `slope_60/120/250` (로그가격 회귀 기울기, 연율화 %), `r2_*` (추세의 매끄러움), `ma20/60/120/200`, `ma_align`(정배열), `close_vs_ma200`, `cross_ma200_20d`, `pos_52w`, `dd_52w`, `mdd_1y`
- **수익률**: `ret_1d/5/20/60/120/250`, `ret_*_pct_rank`(시장 백분위)
- **수급**: `frgn_net_*`, `inst_net_*`, `smart_net_*_pct`(외+기 순매수/발행주식수 %, 20/60/120일), `foreign_ratio`, `foreign_ratio_chg_60`, `smart_buy_streak`
- **거래**: `vol_ratio20`, `amount_avg20/60`, `turnover_20`, `pv_eff_20`(회전율 1%당 가격변화), `obv_chg20`, `atr14_pct`, `vol_ann_60`, `rsi14`, `gap`, `range_pct`
- **밸류·실적**: `per`, `pbr`, `cns_per`, `div_yield`, `target_upside`, `recomm`, `op_qoq`, `op_yoy`, `rev_yoy`, `op_margin_q`, `op_turnaround`, `op_trend_4q`, `roe`, `debt_ratio`
- **섹터**: `sector_ret_*`(시총가중), `sector_med_ret_*`, `excess_*`(종목−업종 중앙값), `sector_rs_*`(업종 상대강도 백분위), `rank_in_sector_*`
- **NXT**: `nxt_close`, `nxt_gap`(애프터마켓 종가 − KRX 종가 %)

## 스크리너 프리셋 (presets/screen_*.json)

코드 수정 없이 JSON만 바꾸면 된다. `filters`는 모두 만족해야 통과, `score`는 통과 종목 내 백분위 가중합(0~100). `w<0`은 낮을수록 좋음.
기본 제공: 추세 지속형 / 수급 누적형 / 섹터 주도형 / 턴어라운드형 / 거래량 돌파(단기 참고).
관심종목은 `presets/watchlist.json`.

## 데이터 한계 (알고 쓸 것)

- 일봉은 **KRX 정규장 기준**. NXT 거래량은 합산되지 않으며 NXT는 애프터마켓 종가만 스냅샷으로 저장한다. 통합 일봉은 KIS API 연동(`stockan/kis.py`, 예정) 후 `venue='UNI'`로 추가.
- 거래대금은 종가×거래량 근사치.
- 수급 백필은 네이버 API 특성상 호출당 60일, 기본 250일까지. 이후 매일 누적.
- 네이버 비공식 API는 예고 없이 바뀔 수 있다. 실패 시 `logs/`와 `run_log` 테이블 확인.
- pykrx의 수급·업종·펀더멘털은 KRX 로그인(`KRX_ID/KRX_PW`)이 필요해 사용하지 않는다.
