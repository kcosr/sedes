# OpenCode v2 2.0.32 protocol profile

- Generated packages: exact `@opencode/client`, `@opencode/protocol` and
  `@opencode/schema` **2.0.32**, with **Effect 4.0.1**, in both the development
  and server-runtime lockfiles.
- Reviewed upstream tag: `v2.0.32`, revision
  `843a6c514e606b436a7fe713422ace0a93ad3d61`.
- Runtime admission: stable stock `opencode2` **2.0.29 or newer**, tested through
  **2.0.32**; Linux execution host, same account, verified native process and
  declared/observed SQLite store identity. Prereleases and below-floor versions
  are rejected. Build metadata does not alter precedence.
- Newer-than-tested versions publish an active installation advisory and use
  this same compiled profile; protocol and behavioral checks remain required.
- Private sidecar capability: `opencode_runtime` major **3**, including the
  observed runtime version; older sidecars must be upgraded with the server.
- Transport: authenticated HTTP plus SSE; owned `serve --stdio` supplies startup
  endpoint discovery and process lifetime, not conversation JSON-RPC.

Review of the 2.0.18 to 2.0.29 schema delta found optional additions: terminal
idle errors, nested provider response bodies, form cancellation messages,
model/provider compatibility settings and server capabilities. The 2.0.32
profile admits these fields without relaxing unknown-field rejection. The
2.0.29 to 2.0.32 delta additionally introduces the optional model capability
`temperature`; existing session, history and mutation routes are unchanged. Terminal
errors project only the bounded, credential-scrubbed message; raw provider
response bodies remain native-private. Required session, inbox and location
shapes remain compatible with 2.0.29.

Provider-private adapters validate the generated native message and event
schemas, bounded HTTP envelopes, and exact error types. Shared browser
contracts contain no native wire DTOs. Ordinary history comes from session,
message, pending-input, interaction, shell and active-session APIs. Mutations
use session creation, prompt, interrupt, exact inbox cancellation, rename/model,
permission and form APIs.

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
operator's existing sessions. Both the 2.0.29 minimum and 2.0.32 tested-through
release are qualified with these fixtures. The separate, explicitly authorized
`test:live-opencode` gate also qualifies 2.0.32 against the configured AW Qwen
model using its read-only canary and bounded request limits. See the [operator runbook](../../../docs/operator/backends/opencode.md)
and [private implementation contract](../../../docs/internals/backends/opencode.md)
for supported surfaces, ownership, and recovery.
