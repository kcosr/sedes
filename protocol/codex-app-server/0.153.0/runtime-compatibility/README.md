# Codex runtime compatibility evidence

The generated parser and development dependency remain pinned to 0.153.0.
This directory records qualification of newer operator-installed runtimes
against that exact protocol. It does not add a parser or change the minimum
supported release.

## Codex 0.154.0

[Artifact metadata](0.154.0.json), the exact
[schema delta](0.154.0-schema-delta.json), and the
[semantic review](0.154.0-review.md) record qualification against the unchanged
0.153.0 production parser. Thread metadata additions are projected away; new
usage, device-verification, and worktree features are not adopted. Unlike
0.153.4, the new runtime has different schema exports. Qualification requires
an exact inventory and hashes for every reviewed addition, change, or removal,
and unchanged hashes for every other file. It never relaxes production codecs.

The [Linux x64 offline result](0.154.0-linux-x64.json) records model discovery,
stable/experimental gating, thread creation, streaming, settings, pagination,
persisted resume after restart,
and fork history through production codecs. The separate
[interaction result](0.154.0-interactions-linux-x64.json) records a real
command-approval request against the production request/response
codecs using a deterministic loopback model. Both use isolated provider state
and do not contact a live model provider.

Only Linux x64 is runtime-qualified here. macOS arm64/x64 packages have integrity
evidence only. No Windows runtime, authenticated account, generated-image,
interactive managed-TUI, real SSH, or external WS/WSS qualification is claimed.

## Reproduce a reviewed qualification

Obtain the matching native package from the exact `resolved` URL in its
metadata and verify its published integrity. Extract the complete package,
including helper binaries and resources, and select `executableRelativePath`
beneath its `package/` directory. The qualifier defaults to the current
tested-through release; an explicit release selects retained historical
evidence through the same manifest format:

```sh
env -u NODE_ENV npm run verify:codex-runtime -- /absolute/path/to/codex 0.154.0
env -u NODE_ENV npm run verify:codex-interactions -- /absolute/path/to/codex 0.154.0
env -u NODE_ENV npm run verify:codex-runtime -- /absolute/path/to/codex-0.153.4 0.153.4
```

The runtime qualifier verifies the exact executable SHA-256, reported version, parser
baseline, and complete reviewed schema inventory before exercising behavior.
Unknown releases, wrong binaries, and unreviewed schema drift fail closed.
Digest pinning applies only to qualification; operator-owned executables still
use the existing production version/capability admission policy.

## Codex 0.153.4

[Artifact metadata](0.153.4.json) records the upstream tag/commit, npm tarball
integrities, and executable hashes. The published npm SHA-512 integrity was
verified for the wrapper and all three supported native packages; SHA-256 was
computed from each downloaded tarball and extracted executable. The upstream
`codex-rs/app-server-protocol` subtree is unchanged between the 0.153.0 and
0.153.4 tags.

The [offline result](0.153.4-linux-x64.json) records execution of the Linux x64
artifact against Sedes' production codecs and a loopback mock Responses
server. Stable and experimental TypeScript and JSON Schema exports are
compared byte-for-byte with the committed official 0.153.0 exports. The probe
also checks experimental API gating and persistent conversation operations.

macOS arm64/x64 artifacts were integrity-checked but were not executed on this
Linux host. This qualification does not claim live model, account, generated
image, managed TUI, SSH, or external WS/WSS verification. It uses a fresh
temporary home and Codex store, disables apps/plugins, and removes its state
after completion.

The separate `npm run check:codex-protocol` command continues to verify the
installed 0.153.0 development fixture and generated production binding.

This is a Codex-private release qualification. Pi, Claude, and Grok retain
their existing implementations and compatibility policies. No normalized
contract, configuration scope, provider capability, or ownership rule changes.
