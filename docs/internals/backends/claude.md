# Claude backend internals

This document defines the backend-private runtime, projection, authority, and
recovery invariants for Sedes's Claude integration. It is intended for backend
maintainers and reviewers. For installation, authentication, configuration,
operator-visible capabilities, and troubleshooting, use the
[Claude operator guide](../../operator/backends/claude.md).

## On this page

- [Runtime and session ownership](#runtime-and-session-ownership)
- [Authoritative history and paging](#authoritative-history-and-paging)
- [Semantic projection and terminal receipts](#semantic-projection-and-terminal-receipts)
- [Collaboration and authenticated evidence](#collaboration-and-authenticated-evidence)
- [Creation, binding, and model state](#creation-binding-and-model-state)
- [Permissions and blocking interactions](#permissions-and-blocking-interactions)
- [Inputs, images, and skill correlation](#inputs-images-and-skill-correlation)
- [Agent-tool presentation](#agent-tool-presentation)
- [Fork lineage](#fork-lineage)
- [Recovery and unsupported mutations](#recovery-and-unsupported-mutations)
- [Verification contract](#verification-contract)

The shared backend rules remain normative. Read this page together with
[Architecture](../architecture.md) and the repository's backend integration
[contract rules](../backend-integration-contract-rules.md).

## Runtime and session ownership

The exact-pinned `@anthropic-ai/claude-agent-sdk` 0.3.274 package runs in one
digest-verified local provider worker or a backend-private persistent runtime
hosted by the SSH or outbound sidecar. The Claude worker requires Node.js
24.18+ and POSIX process-group supervision; native Windows Claude is
intentionally unsupported. Windows sidecars omit the Claude runtime capability
while retaining independently admitted non-Claude operations. Runtime selection follows the admitted execution
environment; unavailable remote authority never launches a local worker. Disabled
historical definitions retain IDs and provider bindings until explicitly
enabled. One
principal/backend runtime owns the SDK queries admitted by the shared Sedes
conversation-runtime budget for that execution environment. A live Sedes thread
has at most one warm query.
Closing a handle does not delete its Claude session, and attaching the same
native session twice is denied independently. After a query closes or fails,
the worker keeps its native session reserved until every Claude process the
query launched is proven gone. Closing returns only then, and a reopen waits, so
two Claude processes never write one transcript. Unproven cleanup keeps the
session reserved and fences the worker generation. The worker's fixed maximum
of 32 simultaneous queries is a last-resort execution-environment safety guard,
not a backend configuration surface.

The persistent service owns remote queries and their bounded retained events;
SSH stdio or an outbound connection carries the current main-side attachment. Detach does not interrupt
the provider query. Reattach binds the exact runtime, session, and controller
epoch, replays retained events, and restores the live stream. Native provider
history remains authoritative after a service restart; retained transport
events are recovery evidence, not an alternative transcript store.

A remote query stays resident only while it can be useful. Main evicts a
handle that fails or whose projection is invalidated, and the host retires that
query once its events are acknowledged and nothing is outstanding, so reopening
the thread starts a fresh query instead of requiring a backend restart. The host
keeps the admission journal of up to 256 queries it retired after a failure, so
submission reconciliation still resolves their inputs. A query detached for 30
minutes with nothing outstanding (no admitted or running input, no Claude
activity or background work, no unacknowledged event, and no unanswered
permission) is retired and resumes on demand. A query that still holds such
retained work is never retired by eviction, this limit, or `retire`; it waits
for an attachment to apply and acknowledge that work. Archiving a thread whose runtime
is not loaded retires its query by session through the `retire` command, and
the archive is refused while that query still has outstanding work. The host
holds at most 32 sessions and fork launches together; an open beyond that is a
retryable overload whose message names the limit.

Connected replay is reclaimed incrementally instead of waiting for the entire
foreground turn to finish. Exact unacknowledged events stay in the delivery
journal. Fully acknowledged, completely framed streams can be replaced by their
matching complete native messages. Paced history reads then retire acknowledged
complete messages whose native identity and content match provider history.
Unfinished or ambiguous streams, uncovered messages, and unsettled control or
terminal evidence remain retained. Acknowledged transient progress notices are
discarded; replaceable state retains its current value.

Each retained event counts once toward a query's bound of 8,190 events and
64 MiB, although an unacknowledged message is both a journal and a replay
entry. While no main is attached, a plain streamed delta (text, thinking,
tool-input JSON, or signature) folds into the immediately preceding delta of
the same block if no main was ever offered that frame, live or in an
attachment. Offered frames keep their exact sequences, because a main may have
applied one without acknowledging it yet. Frames that carry a consumption
stamp, time to first token, or any other field never fold. A long turn that
runs while main is away therefore retains a few merged deltas rather than one
frame per token.

The runtime inspection lists the retained sessions that still hold work, live
work first: a running turn (including one Claude started), a pending input or
permission, background activity, or unacknowledged events. A running fork
launch is not a session and never appears in it. Main maps each to
its bound thread and opens it within the runtime budget whenever it inspects
the runtime: within one 30-second maintenance pass of startup, after the
service's controller changes, and for each lifecycle preview. Retained output
is therefore applied and acknowledged without anyone opening the thread. The
same inspection counts running turns, background agents and commands, pending
permissions, and sessions with unacknowledged output for Stop, Restart, and
Upgrade previews.

Cleanup is independent of optional usage accounting. A failed accounting
capture still withholds its event ACK. Disconnect stops connected reclamation;
long outages or unavailable history can still exhaust the existing retention
limits. Cleanup does not change overflow into an implicit provider restart.
Existing attachment response arrays remain immutable while later sweeps remove
entries from the host's replay map. A replacement main loads native history,
then applies retained residual and live output without resending accepted input.

Discovery, metadata, resume, and model catalogs use the official SDK. Native
history is read by Sedes' own transcript reader, described under
[Authoritative history and paging](#authoritative-history-and-paging), in the
worker that holds the transcript. Sedes does not take a global Claude-home
writer lock, mirror native history into its database, or maintain a
persistent or reusable provider-history cache. Bounded transient snapshots
exist only while transferring one history acquisition. Provider-native IDs,
messages, and binding shapes stay inside this backend.

Both executable and config-directory overrides are optional canonical absolute
POSIX paths in the selected environment. Without an executable override, the
worker resolves the first `claude` on the execution account's `PATH` and retains
its canonical path. Provider-home precedence is explicit `configDirectory`,
then that account's `CLAUDE_CONFIG_DIR`, then `$HOME/.claude`. The worker resolves
and validates this authority on the execution host before opening the SDK.
The local worker uses the local service account's environment; the remote worker
uses the remote account's environment, without copying main-host defaults.
The SDK library is part of the verified worker artifact, independent of the
provider home. Provider login and ambient permission rules remain external
operator authority. Runtime admission,
subscription-only authentication, worker build/digest admission, and version
policy are defined in the
[operator guide](../../operator/backends/claude.md#version-compatibility).
Local worker semantics remain independent of remote sidecar lifecycle.

The worker protocol is provider-private. It carries SDK query control,
messages, session discovery, history, transcript presence, rename, and fork,
version and authentication evidence, cancellation, and reverse permission
requests. Shared transport owns framing, correlation, bounds, generation fencing, and cleanup; it does not own
Claude methods, identifiers, history meaning, or policy. An exact worker
protocol/build mismatch fails before SDK authority opens, with no compatibility
decoder or local fallback.

The worker starts each Claude CLI process as the leader of its own detached
process group and owns every descendant it can attribute. Claude Code runs each
Bash tool shell in its own session (pgid = sid = pid), outside the leader group,
so the worker records descendants from the process table (`/proc` on Linux,
`ps` on macOS) about once a second and immediately before every signal it sends,
while their ancestry is still visible. Stop signals go to the leader group,
every owned descendant group, and every recorded descendant; descendants stay
owned after their parent exits. Cleanup is proven only when all of them are gone,
and an unproven cleanup fences the worker generation. A descendant that starts
and is orphaned between two observations cannot be attributed. The SDK itself
escalates a query close from SIGTERM to SIGKILL only after 5 s, so a closing
leader can outlive its query for that long. If the inner worker dies, the outer
supervisor applies the same rules to every registered leader.

Sedes sets `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1` for every Claude launch
it makes: local and remote workers, the persistent host, and transient fork
sessions. The value is Sedes-owned, is set where Sedes builds the SDK options,
and overrides an inherited value; it is not part of the admitted per-query
environment. Claude then emits `session_state_changed` (`running`,
`requires_action`, `idle`), which it otherwise suppresses. For every
uuid-stamped input, Claude Code also emits a stream-json `command_lifecycle`
frame: `queued` on admission, `started` when a turn dequeues the input or folds
it into the running turn (before any model request), then `completed`,
`cancelled`, or `discarded`. The pinned SDK forwards this frame verbatim
without typing it; Sedes validates its exact shape and ignores anything else.
Sedes does not pass `--replay-user-messages`. Its echoes arrive only with a
turn's first model output, no earlier than the `user_message_uuid` stamp, and
it does not echo task-notification rows. The fixture suite
`tests/real-claude/claude-run-state-native.test.ts` pins these frames on Claude
Code 2.1.281 through 2.1.283.

A send applies model, permission mode, and effort only for an axis that the live
query generation has not already applied and confirmed. Contrary evidence
(a model fallback, a `status` permission mode, or a failed setter) or a new
query generation reapplies it. Main applies persistent-runtime events strictly
in order, but does not wait for each acknowledgement round trip. At most 16
acknowledgements per client are in flight. They name exact sequences, and
`flushMessages` still waits for them.

Worker permission delivery uses an application-level round trip: after the
worker receives a `can_use_tool` result, it acknowledges the exact query,
request, and tool-use identity before releasing that result to the Claude SDK.
An `adopted: true` acknowledgement commits the exact pending interaction.
When caller cancellation makes the worker generate its own fallback deny,
`adopted: false` instead fails and removes any matching pending settlement.
It is a benign no-op when no expectation exists, as is the positive
acknowledgement for a static no-session deny. A successful write into the worker
stream is not delivery proof; malformed positive acknowledgements or settlement
failure fence the worker generation.

The native namespace key binds the execution-environment ID and the configured
provider-home selector: the explicit directory, or a stable native-default
marker when omitted. Preparation does not resolve a remote filesystem path.
The default marker identifies that environment's execution-account defaults;
the worker resolves the effective home there before SDK use. It never derives
a remote namespace from main-host environment variables. Multiple enabled
Claude backends in one environment must all select explicit directories;
native-default runtime admission also excludes retained sibling workers until
their cleanup completes. This prevents an unresolved default from aliasing an
explicit store. Local worker carrier loss retires that worker
generation, rejects pending permission requests, and fails active handles
closed. A replacement local generation reconstructs from Claude's authoritative
store rather than replaying uncertain writes. Persistent remote workers retain
the separate service-owned lifetime and reattachment contract described above.

## Authoritative history and paging

On attach, Claude first arms the resumed SDK stream, then acquires a complete
provider-history baseline. It merges any live messages or
retractions observed during that acquisition. The handle retains the resulting
provider-private value for its lifetime. Reading after start keeps a reattached
remote query's held replay behind the baseline; the read resolves through the
startup message that the launch has just persisted.

Every launch sends Sedes' empty `shouldQuery: false` startup message, which
Claude Code persists as a meta user row at the transcript tip. From 2.1.280 the
row is `queueTranscriptOnly` and never reaches the model; earlier releases
merged its "NON-USER SOURCE" label into the next prompt, one reason the
runtime minimum is 2.1.281. The pinned SDK's
`getSessionMessages` picks the file-latest childless row that is not meta.
Parallel tool calls leave childless sibling tool results, so a transcript
ending in a startup message read back only to its last parallel tool call:
forks failed verification, and reconciliation compared against a truncated
chain. Sedes therefore reads native history with its own reader. Claude Code
appends each row of the active conversation as a child of the row it last
wrote. Rewind and edit start a new branch from an earlier row and leave the
abandoned branch in the file. The active tip is therefore the last
main-conversation user or assistant row in file order: not a sidechain or
team row, but possibly the startup message or a `<synthetic>` assistant row.
The reader walks `parentUuid` from that tip. Claude Code's `last-prompt` leaf
pointer is not used; it can omit a trailing meta row or name a system notice
attached to an old row.

Apart from the tip and compaction, the reader reproduces the SDK's projection
exactly. That covers preserved-segment relinking at compact boundaries,
re-insertion of off-chain assistant fragments and their parallel tool results,
and conversion of answered human queued commands. It also covers meta,
sidechain, and team filtering, `includeSystemMessages`, task-notification
origin reduction, the `is_meta` flag, and offset/limit slicing. Unparseable
lines, including a final line still being written, are skipped as the SDK skips
them. Unlike the SDK, an existing transcript that cannot be read fails the read
instead of reading as empty.

The reader searches only the workspace's own native project directory: the
sanitized canonical path, length-hashed like Claude Code's, or
`CLAUDE_CODE_PROJECT_DIR_NAME` under an explicit `CLAUDE_CONFIG_DIR`. It skips
the SDK's sibling-worktree and legacy hash-prefix fallbacks, because Sedes
rejects a session recorded for another workspace.

A compact boundary has a null `parentUuid`. The SDK, like Claude Code's own
loader, stops there, and Claude Code also drops the earlier rows when it
resumes. What remains is exactly the model's context: the summary, the rows
the compaction preserved (relinked after the summary), and later rows. The
reader returns that segment unchanged, so the SDK's read is always the suffix
of Sedes' read, and prepends the history each compaction summarized. Each
earlier segment continues from the last main-conversation row written before
its boundary, using Claude Code's written parents wherever a relinked parent
points into a newer segment. A row that a compaction preserved therefore
appears once, after that compaction's summary. If the summary is the newest
row, the read continues through the rows relinked after it, as the SDK's leaf
does. Earlier turns keep their identities, so a compaction never re-identifies
them. A native link missing from the transcript still ends the read, as it does
in the SDK. Boundary rows appear only with `includeSystemMessages`. The summary
row keeps the SDK's `isCompactSummary` marker, which the worker protocol
carries under sidecar wire 14.

Native history transfer uses byte-bounded pages from one captured native read.
A private random acquisition ID binds continuation offsets to that snapshot,
session, and read options. Provider appends, compaction, replacement, and
truncation after capture cannot splice different histories into one acquisition;
a subsequent acquisition reads the current canonical history. This is transfer
consistency, not an atomic history/live-stream cursor.

Each worker retains at most 32 transient acquisitions sharing a 256 MiB budget
of serialized-equivalent rows. A single acquisition is also limited to 262,144
messages. Each owns detached projected rows plus byte sizes; it does not retain
a second encoded copy or reread and reproject the full SDK history for every
page. The reader still materializes the whole transcript before these limits
apply, so neither the wire bound nor the retained-row bound caps transcript read memory,
concurrent incoming materialization, or JavaScript heap size. The stopped host
applies the same transfer lifetime to its captured shutdown baseline.

Pages target 4 MiB and at most 8,192 messages; an individual message may occupy
a page up to the existing 32 MiB encoded response ceiling. Oversized records
fail explicitly. Completion, page failure, or owner disposal releases the
snapshot. Snapshots expire after 120 seconds without a continuation; there is
no fixed total lifetime while valid pages advance. Least recently used snapshots
are evicted only when admitting an acquisition would exceed the shared count or
byte budget. Background replay maintenance uses a private acquisition flag
and skips with a retryable busy result whenever admission would evict an
existing snapshot. It cannot repeatedly expire a foreground reader; foreground
acquisitions retain the LRU policy. This flag is scoped to the acquisition and
is never forwarded to the SDK. Missing or expired acquisitions restart in full at most twice;
sustained capacity pressure can still fail an acquisition explicitly.

Native reads proceed independently, with at most 32 in flight. A caller stops
waiting after 30 seconds or owner disposal, and late completion cannot install
a snapshot. Native history reads have no cancellation: a timed-out read continues
to occupy its native-read reservation until it actually settles. Exhausting all
32 reservations returns a retryable busy error; a single slow reader does not
block unrelated acquisition or foreground reads. Maintenance iterates validated
pages without collecting full history, and captured snapshots are never reused
for a new acquisition.
The private page response replaces the old whole-history response under sidecar
wire 12; there is no dual-shape parser, persistent transcript copy, or snapshot
reuse across acquisitions.

Latest and older browser pages are byte-adaptive whole-turn projections over
that acquisition. Loading an older page does not reread the provider.
Live updates are projected from an incrementally maintained provider-private
eleven-turn tail, while the complete native acquisition remains available for
older-page reads.

If the newest turn alone exceeds the normalized transfer window, the latest
snapshot retains its user message and newest items with one deterministic
omission notice. This presentation bound does not close the SDK session.
Requesting the same complete oversized turn as a history page fails only that
page request. More generally, normalized page overflow does not fence an
attached query.

Sedes marks a compaction only where Claude Code wrote its summary row; it
does not infer a boundary from folded history. Provider history is the durable
transcript authority and is reprojected as bounded whole turns after restart or
generation replacement.

Targeted turn lookup scans the retained authoritative messages newest first.
It projects only the matched whole turn together with its durable terminal
receipt. It never rereads the SDK or walks normalized older-history pages, and
it distinguishes exhaustive absence from caller-bound exhaustion.

## Semantic projection and terminal receipts

Claude's native interruption sentinels (`[Request interrupted by user]` and
`[Request interrupted by user for tool use]`) arrive as timestamped user-role
messages containing one text block, without an origin or synthetic flag. The
projector recognizes that exact native shape following an existing turn, marks
that turn interrupted, and omits the sentinel from chat messages and user-input
ordinals. The original prompt remains the completion correlation target, so the
following `aborted_streaming` or `aborted_tools` result can persist its receipt.
History reconstruction recognizes the same shape even when the result receipt
was never saved; runtime reset therefore cannot recreate a phantom active turn.
Explicit origin metadata, authenticated Sedes input-operation UUIDs, string
content, and quoted or mixed content remain ordinary messages. SDK history
does not distinguish an unannotated external input that exactly copies the
native sentinel shape; that reserved shape is interpreted as native control
history. A late interrupt acknowledgment never overwrites a settled run state.

Claude Code closes a trailing user or attachment row when it resumes a session.
That row can be the previous attach's startup message, an unanswered prompt, a
tool result, or an interruption sentinel. The closure is a timestamped
assistant row with the `<synthetic>` model and exactly one text block,
`No response requested.`, and no model call is made for it. The projector
matches that exact shape, as Claude Code itself does. It never projects the
closure as an answer, a turn, a usage source, or a fork checkpoint. Most
closures follow a settled turn and answer a hidden startup message, so history
is unchanged; a thread reopened before its first prompt shows no turn.

A closure can instead follow a turn that had not settled, meaning its last
visible row is not a terminal assistant reply. If that turn also has no Sedes
terminal receipt, it ends `interrupted` at the closure's timestamp. It carries
a warning notice keyed to the closure row: "Claude Code exited before this turn
finished and closed it without a response when the conversation resumed." A
dangling Sedes submission therefore reconciles as interrupted, not completed.
A terminal receipt stays authoritative. An unanswered resume task notification
and its later closure remain hidden. Synthetic API-error rows share the model
but carry other text, so they stay ordinary assistant messages. Usage
accounting ignores every `<synthetic>` row, because none records a model
request.

A fresh launch proves that the process that ran any earlier turn is gone, but
Claude Code writes its closure only when it resumes, which can be after the
handle reads history. When the handle starts a query that is not a reattachment
and the newest turn in history is unfinished, it watches that turn. A resumed
Claude reports `running` while it handles the startup message, then `idle`; the
startup message's result names only itself. Once Claude reports idle, or starts
an input of this attachment instead, a watched turn that is still unfinished and
has no terminal receipt gets an `interrupted` receipt. The receipt has the
Sedes-owned reason `process_lost` and no result UUID. The projector adds a
warning notice: "Claude Code stopped before this turn finished. Sedes marked it
interrupted when the conversation reopened." A reattached persistent query is
never watched, because its turn may still be running. Sedes withholds
`CLAUDE_CODE_RESUME_INTERRUPTED_TURN` from every launch, even when the inherited
environment sets it, so Claude Code never re-runs an interrupted turn, tools
included, without a Sedes input; the user decides whether to resend. The
receipt is write-once, so a later closure row or result cannot change the
outcome.

SDK 0.3.274 can emit intermediate results while draining background task
notifications. Only successful empty zero-turn results carrying native
`task-notification` provenance are classified as those drain receipts, regardless
of optional terminal metadata. Explicit singular or plural user-message
receipt identities must correlate with the pending/current foreground input.
Unrelated receipts neither accept input nor settle the foreground turn, and
acknowledging them cannot prune active persistent replay. Ordinary foreground
zero-turn successes and errors retain terminal semantics.

A compaction summary projects as a normalized compaction item whose summary
is the text Claude Code wrote for the model. The item belongs to the turn that
was running when Claude compacted, which is usually the turn whose prompt the
compaction summarized. A compaction before a notification turn's first response
belongs to that turn. A summary with no turn to join, such as the first row of a
fork child, marks its own settled turn. The summary is never a prompt, a user
ordinal, a retry anchor turn, or a fork checkpoint. Usage counters report the
number of compactions. Live, the synthetic user row that follows a
`compact_boundary` frame is that summary. The handle marks it the same way and
places it before the rows the compaction preserved, then requests one
resnapshot, so live and reloaded views agree.

A foreground result settles the turn that holds its native input identity
(`user_message_uuid(s)`), wherever that turn is, rather than the newest turn.
It ends the run only if no later turn carries an input of its own. A result
without input identity keeps the rules below.

Claude messages project into normalized user, assistant, reasoning, tool,
command, file-read, file-change, web-search, MCP, collaboration, status,
interaction, notice, and usage items. Exact durable `Bash`, `Read`, `Write`,
`Edit`, `NotebookEdit`, `WebSearch`, `mcp__*`, and `Agent` or legacy `Task`
shapes select the common semantic renderers. `WebFetch`, unknown tools, and
malformed or incomplete known shapes remain bounded generic tools. Titles and
prose are never classifiers.

Tool results settle the same stable item, including failure and interruption.
Live and reopened projection converge on the provider's durable tool-call
identity.

Claude can emit one completed assistant wrapper per completed content block.
Those wrappers share the Anthropic message ID and can use `stop_reason: null`
while later blocks or tools still follow. Claude Code 2.1.28x instead stamps
every block row with its message's final stop reason, so a thinking or text
row before a tool call carries `tool_use`. History treats a row as a turn's
answer only when its stop reason is neither null nor `tool_use` and it has no
tool call. A turn is complete only when such a row is its newest visible row:
anything after an answer, such as a tool call, its result, or a steer Claude
folded in, means Claude continued, for example after a blocking Stop hook or
a `max_tokens` continuation, whose prompting rows history hides. Sedes
therefore:

- keys partial and durable blocks by that shared message identity;
- assigns each later live segment the next durable turn order;
- treats the wrappers as nonterminal; and
- persists the SDK's single per-turn `result` as the authoritative success,
  failure, or interruption receipt.

The active run and interrupt target stay latched until that result boundary.
An intermediate SDK `session_state_changed: idle` frame cannot settle an
otherwise in-progress normalized turn. These rules prevent duplicate or
misplaced live text, premature turn footers, and Stop-button flicker between
blocks, including after reload.

Stop is bounded, because Claude has then acknowledged the interrupt. If
Claude's reported state is `idle` when the interrupt is acknowledged, or
becomes `idle` afterwards, the turn settles after a one-second grace, which
lets a result Claude already emitted land. Otherwise it settles after 30
seconds. A Sedes turn then gets an `interrupted` receipt with the reason
`interrupt_unconfirmed`. A turn Claude started ends without one, as its result
would. When a stopped turn Claude started opens its own live turn, the Stop
and its remaining bound move to that turn. A result that arrives first settles the turn normally. A reattached
query's state is not assumed idle until Claude reports it.

### Input acceptance and turns Claude starts

An ordinary input is accepted, materialized, and running when its
`command_lifecycle` `started` frame arrives; the persistent owner synthesizes the
exact user row at that point. Submit therefore returns at Claude's dequeue, not
at first model output. A `user_message_uuid(s)` stamp remains exact evidence,
and it is the only evidence that names a steer's receiving turn. Unstamped
output, a result without input identity, and a bare `running` state never accept
a pending input. A second ordinary input is refused as not sent while another
still awaits its start, because Claude merges inputs queued together into one
turn.

Claude starts turns itself for background-task notifications and peer
hand-backs. Sedes models such a turn as running from one of two events. The
first is Claude's `running` edge, when no Sedes input awaits its start and
this launch's startup message has settled. Claude reports `running` while it
handles that message and ends it with the message's `completed` lifecycle
frame and a result naming only it, so a fresh persistent launch, whose frames
the owner holds until history is installed, does not start a phantom turn. A
reattached query's startup message belongs to an earlier attachment. The
second is the turn's first unstamped main-thread response. The turn ends at its
result, or at Claude's `idle` if no result came. Stop targets it. Its result
writes no terminal receipt, and an uncorrelated result never receipts or settles
the previous application turn. A contradictory later result for an already
receipted turn keeps the first write-once outcome without failing the
attachment. Output from such a turn cannot claim a queued send; that input
starts after the turn's result, on its own turn. Input the actor resolves to
Steer can take over the turn, and Claude's reply stamps then name the steer.
Claude's own non-idle state blocks automatic retirement and counts as
persistent-host active work. This includes a backgrounded agent's wait, during
which Claude stays `running` after the foreground result with no idle edge.

Provider history starts a task-notification turn at its notification row, which
Claude does not stream, and omits a peer hand-back's `isMeta` row entirely.
Both the live and the reloaded projection therefore identify a turn Claude
started by its first Anthropic message ID. If a non-ambient `task_notification`
preceded the turn, the live path opens it with a private in-memory boundary
marker, so partial text streams under the same turn that reload shows. Otherwise
its output extends the settled previous turn, as reload does for a peer. The
result's exact `origin` confirms the choice or corrects it with one resnapshot.
Markers never enter provider history or submission retry anchors.

Two turn identities changed, and existing threads re-identify those turns
once on first read. A task-notification turn was named by its notification
row, which the live stream never carries; it is now named by its first
Anthropic message ID. A summary from a compaction in the middle of a turn
opened a turn of its own; it now joins the turn Claude compacted. The old
identities cannot be kept on reload, because a live turn could never carry
them, so live and reloaded views would disagree. Evidence keyed to an old
identity stays where it is. A terminal receipt for a turn that no longer
exists is stale and ignored, as for any turn missing from history. A fork
lineage record keeps the source turn it named. Message usage stays attributed to the old turn; the new turn
reports it as conflicting evidence instead of counting it again, and session
totals, which come from Claude's cumulative query checkpoints, do not change.

Reviewed retry, rate-limit, and informational events produce bounded notices
without exposing provider payloads.

## Collaboration and authenticated evidence

An exact `Agent` or legacy `Task` call becomes one stable parent-side
collaboration item that advances from spawn through result or terminal status.
Its launch description stays visible after the launch acknowledgement. Exact
top-level native `task_started` evidence records the session, task, and parent
tool identity. A matching terminal `task_updated` or `task_notification` appends
a separate completed, failed, or stopped collaboration item to the parent
turn. Duplicate terminal notifications are idempotent. Child transcripts remain
provider-private, and nested or uncorrelated events cannot create parent rows.

Migration 100 stores bounded lifecycle receipts under server-derived tenant,
principal, application-thread, and native-session authority. SDK history omits
these system notifications, so receipts preserve observed terminal bookends
across reload; they contain no child messages, command output, or live-state
claim. Projection requires the exact parent tool call to remain in native
history. Replaying a receipt cannot complete the main turn again.

When Claude resumes a session whose previous process left background work
unfinished, it ends each such task with a `stopped` or `failed`
`task_notification`, before its initialization frame, and it may relaunch the
task. An in-process worker restart adds `reason: "worker_restart"`; a new
process resuming the session does not. Sedes therefore treats a non-completed
notification in a fresh (not reattached) query for a task that query never
started, or any `worker_restart` notification, as orphaned work. It records the
bookend and shows a warning notice naming the task by its recorded
description, or by its native ID, because the task's result never arrived.
The provider's summary text is not shown.
`claude-resume-orphan-native.test.ts` qualifies this on Claude Code 2.1.283.

`background_tasks_changed` is the authoritative level inventory for live
subagents, Bash commands, and other nonambient work. It maps to the shared
generation-volatile background observation independently of lifecycle rows.
Inventory can clear before a terminal notification arrives; neither event
substitutes for the other. Fresh queries start empty, reattached queries await
their inventory, and query failure invalidates it. Main-turn completion does
not clear it. Persistent hosts retain the latest inventory across terminal
replay pruning and include active background work in retirement and upgrade
checks. A bounded private set of pending task notifications survives an empty
inventory and persistent reattachment. Retirement waits until the notification
has been applied and the receipt persisted, without keeping visible counts
artificially active. Sedes does not expose provider task controls or reconstruct liveness
from receipts or transcript text.

Authenticated Task and context evidence is checked by exact
tenant/principal/thread/operation lookup only for signed candidates encountered
during projection. Sedes does not list every operation snapshot or copy native
history into its database.

## Creation, binding, and model state

The backend supports creation, import, resume or reattach, streaming submit,
interrupt, rename, exact user-message reconciliation, durable desired and
effective model and effort, and scoped durable token accounting. Main-loop turn
usage and cumulative query-pipeline totals remain separate; native round counts
do not establish request cardinality.
Creation reserves an application UUID before crossing the SDK boundary so a
retry or recovery attempt cannot create an untracked replacement.

A session exists natively once its transcript does. The SDK reports metadata
only after a prompt or title, so a thread that was opened but never sent to
holds a transcript with only startup messages and no metadata. Attach resumes
such a session, because Claude Code rejects a fresh launch that reuses the ID.
Reads, fork identity checks, and creation reconciliation treat it as an
existing, empty history. Existence then comes from the runtime's
`session.transcript` presence check. After a deliberate stop, the persistent
host answers that check from its shutdown baseline.

The live model and effort catalog is intersected with installation policy.
Aliases that resolve to the same exact native model produce one option. An
explicit row provides its label, while a matching `default` alias marks it as
the target default. The moving default alias cannot override an explicit row's
effort metadata, and conflicting explicit rows are omitted fail-closed.

Model and effort are separate selectors; the catalog does not repeat each model
for each effort. Models without an effort axis remain selectable and persist a
null effort rather than a fabricated value. `catalog` leaves the provider
catalog unrestricted by Sedes, allowlist matchers admit only matches, and
denylist matchers remove matches while admitting future unmatched values.

Existing disallowed selections remain readable and visible as unavailable.
New provider work is blocked until an admitted model and effort are explicitly
selected. Sedes neither fabricates configured values nor substitutes another
selection. See
[Configuration](../../operator/configuration.md#backend-model-policy).

The desired model, effort, and permission mode are applied as one turn-boundary
selection and frozen into the durable operation snapshot. Observed effective
state can temporarily differ after reconnection or policy change. Delivery
fails closed rather than guessing.

A Saved Agent can capture sparse Claude model, effort, permission-mode, and
Sedes tool-policy overrides. Thread creation resolves them against the current
target catalog and operator ceiling and copies the complete result. No live
link to the Saved Agent remains.

The thread menu's **New** action likewise captures the complete desired model,
effort, permission mode, and exact Sedes tool policy from an available source.
It revision-fences and revalidates those values before creating an independent
empty draft with no Claude session or history.

## Permissions and blocking interactions

SDK 0.3.274 permission callbacks preserve `defaultToNo`,
`suppressAlwaysAllowRule`, and bounded `mcpServer` provenance through the private
worker transport and persistent permission replay. Provenance is descriptive,
not permission authority; invalid provenance labels are omitted at the SDK worker
boundary without dropping permission-safety hints or disconnecting the worker.
A default-to-no request becomes a normalized decision
with Deny first and no primary approval action; keyboard focus starts on Deny.
Suppressing always-allow rules removes the session-grant action and its server-side
authority, so a forged session-grant response fails closed. Allow once remains an
explicit choice. These values belong to the pending thread interaction; they do
not change installation or principal policy.

The browser uses existing normalized action roles. Its no-primary decision path
renders each action once. The cross-backend audit preserves Codex's ordinary
primary decisions and Pi's confirmations; Grok does not advertise provider
blocking interactions. No provider metadata is added to the browser contract.

Claude permissions use the private versioned `claude.permissions@1` feature.
The configured `allowedModes` set is a closed backend ceiling. The backend
keeps the SDK permission callback installed in every admitted mode; it does not
rewrite Claude's user, project, local, or command-line permission files.

SDK prompts become normalized blocking interactions. Bounded ephemeral session
grants are available only where the SDK permits them. A decision's authority is
limited to the exact operation it describes and never silently crosses into
Sedes environment authority.

Claude permission and Sedes environment decisions are evaluated independently:

- Claude **Allow once** or a Claude session grant does not allow a Sedes
  application tool to cross execution environments.
- A Sedes environment approval authorizes one invocation under the
  thread-wide Sedes rule; it does not broaden Claude's mode or ambient policy.

`bypassPermissions` is admitted only when the operator explicitly allowlists
it, and it can never become a target default. Plan mode is not exposed because
the reset-producing `EnterPlanMode` and `ExitPlanMode` lifecycle has no durable
normalized rebind contract.

The operator-visible modes and their effects are summarized in
[Permissions and security](../../operator/backends/claude.md#permissions-and-security).

## Inputs, images, and skill correlation

Claude accepts ordinary text, immutable context excerpts, structured Task
references, and composer attachments through the common immutable delivery
snapshot. Provider wire projection renders Task metadata and the authenticated
staged-file path manifest as text. It does not inline ordinary file contents;
Claude must explicitly read a staged ordinary file.

For recognized PNG, JPEG, GIF, and WebP images, Sedes reads the exact canonical
bytes through the scope/thread-bound reader. Before enqueueing the input, it
rechecks descriptor equality, size, digest, media signature, dimensions, and
Claude request bounds, then adds ordered SDK base64 image blocks. It never
rereads an execution-environment `agentPath` as a local file. Missing byte
authority, mismatch, unsupported media, or a bound failure rejects the complete
input before it enters the SDK queue.

The SDK catalog has no per-model image-modality discriminator. The reviewed
worker profile therefore advertises image input for every admitted Claude model.
The authenticated staged-path manifest also retains each image as a read-only
file for an explicit filesystem request. Its guidance states that native image
content is already present, so Claude should not invoke a read tool merely to
inspect the same pixels again.

Exact native session and message correlation maps provider history back to the
common `deliveryOperationId`. That restores normalized input parts without
parsing an echoed attachment manifest. Native image echoes correlated to the
authenticated input are suppressed. Unrelated native image blocks keep the
truthful omitted-image presentation. Native image input neither enables
provider-output artifacts nor strengthens attachment fidelity across forks.

Claude initialization mixes model skills with local, terminal, settings, and
session-lifecycle commands. Sedes exposes a skill only when a primary command:

1. appears in the same stream initialization's skill set;
2. exists in the official control catalog; and
3. is absent from the terminal-command set.

These positively classified skills appear in the common picker. A picker
selection or exact direct invocation is sent as an ordinary model turn. Sedes
records a scoped immutable association between the skill and the native user
message UUID, allowing live and reopened history to restore the skill badge
without provider-visible framing.

A native fork copies the association only through its verified source-to-child
UUID remap. Aliases, terminal-only commands, unclassified built-ins, stale
selections, malformed commands, and reset-producing forms fail before provider
submission.

## Agent-tool presentation

Eligible Claude queries receive Sedes tools with exact thread-scoped context
in Progressive or Individual mode, on the CLI or Native surface. The CLI
surface installs the generated `sedes` CLI in the query environment:
Progressive uses bounded catalog discovery and generic invocation; Individual
uses live help and named typed commands. The Native surface adds a per-query
`sedes` MCP server; see
[Native MCP presentation](../agent-tools.md#native-mcp-presentation-codex-and-claude). The same per-thread exact-ID policy and
invocation-time authority checks used by other backends apply. Claude does not
implement Pi's shared `set_tool_access` action. Claude's permission mode
decides whether Claude runs a `sedes` command or `mcp__sedes__*` tool; Sedes's
own policy and access boundary then apply independently of that mode.

The worker protocol carries the Native entry as a closed `agentToolMcp` field
that is exclusive with the CLI query environment. The Agent SDK passes MCP
servers to the CLI as a `--mcp-config` argument, so the entry names the
reference as `${SEDES_AGENT_TOOL_SOURCE_CAPABILITY}` and the query environment
carries the value, which Claude expands when it starts the server. The user's
MCP servers from setting sources still load. Local workers use the
local HTTP endpoint. Remote Linux/macOS queries use the private sidecar Unix
socket relay
when `agent_tools_cli` is independently enabled and admitted. Its calls require
a current authorized main-server connection; disconnected calls are not queued
for later execution. For a remote Native query, the sidecar admits the MCP
entry only when it names the sidecar's own `sedes` binary and live ingress,
and the retained query's authority fingerprint includes it. A missing built
CLI disables only the agent-tool presentation, not ordinary Claude
conversation capabilities, and never falls back to another mode or surface. The injected encrypted
thread source reference survives a Sedes restart, while every invocation still
requires the exact current active Claude query and policy. For a service-owned
remote query, losing the CLI carrier does not close the query. The sidecar validates the exact injected ingress/PATH and
reattachment rejects changes to that query authority.

Principal Tool clients are separate generic management-HTTP callers, not a
Claude presentation mode. They are never injected into the Claude query
environment. Claude worker-environment construction removes ambient
`SEDES_AGENT_TOOL_CLIENT_TOKEN` and `SEDES_AGENT_TOOL_CLI_MODE` values before
installing the thread source reference and server-resolved mode hint. That hint
does not authorize tools; discovery and invocation reload current grants.

Admitted client-driven create, send, and fork operations retain exact client
provenance. Destination model work remains governed by the destination
thread's Claude execution settings and Sedes tool policy.

## Fork lineage

An idle Claude thread can fork from an exact successfully completed ordinary
turn. Sedes reserves the child first, resumes the selected provider prefix, and
records native lineage without sending a synthetic follow-up prompt.

The generic thread **Fork** action resolves the newest completed turn while the
source is idle and records `completed_turn_inclusive`. Interrupted and failed
turns are not completed, so they are never selected. If the newest completed
turn carries a `forkUnavailableReason`, the fork fails with that reason; it
never falls back to an older turn. If the newest completed turn in Claude's
history is not the one the actor resolved and records, the fork fails
retryably with `claude_fork_latest_turn_changed`. Transcript and agent-tool forks continue to
select an exact completed turn. Claude does not advertise
`latest_provider_snapshot`.

The projector marks a completed turn unforkable, with a user-facing reason, when
it has no fork checkpoint: it ended without a final answer (for example on a
tool result or an attachment-ended structured output), it precedes the latest
compaction, or it is only a compaction summary. The reason travels as
`forkUnavailableReason` on the backend and normalized turn, and the fork button
and the fork service both honor it. A turn Claude is still running carries no
reason, even when history already reads it as answered, and a change to the
reason alone, such as after an automatic compaction, republishes the turn. File-history and attachment fidelity
across a native fork are not guaranteed. Historical authenticated boundary
carriers remain hidden when older sessions are read. Skill correlation crosses
the fork only through the verified native UUID remap described above.

### Background work and the fork gate

A fork copies native history only. Background agents and commands keep running
in the source, and the child would be told they never finished. Branching is
therefore unavailable, with an actionable reason, while the handle's background
activity is unknown or non-empty, while a background result is still being
recorded, or while Claude reports a session state other than `idle`. The
capability revision includes the blocker, so the fork button updates as soon as
background work settles.

A historical boundary may still name background tasks that never reported a
terminal notification before the checkpoint. When Claude resumes that prefix,
it appends a transcript-only `<task-notification>` row for each such task,
telling the model it did not finish. Sedes allows the fork, records those row
UUIDs as child evidence, and shows one warning notice in the child: the work was
not carried into the fork, and its results, if any, are in the source thread.
The notification rows themselves are not projected as provider turn boundaries.

### Launch

The fork is one locked-down, one-shot Claude Code launch:
`resume` the source at the exact retained leaf with `forkSession` into the
reserved child UUID. The launch loads no setting sources, disables all hooks,
uses a strict empty MCP configuration and no tools, and runs in `default`
permission mode with a callback that denies and interrupts every tool request.
It never sets `CLAUDE_CODE_RESUME_SOURCE_ALIVE`. The query sends only Sedes'
`shouldQuery: false` startup message, so Claude writes the copied prefix, any
unfinished-task notifications, and its startup row without a model request.
Any assistant or stream event means Claude began a turn anyway: the launch is
closed at once and fails with `claude_fork_launch_started_turn`, and with no
tools, hooks, or MCP servers the turn cannot act meanwhile. The launch confirms
the child's frozen model and the `default` permission mode, applies the frozen
effort, then closes and waits for proven process cleanup. The child's own
permission mode is applied later by its first ordinary query.

Launch failures are classified before they reach the fork service:

- `claude_fork_launch_refused*`: no Claude Code process started (unsupported
  version, missing login, unavailable runtime, or the persistent host's
  32-session capacity). Nothing was created.
- settings or effort mismatch, a started turn, or another failure after launch
  with proven cleanup: Sedes checks whether the child transcript exists and,
  if so, verifies it as below before failing. Deterministic failures are
  marked non-restartable, so the UI does not offer to start the same fork again.
- `claude_fork_launch_cleanup_unproven` or a failure without a classification:
  the outcome is unknown and the fork stays in recovery.

On a persistent runtime, the `fork` command runs the launch inside the host
with an empty admitted environment and never registers the child as an
attachable session. `open` rejects fork launches, and reads of a child are
refused while its launch is still running. The child is attached later like any
other session.

### Verification and child evidence

The child's history must start with an exact content copy of the retained
prefix, compared by a content fingerprint that ignores per-session row UUIDs.
After the prefix, only two kinds of rows are accepted, each by exact shape:
a task notification for a task the prefix launched and never saw finish, and
Claude's `<synthetic>` "No response requested." row. At most 256 rows may
follow the prefix. Anything else fails with `claude_fork_history_mismatch`,
whose diagnostic names the expected and found counts and the first differing
source and child UUIDs. A mismatched child is never adopted. When the mismatch
is found on a retry, the message says an earlier attempt already created the
child.

On adoption, Sedes records provider-private child evidence in
`claude_fork_children`: the fork operation, the positional map from child to
source turns in `claude_fork_inherited_turns`, and the omitted-task rows in
`claude_fork_omitted_tasks`. The child's usage projection inherits the source
turns' usage by that map, and terminal receipts for inherited turns are copied.
A task receipt is copied only when its terminal evidence is inside the prefix:
a task notification naming it, or the ordinary result of a launch that did not
ask to run in the background. Tasks Claude reported unfinished are never
carried. Replaying the same evidence is idempotent; different evidence for the
same child fails with `claude_fork_child_evidence_conflict`.

Claude Code resumes a compacted conversation only from its latest compaction.
`--resume-session-at` a row before it fails with "No message found", as
verified on 2.1.283. Only turns whose checkpoint follows the latest compaction
summary are forkable. The child holds the boundary, the summary, the preserved
rows, and later rows up to the checkpoint, with the source's row UUIDs.
Checkpoint prefixes are therefore counted, digested, and verified from the
latest summary before the checkpoint. If the source compacts again after the
checkpoint, a child an earlier attempt already created still verifies and is
adopted, but a new launch fails with `claude_fork_checkpoint_changed`, because
Claude Code can no longer resume at that row. Branching fidelity keeps `compaction: true`, because the child
resumes the same compacted context, and states in a limitation that earlier
turns are not copied or forkable.

## Recovery and unsupported mutations

Provider history is the durable transcript authority. After restart or
generation replacement, Sedes rebuilds its bounded whole-turn projection and
reconciles exact native user messages with durable delivery operations. The
application UUID reserved before creation, immutable operation snapshots,
provider-private bindings, authoritative terminal result, and exact message
correlation prevent recovery from inventing replacement sessions or duplicate
turns.

Anchor-based non-acceptance comes only from a tip-correct read. The handle's
retry anchor covers history that starts from a baseline read through the true
tip, and reconciliation reads the same way. A prompt persisted before a later startup
message is therefore found and accepted instead of hidden behind a parallel
dead end and resent.

On a remote runtime, an ordinary submission can reconcile as `failed_unknown`.
This happens when the persistent owner reports that its session ended and the
tip-correct history shows no acceptance: no turn in the whole history
correlates the input and no row carries its identity. Tracking is then
terminal, and consumption is unknown. Reconciliation searches every turn,
not just the latest snapshot window, so an input accepted before later turns
still reconciles as accepted. When the user reconciles the queue, or on recovery at
startup, the shared queue fails that head with a "Claude may have received
this; review the conversation" diagnostic. The user then dismisses it, deletes
it, or restores it to the draft for an explicit resend; later queued input
waits for that choice. Nothing is resent automatically.

Persistent send admission returns a typed positive acceptance or a bounded
pre-native refusal (busy, closed, or retention capacity). Main awaits that
response within the submission acknowledgment deadline. A known busy refusal
keeps the attachment alive, marks the foreground active, and uses the shared
queue's bounded invalid-state handling. Missing, malformed, or post-admission
failure responses remain uncertain; they never prove the prompt was not sent.

A persistent query's failure code survives event acknowledgment and is included
in every attachment. Main drains retained output, then fails hydration and
closes its handle with eviction, so the host retires the failed query once its
output is acknowledged; reopening the thread then starts a fresh query. Main
must not infer query liveness from an unfinished transcript or recreate a
native query while the failed one is still resident. Thread reset detaches the presentation; it does not
replace the remote owner. Use the confirmed backend Stop/Restart flow to review
and abandon unresolved outcomes when necessary. Ordinary reattachment never
replays an uncertain input or discards unknown background work.

An operator's forced stop ends every session with a failure event, which is
how an attached main learns its query is gone. A session with live work (a
running turn, including one Claude started, a pending input or permission, or
background activity) ends with `claude_persistent_operator_stopped`. A session
whose work had settled ends with `claude_persistent_operator_stopped_settled`
after its retained output, so an unacknowledged result remains its outcome
rather than reading as interrupted. The abandonment evidence records each
session's `liveWork`, background counts, and failure codes. An unforced stop proceeds only after the
owner reports no work, but Claude can start work itself while the stop reads
history. If any session has live work when the worker closes, the stop records
before- and after-shutdown evidence marked `startedAfterConfirmation`, as a
forced stop would.

Force reset answers every pending Claude permission or question it abandons
with a provider-side cancel, which Claude receives as a denial, and waits up to
10 seconds for those answers before it replaces the runtime. A remote query
therefore does not stay blocked on a prompt no client can answer.

A fork failure is definite when it proves no child exists (a refused launch) or
that the child is unusable (a history mismatch, a settings or effort mismatch,
or a launch that started a turn). An explicit recovery then aborts the
reservation, and deterministic failures set `forkRestart: "futile"`, so the UI
does not offer to start the same fork again. An unproven launch cleanup, an
unclassified failure, or a failed read of the child keeps the fork in recovery.
The generic recovery, discard, and discovery rules are in
[Native fork lineage](../native-fork-lineage.md#creation-and-recovery).

Sidecar wire v10 fences older attachment/send response shapes and workers that
cannot carry native steering priority before connecting to a retained runtime. Busy incompatible services require the existing explicit
upgrade flow; they are not silently replaced. During a deliberate shutdown,
reattachment can still drain final receipts without classifying the stopped
query as an unexpected failure or requiring another forced stop.

Claude advertises conversation-targeted Steer using native `priority: "next"`.
Stop interrupts the current turn only. Claude reports a queued steer as
`still_queued` and runs it as the next turn; Sedes does not withdraw it.
Steer needs 2.1.274 or newer, below the 2.1.281 runtime minimum. Testing
2.1.241 showed that it can consume guidance but omits the second input’s
consumption UUID, which cannot establish safe delivery tracking. Older
runtimes fail the common admission guard; there is no separate compatibility
path or version-specific Steer capability.
The target contains no turn ID. Native enqueue stays pending until exact
user-message UUID evidence confirms incorporation; normalized history associates
that input with the actual receiving turn. This can be the current turn or the
next one if current work has completed. Transport loss cannot justify replay or
an invented receiving turn. Existing assistant output cannot confirm a newly
enqueued steer. Queue remains application-owned next-turn work. Native `now`
interruption semantics are not exposed by this feature.

Manual compaction is also unavailable. `/compact` is a Claude Code local
command, and a command result cannot be recovered as one durable normalized
compaction operation. Automatic compaction remains Claude's own decision. Sedes
displays it from the summary row, as described under
[Semantic projection](#semantic-projection-and-terminal-receipts).

Terminal-only, unclassified, reset-producing, and plan-mode commands fail
before submission. Active-source forks, latest-provider-snapshot forks,
managed terminals, provider-output image artifacts, and shared Pi tool-access
mutation are absent from capabilities and fail closed at the backend boundary.
The operator-facing limit list is maintained in
[Current limits](../../operator/backends/claude.md#current-limits).

For shared creation, queue, recovery, fork, and authority rules, return to
[Architecture](../architecture.md). For safe runtime diagnosis, use
[Debug diagnostics](../../developer/diagnostics.md).

## Verification contract

Claude backend changes must preserve the exact SDK/profile boundary and audit
every compiled backend disposition required by the
[backend integration rules](../backend-integration-contract-rules.md).
Verification should cover the changed contract at the narrowest layer and its
normalized integration surface:

- `tests/unit/claude-release-guard.test.ts` and
  `tests/unit/claude-sdk-probe.test.ts` cover runtime, subscription, and
  initialization admission;
- `tests/unit/claude-conversation-handle.test.ts` and
  `tests/unit/claude-conversation-driver.test.ts` cover session lifecycle,
  exact terminal receipts, capabilities, interactions, history, and recovery.
  This includes live compaction against its reload, compacted fork prefixes,
  `process_lost` on fresh launches and never on reattachment, and the Stop
  bound;
- `tests/unit/claude-native-transcript.test.ts` compares the transcript reader
  with the pinned SDK over synthetic native fixtures. The fixtures cover
  startup-message tips, parallel dead ends, rewinds, sidechains, queued
  commands, compaction, and partial lines. Revalidate this parity whenever the
  SDK release changes. For compacted transcripts the SDK's read must be the
  exact suffix of Sedes' read. The automatic-compaction fixtures follow Claude
  Code 2.1.28x rows: a mid-turn compaction with relinked kept rows, one with a
  segment but no listed rows, several compactions, a resume after compaction,
  a process that died right after compacting, a fork child that starts at the
  summary, and a compaction before a notification turn's first response. Its
  resume-shape fixtures also project the Claude Code behaviours Sedes depends
  on: startup messages with and without `queueTranscriptOnly`, one closure per
  later resume, closures after a dangling startup message, prompt, tool
  result, or interruption, and resume task-notification wording variants;
- `tests/unit/claude-native-images.test.ts`, skill/command tests, and
  agent-tool environment tests cover input projection and optional surfaces;
- persistent-runtime tests cover exact-session attachment, event replay,
  permissions, stale controllers, cleanup, and disconnect without resubmit;
- `claude-run-state-native.test.ts` qualifies the lifecycle and session-state
  frames described under runtime ownership against the actual executable and a
  loopback Messages fixture, including turns Claude starts itself;
- `claude-resume-orphan-native.test.ts` kills a query while its background
  command runs, resumes the session against a loopback Messages fixture, and
  checks the notification that ends the orphaned task;
- `claude-compaction-native.test.ts` makes the actual executable compact
  automatically against the loopback fixture, at a turn's start (keeping the
  new prompt) and mid-turn. It qualifies the live boundary, the synthetic
  summary frame, and the result's input identity. It also checks that Sedes
  reads the written transcript with the SDK's read as its suffix;
- `claude-process-loss-native.test.ts` kills the executable with SIGKILL while
  a tool runs, then resumes as Sedes does. It qualifies the unfinished turn in
  history and the `running`, startup-result, and `idle` frames that the
  lost-process rule relies on;
- `claude-background-activity-native.test.ts` runs the pinned SDK and actual
  Claude executable against an isolated loopback Messages fixture. Its finite
  gated Bash and Agent jobs prove the foreground result precedes background
  completion and qualify inventory/start/notification identity and ordering;
- persistence, Saved Agent, automation, fork-lineage, and wrong-scope tests
  must change with their corresponding authority contract; and
- `tests/real-claude/` is an opt-in, capacity-consuming gate for its narrow
  reviewed streaming/persistence/usage/reopen profile. Its native-history
  case reproduces a startup-message tip over parallel tool calls with exact
  pre-approved `sleep`/`echo` Bash invocations, and reopens a thread before
  and after its first reply without a phantom turn. Its persistent-runtime
  case uses real worker stdio over local framed sockets; it does not verify a
  remote SSH or outbound host or provide blanket evidence for images, tools, permissions,
  skills, or subagents.

Use the standard typecheck, unit, build, and E2E sequence for backend-facing
changes. The authorization and safety guidance for the real suite remains in
the [operator guide](../../operator/backends/claude.md#opt-in-live-verification).

Release-specific native qualification and the distinction between native and
synthetic evidence are recorded in the [SDK 0.3.274 evidence](../../../protocol/claude-agent-sdk/0.3.274/README.md).
