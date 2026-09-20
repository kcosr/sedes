# Claude Agent SDK 0.3.274 native qualification

This is release qualification for the existing Sedes Claude integration.
The SDK is pinned to 0.3.274; the qualified current CLI is 2.1.274.
The admitted minimum CLI is 2.1.274. The 2.1.241 observations below are
historical comparison evidence, not a supported runtime configuration. No
automatic adoption of new SDK features is implied by updating the dependency.

## Authority and artifacts

Reviewed the official [SDK 0.3.274 release](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.274),
[CLI 2.1.274 release](https://github.com/anthropics/claude-code/releases/tag/v2.1.274),
and the published SDK declarations against 0.3.241. The native CLI is closed
source; declarations and release notes are not proof of every runtime path.

[Native qualification metadata](native-qualification.json) records exact
registry integrities, tarball SHA-256, executable SHA-256, and reported versions.
The SDK and both Linux native tarballs passed their registry SHA-512 integrity
checks. The installed 2.1.274 executable was byte-identical to the executable
in the official npm Linux x64 package. The 2.1.241 executable was extracted into
an independent cache directory; qualification did not replace the installed
CLI or alter its symlink.

## Deterministic native boundary

`tests/real-claude/claude-native-boundary.test.ts` runs the actual SDK and native
CLI against a bounded loopback Messages SSE fixture. Each case has a disposable
workspace, home and Claude config directory, no inherited credentials, a fake
fixture-only API key, no settings/plugins, and only fixture tool authority.
The authenticated suite's existing no-tools and subscription gates remain
separate and unchanged. No external model capacity is consumed by these cases.

The 2.1.274 cases verify:

- A native Bash permission reaches `canUseTool`; its denial reaches the next
  model request. A marker command never executes.
- An SDK-owned MCP tool reaches `canUseTool` with actual
  `mcpServer: {name: "fixture", source: "sdk"}`. Denial reaches the model and
  the registered MCP implementation never executes.
- `Query.interrupt()` while Bash approval is pending aborts the actual callback
  signal, emits a terminal result, and does not execute the command or make a
  second provider request.
- Opting into `CLAUDE_CODE_EMIT_STARTUP_TIMING=1` produces `startup_timing` in
  the actual initialization message. Production does not enable this flag.

Reproduce the three cases with:

```sh
env -u NODE_ENV npm run test:real-claude -- tests/real-claude/claude-native-boundary.test.ts
```

`SEDES_REAL_CLAUDE_EXECUTABLE` selects an explicit executable. The fixture
always supplies its isolated child environment even when using this override;
it never borrows credentials from that executable's usual home directory.

SDK 0.3.274 also passed native Bash denial and pending-permission interruption
against official CLI 2.1.241:

```sh
env -u NODE_ENV SEDES_REAL_CLAUDE_EXECUTABLE=/absolute/path/to/2.1.241/claude \
  npm run test:real-claude -- tests/real-claude/claude-native-boundary.test.ts \
  -t 'Bash|interrupt'
```

This establishes historical compatibility of those control paths with 2.1.241,
not current runtime admission or parity of optional metadata. The new SDK
explicitly declares MCP provenance optional for CLIs predating that field.
Current runtime admission is defined by the
[Claude backend guide](../../../docs/operator/backends/claude.md#version-compatibility).

## Review dispositions and limits

### Background activity qualification

The subsequent background-activity implementation adds
`tests/real-claude/claude-background-activity-native.test.ts`. The actual 2.1.274
CLI and pinned SDK run finite Bash and Agent jobs against the same isolated
loopback model boundary. A release file is created only after the successful
foreground result, proving the job is still running at that boundary.

Both background cases observe a nonambient `background_tasks_changed` inventory,
`task_started` with the exact parent `tool_use_id`, the foreground result, an
empty inventory, and a completed `task_notification`. The empty inventory can
precede the terminal notification. The UI therefore uses inventory for liveness
and exact correlated notifications for persistent terminal bookends. This
native test consumes no external model capacity and does not prove remote
carrier behavior.
An additional foreground Agent case observes `task_started` with
`is_backgrounded: false`, terminal `task_updated`, and `task_notification`
before the parent result, without a background inventory entry.
All three cases also pass against the cached official CLI 2.1.241 executable
with SDK 0.3.274, including exact parent-tool correlation and the same terminal
event ordering. These historical comparisons do not change the current admitted minimum.

```sh
env -u NODE_ENV npm run test:real-claude -- tests/real-claude/claude-background-activity-native.test.ts
```

The iterative review added an interrupted foreground Agent case. Once the
child's exact finite Bash command has started, the fixture calls the normal
`session.interrupt()` control without releasing the command. On both CLI
2.1.274 and the historical 2.1.241 comparison version, the parent stream emits a correlated
`task_updated` with `patch.status: "killed"` before the parent result. The
fixture asserts that exact terminal observation. The four native lifecycle
cases pass on both versions; no external model capacity is used. This proves
normal foreground interruption settles the same outcome hold as completion;
it does not claim to induce every possible provider failure.

### Task-notification history provenance

The SDK 0.3.274 runtime retains `origin` on `getSessionMessages()` results even
though its public `SessionMessage` declaration omits that field (as it also
omits the already-consumed `timestamp`). Sedes now preserves this bounded
provider metadata through the private history worker wire and live projection.
A complete task-notification envelope with the provider's generic
`origin.kind: "task-notification"` is hidden as an internal bookend. Identical
human/unattributed text and scheduled/peer deliveries remain visible. The
native record still anchors any following assistant response; notification-only
records create no empty running turn or user-input receipt/count. Fork content
fingerprints include provenance so fork validation preserves this distinction.

A real SDK history-reader fixture verifies provenance retention independently
of mocked SessionMessage types. Worker, live/reopen, prompt-count, and literal
user-text regressions cover the application paths. A read-only check of the
reported native session confirms its internal XML disappears while visible
assistant responses and idle state remain intact. No transcript is rewritten.

The release adds permission hints `defaultToNo`, `suppressAlwaysAllowRule`, and
MCP provenance. Sedes carries the optional fields through its strict private
worker contract; decline-first interaction handling and persistent-grant
suppression are covered by focused production tests. Native qualification
above exercises MCP provenance. It does not claim to have provoked either of
the two safety hints in an actual CLI callback.

Release notes say queued background completions each receive a result, with
all but the last empty and zero-turn. That sequence requires explicit
correlation handling; ordinary successful results and startup error results
must not be conflated with these notifications. Native fixture cases above do
not generate background-task coalescing. Synthetic lifecycle regression tests
must be described separately from native observations.

`startup_failure_reason` is additional diagnostic metadata on startup errors;
normal native startup and opt-in timing are tested here, but the named startup
failure causes are not induced. Session-history changes require the separate
authenticated persistence/reopen suite. Optional per-task Stop affordances,
model-switch hooks, additional usage metadata, and new SDK tool controls are
not enabled merely to qualify this release. Sedes does not advertise a native
per-task Stop UI.

These Linux tests do not establish macOS/Windows behavior, actual SSH carrier
operation, authenticated account behavior, or comprehensive upstream feature
support. Authenticated-suite, browser, build, packaging, and regression results
belong in the relevant pull request rather than this protocol reference.

## Licensing and provenance

This directory holds Sedes-authored qualification notes, the
[native qualification metadata](native-qualification.json) (registry
integrities, tarball and executable SHA-256 digests, reported versions). It derives
from `@anthropic-ai/claude-agent-sdk` 0.3.274 and
the closed-source Claude Code CLI, both proprietary: the SDK package declares
`SEE LICENSE IN README.md` and ships "© Anthropic PBC. All rights reserved. Use
is subject to the Legal Agreements outlined here:
https://code.claude.com/docs/en/legal-and-compliance". Sedes redistributes no
upstream source, tarball, or executable here; the directory records only hashes
and observed behavior, and the repository's `postinstall` step removes the SDK's
platform executable packages.
