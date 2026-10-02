# Codex 0.160.0 qualification

The development dependency and sole generated parser baseline are 0.160.0.
[Artifact metadata](0.160.0.json) records the exact upstream tag, commit,
npm package integrity, and Linux x64/macOS arm64/x64 executable hashes.
The [schema delta](0.160.0-schema-delta.json) is empty because qualification
compares the candidate against this release's complete official exports.
The obsolete 0.153.0 generated tree is removed; Git retains earlier evidence.

The runtime floor and tested-through threshold are 0.160.0. This deliberately
aligns supported execution with the qualified remote-TUI permission restoration
and parser baseline. Older runtimes fail admission; no alternate parser or
legacy managed-TUI launch path is retained. Optional wire metadata remains
optional according to the official schemas.

The [Linux x64 result](0.160.0-linux-x64.json) verifies exact exports, model
discovery, experimental gating, changed execution settings (including
`disabledPluginIds`), streaming, item events, persisted resume after restart,
pagination, and fork history with explicit execution settings. The
[interaction result](0.160.0-interactions-linux-x64.json) verifies a real native
command-approval request, encoded decline, and that the declined command never
runs. Both use isolated state and a deterministic loopback Responses provider.

Reproduce using the complete matching native package and its executable:

```sh
env -u NODE_ENV npm run verify:codex-runtime -- /absolute/path/to/codex 0.160.0
env -u NODE_ENV npm run verify:codex-interactions -- /absolute/path/to/codex 0.160.0
env -u NODE_ENV npm run check:codex-protocol
```

Only Linux x64 execution is claimed by these results. macOS artifacts have
integrity evidence only. Windows, authenticated providers, image generation,
managed TUI, SSH, and external WS/WSS require separate topology checks.
Runtime executable admission remains version-based; qualification hashes do
not impose hash pinning on operator-owned executables.

This changes only Codex's provider-private protocol and projection. Pi, Claude,
Grok, and OpenCode keep their existing implementations and capabilities.
There is no normalized browser protocol or ownership-boundary change.
