# Codex backend internals

This document defines the contributor-facing Codex integration contract:
protocol selection, runtime ownership, native thread binding, history and event
projection, durable recovery, and backend-specific features. Provider JSON-RPC
methods, notifications, requests, native identifiers, rollout history,
transport frames, and process topology stay private to
`src/server/backends/codex`.

For installation, topology selection, configuration, and operational
troubleshooting, see the [Codex operator guide](../../operator/backends/codex.md).

## On this page

- [Protocol and release admission](#protocol-and-release-admission)
- [Runtime and transport generations](#runtime-and-transport-generations)
- [Native thread creation and binding](#native-thread-creation-and-binding)
- [History and event projection](#history-and-event-projection)
- [Asynchronous question items](#asynchronous-question-items)
- [Delivery and interaction routing](#delivery-and-interaction-routing)
- [Generated image artifacts](#generated-image-artifacts)
- [Execution settings and feature persistence](#execution-settings-and-feature-persistence)
- [Forks and recovery](#forks-and-recovery)
- [Agent-tool integration](#agent-tool-integration)
- [Managed TUI integration](#managed-tui-integration)
- [Contributor verification](#contributor-verification)

## Protocol and release admission

Sedes pins `@openai/codex` 0.153.0 as its development-time generated protocol
baseline. Generated TypeScript, JSON Schema, the method
inventory, hashes, and release evidence live under
`protocol/codex-app-server/0.153.0`.

Owned Codex processes support Linux x64 and macOS arm64/x64. External
topologies retain their separate transport and execution-environment
requirements.

The compiled Codex backend supplies exactly one `0.153.0` generated parser
profile and persists that value for diagnostics and runtime-generation
integrity. It is not operator configuration and remains separate from
executable admission. Owned and external runtimes admit stable releases at or
above 0.153.0. Build metadata is allowed. Prereleases, malformed versions,
versions below the floor, and explicitly excluded known-bad releases are
rejected.

Releases newer than the 0.154.0 tested-through threshold receive a
provider-private `newerThanTested` assessment for the installation advisory.
They still use only the pinned 0.153.0 stable and experimental validators and
gain no capabilities from their version. Managed TUI uses the same
operator-installed command policy in every deployment: an optional canonical
`tuiExecutablePath` override, otherwise the first `codex` on `PATH`, with the
same release admission repeated at every Start. Missing or incompatible
commands disable only managed TUI.

Managed TUI disables the native startup update check for that process. An
update prompt must not intercept terminal input or replace the executable
outside Sedes release admission; operators update the installed command
separately.

Raising the tested-through threshold requires artifact review and focused
conformance. Change the compatibility floor only when a required contract
changes; do not add a second parser merely
because a newer compatible executable is admitted.

The 0.154.0 qualification retains the 0.153.0 development fixture and parser.
Its [artifact metadata and reproducible offline probe](../../../protocol/codex-app-server/0.153.0/runtime-compatibility/README.md)
record exact reviewed protocol-export deltas and Linux x64 execution against a
local mock model. Unreviewed export changes fail qualification; production
continues to use the unchanged 0.153.0 parser. macOS artifacts were
integrity-checked but not executed on that host; live-provider and additional
topology verification remain separate.

Sedes opts into only the contracted experimental `thread/settings/update`
method. Unknown experimental methods are rejected. The stable, invoked
`thread/turns/list` and `thread/items/list` methods belong only to the private
`paginated` history adapter; `legacy` never calls them.

Method stability is distinct from the selected wire artifact. Because Sedes
initializes app-server with `experimentalApi`, nine reviewed route directions
select their exact experimental 0.153.0 definition: five stable thread
requests, settings update, command approval, settings-updated, and
thread-started. Remaining adopted directions, including both pagination
requests, select the stable artifact. No direction falls back between profiles.
RPC admission recognizes all 83 official stable server notifications; 63 have
reviewed thread-routing evidence for bounded resnapshot recovery. The 31
adopted notifications retain their explicit semantic consumers, while other
official notifications are validated and ignored when no consumer is active.

The 0.153.0 command-approval request distinguishes ordinary commands from
`writeStdin`. Sedes handles both kinds. A `writeStdin` approval requires a
distinct approval ID, its visible command context, and exactly ordered
`accept`/`cancel` decisions; policy and network amendments fail closed. It is
correlated to the current turn and original terminal item before the existing
normalized decision interaction is published. The `openaiForm` and `openai/form` MCP
elicitation variant is structurally recognized but rejected by the semantic
gate because Sedes does not advertise or implement that extension. This
release cutover remains provider-private: it does not change shared backend
contracts, capabilities, or the Pi, Claude, and Grok dispositions.

MCP tool-approval requests can carry exact invocation arguments in
`_meta.tool_params`, identified by `_meta.codex_approval_kind: mcp_tool_call`.
The interaction bridge projects only those arguments into normalized,
bounded and redacted `invocation.arguments` for read-only display. Other
metadata remains private, and missing context is not reconstructed from tool
history or message text. The elicitation response remains independent of the
displayed invocation arguments.

Empty MCP form schemas project as an Allow/Cancel confirmation. Nonempty
supported form schemas project into normalized typed fields, including required
state, defaults, bounds, and supported formats. The broker replaces field and
choice identifiers before publication; response validation and reconstruction
of native property names stay server-side. Unsupported schemas fail closed
instead of using a JSON editor. Other compiled backends intentionally omit the
new `form` capability.

Regenerate or check the baseline with:

```sh
env -u NODE_ENV npm run generate:codex-protocol
env -u NODE_ENV npm run check:codex-protocol
env -u NODE_ENV npm run build
env -u NODE_ENV npm run check:codex-generated-runtime
```

Protocol generation is a deliberate dependency update, not a startup action.
The ordinary build performs the generated-runtime check after compiling the
server; the explicit command above is useful when auditing that emitted binding.

## Runtime and transport generations

The backend runtime creates one shared RPC facade, server-request router,
interaction bridge, model/catalog service, native ownership registry, and
driver factory for each tenant/principal/backend instance. Each attached Sedes
thread claims its native Codex thread within that runtime. Configured profiles
share one client generation; they do not create one app-server per logical
thread.

Transport loss, owned process replacement, external endpoint replacement, or
an unrecoverable RPC condition retires the client generation. Stale responses,
server requests, interactions, and channels from that generation are rejected.
The replacement initializes independently, and attached actors establish a
fresh normalized projection.

Only reads with an explicit safe-retry contract are replayed after connection
loss. A sent mutation stays governed by its method-specific delivery
classification and durable recovery evidence. Reconnection never makes it
safe to repeat automatically.

Transport implementations also own their generation boundaries:

- Owned stdio probes the executable, verifies that initialized app-server has
  the same semantic-version precedence, owns the process group and native-store
  lock, and releases the lock only after killing the process group.
- Local and sidecar-hosted UDS capture the assured owner/mode/socket identity
  and fence a replaced endpoint. A final owned symlink is allowed only between
  canonical owner-only directories and directly to an owned `0600` socket;
  alias and target identities are both revalidated. The configured selector
  remains the native-store/accounting namespace input.
- TCP/WSS resolves a fresh capability bearer for each generation and limits it
  to the Upgrade header.
- Persistent SSH execution owns its provider runtime on the sidecar, retaining
  exact runtime/session identity and bounded receipts through main/carrier loss.
  Read-only RPCs use transient responses and the native client's existing
  concurrency limit, without an additional relay queue; they do not
  enter the mutation receipt ledger or require a delivery acknowledgement.
  Session reattachment preserves typed provider, delivery, and protocol errors
  across the sidecar and maps their native generation to the current application
  attachment. A newly created paginated session can reject history reads before
  its first message; only the existing exact unmaterialized-thread classification
  permits an empty idle projection after same-generation metadata confirmation.
  Other read failures remain errors, and reattachment never creates a mutation
  receipt or resumes the session with replacement settings.
  Mutation admission accounts for actual queued input and retained outcome
  bytes instead of reserving a maximum-size response for every request. Four
  native mutations may run concurrently. Already running calls retain their
  outcomes even if completion crosses the storage admission threshold; further
  dispatch is refused until usage falls. Main commits correlated delivery
  evidence before acknowledging the host, and an acknowledgement delay does
  not delay an already recorded result.
  The byte threshold measures serialized retained data, not process RSS; it is
  an admission watermark, with bounded headroom for already running mutations.
  Thread notifications, receipts, and pending question/approval replies use
  independent ordering queues within that runtime. A slow thread cannot delay
  another thread's metadata read or mutation response. Each thread still
  receives its preceding notifications before its snapshot receipt; lifecycle
  and unclassified events fence all threads. Operation/request affinity maps
  are bounded, and completed queue tails are removed.
  Model, experimental-feature, skills, and permission-profile catalog reads
  wait for runtime-wide barriers, without waiting for thread output. Thread
  inventory reads retain the conservative runtime-wide fence.
  Provider connections use the admitted host-local transport. Optional workspace
  operations retain independent grants; external daemons remain operator-owned.

The operator-facing ownership and route requirements are in
[Supported topologies](../../operator/backends/codex.md#supported-topologies).

## Native thread creation and binding

A new Sedes draft has no native Codex ID. On first send, Sedes:

1. records a durable creation attempt and exact settings/input fingerprint;
2. calls native `thread/start` once;
3. durably binds the provider-assigned thread ID;
4. applies the Sedes title through the separate recoverable rename path; and
5. sends or reconciles the first input.

If the native response is known, Sedes retains the returned thread for exact
binding recovery even when later persistence fails. If the result is unknown,
it neither lists arbitrary threads and guesses by title, workspace, time, or
content nor calls `thread/start` again.

New ordinary Sedes-created threads request the exact native
`historyMode: "paginated"` storage contract. If the provider or store rejects
it, creation fails truthfully; Sedes does not retry without the field or fall
back to legacy storage. Imported and attached threads retain their persisted
mode. Native forks inherit the source thread's provider-owned mode.

## History and event projection

The history projector maps strict app-server items and live notifications into
normalized user, assistant, reasoning, tool, compaction, and status items.
Native thread, turn, and item IDs and rollout paths stay server-side. One
established history baseline plus live subscription feeds the actor's shared
projection.

The native `contextCompaction` item proves a compaction boundary but carries no
summary content. Codex therefore projects a normalized compaction item without
the optional summary; the browser shows a static marker rather than expandable
boilerplate.

Codex's explicitly ordered reasoning-summary parts remain separate from
detailed reasoning content in history and live updates. Summary activity may
send those parts without detailed reasoning or tool payloads.

Model-provider authentication recovery notifications are transient execution
status, not transcript mutations, durable history, account identity, or
app-server transport health. Sedes closed-validates their native thread and
turn attribution, consumes them only for the matching conversation, and emits
bounded normalized warning and success notices with Sedes-owned text. Native
provider identifiers and provider-authored recovery messages remain private to
the Codex backend. Pi, Claude, and Grok require no special disposition because
this reuses the existing backend-neutral runtime-notice contract rather than
adding a capability or browser protocol shape.

Sedes branches on the exact closed `historyMode` discriminator.

### Legacy history

Attachment obtains one complete native resume and retains that provider-private
thread as authoritative history. Sedes projects only the newest bounded
normalized window and serves older normalized pages locally from opaque native
turn-boundary cursors. Projection is whole-turn and byte-adaptive. A single
turn that cannot fit the normalized page contract fails only that read.

Legacy page reads never call native turn/item list routes or reread the
rollout. Cumulative conversation size is not an independent rejection budget;
shared carrier, per-field, per-turn, normalized snapshot, and page bounds still
apply.

### Paginated history

Attachment resumes with turns excluded and requests a bounded descending page
of `notLoaded` turn shells. Sedes hydrates each shell backwards from the exact
inclusive item cursor returned by that resume, restores normalized ascending
item order, retains only the current native/normalized window, and keeps
provider cursors in an authenticated provider-private cursor. Matching
post-resume transcript notifications enter a count- and byte-bounded catch-up
journal while hydration runs. Sedes installs the cursor-bounded snapshot,
replays that journal through the ordinary live reducer in inbound order, and
then switches to direct live delivery. Active output therefore does not require
or wait for a quiet interval. Older pages use `thread/turns/list` plus exact
per-turn hydration as request-local work and release each page after projection.

Repeated cursors, wrong-turn items, malformed shells, catch-up overflow or
sequence contradiction, undecodable catch-up input, generation changes, and
history-mode changes fail closed. Sedes publishes no partial page and does not
fall back to a full compatibility read. A detached active paginated thread is
retryable instead of silently omitting its in-memory active turn. Ordinary
detached `notLoaded` metadata resolves from the bounded durable head;
`systemError` remains unavailable. During attached active resume, a one-row
durable-head check distinguishes a persisted active turn from an in-memory
overlay. Sedes hydrates the former and retries the latter until an authoritative
item source exists.

Codex can retain abandoned durable turn shells with native `inProgress` status.
Sedes does not rewrite the provider store or reject an otherwise readable
paginated transcript. At projection time it preserves only the newest
`inProgress` shell when thread metadata is active and projects every older one
as interrupted. Idle and `notLoaded` metadata project every historical
`inProgress` shell as interrupted. Older pages and terminal head refreshes use
the same rule, so an abandoned shell cannot manufacture an active run or a
Stop/Steer target.

Authenticated boundary-only turns are discarded as each native page is
inspected. A request-local deadline bounds a long hidden-only seek without
retaining intervening pages.

Cold thread metadata reads, resume/retained-session attachment, and history RPCs
allow up to 60 seconds, including across SSH or outbound sidecars. Paginated
bootstrap, older-page acquisition, and detached-head loading each retain one
60-second aggregate deadline; a new page does not restart that deadline.
The outer thread-stream runtime acquisition allows 90 seconds for backend
setup and history loading. Caller cancellation still ends its wait and late
acquisitions are released. The best-effort current-head refresh keeps its
one-second deadline; routine controls, mutation receipts, catalogs, and
discovery keep their existing budgets.

### Targeted lookup and limits

Targeted turn lookup does not reuse older-page acquisition. Legacy scans the
retained native turns and projects only the match. Paginated scans descending
`thread/turns/list` shells under the caller's candidate bound, tests their
derived application identity without hydration, and calls filtered
`thread/items/list` only for the match. Exhausting the provider cursor proves
absence; reaching the candidate bound is a distinct result. Per-RPC deadlines,
cursor-cycle checks, cancellation, generation fencing, exact item filtering,
and whole-turn projection still apply.

One turn may contain at most 20,000 native and projected items, and the retained
normalized window at most 100,000 items. These limits admit long-running tool
and collaboration turns. The 16 MiB backend page and 32 MiB normalized
snapshot/page limits remain the effective content ceilings.

Fork checkpoints and reconciliation use mode-specific provider evidence.
Legacy acquires one complete native thread and scans targeted identities.
Paginated uses bounded turn shells and exact item filters and never requests a
full compatibility history. Exact paginated reconciliation follows the finite
provider cursor chain with caller cancellation and one deadline per RPC, not
one transcript-age deadline for the full scan. Each hydrated turn is inspected
and released before the next.

## Asynchronous question items

Codex 0.153 can attach structured, nonblocking follow-up questions to an
`agentMessage`. The C1 codec validates the native producer contract before
projection: `questions: null` means an ordinary assistant message; a non-null
value requires `delivery: "async"`, at least one question, an exact closed
`{ title, options }` question shape, a nonblank title, and either `null` or a
nonempty list of nonblank options. A missing field, extra key, empty value, or
questions attached to another delivery mode fails closed at the native item
boundary and follows the existing history/live recovery path. Native fields
and delivery metadata never enter the normalized item contract.

A valid native item always retains its ordinary bounded assistant text. When
the structured value also fits the normalized `nonblockingQuestions` payload,
the projector attaches that typed assistant-item facet. It admits at most eight
questions and eight options per question, with 4 KiB UTF-8 titles, 2 KiB UTF-8
options, and a 48 KiB total payload. A valid native value exceeding these bounds
omits the entire facet while preserving bounded assistant text. Questions and
options are never truncated or synthesized.

History and live input share the same projector and stable normalized item
identity. New live items open durable, principal-owned question requests, one
request per emitted batch. History hydration does not manufacture pending
requests or notifications. The source identity remains after resolution so
replay cannot reopen a sent or dismissed batch. Open requests survive later
ordinary messages, turn completion, browser reload, and server restart.

A pending-only notice and Questions tab beside Prompts open the same panel above
the composer. It presents requests oldest first with previous/next navigation;
it does not dim or block the conversation. Preset choices immediately send that
question's answer. **Other…** reveals custom input; a question without presets
uses **Write an answer…**. Answering part of a batch removes only the answered
questions, retaining stable original indices for the rest. Request revisions
protect concurrent answers and dismissals. Finishing or dismissing a request
advances to the next; resolving the last closes the panel and removes both
entry points. Navigation preserves unfinished local answers.

Sedes validates answer indices against the durable pending request and builds
ordinary user text from the authoritative question titles, using an explicit
`User responded to a question:` prefix and `Question:` / `Answer:` labels.
Admission, response provenance, and partial resolution share a transaction.
Retries cannot enqueue the same answer twice. The composer draft is untouched.
The shared delivery gateway resolves a supported active steer target, an idle
submission, or queued admission while preserving earlier input ordering. The
browser displays an immediate Sending row, then reconciles the admission
receipt with queue and transcript events using the delivery operation identity.
Confirmed delivery status remains visible until the transcript supplies the
matching message; the browser does not infer a steer from merely clicking Send.
**Dismiss** silently clears the request's remaining questions.

The application stores a typed `question_response` origin with the answered
question/answer pairs and source identity. The existing authenticated delivery
operation links that immutable metadata to provider history, allowing a compact
**Question answered** transcript disclosure after reload. Metadata lives in
Sedes, not in a new provider-native field; a fresh import without the Sedes
records retains the ordinary text but cannot reconstruct the special styling.

Neither action calls a provider answer API, enters the blocking interaction
broker, holds a turn open, or sets `waiting_for_input`. Native
`item/tool/requestUserInput` remains the separate blocking questionnaire path.
New committed requests can emit the opt-in `question.requested` notification
without exposing question or answer text. Partial answers and dismissals do not
emit another notification.

Codex advertises `nonblockingQuestions: true`. Pi, Claude, and Grok explicitly
advertise false and never infer questions from prose or map existing blocking
interactions to this facet. The former `codex.async_questions` provider feature
is removed; pending questions use the shared application workflow.

## Delivery and interaction routing

Codex projects the common immutable delivery snapshot into native user input.
Ordinary files use the authenticated staged-path manifest. Images use
`localImage` only when the selected model supports native image input, because
that item already contains the usable path. Otherwise images remain in the
staged-path manifest so a text-only model still receives a file path.

An operation-scoped client identity maps native user messages and steering to
the shared `deliveryOperationId`. Sedes restores original text, context, Tasks,
and attachment cards from that snapshot. Exact persisted
`userMessage.clientId` evidence can prove acceptance, prove absence only after
a stable terminal scan, or preserve uncertainty. It never falls back to fuzzy
text/time matching. Interrupt, rename, and action reconciliation use
metadata/current-head evidence instead of rebuilding a normalized transcript.

Sedes durably admits multiple exact-target Steer intents and invokes
`turn/steer` serially. Codex exposes no normalized operation to retract a Steer
after that provider boundary. If the exact reviewed invalid-request response
proves that no active target remains or the expected turn changed before
acceptance, the adapter classifies that rejection so Sedes can preserve it as
ordinary next-turn queue work. Every other rejection and uncertain outcome
fails closed.

Server requests route only to the active owner of the matching native thread
and client generation. Command, file-change, and permission approvals become
normalized decisions. `item/tool/requestUserInput` becomes a normalized
questionnaire with private positional option mapping. Provider request IDs and
answer encoding never enter the browser contract. See
[Blocking interactions](../blocking-interactions.md).

## Generated image artifacts

The 0.153.0 protocol defines a closed `imageGeneration` item with native
status, revised prompt, transparent-background flag, in-band `result`, and
`savedPath`. For a completed item, Sedes accepts only canonical padded base64
that decodes to at most 16 MiB and passes shared PNG header and dimension
checks. It hashes and stores immutable bytes through the common
tenant/principal/thread-scoped `OutputArtifactService` and projects only a
normalized descriptor. Native base64, `savedPath`, and storage paths never
enter normalized history, browser events, diagnostics, or logs.

The in-band `result` is the reviewed byte authority. Sedes does not read
`savedPath`; generated images do not depend on Files, attachment staging, or a
server-local interpretation of a provider path. This also applies over SSH
UDS: the result crosses the existing carrier and the sidecar contributes no
output-artifact operation. A future path-only output needs a separately
reviewed sidecar adapter; none exists.

Live updates and later history use the same native item identity to resolve one
immutable artifact. The browser fetches bytes through the common scoped route
and uses the shared expandable safe-raster preview. In-progress, failed,
missing, malformed, oversized, or non-PNG results remain unavailable without
exposing rejected values. This adds no generation control, dedicated download
action, or durable promotion for ordinary tool-result images. See
[Provider output artifacts](../output-artifacts.md).

## Execution settings and feature persistence

The target defines safe defaults; the thread stores desired model, reasoning,
service tier, sandbox, network, approval policy, and reviewer. Observed
effective settings become durable authority only through declared adoption
rules. Unproven desired settings are not presented as provider-effective. Fork
eligibility requires a complete allowed tuple for the child. See
[Codex execution settings](../codex-thread-execution-settings.md).

Fast mode is the closed service-tier feature. Codex 0.153 catalog metadata may
also advertise the distinct native `ultrafast` tier; Sedes validates that
reviewed identifier but does not expose or map it to Fast. Goal stores one
bounded objective and projects provider-observed lifecycle status. Create,
pause, resume, and clear are capability- and revision-checked. Neither feature
is inferred from model names or provider text.

The thread menu's **New** action snapshots all seven desired axes—model,
reasoning effort, service tier, sandbox, network, approval policy, and
reviewer—plus the exact Sedes tool policy. It revision-fences and revalidates
that snapshot before creating an independent empty draft. Provider history,
Goal, TUI state, and runtime generation do not transfer.

## Forks and recovery

An explicit completed normalized turn resolves to a native historical boundary
and calls non-ephemeral `thread/fork` with `excludeTurns: true`. The native fork
is atomic copy authority. Sedes validates returned child metadata and exact
history mode without requesting or comparing a full child transcript. A
selected completed turn may be forked while later source work is active.

The generic thread **Fork** action uses the distinct
`latest_provider_snapshot` capability. Sedes omits both native turn-boundary
fields, so `thread/fork` captures the latest provider-persisted history at RPC
acceptance. An active copied leaf becomes interrupted in the child while the
source continues. The source may settle before native acceptance, and
unpersisted streaming token deltas are excluded. Durable lineage records
`provider_snapshot_at_acceptance` with no asserted application `sourceTurnId`.

Transcript **Fork from here**, provider `latest_completed`, and the canonical
agent `thread.fork` tool remain completed-turn operations and send an exact
native boundary where applicable.

The native fork RPC has a 60-second timeout; routine controls and discovery
keep their shorter timeout. Agent-tool forks allow 90 seconds for the whole
application operation, including checkpoint reads and post-fork work. A sent
request that times out is not retried because a native child may exist. Opt-in
`SEDES_DEBUG_DELIVERY` diagnostics report method, elapsed time, and outcome
without changing recovery.

For an exact completed-turn fork, later exhaustive discovery may adopt one
child only from authenticated operation, parent, and source-turn evidence. A
`latest_provider_snapshot` has no exact source-turn anchor, so an unknown sent
outcome is not adoptable. Discovery retains authenticated operation evidence
to quarantine a possible correlated child instead of importing it as an
unrelated thread; Sedes neither binds it nor repeats the fork.

Sedes does not call `thread/inject_items` or add any model-visible item after
`thread/fork`. Native child identity, ancestry, and authenticated creation
correlation stay private. A known child is retained for exact recovery; an
unknown provider-snapshot result is never reconstructed by listing or repeated
automatically. Historical authenticated hook-prompt boundary carriers from
older Sedes releases remain hidden during projection but are never written.

See [Native fork lineage](../native-fork-lineage.md) for the normalized lineage
contract.

## Agent-tool integration

Codex has no Native Sedes-tool surface. Eligible Sedes-created local threads on
owned stdio or external local UDS/TCP receive the generated CLI through the
local HTTP endpoint in Progressive or Individual mode. Progressive uses the
bounded catalog/describe/invoke flow; Individual uses live help and named typed
commands. SSH UDS uses an owner-only Unix socket only when `agent_tools_cli` is
enabled and the managed sidecar is available.

Both routes expose one `SEDES_AGENT_TOOL_ENDPOINT`, one opaque encrypted
`SEDES_AGENT_TOOL_SOURCE_CAPABILITY`, the non-authoritative
`SEDES_AGENT_TOOL_CLI_MODE` presentation hint, and the built provider CLI
directory on `PATH`. The reference authenticates thread and ingress beneath the
server-derived tenant/principal and survives Sedes/provider runtime replacement
under the same installation key. It never enters the shared daemon environment.
Current workspace, environment, backend, inventory, policy, and exact active
Codex turn are re-resolved for every invocation. Runtime teardown aborts
outstanding use without revoking the serialized reference.

Imported threads, network-disabled settings, a missing built CLI, unavailable
sidecar/capability, or unprovable isolation receive no injection. Network
access remains required for SSH CLI admission even though the endpoint is a
Unix socket. Codex shell policy removes ambient principal Tool client tokens
and mode hints before installing server-resolved values. Every request reloads
current grants; the mode hint grants nothing. Failure does not fall back to
another mode or a Native surface. Saved Agents can copy the complete
execution tuple and Sedes tool policy into a new thread. See
[Agent tools](../agent-tools.md).

Sedes-owned Codex MCP management is not implemented. Principal Tool clients
use only generic management HTTP routes; they are not injected into Codex or
accepted by the SSH sidecar. An admitted client may invoke currently eligible
Codex-backed operations with exact client provenance on creation, queue/send,
and fork records. Destination work uses that thread's own Codex execution and
Sedes tool policies.

## Managed TUI integration

Managed TUI is eligible only when an external local UDS/TCP target provides the
required executable, endpoint, PTY, and execution-policy capabilities and the
backend model policy is `catalog`. Sedes disables it for allowlist and denylist
policies because the interactive client can select and invoke a model without
a pre-turn authorization hook.

Before every catalog-policy launch, Sedes rechecks the exact model and effort
against an uncached live daemon catalog. The TUI resumes the selected native
thread and uses one viewer/control lifecycle shared with the browser panel. It
is unavailable for owned stdio and SSH. See
[Managed Codex TUI](../codex-managed-tui.md).

## Contributor verification

Backend changes must follow the
[backend integration rules](../backend-integration-contract-rules.md), advance
the generated protocol baseline deliberately when required, and keep provider
protocols private. Use the generated-protocol checks above for protocol changes
and the repository's standard verification sequence for all backend-facing
work.

Live-provider suites consume authenticated provider capacity and are not part
of ordinary verification. The authorization and topology-specific guidance is
in [Opt-in live verification](../../operator/backends/codex.md#opt-in-live-verification).

Return to the [Codex operator guide](../../operator/backends/codex.md).
