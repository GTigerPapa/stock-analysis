#!/bin/bash
# 매일 20:30 KST launchd 가 호출. 수집→지표→export→GitHub push
set -u
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
export PYTHONPATH="$(pwd)/src"   # editable 설치와 무관하게 패키지를 찾도록
LOG="logs/launchd_$(date +%Y%m).log"
mkdir -p logs
{
  echo "===== $(date '+%F %T') start"
  # 주말·공휴일: KRX 마지막 영업일 데이터가 이미 있으면 수집은 빠르게 끝남(증분 0건)
  .venv/bin/python -m stockan.run_daily
  rc=$?
  echo "pipeline rc=$rc"
  if [ -d .git ]; then
    git add -A >/dev/null 2>&1   # .gitignore 가 .env·DB·로그를 막음 → 코드 변경도 함께 올라감
    if ! git diff --cached --quiet; then
      git commit -q -m "daily: $(date '+%F') 데이터·코드 업데이트" && git push -q origin HEAD && echo "pushed"
      git gc --auto -q   # 매일 2,600여 개 파일이 바뀌므로 임시 객체 정리
    else
      echo "no data change"
    fi
  fi
  echo "===== $(date '+%F %T') end"
} >> "$LOG" 2>&1
# macOS 알림 (실패 시)
if [ "${rc:-1}" -ne 0 ]; then
  osascript -e 'display notification "stockan 일일 파이프라인 일부 실패 — logs 확인" with title "Stock Analysis"' 2>/dev/null || true
fi
