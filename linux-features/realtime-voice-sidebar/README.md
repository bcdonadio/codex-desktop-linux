# Realtime Voice Sidebar

`realtime-voice-sidebar` is a disabled-by-default Linux feature that exposes
the upstream realtime Voice entrypoint in the sidebar when explicitly enabled.
Enable it by adding the feature id to `linux-features/features.json` and rebuild
the application:

```json
{
  "enabled": ["realtime-voice-sidebar"]
}
```

The feature changes only the sidebar footer gate in the signed upstream
`app-primary-*.js` webview asset. It replaces the Statsig gate lookup for
`2919110489.enabled` with a forced UI-side true boolean while preserving the
upstream realtime Voice capability predicate and non-null `codex` start
callback. It does not change persisted or global Statsig state, grant backend
entitlement, alter account rollout state, or start a metered session. The
account must still be entitled and the service must be available.

The matcher is fail-closed. If the expected footer contract is missing,
duplicated, partial, mixed, or has drifted, the asset remains byte-identical and
the patch emits a warning. A contract already carrying the feature marker is
idempotent.

The gate helper's minified name may change between upstream builds. Matching
uses the stable gate key and complete footer contract. The regression fixture
`fixtures/footer-26.901.41600.js` comes from the signed amd64 package (SHA-256
`15cf422a77e8f28a7553d3180b8c72784a994438a141784c82d72cde93efca77`).

Run the feature tests with:

```bash
node --test linux-features/realtime-voice-sidebar/test.js
```

The tests cover descriptor enablement and asset targeting, Voice branch and
capability/callback behavior, idempotence, unrelated Statsig calls, drift and
fail-closed cases, and an extracted-app patch-report integration.
