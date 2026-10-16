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

## Validation limits

Only Linux x64 execution is established by these results. macOS artifacts
have integrity evidence only. Windows, authenticated providers, generated
images, managed TUI, SSH/outbound, and external WS/WSS require separate
platform/topology checks. Mock-provider execution and artifact integrity do
not establish those live behaviors. Native proxy/security fixes in 0.163.0
also require updating each separately installed runtime; this parser refresh
does not install them.
