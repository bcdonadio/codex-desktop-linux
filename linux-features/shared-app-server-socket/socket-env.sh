#!/usr/bin/env bash
set -eu

runtime_root="${XDG_RUNTIME_DIR:-${CODEX_LINUX_APP_STATE_DIR:?}}"
runtime_dir="$runtime_root/${CODEX_LINUX_APP_ID:-codex-desktop}/app-server-bridge"
socket_path="${CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET:-$runtime_dir/app-server.sock}"
adopted_canonical=0
node_bin="$(command -v node || true)"

socket_is_live() {
    [ -n "$node_bin" ] || return 1
    "$node_bin" -e '
const net = require("node:net");
const socket = net.createConnection({ path: process.argv[1] });
const finish = (ok) => { socket.destroy(); process.exit(ok ? 0 : 1); };
const timer = setTimeout(() => finish(false), 500);
socket.once("connect", () => { clearTimeout(timer); finish(true); });
socket.once("error", () => { clearTimeout(timer); finish(false); });
' "$1"
}

canonical_socket="${CODEX_HOME:-$HOME/.codex}/app-server-control/app-server-control.sock"
remote_control_marker="${CODEX_LINUX_APP_DIR:-}/.codex-linux/desktop-app-server-remote-control-enabled"
if [ -z "${CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET:-}" ] &&
    [ -f "$remote_control_marker" ] && [ ! -L "$remote_control_marker" ] &&
    [ "$(cat "$remote_control_marker" 2>/dev/null || true)" = "version=1
owner=desktop" ] &&
    [ -S "$canonical_socket" ] && [ ! -L "$canonical_socket" ] &&
    [ "$(stat -c '%u:%a' "$canonical_socket" 2>/dev/null || true)" = "$(id -u):600" ] &&
    [ "$(stat -c '%u:%a' "$(dirname "$canonical_socket")" 2>/dev/null || true)" = "$(id -u):700" ] &&
    socket_is_live "$canonical_socket"; then
    socket_path="$canonical_socket"
    adopted_canonical=1
fi

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
reaper_path="$script_dir/orphan-reaper.js"

if [ -n "${CODEX_LINUX_APP_DIR:-}" ]; then
    staged_reaper="$CODEX_LINUX_APP_DIR/.codex-linux/features/shared-app-server-socket/orphan-reaper.js"
    if [ -f "$staged_reaper" ]; then
        reaper_path="$staged_reaper"
    fi
fi

if [ "$adopted_canonical" -eq 0 ] && [ -n "$node_bin" ] && [ -f "$reaper_path" ]; then
    if ! "$node_bin" "$reaper_path" "$socket_path"; then
        printf 'WARN: shared app-server orphan cleanup failed closed for %s\n' "$socket_path" >&2
    fi
fi

if [ -n "$node_bin" ] && [ -f "$reaper_path" ] &&
    [ -n "${CODEX_LINUX_APP_SERVER_PRIVATE_FALLBACK_SOCKET:-}" ] &&
    [ "${CODEX_LINUX_APP_SERVER_PRIVATE_FALLBACK_SOCKET}" != "$socket_path" ]; then
    if ! "$node_bin" "$reaper_path" "$CODEX_LINUX_APP_SERVER_PRIVATE_FALLBACK_SOCKET"; then
        printf 'WARN: shared app-server private fallback cleanup failed closed for %s\n' \
            "$CODEX_LINUX_APP_SERVER_PRIVATE_FALLBACK_SOCKET" >&2
    fi
fi

if [ "${CODEX_LINUX_FEATURE_HOOK_PHASE:-launcher}" = "launcher" ]; then
    cli_path="${CODEX_CLI_PATH:-${CODEX_LINUX_APP_DIR:?}/resources/codex}"
    install_dir="$(dirname -- "$cli_path")"
    printf 'env CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET=%s\n' "$socket_path"
    printf 'env CODEX_CLI_PATH=%s\n' "$cli_path"
    printf 'env CODEX_INSTALL_DIR=%s\n' "$install_dir"
    if [ "$adopted_canonical" -eq 1 ]; then
        printf '%s\n' 'env CODEX_LINUX_ADOPT_CANONICAL_APP_SERVER=1'
        printf 'env CODEX_LINUX_APP_SERVER_PRIVATE_FALLBACK_SOCKET=%s\n' "$runtime_dir/app-server.sock"
    else
        printf '%s\n' 'env CODEX_LINUX_ADOPT_CANONICAL_APP_SERVER='
        printf '%s\n' 'env CODEX_LINUX_APP_SERVER_PRIVATE_FALLBACK_SOCKET='
    fi
fi
