# OpenCode v2 2.1.1 protocol profile

- Generated packages: exact `@opencode/client`, `@opencode/protocol` and
  `@opencode/schema` **2.1.1**, with **Effect 4.0.1**, in both the development
  and server-runtime lockfiles.
- Reviewed upstream tag: `v2.1.1`, revision
  `ba546ec1598a70db2570e9c6258028d955ba8f58`.
- Runtime admission: stable stock `opencode2` **2.1.1 or newer**, tested through
  **2.1.1**; Linux execution host, same account, verified native process and
  declared/observed SQLite store identity. Prereleases and below-floor versions
  are rejected. Build metadata does not alter precedence.
- Newer-than-tested versions publish an active installation advisory and use
  this same compiled profile; protocol and behavioral checks remain required.
- Private sidecar capability: `opencode_runtime` major **4**, including the
  observed runtime version, under sidecar wire protocol **16**, retaining
  negotiated traffic compression. Upgrade older sidecars with the server and
  the native runtime on each execution host.
- Transport: authenticated HTTP plus SSE; owned `serve --stdio` supplies startup
  endpoint discovery and process lifetime, not conversation JSON-RPC.

The 2.1.1 profile replaces the previous compiled profile with one current strict
parser. Assistant `providerState`, text/reasoning-part `state`, and tool-part
`providerState`/`providerResultState` are replaced by `native`. Completed
compactions no longer use `recent` or
`providerContext`; a native replacement window is carried at `native.messages`.
That field's presence, including an empty or null value, is opaque provider
context rather than proof that earlier image bytes survived. Model compatibility
adds optional `streamUsage`. Session archive timestamps and archived/unarchived
events remain private metadata; they do not change Sedes thread archive state.
Terminal errors project only the bounded, credential-scrubbed message; raw
provider response bodies remain native-private. Obsolete field shapes are not
accepted by fallback schemas.

Viewed-image qualification recognizes image-prefixed native input modalities and
uses the resolved catalog provider for stock xAI's GIF exclusion. PNG, JPEG and
WebP qualification retains the existing evidence and byte bounds.

Provider-private adapters validate the generated native message and event
schemas, bounded HTTP envelopes, and exact error types. Shared browser
contracts contain no native wire DTOs. Ordinary history comes from session,
message, pending-input, interaction, shell and active-session APIs. Mutations
use session creation, prompt, interrupt, exact inbox cancellation, rename/model,
permission and form APIs.

The admitted release supports querying idle records. Sedes retains its complete
bounded history acquisition and its existing paging, session counters, image
proof, delivery evidence and usage attribution. No idle-boundary paging redesign
is enabled by this compatibility update. Pi, Codex, Claude and Grok retain their
existing provider contracts.

The stock client hardcodes a 16 MiB SSE parsing buffer without an override.
The adapter reads only the event and finite input-log SSE routes through its
bounded 32 MiB framing reader, retaining official payload schemas and the same
authenticated HTTP/cancellation boundary. This supports the base64 expansion
of a 16 MiB image without modifying the SDK installation or native executable.

The supplemental `/api/experimental/session/:sessionID/log` endpoint is used
only for bounded read-only input recovery. It requires one final matching
`log.synced` marker and EOF and records missing sequence intervals explicitly.
It is experimental, and its presence does not imply replay: stock CLI defaults
native event persistence off. Isolated qualification observes live durable
events followed by a cold log containing only its watermark. Revert can erase
both pending and consumed user messages without input cancellation events.
Those limitations are part of recovery behavior, not reasons to patch the
native database or invent absence proof.

Deterministic coverage lives in `tests/unit/opencode-*.test.ts`. Opt-in
`tests/real-opencode` uses a fixture-owned stock daemon, disposable native store,
and loopback model/MCP endpoints. It does not use paid model inference or an
operator's existing sessions. The minimum and tested-through runtime are both
2.1.1. Focused stock-binary qualification covers idle-filtered paging and cursor
round trips, archive metadata/events, completed manual compaction and its
projected summary, usage attribution after compaction, retained viewed images
after source deletion, and new image capture after a local summary compaction.
The loopback live-gate rehearsal also passes without authenticated providers.

Live-provider results are **intermittent; stable qualification is inconclusive**.
Two authorized `test:live-opencode` read-only canary attempts on 2026-10-23 used
`https://aw-qwen-3-8-27b/v1`, model `aw-qwen-3-8-27b`, OpenCode 2.1.1,
`max_tokens: 256` and low-reasoning chat-template settings. The first stopped at
the two-model-step guard, with no finish diagnostic retained. After adding
bounded counts-only failure diagnostics, one retry passed. Both attempts used
unchanged request, step and time limits. The cause of the initial guard stop was
not established.

On 2026-10-26 at 03:48:50 UTC, one additional authorized canary passed after
rebasing onto Sedes `49f7d45b`, with the same endpoint, model, 256-token limit,
two-model-step guard and low-reasoning chat-template settings. The three
attempts total one guard stop and two passes; they do not establish stable
live-provider reliability.

See the [operator runbook](../../../docs/operator/backends/opencode.md)
and [private implementation contract](../../../docs/internals/backends/opencode.md)
for supported surfaces, ownership, and recovery.
