# Codex 0.162.1 qualification

The development dependency and sole generated parser baseline are 0.162.1.
[Artifact metadata](0.162.1.json) records the exact upstream tag, commit,
npm package integrity, and Linux x64/macOS arm64/x64 executable hashes.
The [schema delta](0.162.1-schema-delta.json) is empty because qualification
compares the candidate against this release's complete official exports.
The obsolete 0.160.0 generated tree is removed; Git retains earlier evidence.

The runtime floor and tested-through threshold are 0.162.1. This aligns supported execution with the new protocol and independent speed
settings. The generated parser does not fall back to an older profile. Older runtimes fail admission; no alternate parser or
legacy managed-TUI launch path is retained. Optional wire metadata remains
optional according to the official schemas.

The [Linux x64 result](0.162.1-linux-x64.json) verifies exact exports, model
discovery, experimental gating, changed execution settings (including
`disabledPluginIds`), streaming, item events, persisted resume after restart,
pagination, and fork history with explicit execution settings. It checks
`rootTurnId` in start replies, both turn lifecycle notifications, persisted reads,
resume with full history, paginated turn shells, and fork history. The
[interaction result](0.162.1-interactions-linux-x64.json) verifies a real native
command-approval request, encoded decline, and that the declined command never
runs. Both use isolated state and a deterministic loopback Responses provider.

Reproduce using the complete matching native package and its executable:

```sh
env -u NODE_ENV npm run verify:codex-runtime -- /absolute/path/to/codex 0.162.1
env -u NODE_ENV npm run verify:codex-interactions -- /absolute/path/to/codex 0.162.1
env -u NODE_ENV npm run check:codex-protocol
```

Only Linux x64 execution is claimed by these results. macOS artifacts have
integrity evidence only. Windows, authenticated providers, image generation,
managed TUI, SSH, and external WS/WSS require separate topology checks.
Runtime executable admission remains version-based; qualification hashes do
not impose hash pinning on operator-owned executables.

This evidence qualifies the Codex provider-private protocol on Linux. Shared
partial-answer notification and speech changes have separate normalized
contract tests across Pi, Codex, Claude, Grok, and OpenCode. No provider
authentication or ownership boundary is broadened by the protocol upgrade.
