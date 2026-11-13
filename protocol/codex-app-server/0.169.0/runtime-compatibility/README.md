# Codex 0.169.0 runtime qualification

The development dependency, sole generated profile, runtime minimum and tested
release are 0.169.0. Native provider-specific catalog selection is required:
earlier app-servers can ignore the selector and return their default provider's
catalog. The [selector contrast](provider-selector-contrast.json) records a
0.167.0 unknown-provider request returning the default catalog while 0.169.0
rejects it. Older profile artifacts and qualification records remain in Git history;
no older parser or version-dependent decoding fallback remains in production.

## Artifact and schema evidence

[Release provenance](../release.json) and [runtime metadata](0.169.0.json) record
the exact source tag, commit, npm integrity and native executable hashes.
[Schema delta](0.169.0-schema-delta.json) verifies all current stable/experimental
TypeScript and JSON Schema exports against the generated profile. Qualification
rejects any unreviewed file or byte change. Linux x64 execution is separate from
macOS artifact-integrity evidence.

## Native runtime and interactions

[Runtime results](0.169.0-linux-x64.json) exercise one digest-verified native
executable with an isolated native store and loopback model providers. They verify
model discovery, experimental gating, settings observations, streaming/item/turn
events, lifecycle timestamps, read-state ordering, restart persistence, pagination,
root-turn lineage and fork settings/history through current Sedes decoders.

The reasoning regression uses a model offering Low/High effort and a conflicting
native `none` default. Twelve captured WebSocket requests prove that sending the
selected effort in session config supplies the correct request baseline on
creation, cold resume and fork. Turn-level effort alone does not replace the
prewarmed baseline; live shared sessions retain native observation authority.

[Interaction results](0.169.0-interactions-linux-x64.json) verify a native command
approval, encoded decline, provider-visible rejection, and nonexecution. These
checks use mock inference and never execute the requested command.

Reproduce using the complete matching native package:

```sh
env -u NODE_ENV npm run check:codex-protocol
env -u NODE_ENV npm run verify:codex-runtime -- /absolute/path/to/codex 0.169.0
env -u NODE_ENV npm run verify:codex-interactions -- /absolute/path/to/codex 0.169.0
```

## Additional qualification

The gated native Speed suite uses the production driver, actor, scoped settings,
receipts and persistent sidecar with loopback models. The separate ordering probe
injects delayed native-bound frames to establish same-stream ordering and the
absence of a cross-stream issue-order guarantee. The lifecycle suite covers real
spawned-child archival and saved-provider restoration after a default change.

```sh
env -u NODE_ENV SEDES_SPEED_NATIVE_EXECUTABLE=/absolute/path/to/codex \
  npx vitest run tests/integration/codex-active-speed-native.test.ts tests/integration/codex-runtime-native.test.ts
env -u NODE_ENV SEDES_SPEED_NATIVE_EXECUTABLE=/absolute/path/to/codex \
  node scripts/codex-probes/verify-active-speed-ordering.mjs
```

Native source shape/metadata regression tests also cover bounded moderation,
completion counts, local executor metadata, attachment metadata and file-backed
audio output. Admitting that metadata grants no audio, extra-executor, native
presentation-action or attachment capability. Other compiled backends retain
their existing contracts.

## Validation limits

Loopback checks do not establish authenticated model behavior, real web search,
image generation, external networking or target-platform desktop compatibility.
The authorized live suites and their actual results are recorded separately.
macOS artifact integrity is not execution evidence. Windows/macOS desktop
verification must run on the target platform before shipment.
