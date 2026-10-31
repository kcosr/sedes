# Native Pi backend contract

The native backend is `pi_native` with `pi_rpc` targets. It is separate from
the embedded `pi` / `pi_sdk` backend. Both remain under
`src/server/backends/pi`; native RPC parsing, native identifiers, and JSONL
interpretation must not escape that boundary. The
[operator guide](../../operator/backends/pi-native.md) owns installation,
capabilities, and configuration guidance.

## Runtime and transport ownership

`native/pi-native-backend-module.ts` prepares one execution-environment-owned
runtime. Local execution uses `PiNativeHost`; SSH and outbound execution use
the same host behind `PiNativeRemotePort`. The persistent sidecar advertises
`pi_native_runtime` major version 1. There is no remote-to-local fallback.
Windows is excluded because the managed companion uses a Unix-domain socket.

`native/rpc/pi-native-launch.ts` resolves and fingerprints the host executable,
probes exact version `1.4.0`, and starts owned RPC stdio. It installs only the
managed companion under `--no-extensions`; project trust selects `--approve`
or `--no-approve`. The companion resolves public factories from the installed
native package, not the embedded SDK dependency. The separate authenticated
socket carries control and evidence unavailable in ordinary RPC responses.
Neither the evidence key nor the bridge token enters argv or the process
environment. The companion synchronously consumes a private one-use token
file before installing native factories. After authentication, the bridge
supplies the key in memory; the host verifies that the token file was removed
before delivering it. The key never enters session files.

The host owns processes, writer leases, event retention, operation results,
and cleanup. A carrier or main proxy closing must not retire remote accepted
work. Attachments bind runtime, handle, and generation identity. Release can
retire a session only after it is idle, has no pending interactions, and its
operation and event evidence has been acknowledged. Runtime stop/restart uses
an ownership/blocker revision that remains stable through streaming progress.

New runs, sessions, interactions, mutation or retained-result obligations, and
cleanup state invalidate the confirmation. Non-retained observation-only
requests do not change the revision or add a delivery obligation. Force records
abandonment only after confirmation is accepted,
before cleanup.

Production composition records the service incarnation of a module's first
provider lease. If authenticated management observes a ready, applied successor
service, it retires the idle module through the normal actor, provider, and
cleanup gates before creating another port. Configuration equality alone cannot
keep a port pinned to a retired service. Carrier and controller-epoch changes
within the same service preserve the module. The old port still rejects changed
runtime identities, so retained handles and unknown operations never cross into
the replacement. An unavailable peer supplies no replacement authority.

Failed cleanup retains ownership and reports `cleanup_unproven`.
Live and recovered administration use the same normalization for positively
reported stale confirmation, blocked work, and unproven cleanup. Transport loss
remains an unknown outcome; a cleanup refusal permits another explicit Stop
against the retained owner, never a replacement process.
Before actor disposal, the remote runtime closes its main-side port and permits
local release of only the handles that port returned. This cleanup performs no
provider operation and proves no remote retirement: rejected or uncertain Stop
results leave the sidecar's work available for recovery.

Existing-only drain attachments can read closed sessions or sessions with
earlier environment settings without launching or reconfiguring a process.
The remote port keeps their lease separate from its normal attachment: drain
handles reconnect through retained lookup, while unrelated threads acquire
normal authority for new work. Releasing a drain does not release that normal
attachment.
The driver rebuilds closed history from disk, transfers recognized exact
operation outcomes into its durable journal before acknowledging them, and
retains unknown outcomes as unknown. Unrecognized receipts still block
retirement. A drained, proven-closed session can then release its resident slot.

## Exact operation evidence

`native/rpc/pi-managed-protocol.ts` defines authenticated input and operation
evidence. Submit and turn-scoped Steer use stable operation identities and
signed per-input markers. The companion associates consumption with the exact
native user-entry ID after the input hook, including native skill/template
expansion. Prompt text, ordering guesses, and timestamps are never acceptance
proof. A pending operation can remain unresolved across observation loss.

`native/driver/driver.ts` journals application operations before dispatch and
reconciles against native receipts. Stop brackets native queue clearing and
abort with managed stop evidence so dropped inputs do not become accepted
messages. Settings actions, rename, and compact require their own operation
receipts. Retrying transport calls cannot manufacture a second native mutation.
Only dispatch of the requested operation crosses its submission boundary.
Uncertain failures in earlier state reads, settings setup, or command lookup
leave that operation retryable; auxiliary requests retain their own cleanup and recovery
ownership. An absent or prepared journal record proves that the operation was
not dispatched, so reconciliation needs no native read. Once dispatched,
later read or bookkeeping failures remain uncertain until exact native evidence
proves the outcome, including on retries of the same operation.
Proven-unsent preparation retries use a persisted attempt number, keeping
late acknowledgements separate from subsequent attempts. Definitive companion
refusals before input admission become durable `not_applied` receipts before
their host receipts are acknowledged, including during closed-session drain.
Retries and reconciliation use that local proof without inventing signed native
input. Existing-operation conflicts and unexpected preparation errors remain
uncertain until native history establishes their outcome.

The journal sets `dispatchStarted` immediately before the native prompt or Steer
request. If preparation loses its reply and this marker remains false, an exact
native intent can be withdrawn through its stable completion operation. The
driver persists the resulting native rejection before acknowledging receipts;
reconciliation then reports that the original input was not sent and must not
be retried automatically. The user can restore it and send it under a new
operation identity. Replaying the original identity returns its terminal
rejection without issuing another native request.
Submission recovery is serialized with sends. Once the dispatch marker is true,
an unresolved intent cannot be withdrawn or resent without authoritative native
outcome evidence. Recovery reuses an attached client handle without closing it;
when it owns a temporary attachment, concurrent client attachment is retryable
until recovery and cleanup finish. Manual compaction
waits for its terminal outcome without the ordinary 60-second control deadline;
caller cancellation still ends the wait without erasing the operation.

`native/host/disk-store.ts` creates sessions and forks with immutable,
authenticated operation markers. The marker binds the operation fingerprint,
session identity, and captured native prefix. Reconciliation accepts continued
sessions only when that original prefix still verifies. A copied marker or
edited prefix is not authority. Fork fingerprints include captured model,
thinking level, and tool-access settings. Before reading the source or applying
current policy, recovery verifies the reserved child's immutable receipt;
it must succeed even when source history is no longer available. Only a
missing child reservation permits a new fork attempt. Remote authentication keys are private
sidecar state outside the session store; local authority derives from the
installation's private provenance key and backend scope.

The SDK and native hosts use `pi-session-writer-lock.ts` against canonical
session paths. Native child lifetime additionally retains a detached writer
marker. A dead parent or child PID alone cannot establish descendant cleanup.
The marker records kernel boot identity: only a verified change of boot permits
automatic stale-marker recovery. Same or unknown boot identity remains blocked.
Retain the lease until process close is proven; history reads require no lease.

SDK and native discovery share durable `pi_session_claims`, scoped to tenant,
principal, execution environment, storage host, canonical session directory,
and native session ID. Canonical directory resolution runs on the storage host
before create/fork publication and creates neither a process nor directories.
SDK storage remains on main for remote workspaces; remote native storage belongs
to the execution host. A claim is atomic with binding persistence and discovery
checks it inside the import transaction. Reservations survive aborted-child
removal, and exact retries cannot change their store identity. Existing bindings,
identified attempts, and aborted-fork source stores also suppress duplicate
imports across both Pi kinds and every configured instance. Writer locks still
operate per session, so distinct sessions can use the shared store concurrently.

## History, forks, and accounting

The disk store acquires a bounded, stable native JSONL snapshot, validates
the session header and entry graph, and selects its authoritative branch.
Discovery is canonical-CWD-scoped. Pagination consumes a retained discovery
snapshot, not a fresh scan with a guessed offset. Detached
`PiNativeHistoryReader` reads through the port without attaching a process.

`native/driver/history.ts` projects entries and native tool evidence into
normalized turns, items, compaction, and usage. Live projection and detached
history must use the same interpretation. Correlate tool calls/results by
native call identity, preserving unknown native details as data rather than
inventing a normalized command, edit, or generated artifact.

Forks capture an inclusive completed boundary. The source need not be idle
when the chosen boundary precedes active work. A fork has its own application
identity and current host instruction load; it is not an exact historical
instruction snapshot. Signed inherited entry IDs establish copied usage
provenance. Re-attest copied input markers under the child's identity instead
of accepting parent markers as child operations. Missing or invalid ancestry
stays unknown and cannot claim complete new-spend coverage.
Append the captured model and thinking-level entries after the copied branch,
so an earlier historical selection cannot override the child's application
settings. These new settings entries are outside the inherited usage prefix.
Tool access remains application-owned and participates in the fork receipt.

Usage facts derive from distinct native entries. Identical snapshots retain
the same fact identity; verified inherited entries do not create new spend.
Live usage snapshots advertise context and counters. The companion reads
`ExtensionContext.getContextUsage()` for every snapshot, and the driver maps
that evidence to normalized occupancy without reconstructing it from spend.
Native null tokens and percentage after compaction remain absent while the
model window remains available. Detached history advertises counters only.
Live completed-turn throughput
uses matching native assistant request-duration and output-token evidence;
missing or interrupted observation invalidates the measurement. Native image
input requires model support and verified content evidence. Native in-band
assistant and tool-result image bytes are validated and published through the
shared output-artifact publisher under the exact thread scope; never interpret
a provider path as image-read authority.

## Tools and policy

The companion explicitly installs the native code-mode, MCP, and tool-search
factories. It tracks tools registered by these factories through their public
registration boundary. Unknown extension or built-in authority is not inferred
from a display name. Model policy remains an application-controlled catalog;
code-mode model discovery is disabled.

`native/agent-tools.ts` supplies thread-scoped Sedes Native Progressive or
Individual tools and eligible CLI credentials. Each call binds the exact
native tool-call identity to server-derived principal, workspace, environment,
and thread authority. It rechecks policy and tool effects at invocation.
Eligible CLI launches provision the stable scoped environment independently
of the master enable flag and selected tool IDs. Changes to those grants take
effect at the next invocation without replacing the running process.
Native tool changes require the existing idle configuration boundary.

The driver caches complete native model, command, and skill snapshots with
five-second freshness. Explicit `skill_picker` reads await a fresh snapshot
and coalesce concurrent reads; passive presentation retains the last successful
snapshot during refresh or failure. Owner, connection, and workspace authority
revisions fence stale results before delivery or cache installation.

The final native tool-call hook enforces read-only, ask, or full access for
direct calls and calls nested inside code mode. It runs after MCP readiness
so late registration cannot bypass policy. Third-party read-only annotations
are untrusted: read-only denies those calls; ask requires approval. Native
MCP file configuration and OAuth state remain host-owned. Arbitrary extension
slash commands and per-session MCP configuration editors are unsupported.

## Capacity and verification

The host has fixed guards of 32 resident sessions, 16384 retained events per
session, and 256 operations per session. Each session has its own 32 MiB budget
for retained events and unfinished stream state, yielding a 1 GiB aggregate
bound at maximum residency. Sessions cannot borrow one another's budget or
cause another session to lose observation continuity. These limits are distinct
from the 128 MiB transport/snapshot bound and the host's 512 MiB ordinary
retained-operation budget with a separate 128 MiB control pool. Read-only
operations, including snapshots and status reads, cannot consume that control
pool. They are limited to 384 MiB across the host and 128 MiB per session,
protecting 128 MiB of ordinary mutation capacity from read traffic.
Pending commands reserve their encoded command bytes plus 4 KiB for small
replies or 64 KiB for bulk replies. Settlement replaces that reservation with
the actual encoded outcome size and rechecks all applicable limits. An outcome
that cannot fit becomes an explicit `sent_outcome_unknown` capacity receipt;
the host neither calls the mutation unsent nor silently permits replay.
Decoded transport frames are transient allocations governed by their separate
frame bounds; these budgets cover retained outcomes and pending command data.
Exhausting a session's
event budget freezes its ordinary mutations while retaining control and
process ownership. Unconsumed output, including a prolonged detached run,
remains bounded; unresolved evidence is never silently evicted to accept work.
Transient text, thinking, tool-input, tool-output, and bash progress coalesce
into absolute snapshots with monotonic sparse sequence numbers. Replacing
superseded progress does not advance the offered or acknowledged cursor;
durable boundaries, interactions, and operation evidence require explicit
acknowledgement.
The byte guard includes accumulated active-message state, so coalescing does
not remove the memory bound.

An exhausted session can recover through the existing-only drain without stopping
the host or other sessions. A live process must first prove idle through native
state and companion snapshots, with no active run, pending interaction, queued
input, or unresolved native mutation; the host then closes that process and proves
writer cleanup. A closed drain explicitly advertises the observation gap and
permits reading its retained prefix. The driver applies stable disk history and
every retained page, queues a gap notice for the next sequenced projection
subscriber, and acknowledges the exact generation and final retained sequence before the
continuity fence clears.
The notice survives an unobserved attachment or a lost acknowledgement reply.
Operation outcomes remain separate obligations, including unknown delivery;
gap recovery never acknowledges or retries them implicitly. Failed cleanup keeps
recovery fenced. A reconnected remote drain restores its exact session attachment
before observing or acknowledging retained evidence.

A live gap that is still busy can attach in control-only mode, including an
existing attachment whose observer detects exhaustion. This mode reads native
state but cannot observe the incomplete stream, submit work, change settings,
approve an interaction, or return a successful Sedes tool result. Attachment,
residency release, and configuration changes never stop the run. An explicit
user Stop uses the normal retained begin/clear/abort/end operations; begin_stop
denies companion approvals, cancels Sedes calls, and cancels recorded native
dialogs. Failed cancellation retains the outcome uncertainty and pending wait.
The companion's begin/end replies are fixed acknowledgements; submission history
remains available through snapshots and individual submission reads. Once Stop
acceptance is durably recorded, receipt cleanup runs independently of its deadline
and normal observation refreshes the conversation. A slow read or lost cleanup
reply cannot turn an accepted Stop into an unknown outcome.
Once idle, releasing the control handle permits the same gap drain and recovery.
Cancelled non-retained reads have an explicit observation-abandonment operation.
It reports `pending` until the native read settles, then frees its result and
reports `released`; retries use a bounded record of the read's identity. Retained
reads and mutations cannot be released through this path. If the host has no
operation or retained receipt for the ID, it first records a terminal cancellation
marker, then reports `released`. Any late request with that ID is rejected
regardless of its command; this does not classify a previous mutation as unsent.
These markers are bound to the exact session handle and never evict within its
generation; after 4,096 markers, further unknown-ID cleanup stays
blocked until that session can be retired. Ordinary settled reads use separate
bounded receipt history and do not consume this cancellation capacity.
The driver keeps the exact pending read as a gate against replacement reads,
including when cleanup acknowledgement is lost or the same native handle is
reattached. Read cancellation never erases
mutation uncertainty or forwards cancellation into an admitted native mutation.

The driver requests replacement immediately when its first control snapshot is
idle, after natural completion, or when the existing process disappears. While
active, it polls the small RPC `get_state` result once per second with a
five-second wait budget. It hydrates full history only when the control state
changes or first becomes idle, using the normal read deadline. All transient
reads on a handle are serialized; an abandoned read blocks further reads until
the host confirms its release, while retained Stop commands remain independent.
A confirmed `end_stop` receipt permits recovery without another history read.
Closing the handle cancels its read waits and abandons their results. A missing or ended
control attachment retries the normal drain once; failed cleanup remains a
visible error instead of an automatic retry loop. Replacement is replayed to
late raw and sequenced subscribers, including closure during initialization.

An idle snapshot alone does not prove that host-held interactions, queued input,
or native mutations are settled. If recovery returns the same control generation
with unchanged native evidence, the driver reports `reconciling` and keeps
polling without replacing it on every poll. Changed evidence or a confirmed Stop
permits another attempt immediately; unchanged evidence permits one retry after
30 seconds, because a host-held obligation can settle without changing the
transcript. Its warning directs the operator to review that
session's pending operations and stop its exact Pi process on the execution host
when an unresolved wait cannot otherwise finish. Unknown receipts remain unknown;
process exit and gap acknowledgement never make them safe to repeat. Pending
local Sedes calls also block automatic replacement until their completion or an
explicit Stop, because closing their handle would otherwise cancel the bridge.
Existing visible question panels are resolved only after confirmed Stop, not by automatic
replacement or a failed control read. Their response buttons may still appear,
but recovery rejects those responses. The shared Stop descriptor does not depend
on whether new input is supported; an idle session without an active turn does
not advertise Stop merely because retained obligations remain.

Attached drivers acknowledge durable event prefixes during a run after applying
the authenticated companion snapshot. A message or tool-progress prefix remains
retained until the snapshot contains its exact completed message or tool result;
an ended nested call rejected before the tool-call hook can instead use its
persisted parent result, because Pi does not attest those rejected children.
Attested or unfinished children still require their own completion evidence.
Applied extension notices can advance acknowledgement after delivery; unresolved
UI and agent-tool requests still fence acknowledgement. Later partial
streams remain available on reattachment. Operation outcomes use their separate
durable receipt acknowledgements. Closed-process draining consumes every retained
page through the attachment's advertised sequence before retiring the session;
the closed flag does not mark the end of paginated evidence.

Catalog probes admit at most 32 outstanding distinct authority/workspace reads,
including the active probe, and run one native process at a time. Equivalent
reads share their probe. Reader cancellation ends only that reader's wait.
Unproven probe cleanup fences subsequent launches until cleanup succeeds.

Completed cleanup retains compact exact handle receipts: 256 released handles
per host and 128 retired runtimes per persistent registry. These bounded
receipts make release retries idempotent after a lost reply or successful Stop.
They authorize only cleanup of recorded handles on the same authenticated
service; unknown or expired identities fail closed and never create a runtime.

The disk store limits a file to 64 MiB, its header to 1 MiB, and entries to
250000. Discovery limits a directory to 100000 entries, 10000 sessions, and
512 MiB scanned data. It retains at most eight 32 MiB discovery snapshots for
five minutes and admits four concurrent reads. Hitting a guard fails visibly.
Discovery fixes each file's read limit at its enumerated size and includes only
complete JSONL records. A valid final record without a trailing newline is
included only when the file remains unchanged through prefix verification;
growth during that read requires a retry. Same-inode growth after terminated
records is accepted only after re-reading and
hash-checking the captured header/history prefixes; unfinished appended records
wait for a later scan. Names, inode replacement, truncation, and prefix rewrites
still invalidate the scan. Writer locks, markers, and temporary files do not.
Invalidated scans permit up to three complete attempts under one byte budget,
including prefix verification reads; published pagination snapshots remain
immutable. History reads and fork-source lookup also capture complete prefixes
and verify their bytes while accepting append-only growth, so reattachment and
forking can observe an active writer. A history read uses at most two bounded
file reads. Create identity lookup and publication-receipt verification retain
strict file checks; an unfinished receipt file is never accepted as proof.

Focused tests are `pi-native-{configuration,backend-module,rpc-client,
rpc-companion,host,sidecar,disk-store,driver,history,authentication-key}` and
`pi-session-writer-lock`, plus the native backend-kind migration test. Changes
must exercise wrong-scope denial, lost responses, duplicate operation IDs,
malformed evidence, detached reads, and cleanup failure as applicable. Run
typechecks, the normal suite with host-specific sandbox exclusions, builds,
and applicable browser coverage through the repository's standard scripts.
The isolated `test:real-pi-native` suite uses a stock 1.4.0 executable selected
by absolute `SEDES_REAL_PI_NATIVE_EXECUTABLE` and loopback model/MCP fixtures.
The SDK live suites do not verify this backend. The separately authorized
`test:live-pi-native` gate requires `SEDES_RUN_LIVE_PI_NATIVE=1`, an absolute
`SEDES_LIVE_PI_NATIVE_EXECUTABLE`, and the exact AW Qwen provider/model pair,
low reasoning, and read-only tools verified before prompting in disposable
native sessions. It checks signed nested code-mode reads and detach/resume.
