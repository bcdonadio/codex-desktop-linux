# Linux Computer Use

Disabled-by-default Linux Computer Use integration. It owns the eight current
ASAR descriptors, including the local thread-resume MCP transport compatibility
patch and local thread-tool capability continuity patch, and the native MCP
plugin staged only when explicitly enabled. Immutable Nix packages receive
their bundled-marketplace staging permission repair from the separate internal
`nix-store-bundled-marketplace-permissions` feature.

When enabled, resumed local Desktop threads request the `thread_tools` capability
before the Codex app MCP server is configured. This preserves the model-visible
`create_thread`, `list_threads`, `read_thread`, `wait_threads`, and
`send_message_to_thread` tools across a Desktop restart without enabling those
tools for remote hosts.

Enable it in `linux-features/features.json`:

```json
{ "enabled": ["computer-use-linux"] }
```

`make install-native` builds `codex-computer-use-linux` and
`codex-computer-use-cosmic` once before staging the package. Direct
`./install.sh` builds may provide binaries in `target/release/` or set
`CODEX_COMPUTER_USE_BINARY_SOURCE` and `CODEX_COMPUTER_USE_COSMIC_BINARY_SOURCE`.
Updater rebuilds reuse the packaged artifacts and never invoke Cargo.

Validate descriptor ownership and artifact-only staging with:

```bash
node --test linux-features/computer-use-linux/test.js
```
