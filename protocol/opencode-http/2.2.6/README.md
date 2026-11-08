# OpenCode v2 2.2.6 protocol profile

- Generated packages: exact `@opencode/client`, `@opencode/protocol` and
  `@opencode/schema` **2.2.6**, with **Effect 4.1.0**, in both the development
  and server-runtime lockfiles.
- Reviewed upstream tag: `v2.2.6`, revision
  `dc2ffcf8bf26f9e669b6aa22b95f50e12be15e06`.
- Runtime admission: stable stock `opencode2` **2.2.6 or newer**; Linux
  execution host, same account, verified native process and declared/observed
  SQLite store identity. Tested through **2.2.6**. Prereleases and below-floor
  versions are rejected.
  Build metadata does not alter precedence. Runtime admission and its
  tested-through evidence remain distinct from this compiled profile.
- Newer-than-tested versions publish one active installation advisory and use
  this same compiled profile; protocol and behavioral checks remain required.
- Private sidecar capability: `opencode_runtime` major **5**, carrying native
  DTOs validated by this profile, under sidecar wire protocol **17**. Capability
  negotiation rejects older peers before parsing their native DTO envelopes.
  Upgrade server and execution sidecar together. No browser protocol change is
  required.
- Transport: authenticated HTTP plus SSE; owned `serve --stdio` supplies startup
  endpoint discovery and process lifetime, not conversation JSON-RPC.

The qualified runtime floor is 2.2.6. The current global event schema requires
`PersistentPty.Info.userTitle`; native releases before 2.2.4 omit it. A valid
older `persistent-pty.added` event therefore fails strict validation before
session routing, even when terminals are not a Sedes feature. Earlier releases
are rejected at admission; no synthetic field or alternate parser is used.
The prior 2.1.1 workflow tests passed but did not exercise that global event, so
they do not establish compatibility with this profile.

The sole compiled profile admits the current optional server hostname, session
busy timestamp, retry-delay diagnostics, model type and media-input metadata,
and the known `artifact.updated` event. Artifact inventory notifications are
passive and do not grant Sedes artifact-management capabilities. Only chat
models (including native models with no explicit type) are offered for
conversations. Optional metadata remains provider-private; it does not change
normalized delivery, lifecycle, history, image or usage semantics.

The profile retains current native replay fields. Assistant, text/reasoning
and tool-part replay data use `native`; completed compactions carry their
replacement window at `native.messages`. Obsolete `providerState`, `state`,
`recent` and `providerContext` shapes are not accepted by fallback parsers.
Native archive state does not select Sedes thread archive state. Terminal
errors expose only bounded, credential-scrubbed messages.

Upstream 2.2.6 provides stack-safe linear Base64 validation. Sedes uses the
official encoded schemas directly and removes its obsolete AST substitution.
Large-image regression coverage preserves the exact lexical constraints and
strict nested shape checks. The adapter's bounded 32 MiB SSE reader still
handles a 16 MiB image's Base64 expansion; it retains official payload schemas
and authenticated HTTP/cancellation boundaries without modifying the SDK or
native executable.

Native SQLite storage and blob hydration remain provider-owned. Sedes uses the
normal hydrated HTTP representation and does not opt into experimental media
URI representations. Ordinary history acquisition remains complete and bounded,
with existing paging, counters, delivery evidence, images and usage attribution.

The supplemental `/api/experimental/session/:sessionID/log` endpoint remains a
bounded read-only recovery surface. It requires a final matching `log.synced`
marker and EOF and records missing sequence intervals explicitly. Experimental
log availability does not prove replay: default native event persistence and
revert limitations remain part of recovery behavior, not reasons to patch the
database or infer absence.

Deterministic coverage lives in `tests/unit/opencode-*.test.ts`. The isolated
`tests/real-opencode` suite uses an explicitly selected stock daemon, disposable
native state and loopback model/MCP fixtures; it does not use authenticated
provider inference or existing operator sessions. On 2026-11-08, the selected stock 2.2.6 binary passed all 52 offline tests,
including all seven production carrier cases across local, SSH and outbound
owned/external placements, native images, MCP, streaming, input recovery,
compaction and read-only live-gate rehearsals. Earlier concurrent runs hit an
unreadable orphan-process `/proc` entry during cleanup; serial qualification
passed without weakening the ownership checks. Native 2.2.6 qualification used the
official `opencode-linux-x64.tar.gz` release asset, SHA-256
`08bb21d6326ce740d91cce7ebe88a6536933f6e1e30353b91a06b01f25da306c`.
On 2026-11-08, one separately authorized 2.2.6 AW Qwen read-only canary passed
against `https://aw-qwen-3-8-27b/v1`, model `aw-qwen-3-8-27b`, with low-reasoning
chat-template settings, a 256-token limit and the unchanged two-model-step
budget. The isolated configuration disables the built-in skill plugin, keeping
exactly the canary read tool available. This result covers that model on Linux
x64; one pass does not establish reliability across providers or platforms.

## Historical 2.1.1 live-provider evidence

These prior results do not qualify 2.2.6. Live-provider results are
**intermittent; stable qualification is inconclusive**.
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
