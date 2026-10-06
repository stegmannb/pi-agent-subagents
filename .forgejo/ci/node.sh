#!/usr/bin/env bash
set -euo pipefail
npm_config_ignore_scripts=true
npm_config_script_shell="$(command -v bash)"
export npm_config_ignore_scripts npm_config_script_shell
pnpm install --frozen-lockfile --ignore-scripts
case "$1" in
  typecheck) pnpm run ci:check ;;
  lint) pnpm run ci:lint ;;
  format) pnpm run ci:fmt ;;
  test)
    pnpm test
    pnpm run test:tui
    pnpm run test:process
    pnpm run test:lifecycle
    pnpm run test:delegation
    pnpm run test:process:tui
    ;;
  *) exit 2 ;;
esac
