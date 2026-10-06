#!/usr/bin/env bash
# 在无法以 root 安装 Chromium 系统依赖的环境里，使用 apt-get download 解压到
# 用户目录的库前缀运行 Playwright；系统已具备依赖时直接运行。
set -euo pipefail

CHROME_LIBS="${CHROME_LIBS:-/tmp/chromelibs}"
BIN="$(dirname "$0")/../node_modules/.bin/playwright"

NEED=0
SHELL_BIN="$(ls "$HOME/.cache/ms-playwright/chromium_headless_shell-"*/chrome-headless-shell-linux-*/chrome-headless-shell 2>/dev/null | head -1 || true)"
if [ -n "$SHELL_BIN" ] && ldd "$SHELL_BIN" 2>/dev/null | grep -q 'not found'; then
  NEED=1
fi

if [ "$NEED" = "1" ] && [ -d "$CHROME_LIBS" ]; then
  export LD_LIBRARY_PATH="$CHROME_LIBS/usr/lib/aarch64-linux-gnu:$CHROME_LIBS/lib/aarch64-linux-gnu:${LD_LIBRARY_PATH:-}"
fi

exec "$BIN" test "$@"
