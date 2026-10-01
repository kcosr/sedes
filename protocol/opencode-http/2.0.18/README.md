# OpenCode v2 2.0.18 protocol profile

- Native executable: stock `opencode2`, reporting `opencode v2.0.18`.
- Generated client/schema package: exact `@opencode/client` 2.0.18 in the lockfile.
- Reviewed upstream revision: `cd9a14a6b688d4021bee381dfd39d2cef9c0f862`.
- Runtime admission: exact 2.0.18, local Linux, same account, verified native
  process and declared/observed SQLite store identity.
- Transport: authenticated HTTP plus SSE; owned `serve --stdio` supplies startup
  endpoint discovery and process lifetime, not conversation JSON-RPC.

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
operator's existing sessions. See the [operator runbook](../../../docs/operator/backends/opencode.md)
and [private implementation contract](../../../docs/internals/backends/opencode.md)
for supported surfaces, ownership, and recovery.
