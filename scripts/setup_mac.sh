#!/bin/bash
# 맥 터미널에서 1회 실행:  bash scripts/setup_mac.sh
# 1) uv 로 .venv 생성·설치  2) launchd 에 매일 20:30 KST 작업 등록  3) 잠자기 설정 안내
set -e
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"

if ! command -v uv >/dev/null; then
  echo "uv 설치 중..."; curl -LsSf https://astral.sh/uv/install.sh | sh; export PATH="$HOME/.local/bin:$PATH"
fi
echo "▶ 가상환경 생성 및 패키지 설치"
uv venv .venv --python 3.11 -q || uv venv .venv -q
uv pip install -q -p .venv/bin/python -e .
[ -f .env ] || cp .env.example .env

echo "▶ launchd 등록 (매일 20:30)"
PLIST="$HOME/Library/LaunchAgents/com.gtigerpapa.stockan.plist"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.gtigerpapa.stockan</string>
  <key>ProgramArguments</key><array><string>/bin/bash</string><string>$ROOT/scripts/run_daily.sh</string></array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>20</integer><key>Minute</key><integer>30</integer></dict>
  <key>StandardOutPath</key><string>$ROOT/logs/launchd.out</string>
  <key>StandardErrorPath</key><string>$ROOT/logs/launchd.err</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string><key>LANG</key><string>ko_KR.UTF-8</string></dict>
</dict></plist>
PL
mkdir -p logs
launchctl bootout "gui/$(id -u)/com.gtigerpapa.stockan" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
chmod +x scripts/run_daily.sh
echo "✓ 등록 완료: launchctl list | grep stockan 으로 확인"
echo
echo "▶ 잠자기 설정 확인 (20:30에 맥이 깨어 있어야 함)"
pmset -g | grep -E "^\s*(sleep|displaysleep)" || true
echo "  전원 연결 시 잠자지 않게 하려면:  sudo pmset -c sleep 0"
echo "  (launchd 는 잠자는 동안 놓친 작업을 깨어난 직후 실행함)"
echo
echo "▶ 수동 테스트:  bash scripts/run_daily.sh && tail -20 logs/launchd_*.log"
