# Pi backend internals

This document defines provider-private runtime ownership, persistence,
projection, recovery, isolation, and mutation invariants for the embedded Pi
backend. It is contributor documentation, not an operator setup guide.

For prerequisites, configuration, supported topologies, capabilities, and
troubleshooting, see the [Pi operator guide](../../operator/backends/pi.md).
Cross-cutting changes must also follow the
[backend integration rules](../backend-integration-contract-rules.md).

## On this page

- [Runtime and native-store ownership](#runtime-and-native-store-ownership)
- [Model catalog and policy projection](#model-catalog-and-policy-projection)
- [Workspace execution boundaries](#workspace-execution-boundaries)
- [Actor, history, and event projection](#actor-history-and-event-projection)
- [Persistence and recovery](#persistence-and-recovery)
- [Steer and fork invariants](#steer-and-fork-invariants)
- [Tool and agent-tool internals](#tool-and-agent-tool-internals)
- [Verification and change contract](#verification-and-change-contract)

## Runtime and native-store ownership

All Pi SDK imports, native IDs, markers, event parsing, and history
interpretation stay under `src/server/backends/pi`. The browser and shared
protocol consume only normalized Sedes types.

The principal/backend runtime owns native discovery, connection preferences,
store locking, driver creation, binding details, persistence adapters, semantic
presentation, and native-action recovery. Pi remains authoritative for:

- authentication and providers;
- model, command, extension, and skill catalogs;
- agent instructions and settings;
- native tools and tool execution; and
- native JSONL session history.

`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, and Pi `sessionDir`
retain their native meanings. For an SSH workspace, Sedes keeps its owned Pi
session beneath `APP_STATE_DIR`; it does not claim a remote Pi store. The
runtime holds the canonical writer lock while active. Another Pi process must
not operate the same native session concurrently.

Each active Sedes thread has one SDK session behind the shared conversation
actor boundary. Creating a draft reserves no Pi file. First send uses an
application-reserved native identity, creates and binds the Pi session, applies
the selected settings and first input, and retains exact recovery state when
persistence cannot be proven.

Only native sessions whose canonical workspace matches an explicitly
remembered project are eligible for discovery and import.

## Model catalog and policy projection

Sedes intersects Pi's live native catalog with the backend `modelPolicy`.
Matchers may constrain native `providerIds`, `modelIds`, and
`reasoningEfforts`. Values within one list are ORed, present dimensions are
ANDed, and omitted dimensions match any value. Catalog projection and provider
mutations use the same native provider/model/effort tuple, so equal model IDs
under different providers stay distinct.

`catalog` imposes no Sedes restriction. An allowlist admits only matching
selections. A denylist removes matching values while admitting future
unmatched catalog entries. Projection must neither fabricate
configured-but-missing entries nor substitute a different tuple.

The enabled backend declaration, dependency, lockfile, and integration profile
must share the exact Pi release. Version mismatch is rejected before runtime
startup or persisted-state reconciliation.

Native global `cacheWarming` is service-account policy. Executor-backed
sessions preserve it in their in-memory settings projection; project settings
cannot override it. Pi's default is `streaming`, with `off` and explicit
`idle` modes also supported. This is Pi-private configuration: Codex, Claude,
and Grok do not implement this Pi setting and retain their native policies.
There is no new shared capability, browser control, or persisted Sedes field.

## Workspace execution boundaries

### Local Bubblewrap isolation

Direct local Pi targets support Linux x64 and macOS arm64/x64. Bubblewrap
isolation is available only on Linux and has no unsandboxed fallback on macOS.

When supported, a thread can select either a writable private Git clone or a
read-only mount of the source project. Both modes receive a durable private
writable home, start in `/home/agent`, and expose the project at `~/workspace`.
Relative Bash and structured file-tool paths resolve from home; absolute
sandbox paths remain available. Project context discovery stays rooted at
`~/workspace`, and every admitted Pi workspace-tool or context read routes
through the sandbox worker.

A writable clone never mounts the source. A read-only allocation mounts
exactly the server-authorized source, while permitting writes elsewhere in the
private home and ephemeral `/tmp`; the kernel rejects writes beneath
`~/workspace`. The mount is a live view, not a snapshot. Git branch import and
outside handoff apply only to writable clones. Deleting a read-only allocation
removes only its private home, never the source project.

The thread lifecycle controls preservation and exact-scope deletion of the
allocation. A failed runtime or now-disallowed network profile always fails
closed. Provider discovery, model calls, credentials, session persistence, and
native history remain in the Sedes process: Bubblewrap contains workspace
operations, not the provider runtime. Isolated workspaces cannot be forked.

The isolated session still honors the thread's ordinary enabled Sedes agent
tool IDs and Native Progressive/Individual presentation. Those host-owned
application operations execute through Sedes's scoped facade and authenticated
source identity; they do not create a filesystem or shell escape. The Sedes
agent-tool CLI is unavailable, and Pi's seven workspace builtins remain
executor-backed.

The complete allocation, namespace, lifecycle, and handoff contract is in
[Pi workspace sandbox](../pi-workspace-sandbox.md).

### Managed SSH sidecar

The model API, SDK, credentials, approvals, session, and transcript remain on
the Sedes host. Only Pi's seven built-in read/write/edit/list/find/grep/bash
workspace operations execute remotely. The bounded instruction hierarchy is
loaded as data for that exact workspace; `AGENTS.override.md` replaces the
same directory's ordinary `AGENTS.md`/`CLAUDE.md` candidate without removing
instructions inherited from ancestor directories.

A Pi-only SSH environment is deliberately unvalidated at startup. Its first
sidecar-backed browse, Files, context, skill-catalog, attachment, CLI, or
workspace-tool operation completes the protocol handshake and marks the
environment available. A skill catalog starts it only when `workspace_skills`
is enabled; otherwise passive catalog and history reads do not. Failure never
falls back to local execution.

Remote extensions, settings, provider credentials, custom tools, and Pi
binaries are not loaded from the SSH account. Optional `workspace_skills@1`
discovers metadata in four fixed Agent Skills roots and resolves the selected
`SKILL.md` body against the same catalog fingerprint. The host-local adapter
constructs Pi 0.86.0's exact private `<skill>` envelope and disables SDK prompt
expansion so no remote path is read on the Sedes host. Remote Bash has the SSH
account's authority and does not receive the Sedes CLI. The protocol and
fail-closed rules are specified in
[Remote Pi workspace tools](../pi-remote-workspace-tools.md).

## Actor, history, and event projection

The SDK session wraps Pi's public agent stream function so a native error
received after its request signal is aborted becomes an `aborted` response
before agent events and transcript persistence. This preserves interruption
in both live and restored projections. The wrapper captures the signal when
the native result resolves, preserves genuine failures and successful results,
and does not infer cancellation from error text. This adapter is Pi-private;
Codex, Claude, and Grok retain their own cancellation protocols.

The backend reads one complete active-branch suffix and subscribes to SDK
events without exposing native entries to the browser. Streaming assistant
text, reasoning, tool arguments, execution updates, results, interruption, and
persisted history reconcile into normalized semantic items.

A tool Stop aborted keeps `failed`. Pi records it as an ordinary error
result ("Operation aborted", or the tool's own thrown message) with no abort
flag, and a sibling that failed on its own in the same batch looks the same,
so only text would tell them apart. A call with no result when the run ends is
`interrupted`, as before.

Compaction or a persisted branch/window change can replace the projection with
a fresh generation. Abandoned Pi branches are never flattened into one
transcript.

Pi 0.86.0 persists system prompt sections and tool declarations as system
messages, with a complete `systemMessage` checkpoint on compaction. These
remain provider-private native history and never become browser messages.
Resume and fork preserve the historical entries; the next request applies
current environment instructions and admitted tools as transcript updates.

Native `usage` entries supply durable accounting evidence without creating
assistant messages. Their `entry_appended` notifications capture normalized
facts on main, including while idle, without changing run state or projecting
transcript content. Request counts use only native records that establish
cardinality; unproven extension overlap remains unallocated. Live usage events
retain context occupancy and transcript counters, not accumulated token/cost
authority. See [usage accounting](../usage-accounting.md).

Completed-turn throughput is a separate, volatile performance measurement.
Pi advertises `turnThroughput: "supported"` independently of usage accounting.
The SDK facade wraps the cancellation-normalized `agent.streamFunction`, taking
a monotonic start before invocation and an end when its terminal result arrives.
It snapshots output tokens and duration against the exact result object before
extension handlers can mutate that object. The driver consumes each measurement
once at ordinary assistant `message_end` and attributes it to the active Sedes
turn. Native message timestamps and presentation-item timing are not substitutes
for request timing.

The numerator is main-agent output, already inclusive of reasoning. The
denominator sums those same requests' durations, including provider startup,
network latency, and retries internal to the provider stream. Tools, approval
waits, compaction, summaries, cache warming, subagents, and gaps between requests
are excluded. Any emitted error response suppresses the entire turn's rate,
even if SDK retry or context-overflow recovery later succeeds. Interrupted,
missing, or invalid response measurements also suppress the rate. Zero output
with nonempty response content is invalid; a genuinely empty zero-output response
can contribute request time to an otherwise positive aggregate. Only completed
turns with a positive valid aggregate carry normalized
`{ outputTokens, requestDurationMs }`.

The thread handle retains at most 100 completed measurements in memory and
decorates live turns, replacement snapshots, history pages, and targeted turn
reads while resident. Projection refreshes preserve the measurements; handle
closure clears them. Nothing is appended to Pi history or stored in Sedes's
database, and a new runtime never reconstructs timing from old messages. Browser
full/summary views and reconnect checkpoints carry the same optional metadata.

Pi 0.86.0 can compact automatically after a tool result and then resume the
same provider run. Sedes therefore keeps the current live projection open
until `agent_settled`, then requests exactly one replacement generation that
contains both the persisted compaction and the run's later output. If prompt
preflight rejects after an idle automatic compaction, the replacement is
requested immediately because no settlement event will follow. A failed
non-manual compaction emits a bounded warning and leaves the persisted
projection unchanged.

Pi's persisted compaction entry carries the genuine provider-authored summary.
Sedes retains that bounded text on the normalized compaction item, so the
browser marker is expandable. It does not substitute compact instructions or a
locally generated status sentence for that summary.

Trusted built-in tool presentation is authenticated with installation-owned,
conversation/call-bound markers. Missing, copied, malformed, or tampered
markers reopen as bounded generic tools with diagnostics. Provider text cannot
promote itself to a trusted command, file-read, file-change, or image card.

Live assistant blocks take source order `base + 2 * contentIndex`, with a
stride of 2000 per assistant message and content indexes below 1000. The odd
position after each block is reserved for a child item added later; history
reserves the same position after each viewed image. A tool call seen only
through execution events takes its index from the ended assistant message.
History numbers items across the whole branch, so a seed taken during a
running turn advances the next live base past every item and reserved slot of
that turn. Source order never reaches the browser.

### Viewed images

A trusted built-in `read` (identity `pi:builtin:read`, including the
`<sdk:read>` override of SSH and isolated sessions) whose `path` argument ends
in `png`, `jpg`, `jpeg`, `gif`, `webp`, or `bmp`, case-insensitively, projects
as a standalone `viewed_image` item instead of a file-read card. It carries
only the path's final component as `fileName`. The decision uses the requested
path, not Pi's content sniffing: a text file named `*.png` shows as a viewed
image with no image, and an image with any other extension keeps its file-read
card. History requires the authenticated identity marker, so an unmarked read
stays a generic tool.

Pi streams tool arguments as partial JSON and an emitted item cannot change
kind, so the live item of every built-in read waits for `toolcall_end`. The
`tool_execution_start` fallback already has complete arguments, and a read
interrupted while its arguments stream decides from the partial path. The row
stays `streaming` until `tool_execution_end`. Success completes it; an error
fails it with the Sedes-written `pi_viewed_image_read_failed` message, because
native errors can contain absolute paths. A persisted read without a result is
`interrupted` with `pi_tool_result_missing`.

The image child is the first image part of the read's own result, which is the
exact in-band data Pi sent the model after its resizing and BMP-to-PNG
conversion. It is an `image` item with origin
`{ kind: "viewed", capture: "provider_input" }` at the reserved position; no
Files read or `ViewedImageCaptureService` is involved. There is no child for
an error, a text-only result (Pi could not process the image, or the file was
not one), a result carrying Pi's non-vision-model note, or bytes that are not
strict base64 of a supported, magic-matching image within 16 MiB. Pi's
`blockImages` setting strips images from provider requests without marking
the stored result, so Sedes cannot detect it and still shows the child. Images
from MCP servers, extensions, and other tools keep their bounded tool-result
metadata, and `providerOutputArtifacts.nativeImage` remains `false`.

The publication key is `pi-viewed-image:` followed by the SHA-256 of
`[sessionId, assistantEntryId, toolCallId, imageIndex]`, where `imageIndex` is
the image part's index in the result content. The tool-result entry ID does
not exist live, so it is not part of the key. Live observation, history,
pagination, and reattachment therefore resolve one artifact. A fork copies
entries into a new session and thread, so it gets its own key and artifact.

Only the conversation handle publishes. `PiHistoryProjector` stays pure,
because usage accounting, checkpoint resolution, and submission reconciliation
also construct it; it returns each completed image read that has a child as a
candidate with the child identity, reserved order, native coordinates, and the
tool-result entry and content index that locate the image part.

- At `tool_execution_end`, the handle resolves the assistant entry, publishes
  the in-band part, and adds the child.
- Every projection seed, from construction or `refreshProjection`, first adds
  the children that already exist by synchronous `findImage` for the newest
  ten turns, then selects its window. It publishes the window's missing
  children in the background, newest first, at most 32 per seed.
  This backfills forks and sessions from before image capture.
- A late child is delivered as `item_completed` only. The projections order it
  by its reserved source order; no turn update follows, because the handle's
  tracked turn update would reopen a completed turn.
- The handle maps each publication key to the current generation's child
  identity and replaces that map on every seed. A publication that finishes
  after a refresh adds the child under the new generation's identity, or
  nothing when the new window no longer contains it. Concurrent publications of
  one key share one attempt.
- `history()` and `locateTurn` wait for at most the four newest missing
  children of their page or turn, for at most two seconds in total, as Codex
  and Claude readers do. The rest, and any still running at the deadline,
  publish in the background, newest first and at most 32 per call; they show
  on the next fetch, or live when the live window contains them. An unattached
  `read` only looks artifacts up.
- Background publication runs serially, holds at most 256 queued
  publications per handle, and skips keys the handle knows failed.
- A candidate exists only for non-empty data of a supported output media type.
  Each handle remembers up to 4096 keys whose publication failed and does not
  retry them; a new attachment does.
- No publication starts once the handle is closed. `close()` waits for those
  already started, which deliver nothing, before it disposes the session. A
  page or turn lookup still waiting fails with `pi_handle_closed`.
- A seed taken during a running turn can include image reads whose results
  Pi has not persisted yet; with parallel tools, Pi persists a batch's results
  together once all of them finish. History reports these rows, still
  `streaming`, and the handle completes each one as history would when its
  result persists, then publishes its child. At settlement any such row still
  waiting completes from a persisted result or is interrupted with
  `pi_tool_result_missing`, so no viewed row stays `streaming`. The image the
  earlier generation published live is not shown for an interrupted row.

Pi's window and page selection, including its 1000-item turn bound and byte
budget, measure turns without viewed-image children, so a child never changes
which turns are transferred or fails a transfer. Each child pairs with a
counted viewed item, so a turn carries at most 2000 items, well within the
shared 20000-item limit. Children return with their turns unless they would
push the payload past Pi's 4 MiB ceiling; the rows are then returned without
them.

Targeted turn lookup projects the retained authoritative branch once, scans
turn identities newest-first within the caller's candidate bound, and returns
only the matched whole turn without a cursor. It performs no normalized
older-page loop. Exhaustive absence and candidate-bound exhaustion remain
distinct outcomes.

## Persistence and recovery

Discovery uses one SDK metadata listing per scan. It reads child ancestry,
groups authenticated checkpoint references by canonical parent file, and opens
each referenced parent once more to resolve those checkpoints. Only compact
references and per-parent results are retained during the scan; no transcript
cache or SQL mirror is added. Parent-ID ambiguity, authenticated markers,
context boundaries, and current-branch completed-turn evidence remain required
for exact fork recovery. Native parent-only relationships remain discoverable.
Continuation pages reuse the existing bounded discovery snapshot.

Fork checkpoint selection reuses its validated session open and checks that
the canonical file remains regular and nonempty, without a second inventory
scan. Ordinary cold attachment still uses the existing full-store identity
lookup. These optimizations are Pi-private; Codex, Claude, and Grok keep their
existing discovery, history, and checkpoint implementations.

Pi writes authenticated started/completed markers for submissions, managed
interaction responses, forks, and other recoverable native actions. Fresh
history can therefore prove exact acceptance, prove that some reserved actions
were not applied, or preserve uncertainty.

Recovery must not correlate by fuzzy text or timestamps, and an unrelated
later turn must not clear an earlier receipt. A locally forced reset abandons
only Sedes blockers; it neither edits nor stops the native Pi session.

First-send binding and every recoverable mutation retain their reserved native
identity until the actor can establish a terminal outcome. On restart, the
runtime reconciles the durable application receipt against authenticated native
evidence before allowing a conflicting retry.

## Steer and fork invariants

Sedes durably admits multiple exact-target Steer intents and invokes Pi
serially: it sends the next Steer once Pi has accepted the previous one,
without waiting for that one to materialize. Each conversation handle holds an
ordered set of the Steers Pi accepted but has not yet materialized, keyed by
application operation. Pi queues each accepted Steer and persists one user
entry per queued Steer, in queue order, in either of its steering modes.
Authenticated submission markers therefore correlate Pi's user entries to the
pending Steers FIFO. A Steer intent waits behind the Steers already pending
for the same turn. A Submit intent, which cannot occur while Steers are pending
through the application, still displaces every earlier pending input, which
then reconciles `not_accepted` with retry permission. Pi exposes no normalized
operation for retracting one selected Steer after it crosses the provider
boundary. Stop and runtime retirement are generation-wide: they clear Pi's
volatile Steer and follow-up queues before aborting, without modifying Sedes's
durable next-turn queue.

Authenticated submission markers record each Steer as `intent`, `enqueued`
once Pi accepts it, and then either its materialized user entry or its own
`lost` marker, which closes that input alone. Settlement, retirement, and
restart reconciliation write `lost` for every accepted Steer whose run ended
without using it, and none for a Steer Pi already used. Pi drains queued
steering before a run ends on its own, so only an abort (Stop, retirement, or
an extension abort, each clearing the queue first) or loss of the Sedes
process leaves one unused. Stop may therefore keep the Steers Pi already used
with the stopped turn and return the rest as not sent. Pi can also accept
steering input without queueing it, when an extension input handler or command
consumes it. The SDK session reports whether Pi's steering queue grew during
admission, and the handle writes `lost` for such input at once, so it cannot
claim a later Steer's user entry.

Sedes's own Stop waits in the conversation actor behind an in-flight Steer, so
it withdraws only admitted input. If retirement or an extension abort ends the
targeted run while Pi is still admitting an input, the handle clears Pi's idle
queue and writes `lost` for that input and every earlier pending Steer, because
an idle Pi hands queued steering to its next run. If another run is already
active, the Steer fails closed as uncertain instead.

Reconciliation is per operation. It reports a materialized Steer accepted and
a `lost` one `not_accepted` without retry permission and with a not-sent
diagnostic, so the queue returns it to the user to restore or dismiss and never
resends it, as the backend-neutral
[Stop rule](../backend-integration-contract-rules.md#interactions-input-and-interruption)
requires. Absence of a user entry is never the evidence on its own: a Steer
stays unresolved while the live handle that admitted it is still admitting it,
or still holds it pending and its run has not settled. Other Steers pending in
the same generation never decide its outcome. A Steer from a gone generation
(the Sedes process restarted, or its handle closed without recording the loss)
that has neither a user entry nor a `lost` marker gets its own `lost` marker
when it is reconciled, so several such Steers reconcile individually, in any
order.

When Pi proves before that boundary that the exact target is no longer active,
the adapter returns normalized stale-target evidence and Sedes preserves the
same durable input as ordinary next-turn queue work. The handle rechecks the
target synchronously after preparing the input and before recording intent,
because Pi starts a new run from steering input once nothing is streaming; a
run that settles or a handle that closes during preparation therefore leaves
the input as Sedes's own work instead of starting a turn from it. A `rejected` marker, written when Pi refuses input before accepting it,
also reconciles `not_accepted` with retry permission. Every other rejection
and every uncertain or crossed-boundary outcome fails closed.

An explicitly selected completed turn can be forked while later source work is
active. Pi copies root-to-selected history into a separately reserved child
without switching or interrupting the source. The child preserves messages,
tools, results, compaction, attachments, and applicable settings, but reloads
current environment instructions for the next request. Historical system
entries remain intact; they do not freeze the child's effective instructions.
Creation is idempotently recoverable through the reserved child identity.

Pi cannot promise Codex-style atomic capture of an active provider-persisted
leaf and therefore does not advertise `latest_provider_snapshot`. The generic
thread **Fork** action resolves the newest completed Pi turn in the
authoritative snapshot and records the exact `completed_turn_inclusive`
boundary. Transcript and agent-tool exact-turn forks retain their own exact
semantics. All fork paths reject isolated workspaces.

## Tool and agent-tool internals

Sedes pins an explicit disposition for every Pi 0.86.0 built-in. `read`,
`grep`, `find`, and `ls` are supported read-only tools; `bash`, `write`, and
`edit` are supported mutators. Pi's optional `powershell` tool is intentionally
unsupported on the current Linux/macOS server platforms and is excluded at SDK
construction. Sedes does not pass a closed SDK `tools` list: that would also
hide project extensions, scoped custom tools, and newly introduced Pi
built-ins. Instead, it audits the source and synthetic path of every built-in
at construction and after reload. An unknown future built-in, malformed
built-in identity, untrusted SDK override, or residual host built-in in an
executor topology fences the session and fails closed.

Direct local built-ins must have Pi's `builtin` source and exact
`<builtin:name>` path. SSH and isolated workspace operations replace the same
seven names with exact, trusted `<sdk:name>` definitions. Ordinary local
extensions retain extension identity and availability; sharing a built-in name
does not turn an extension into a trusted built-in or grant read-only
authority.

Pi `ask` exposes the same eligible native catalog as `full`, while Sedes
intercepts built-in mutators and non-read-only Sedes agent tools through the
decision path. Provider admission and Sedes environment admission remain
independent. Each can deny or prompt without granting authority at the other
layer.

Per-thread Sedes agent tools are default-off. Presentation stores an exact
Native-or-CLI surface and Progressive-or-Individual mode. Native Progressive
installs a small catalog/read/action gateway set; Native Individual installs
every selected definition. Both freeze the effective native catalog for the
turn. Eligible local direct Pi can use CLI Progressive catalog discovery or
CLI Individual help and named typed commands through its existing Bash tool.
Its injected CLI mode is a presentation hint, while invocation still requires
the exact current active Pi turn and current grants. SSH and isolated targets
support only the two Native modes. Missing CLI or Native admission never falls
back to the other surface or mode. Saved Agents copy model, thinking, Pi tool
access, and one complete Sedes tool policy into a new thread. See
[Agent tools](../agent-tools.md).

Principal Tool clients are not a fourth Pi presentation mode. They call the
generic management HTTP tool routes directly and receive neither Pi's native
gateways, Bash environment, source-only `agent.context`, nor Pi tool-access
approval. Canonical create/send/fork operations record the exact initiating
client; destination model work still uses the destination thread's own
Pi/Sedes policy. Pi CLI spawn hygiene removes any ambient Tool client token
before installing the thread source reference.

The thread menu's **New with same settings** action captures the same
complete durable tuple from an available source thread, revision-fences it, and
revalidates it against the current Pi catalog and policy before creating an
independent empty draft.

## Verification and change contract

Any backend-facing change must audit every compiled backend and preserve the
shared rules for capabilities, normalized browser contracts, fail-closed
unsupported paths, persistence receipts, and native-data ownership. Update
[Backend integration rules](../backend-integration-contract-rules.md) when a
change adds a reusable invariant or audit surface.

For Pi changes, test the affected paths across:

- exact version/configuration admission and live catalog policy projection;
- first-send creation, binding, reload, lock ownership, and uncertain outcome
  recovery;
- bounded history, targeted lookup, compaction, event reconciliation, and
  trusted semantic-marker downgrade behavior;
- viewed-image classification, reserved child order, late child delivery
  through the shared projector without a resnapshot, refresh races, and
  backfill, with usage accounting never publishing;
- direct, isolated, and managed SSH execution, including unsupported and
  fail-closed paths;
- Steer FIFO materialization with several Steers pending at once, per-input
  `lost` evidence on Stop, retirement, and restart, stale-target conversion,
  and crossed-boundary uncertainty;
- selected-turn/latest-completed forks, recovery idempotence, and isolated
  rejection; and
- Native/CLI surface and Progressive/Individual mode combinations admitted by
  each topology, including independent environment authorization and explicit
  unsupported combinations.

Use the standard unit, typecheck, build, and E2E suites described in
[Development and testing](../../developer/development.md). Real-Pi tests are
opt-in because they consume authenticated provider capacity; follow the exact
gate in the [operator guide](../../operator/backends/pi.md#opt-in-live-verification)
and do not weaken its provider/model or read-only-tool preflight.
