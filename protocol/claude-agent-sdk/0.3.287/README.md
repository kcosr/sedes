# Claude Agent SDK 0.3.287 native qualification

Sedes pins Agent SDK 0.3.287 and admits stable Claude Code 2.1.287 or newer,
with 2.1.287 as its tested-through release. This replaces the 0.3.283 SDK
profile and the 2.1.281 runtime floor. It adopts the updated history behavior
and skill aliases; urgent `priority: "now"` steering and process prewarming
remain separate follow-up work. Sedes runs the operator-installed executable,
never the executable bundled with the SDK.

## Authority and artifacts

Reviewed the official SDK release notes for
[0.3.284](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.284),
[0.3.285](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.285),
[0.3.286](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.286),
and [0.3.287](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.287),
the published declarations, and `getSessionMessages` in the published
`sdk.mjs`. The native CLI is closed source; release notes and declarations do
not establish every runtime behavior.

[Native qualification metadata](native-qualification.json) records the exact
SDK registry integrity, declaration digest, native CLI registry integrity,
tarball and executable SHA-256, and reported version. The Linux x64 native
CLI tarball passed its registry SHA-512 integrity check. Both root and slim
server package lockfiles pin the same SDK. The native executable used for
qualification was installed separately from the SDK.

## Adopted behavior

- History conversion follows the SDK's delivery-ledger selection for queued
  command copies, including `absorbed_mid_turn` evidence and eligible trailing
  queued inputs. Sedes retains its existing true-tip selection and history
  across automatic compactions.
- Eligible external-origin meta messages are retained in history and live
  projection. Internal meta messages, including Sedes startup markers, remain
  hidden. Visibility alone never acknowledges a pending Sedes steer;
  delivery still requires native acceptance or consumption evidence.
- The skill picker searches safe native aliases and submits the canonical
  skill. Classification, native primary-name and builtin precedence, terminal
  exclusions, and ambiguous aliases are checked inside the Claude backend.
- The new `provider_not_allowed` startup reason maps to Sedes' bounded
  settings-unavailable failure. No provider error text becomes a browser
  contract.

The normalized skill alias metadata requires client protocol 132. Claude
worker capability `claude_runtime@3` and persistent sidecar capability
`claude_persistent_runtime@4` fence older catalogs that do not preserve builtin
classification and older history behavior. Existing sidecars must be upgraded
through their normal active-work-protected lifecycle.

## Permission initialization

SDK 0.3.286 stopped supplying an implicit `default` when the host omits
`permissionMode`. Sedes intentionally omits it when importing without a saved
selection, allowing native configuration to provide the initial mode. The
driver adopts a recognized allowlisted result; disallowed, unknown, and plan
modes block new Sedes submissions. Explicit target selections and isolated
fork launches retain their explicit modes.

Six isolated native initialization probes covered old/new SDK defaults and
configured modes without model requests. Five driver regression cases cover
adoption and denial for `acceptEdits`, `auto`, and `plan`. A bounded native
probe resumed a killed background Bash task with an observed native mode
outside a simulated Sedes allowlist: orphan cleanup and the startup marker
completed with zero model turns, and no model request, permission callback,
or resumed tool execution occurred during eight further seconds.

That last probe qualifies killed-background-Bash cleanup only. It does not
establish a global native permission ceiling for every autonomous
notification, schedule, subagent recovery, or reattachment to a running query.
The Sedes mode allowlist remains application submission policy, not a native
sandbox.

## Ownership and cross-backend disposition

SDK parsing, native aliases, delivery ledgers, and runtime admission stay
Claude-private. Catalogs belong to the authenticated thread/workspace and its
execution environment. They do not create new persisted alias state or grant
authority across principals. The browser receives only bounded skill search
metadata and continues selecting an opaque canonical skill ID.

Claude implements alias discovery. Pi, Codex, Grok, and OpenCode keep their
existing skill discovery and omit aliases; their provider contracts and
submission paths are unchanged. The common picker handles optional normalized
aliases without backend-name branches. Send, ordinary Steer, Queue, Stop,
forks, and permission capabilities are unchanged.

## Qualification limits

The final implementation passed typecheck, the release build and its contract
checks, and Android package verification (unit tests and debug application/test
APK assembly; no device run). The default unit/integration suite completed:
two stale version/capability fixture files were corrected and passed all 46
tests on rerun. The remaining 24 failures require nested Bubblewrap operations
that this container denies: mounting `/proc` and setting the sandbox hostname.
Those restrictions were reproduced separately without changing protections.
Electron's full Linux package, native addons, provider imports, isolated bundled
server startup, HTTP assets, and graceful shutdown passed verification. Its
graphical smoke gate stopped at secure credential storage because this
container supplies no OS keyring and Electron reports `basic_text`; that gate
is not qualified here.

The full four-lane browser run passed 119 of 120 tests in 425.9 seconds. An
existing Pi mobile queue-deletion assertion failed, then passed in isolation
without changes. The changed Claude journey passed in 33.4 seconds against its
29-second committed estimate; its alias-search and in-flight screenshots were
inspected. The full run exceeded the 200-second guidance on a shared host with
other development activity, so it is not a quiet-host performance comparison.

All 14 real-Claude files ran against the separately installed native 2.1.287
executable. The first run passed 33 of 34 tests. The model refused the native
parallel-tools history request after seeing the startup source label; that
single case passed on a fresh isolated retry without changes. This upgrade
does not establish a fix for the previously observed startup-marker refusals.

The prior 2.1.286 persistent-runtime timeout did not reproduce in the bounded
2.1.287 authenticated and held-text loopback cases. Its cause remains unknown;
the passing cases do not prove a particular upstream fix caused the change.

Persistent-runtime tests exercise production workers and runtime ownership
over local framed carriers. They do not qualify an actual SSH login, remote
host, or outbound connector deployment. Native qualification is Linux x64;
it supplies no native macOS or Windows evidence. Optional SDK features not
adopted here remain unqualified.

The [operator guide](../../../docs/operator/backends/claude.md) documents the
upgrade requirements, permission semantics, and opt-in live test gate.
