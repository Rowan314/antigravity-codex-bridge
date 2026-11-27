#!/bin/sh
# Locate Node.js across macOS Homebrew, /usr/local, and standard PATH so GUI apps
# (which may have a minimal PATH) can reliably launch the MCP stdio server.
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
for n in /opt/homebrew/bin/node /usr/local/bin/node node; do
  if command -v "$n" >/dev/null 2>&1; then
    exec "$n" "$SCRIPT_DIR/mcp.mjs" "$@"
  fi
done
echo "Antigravity-Codex Bridge requires Node.js 20+ on PATH." >&2
exit 127
