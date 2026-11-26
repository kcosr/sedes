# Codex 0.172.0 runtime qualification

Sedes uses one generated 0.172.0 app-server profile. The runtime minimum and
tested-through release are both 0.172.0. Codex 0.170.0 changed assistant
moderation metadata, and 0.171.0 added MCP registration scope to tool events,
history and elicitation. The new runtime also emits the scope when reading
older MCP history. Earlier profiles and their qualification records remain
available in Git history.

## Artifacts

[Release provenance](../release.json) and [runtime metadata](0.172.0.json)
record the source tag, commit, npm integrity and executable hashes. The
[schema inventory](0.172.0-schema-delta.json) verifies the official stable and
experimental exports against the pinned profile. Linux x64 has runtime
evidence. macOS arm64 and x64 have artifact-integrity evidence.

## Linux x64 offline checks

- [Runtime](0.172.0-linux-x64.json) covers model discovery, experimental gating,
  ordinary streaming, item timestamps, read-state ordering, restart,
  pagination, fork history and reasoning settings with loopback model
  providers.
- [Command approval](0.172.0-interactions-linux-x64.json) verifies that a
  declined native command never executes and the decision reaches the
  loopback provider.
- [MCP history](0.172.0-mcp-history-linux-x64.json) covers 14 live and persisted
  tool results through Sedes' codecs in each history mode. It also checks old
  native stores and cold resume after compaction on the new runtime.
- [Lifecycle and Speed](0.172.0-lifecycle-speed-linux-x64.json) covers 13
  passing cases across owned stdio, UDS and a persistent sidecar with
  loopback models. It also tests saved provider settings, fork and child
  lifecycle, and rejects stale controller requests before native I/O.
- [Speed request ordering](0.172.0-active-speed-ordering-linux-x64.json) checks
  service-tier publication with a deterministic relay that delays requests.
- [Creation crash behavior](../evidence/d1-empty-thread.json) and
  [MCP isolation](../evidence/d2a-mcp-isolation.json) record raw native
  observations. The isolation probe leaves several production authority
  checks unproven, including the direct shell-environment negative check.
  The raw probe cannot replace the scoped native-thread lease or broker
  checks.

Use the complete pinned Linux x64 native package for these checks.

```sh
env -u NODE_ENV npm run check:codex-protocol
env -u NODE_ENV npm run verify:codex-runtime -- /absolute/path/to/codex 0.172.0
env -u NODE_ENV npm run verify:codex-interactions -- /absolute/path/to/codex 0.172.0
env -u NODE_ENV npm run verify:codex-mcp-history
```

Set `SEDES_SPEED_NATIVE_EXECUTABLE=/absolute/path/to/codex` to run the
Speed and native lifecycle checks listed in the evidence. Use the same
variable for `node scripts/codex-probes/verify-active-speed-ordering.mjs`.

The MCP history probe accepts an optional absolute path to a verified stock
0.169.0 binary to seed both native history formats before opening them with
0.172.0.

## Validation limits

Offline checks use disposable state and loopback inference. Authenticated
provider behavior, external networking, and target-platform desktop execution
each require their own verification. Before shipping desktop builds, run the
documented verification on the target operating system and architecture.
