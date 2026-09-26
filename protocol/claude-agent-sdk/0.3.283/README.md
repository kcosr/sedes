# Claude Agent SDK 0.3.283 native qualification

This is release qualification for the existing Sedes Claude integration.
The SDK is pinned to 0.3.283, replacing 0.3.274. The qualified current CLI is
2.1.283 and the admitted minimum CLI is 2.1.281; the runtime policy did not
change with the SDK. No new SDK feature is adopted by this update, and Sedes
still runs the operator-installed executable, never the one the SDK bundles.

## Authority and artifacts

Reviewed the official SDK release notes for
[0.3.275](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.275)
through [0.3.283](https://github.com/anthropics/claude-agent-sdk-typescript/releases/tag/v0.3.283),
the published `sdk.d.ts` against 0.3.274, and the `getSessionMessages`
implementation in the published `sdk.mjs` of both releases. The native CLI is
closed source; declarations and release notes are not proof of every runtime
path.

[Native qualification metadata](native-qualification.json) records exact
registry integrities, tarball SHA-256, executable SHA-256, and reported
versions. The SDK tarball and both Linux x64 CLI tarballs passed their
registry SHA-512 integrity checks. The installed 2.1.281 and 2.1.283
executables are byte-identical to the executables in the official npm
packages, and the SDK's own Linux x64 platform package carries the same
2.1.283 executable.

## Package and API review

- The package adds a `/core` entry and two `core-*.mjs` chunks for hosts that
  bundle their own zod and MCP SDK. Sedes imports only the root entry, which
  is still one self-contained `sdk.mjs`; the Claude worker and sidecar
  source-ownership checks pass unchanged. `sdk.mjs` shrank from 1.56 MB to
  1.15 MB.
- No declaration Sedes compiles against changed incompatibly. New optional
  surfaces are not adopted: `prewarm()`/`SpareProcess`, `verbatimPrompts`,
  `readMcpResource()`, `pasted_content`, `SlashCommand.builtin`,
  `plugin_errors`, `view_mode`, `conversation_reset` metadata, the
  `highlights` thinking display, and `updateSettings('userSettings')`.
  Private worker schemas project only the fields Sedes uses, so the new
  optional fields never cross them.
- `Query.interrupt()` is still declared without arguments. The runtime, in
  0.3.274 and 0.3.283 alike, accepts an undeclared `{ cancelQueued: true }`
  that sends `cancel_queued` and returns `cancelled` beside `still_queued`,
  and has an undeclared `cancelAsyncMessage(uuid)`. `command_lifecycle`
  frames remain untyped and are forwarded verbatim; Sedes still validates
  their shape itself and uses neither cancellation path.
- Options Sedes passes (`env`, `extraArgs`, `settingSources`,
  `persistSession`, `resume`, `forkSession`, `resumeSessionAt`, `canUseTool`,
  `mcpServers`, `strictMcpConfig`, hooks and settings) and the session
  helpers it calls (`getSessionInfo`, `listSessions`, `renameSession`) keep
  their declarations.

## Native history parity

Sedes reads native transcripts with its own reader, which must equal the
pinned SDK's `getSessionMessages` wherever the read does not continue across
a compaction. 0.3.283 changed that read in five ways, and the reader adopts
each:

- The leaf walks up from the file-latest childless main-conversation row of
  any type, so a startup-message tip now reads its whole chain (release note:
  "a rewound-away branch when the newest branch ends at a meta row").
- Every answered queued-command attachment is converted, not only human
  prompts, and carries `isQueuedCommand: true`. A task notification queued
  without an origin gets `{ kind: "task-notification" }`
  (release note 0.3.275: "a task notification or other queued message that
  Claude read while running a tool").
- A completed local command's record and output rows carry
  `isCompletedLocalCommand: true` and do not count as prompts when deciding
  whether a queued command was answered.
- Parallel tool results are also re-inserted when they name their call by
  `sourceToolAssistantUUID` or `tool_use_id` rather than by parent, and three
  more interruption markers count as replies.
- Task-notification origins keep `fireReason`.

A read-only comparison over all 308 local transcripts on this host, with and
without `includeSystemMessages`, found 305 deep-equal, 2 where the SDK's read
is exactly Sedes' newest segment (compaction continuation), and 1 difference.
Of the 91 transcripts whose tip is a startup message, 90 are deep-equal; the
91st is one of the two compacted ones. The difference is a CLI 2.1.269
session whose last row is a Remote Control `system/informational` warning
attached to a `turn_duration` row ten hours older: the SDK's walk from that
notice returns 198 messages, while Sedes reads all 261 to the true tip.
`tests/unit/claude-native-transcript.test.ts` pins that case.

The new conversions add rows to 33 of those transcripts, so the projector was
compared too. Through the worker's wire fields, the latest snapshot (turns,
items and fork checkpoints) and every history page are identical before and
after the update for all 308. That needs the `isQueuedCommand` marker, which
sidecar runtime protocol 14 now carries: without it, 32 transcripts split a
turn at a task notification Claude read mid-turn.

## Deterministic native boundary

`tests/real-claude/claude-native-boundary.test.ts` runs the actual SDK and
native CLI against a bounded loopback Messages SSE fixture. Each case has a
disposable workspace, home and Claude config directory, no inherited
credentials, a fake fixture-only API key, no settings or plugins, and only
fixture tool authority. No external model capacity is consumed.

Its cases verify:

- A native Bash permission reaches `canUseTool`; its denial reaches the next
  model request. A marker command never executes.
- An SDK-owned MCP tool reaches `canUseTool` with
  `mcpServer: { name: "fixture", source: "sdk" }`. Denial reaches the model,
  the registered MCP implementation never executes, and the opt-in
  `CLAUDE_CODE_EMIT_STARTUP_TIMING=1` produces `startup_timing` in the
  initialization message. Production does not enable this flag.
- `Query.interrupt()` while Bash approval is pending aborts the callback
  signal, emits a terminal result, and makes no second provider request.
- `Query.interrupt()` during streaming ends the turn `aborted_streaming`.

The other loopback files qualify lifecycle behaviour Sedes depends on:
background activity (`claude-background-activity-native`), compaction
(`claude-compaction-native`), process loss (`claude-process-loss-native`),
resume after an orphaned background task (`claude-resume-orphan-native`), run
state and input lifecycle frames (`claude-run-state-native`), and steer
delivery (`claude-steer-native`).

Reproduce one file with:

```sh
env -u NODE_ENV SEDES_REAL_CLAUDE_EXECUTABLE=/absolute/path/to/claude \
  npx vitest run --config vitest.real-claude.config.ts \
  tests/real-claude/claude-native-boundary.test.ts
```

The fixture always supplies its isolated child environment, even with an
executable override; it never borrows credentials from that executable's
usual home directory.

## Results

On 2026-09-26, with SDK 0.3.283:

- All seven loopback files passed on Claude Code 2.1.283 and on the admitted
  minimum 2.1.281: native boundary (4 cases), background activity (4),
  compaction (2), process loss (1), resume orphan (1), run state (3), and
  steer delivery (4).
- The four authenticated files passed on 2.1.283 with explicit approval:
  conversation driver, native history (2 cases), Native MCP tools, and the
  persistent runtime. The native-history case now also asserts that the
  SDK's own read of a resumed transcript with a startup-message tip and
  parallel-call dead ends equals Sedes' read; under 0.3.274 it stopped at a
  dead end.

## Review dispositions and limits

### Resumed usage totals

Release 0.3.277 notes that a resumed or forked session's `total_cost_usd`
and `modelUsage` continue from the totals its transcript saved instead of
starting at zero. That is Claude Code behaviour from 2.1.277, so it applies to
every admitted runtime whatever the SDK release. A loopback probe on 2.1.281
and 2.1.283 confirmed it: after two turns, a resumed query's first result
reported three requests. Sedes' usage accounting still opens each fresh
query from a proven zero, so the pipeline totals of a resumed or forked thread
count its earlier turns again. That is an open defect of the runtime policy,
not of this SDK update, and is not changed here.

### Background activity and task notifications

Background inventory, `task_started` with the parent `tool_use_id`, the
foreground result, and correlated `task_notification`/`task_updated` terminal
events keep the ordering the UI relies on: inventory for liveness, exact
correlated notifications for terminal bookends. Release notes since 0.3.274
say queued background completions each receive a result, with all but the
last empty and zero-turn; Sedes classifies only those with native
`task-notification` provenance as drain receipts. The native cases do not
generate background-task coalescing.

The SDK keeps `origin` on `getSessionMessages()` results although its public
`SessionMessage` declaration omits it (as it omits `timestamp`,
`isQueuedCommand`, and `isCompletedLocalCommand`). A complete
task-notification envelope with the generic `origin.kind:
"task-notification"` is hidden as an internal bookend; scheduled and peer
deliveries stay visible.

### Not exercised

Permission hints `defaultToNo` and `suppressAlwaysAllowRule` are carried
through Sedes' strict worker contract and covered by production tests, but
no native callback here provokes them. `startup_failure_reason` causes are
not induced. These Linux tests do not establish macOS or Windows behaviour,
actual SSH or outbound carrier operation, or comprehensive upstream feature
support. Authenticated-suite, browser, build, packaging, and regression
results belong in the relevant pull request.

## Licensing and provenance

This directory holds Sedes-authored qualification notes and the
[native qualification metadata](native-qualification.json) (registry
integrities, tarball and executable SHA-256 digests, reported versions). It
derives from `@anthropic-ai/claude-agent-sdk` 0.3.283 and the closed-source
Claude Code CLI, both proprietary: the SDK package declares
`SEE LICENSE IN README.md` and ships "© Anthropic PBC. All rights reserved.
Use is subject to the Legal Agreements outlined here:
https://code.claude.com/docs/en/legal-and-compliance". Sedes redistributes no
upstream source, tarball, or executable here; the directory records only
hashes and observed behavior, and the repository's `postinstall` step
removes the SDK's platform executable packages.
