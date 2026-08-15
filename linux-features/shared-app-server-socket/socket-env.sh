#!/usr/bin/env bash
set -eu

runtime_root="${XDG_RUNTIME_DIR:-${CODEX_LINUX_APP_STATE_DIR:?}}"
runtime_dir="$runtime_root/${CODEX_LINUX_APP_ID:-codex-desktop}/app-server-bridge"
socket_path="${CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET:-$runtime_dir/app-server.sock}"

canonical_socket="${CODEX_HOME:-$HOME/.codex}/app-server-control/app-server-control.sock"
remote_control_marker="${CODEX_LINUX_APP_DIR:-}/.codex-linux/desktop-app-server-remote-control-enabled"
if [ -z "${CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET:-}" ] &&
    [ -f "$remote_control_marker" ] && [ ! -L "$remote_control_marker" ] &&
    [ "$(cat "$remote_control_marker" 2>/dev/null || true)" = "version=1
owner=desktop" ] &&
    [ -S "$canonical_socket" ] && [ ! -L "$canonical_socket" ] &&
    [ "$(stat -c '%u:%a' "$canonical_socket" 2>/dev/null || true)" = "$(id -u):600" ] &&
    [ "$(stat -c '%u:%a' "$(dirname "$canonical_socket")" 2>/dev/null || true)" = "$(id -u):700" ]; then
    socket_path="$canonical_socket"
fi

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
reaper_path="$script_dir/orphan-reaper.js"
node_bin="$(command -v node || true)"

if [ -n "${CODEX_LINUX_APP_DIR:-}" ]; then
    staged_reaper="$CODEX_LINUX_APP_DIR/.codex-linux/features/shared-app-server-socket/orphan-reaper.js"
    if [ -f "$staged_reaper" ]; then
        reaper_path="$staged_reaper"
    fi
fi

if [ -n "$node_bin" ] && [ -f "$reaper_path" ]; then
    if ! "$node_bin" "$reaper_path" "$socket_path"; then
        printf 'WARN: shared app-server orphan cleanup failed closed for %s\n' "$socket_path" >&2
    fi
fi

if [ "${CODEX_LINUX_FEATURE_HOOK_PHASE:-launcher}" = "launcher" ]; then
    cli_path="${CODEX_CLI_PATH:-${CODEX_LINUX_APP_DIR:?}/resources/codex}"
    printf 'env CODEX_LINUX_APP_SERVER_BRIDGE_SOCKET=%s\n' "$socket_path"
    printf 'env CODEX_CLI_PATH=%s\n' "$cli_path"
fi
