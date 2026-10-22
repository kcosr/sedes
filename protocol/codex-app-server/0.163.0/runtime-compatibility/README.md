# Codex runtime qualification against the 0.163.0 parser

The development dependency and sole generated parser baseline are 0.163.0.
The supported runtime minimum remains 0.162.1 and tested-through is 0.163.0.
Both releases use the same official stable/experimental validators and Sedes
refinements. No old generated parser, schema relaxation, synthetic receipt
value, or runtime-version decoding branch is retained.

## Artifact and schema evidence

[0.163.0 metadata](0.163.0.json) and [0.162.1 metadata](0.162.1.json) record
upstream tags, commits, npm integrity, and executable hashes. The generation
release's provenance is in [release.json](../release.json).
The [0.163.0 schema delta](0.163.0-schema-delta.json) is empty against the
current official exports. The [0.162.1 schema delta](0.162.1-schema-delta.json)
records every reviewed file addition, removal, and change, with exact hashes,
against that same baseline. Qualification rejects unreviewed drift.

The older exports omit native read-state metadata. The current official JSON
Schema permits that omission, while the present value is nullable and retains
its exact official definition. Sedes validates, bounds, and discards receipt
metadata; provider-owned receipts do not replace Sedes completion attention.
Other export differences concern additive request options, unadopted targeted
item reads and prediction mode, or unconsumed raw/realtime metadata. None
introduces a second production parser or a new normalized capability.

## Linux x64 execution

Fresh [0.162.1 runtime](0.162.1-linux-x64.json) and
[0.163.0 runtime](0.163.0-linux-x64.json) results exercise native executables
against isolated deterministic loopback Responses providers. They verify:

- exact reviewed stable and experimental exports and experimental method gating;
- model discovery, execution-setting changes, streaming, item events, and turn lineage;
- persisted read/resume after restart, pagination, and fork history/settings;
- omitted receipt result fields on 0.162.1 and serialized metadata on 0.163.0; and
- the new native receipt notification before turn completion on 0.163.0.

Fresh [0.162.1 approval](0.162.1-interactions-linux-x64.json) and
[0.163.0 approval](0.163.0-interactions-linux-x64.json) results verify a real
native command-approval request, encoded decline, and nonexecution of the
declined command. These use mock inference, not authenticated provider access.

Reproduce with the complete matching native package and executable:

```sh
env -u NODE_ENV npm run verify:codex-runtime -- /absolute/path/to/codex RELEASE
env -u NODE_ENV npm run verify:codex-interactions -- /absolute/path/to/codex RELEASE
env -u NODE_ENV npm run check:codex-protocol
```

Use `0.162.1` and `0.163.0` separately for `RELEASE`. Recorded hashes attest
the qualification artifacts; operator-installed runtimes remain version-based
admissions and are never digest-pinned.

## Active Speed

The opt-in `tests/integration/codex-active-speed-native.test.ts` uses the real
Sedes driver, actor, execution-settings repositories, and native executable.
The [0.162.1 results](0.162.1-active-speed-linux-x64.json) and
[0.163.0 results](0.163.0-active-speed-linux-x64.json) record all 11 test cases
per release. They cover isolated homes
and loopback Responses providers, over owned
stdio, an external private Unix socket, and the bundled persistent sidecar.
The sidecar test replaces the outer SSH carrier with a private Unix carrier;
it exercises the actual host runtime and receipt protocol.

The fixture checks captured model requests, explicit future `turn/start`
tiers, completed-target receipts, publication followed by Stop without another
inference, per-thread feature isolation, actual native subagent inheritance, fork, and cold
resume after idle eviction and runtime wake. It also covers imported threads, already-loaded
resume, paused-Goal convergence and Resume, and a model-created Goal's current
turn versus later native continuation. Subagent evidence records the first
child's initial and subsequent step tiers, a later child's tier after a confirmed
thread-default update, and the parent's independently published tiers. Replaying
a completed operation or addressing a completed turn sends no native update.
The fixture verifies the executable against the
hashes in the release metadata.

Additional cases gate Fast and Ultrafast independently, reject unsupported and
fallback-only model advertisements, and latch a stale loaded session's native
feature rejection. The sidecar records complete frames immediately before the
native process to verify dispatch order, then rejects the retired controller
through a replacement carrier without sending another native frame. A managed
daemon restart during an accepted but unanswered publication verifies an
uncertain receipt, no redispatch, native recovery, explicit successor tiers,
and the bounded 30-second default-convergence grace.

A separate deliberate active-default write is confirmed by its native settings
notification before restart. Both pinned versions retain the interrupted-turn
snapshot and resume with that turn's original tier. The earlier source-based
assumption that this write destroys daemon recovery was incorrect: the native
in-memory continuation fence and the persisted interrupted-turn snapshot are
different state. Sedes still never intentionally writes defaults while active.

The separate fault-relay probe records
[0.162.1 ordering](0.162.1-active-speed-ordering-linux-x64.json) and
[0.163.0 ordering](0.163.0-active-speed-ordering-linux-x64.json). Same-stream
requests retain their native arrival order after a caller timeout. Replaced
streams do not preserve issue order across connections. A delayed default
write does not change an explicitly tiered root turn. These controlled relay
faults establish native behavior, not an observed production reconnect bug.

Run each command with each pinned release binary:

```sh
env -u NODE_ENV SEDES_SPEED_NATIVE_EXECUTABLE=/absolute/path/to/codex \
  npx vitest run tests/integration/codex-active-speed-native.test.ts
env -u NODE_ENV SEDES_SPEED_NATIVE_EXECUTABLE=/absolute/path/to/codex \
  node scripts/codex-probes/verify-active-speed-ordering.mjs
```

Neither command uses an authenticated model provider. The relay probe declines
all command approvals; the application fixture stops its approval-bound turn.
No tool command is executed.

## Validation limits

Only Linux x64 execution is established by these results. macOS artifacts
have integrity evidence only. Windows, authenticated providers, generated
images, managed TUI, SSH/outbound, and external WS/WSS require separate
platform/topology checks. Mock-provider execution and artifact integrity do
not establish those live behaviors. Native proxy/security fixes in 0.163.0
also require updating each separately installed runtime; this parser refresh
does not install them.
