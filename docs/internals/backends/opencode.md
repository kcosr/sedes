# OpenCode v2 runtime and native history

The OpenCode module and its native runtime are implemented under
`src/server/backends/opencode`. The production catalog registers the module alongside Pi, Codex, Claude,
and Grok. It supports discovery, attachment, native history, creation, Submit,
conversation-scoped Steer, Stop, rename, reviewed model/effort settings,
permissions, expressible native forms, skills, attachments/image delivery,
viewed images, Sedes MCP/CLI tools, owned thread execution variables, and manual
compaction. Native forks, commands, generated images, and managed TUI are
unavailable.
The normalized backend identity is `opencode`, its connection kind is
`opencode_http`, and the browser brand is `opencode`. Client protocol 128
includes these closed-enum additions and terminal Stop diagnostics.

Conversation, catalog and tool consumers use the provider-private
`OpenCodeNativePort`. Its closed read/mutation catalog carries validated JSON
data, exact workspace/session authority, immutable operation/sub-operation
identity and the original application deadline, when one exists. `OpenCodeNativeHost` dispatches those
operations through one host-local HTTP adapter. Native clients, callbacks and
resolved environment secrets do not cross that boundary. Directory discovery
can read session metadata; history, interactions and session effects require a
bound session port.

The host retains bounded mutation outcomes until acknowledgment after the
application's terminal receipt commits, including refusal and unknown outcomes.
Application acknowledgment covers all retained sub-operations, including dynamic
Stop withdrawals, and terminal replay retries a lost acknowledgment.
An acknowledgment for still-pending native work records release intent; the
owner keeps responsibility and evidence until that work settles. Cancellation ends a caller's wait without
repeating or retracting an admitted write. Reusing an operation identity with
different input or a later deadline is rejected. Control operations reserve
their own queue and retention capacity, with small reservations for fixed-size
control responses. Ordinary operations do not acquire an artificial deadline
from receipt age; Stop preserves its explicit original deadline. Unused scopes
are reclaimed after leases, observations, retained mutations, and native work
evidence release them. Prompt and compaction dispatch pin the scope before the
HTTP response can race the first native event.
Owner retirement fences existing ports
before native cleanup; a retry after owner loss remains unknown.

The execution host owns one resident native SSE subscription. Each admitted
thread has a bounded evidence journal, dense sequence, continuity token and
compact native proof baseline. Main commits receipt evidence and its observation
cursor in one transaction before acknowledging the host. Carrier loss does not
end native observation; native SSE loss explicitly invalidates continuity.
Main acknowledges once per committed replay batch. Evidence retains full input,
execution-terminal, step-boundary, deletion and revert events; other durable
payloads become compact sequence/fingerprint facts. Native presentation still
receives the full events. Cached historical proof facts are reclaimable across
scopes; pending execution and input markers are not. Positive root completion
can clear uncertainty caused by a native stream break. After reconnect, bounded
native inventory reads reconcile known pending and work markers against their
exact owning session and location; inbox reads precede activity so a promoted
input remains retained while running. Read cuts are identity-, continuity- and
lifecycle-fenced and change no application receipts or approval authority.
Settlement IDs are captured before host routing in a bounded map and invalidate
matching in-flight positive inventory, including gap-born children and shells
whose start was missed,
so stale inventory cannot resurrect completed work. Failed reads retry separately
for each owner with exponential delay from one second to two minutes, stopping
after ten failures. Only a new native break/reconnect starts a fresh bounded
cycle. Backend inspection and automatic service polling do not reset it.
Inventory fence races retry without spending the read-failure budget; unrelated
session settlements do not fence a scope. Settlement-map overflow retries
conservatively without resurrecting work. Other owners continue reconciling independently.
Unobserved dispatch pins, exhausted retries and collapsed unknown inventories
remain conservative; failed reads never prove retirement. An operation
acknowledgment alone never proves that native work ended.

Presentation subscribers have separate bounded queues and cannot acknowledge
operation evidence. When their shared byte budget fills, the subscriber holding
the most queued data must resnapshot. Retention exhaustion for unacknowledged
critical evidence prevents new ordinary work while preserving the independent
control path.

The persistent sidecar advertises the private `opencode_runtime` capability on
Linux. Its registry owns the same runtime/host used locally; SSH and outbound
carriers share typed operations and the bounded runtime body channel. Carrier
detach releases ports and subscribers, preserving the native owner and evidence.
Existing-only recovery can reopen exact retained thread authority after a
configuration change, but cannot create scopes or submit new work. Backend
administration can inspect and explicitly retire the original owner even after
desired native paths change. Scope acquisition, evidence recovery and controls
have a separate lane from ordinary history/body requests. Observations multiplex
into at most two polling requests per carrier, with bounded aggregate responses
and separate evidence/presentation purposes. Closing one subscription cannot
invalidate another thread's poll. Stop confirmation binds the runtime identity,
generation, ownership and state, so streaming text cannot continually invalidate
a confirmed Stop. At the environment service boundary, stock OpenCode remains
conservatively unknown for automatic retirement; forced confirmation is stable
for the exact native owner while detailed inspection and abandonment evidence
continue to report retained activity.

Remote product admission remains disabled pending full remote qualification.
The resident host and tool relay are implemented and qualified through private
test composition; remote OpenCode is not yet a Settings-supported topology.
Pi, Codex, Claude and Grok retain their existing backend contracts.

## Native ownership

The exact admitted release is OpenCode **2.0.18**, with the generated
`@opencode/client` package pinned to that same release. Qualification uses
upstream source revision `cd9a14a6b688d4021bee381dfd39d2cef9c0f862`. An owned
backend requires an explicit absolute executable path. On the reference host
that executable is `opencode2`; Sedes never searches for the older `opencode`
executable as an alternative.

| Mode | Connection | Lifetime |
| --- | --- | --- |
| Owned | `serve --stdio --hostname 127.0.0.1 --port 0`; stdout announces the HTTP endpoint, and stdin controls process lifetime. Application traffic uses authenticated HTTP and SSE. | Conversation references can reach zero while the daemon and its background work remain alive. Explicit backend Stop, Restart and main shutdown retire the owned process. |
| External | Authenticated HTTP to an explicit loopback IP literal and port. DNS, remote endpoints, URL credentials, redirects, query strings and endpoint paths are rejected. | Disconnect closes Sedes subscriptions and releases its lease. It sends no native interruption and leaves the external daemon and background work running. |

Both modes require a local Linux execution environment and the same OS account
as Sedes. Admission records PID, process start time, executable identity and
canonical database identity. Subsequent identity changes revoke the connection;
an endpoint alone never proves continuity. The configured database path is an
operator declaration where the native API cannot prove which store it opened.
An observed `OPENCODE_DB` must resolve to the declared store. Without that
variable, an open database named `opencode.db` or `opencode-<channel>.db` in the
native HOME/XDG data directory must have the declared store's inode. Conflicting
evidence rejects admission conservatively. The server API omits its compiled
channel; absent such an open file or explicit override, Sedes retains the
operator declaration instead of guessing the default filename.
An unlinked native descriptor still counts as conflicting evidence after a
replacement file appears at the selected pathname. Literal filenames ending
in Linux's ` (deleted)` suffix are distinguished using descriptor/file identity.
Symlink and hardlink store aliases are rejected. Other operating systems and
remote execution environments have no qualified identity/cleanup path here.

The adjacent, private store lease excludes another Sedes runtime using the same
store. It does not lock out independent native OpenCode processes. The operator
must select external mode for an existing owner. Unconfirmed cleanup retains the
lease; Sedes does not steal it or launch a replacement over it.
The versioned lease records the hosting incarnation, ownership kind, exact
owner-process identity and the owned descendant marker. A dead external owner
can release only its proved exact lease. A dead owned owner requires proof that
its marked descendants are gone; uncertain or malformed records retain the
fence. Explicit host recovery reinspects the exact record and process identities
before signaling positively identified descendants or releasing the lease.
Failure while first writing the lease record removes only the proved newly
created directory and partial record. Unknown directory/file identity, changed
ownership or unexpected remnants retain the fence for operator inspection.

Owned shutdown first tries bounded native session interrupts, then closes stdin,
then escalates through TERM/KILL and verifies descendants. Process identity and
an inherited ownership marker identify detached children. Processes deliberately
stripping that marker before escaping cannot be inventoried without OS
containment; this is a same-account trust boundary, not a sandbox. Cleanup never
deletes native history or credentials. A clean restart keeps the store and
acquires a new runtime generation. Incomplete native interruption and unproved
process cleanup are distinct outcomes.
Cleanup signals positively identified children even when another process's
ownership cannot be proved. A new same-account non-dumpable orphan can remain
ambiguous and keep restart fenced after all identified children have stopped.
Sedes reevaluates that uncertainty during bounded cleanup. Explicit Stop can
retry cleanup using the retained owned-process handle after the ambiguity
resolves; it never starts a replacement owner or steals a lease. A failed
startup retains a retryable cleanup callback when the launcher can still prove
its owned descendants; otherwise operator inspection remains required.

## Configuration and authority

Backend configuration requires `nativeStorePath` and one closed `connection`
shape. Owned connections contain `process_stdio`, `executablePath` and
`workingDirectory`; external connections contain `http`, `url` and a Basic
authentication secret reference with the fixed username `opencode`. Connection
defaults contain separate model and variant selections. Variants are not
implicitly reasoning-effort values.

External credentials resolve in the execution environment from an approved
`SEDES_OPENCODE_…PASSWORD…` variable or an approved protected file. Password
validation has its own purpose; Codex capability-token namespaces and validation
remain separate. Protected-file resolution preserves canonical-path, owner,
mode, inode and replacement checks. Password values remain private to the native
client and never enter browser configuration, fingerprints or diagnostics.

Owned startup generates a password and preserves the account's HOME, native
authentication and configuration. An explicit configuration directory overrides
the default `${XDG_CONFIG_HOME:-$HOME/.config}/opencode`. It derives
`OPENCODE_DB` from the admitted store and rejects a conflicting override, forces
`OPENCODE_DISABLE_AUTOUPDATE=1`, and removes inherited process-mode/password
controls. The selected configuration directory replaces inherited
`OPENCODE_CONFIG_DIR`. Both ownership modes reject simulation and incompatible
config/client/model-URL profiles during admission.
Owned launch removes all ambient `SEDES_*` variables before installing its
private runtime ownership marker. Native tools therefore cannot inherit another
Sedes thread's capabilities, an MCP channel credential or another backend's
Sedes-managed secret. Generated per-thread CLI variables enter only the exact
admitted session's separate shell map.

Native project configuration, plugins, hooks, MCP registrations, provider
credentials, custom models and saved permission grants remain operator authority.
Sedes does not rewrite them. Tools already allowed by native policy may run
without a Sedes interaction. The pinned source inventory found only retained
configuration/migration fields for `share`, `autoshare` and `share_url`, with no
active core/CLI/server sharing producer; no active telemetry producer was found
in that scope. These observations are release-specific, not promises about
plugins or future releases.

Native binding and operation evidence are private scoped tables. A binding
includes principal, backend, connection, environment, canonical workspace,
native namespace and session. Operation identity and request fingerprint are
immutable before dispatch; accepted or proven-not-applied outcomes cannot be
reopened. Create/fork destinations are deliberately unbound until their result
is validated. Later mutations must match the exact persisted session binding. First Send
may use a provisional binding only when its active scoped attempt, application-
reserved native session ID, accepted creation receipt, immutable settings
snapshot, source, and private binding detail all match. There is no general
adoption authority in a native metadata marker.
Changing the configured database changes reserved native identity; changing an
endpoint updates the runtime configuration revision and requires fresh admission.

## Shared control and verification

Native discovery validates the canonical workspace and returns private,
scope-bound binding details. It performs no native mutation. Attachment requires
the persisted tenant/principal/thread/backend/connection/environment/store/session
binding before acquiring the runtime. A native session move or deletion revokes
that handle and its control without stopping the daemon; fresh binding validation
is required. Stop independently revalidates session location and native ownership
even if its event was missed.

The native API validates the pinned official message/event schemas. It waits for
`server.connected` before reading history, with no SSE replay assumption. EOF,
malformed events, overflow or historical mutation invalidate the projection.
Recovery acquires native history, pending inputs, interactions and activity again;
it never resends a native effect. Lifetime invalidation remains visible on the
separate raw subscription while snapshot hydration is pending.

Only `/api/event` and the finite native input-log route use the provider-private
SSE framing reader. The official 2.0.18 client hardcodes a 16 MiB decoded buffer,
including several frames received in one chunk, and offers no override. The
local reader enforces 32 MiB UTF-8 line/frame bounds, preserves finite EOF flush
and multiline framing, and rejects malformed JSON/UTF-8. Payloads still pass
the pinned official event/log schemas. Every observer owns an authenticated
connection and cancellation lifetime; there is no multiplexing, automatic
reconnect or event replay at the transport layer. Ordinary requests and native
mutations continue through the official client. A configurable upstream SSE
frame bound would remove this local framing requirement.

Each resident handle retains one complete, disposable native-history projection.
Initial acquisition reads to a captured finite head, validates continuation
anchors, and catches up by refreshing mutable records, exact records identified
by durable events, and the retained head before following native forward cursors.
A completed assistant can reopen on a native retry or receive a late tool result;
completion alone is not an immutability guarantee. A retry that changes the
record's creation anchor triggers a fresh projection generation.
Live durable changes reuse the retained native cut and unchanged
closed-turn projections; text fragments update only affected normalized items.
Child execution and attributed shell changes refresh the scoped activity inventory
without reading parent history. Paging and lookup operate on the retained
projection and cannot consume live events. It does not write a transcript mirror. Limits are 32 MiB per
HTTP response, 96 MiB aggregate decoded acquisition/projection, 100,000 acquisition
records and 60 seconds through final selection. SSE buffering is bounded to
4,096 records/32 MiB; the normalized event journal remains 4,096 records/16 MiB. A single whole turn must
fit the shared 16 MiB page limit and item-count limit. Fixed-limit failures are
explicit and non-retryable; results are never silently truncated to fit history.

Native idle records close busy periods. A period's opening record gives it a
stable private turn identity, including settings-only openings. Whole-turn
pagination and targeted older-turn lookup share that complete retained history.
Cursors bind scope, projection generation, finite history frontier and selected
prefix; appending later turns preserves an older cursor, while changing its
prefix or owner invalidates it. Missing active execution alone cannot settle an
unfinished period: an orphan remains disconnected/in-progress until native
terminal evidence arrives. Settings-only suffixes do not claim running ownership.

Text and reasoning use separate native ordinal counters. Observed deltas are
disposable overlays; final native values replace them, including empty text.
After prefix loss, the final value repairs the transcript. Native inputs receive Sedes delivery provenance only from an exact private
input receipt and positive consumed-input evidence. External native inputs
receive none. Observed child sessions and attributed
shells refresh background counts; this is not a complete inventory of native Jobs.
Idle client eviction releases the handle while keeping either native owner alive.
Archive/policy residency release refreshes observed activity and refuses busy or
unknown state without cancellation.

Conversation Stop borrows already-published control before history hydration. A
per-owner fence serializes native Send/Steer calls with Stop, including first
Send, while history and queue acquisition stay outside that fence. A failed
initial projection retains control within the normal retention period, permits
exact force reset and remains reclaimable under runtime-budget pressure. Missing
history never proves native idle state. See the
[backend contract](../backend-integration-contract-rules.md) for deadline,
reconciliation, queue and automatic-detachment rules.

Deterministic tests cover schema/authentication boundaries, release mismatch,
HTTP response limits, runtime identity replacement, native store leases and
scoped operation evidence. Opt-in isolated native tests use stock `opencode2`
2.0.18 with fixture-owned state. They verify owned startup, malformed/expired
readiness, background-shell survival after reference release, external
Disconnect, detached-descendant cleanup, retained database identity and restart.
History qualification also exercises the actual driver/handle/actor with native
multi-turn history and a deterministic loopback model: older-turn lookup during
streaming, delta/final replacement, stable cursors and native interrupted-idle
evidence after Stop. Deterministic actor tests cover stalled hydration, request
cancellation, overflow/reconnect, fixed-limit failures, lifetime revocation and
background-safe eviction.
These tests do not require authenticated model requests or use an operator's
running OpenCode server.

## Delivery and mutation evidence

Creation reserves a provider-valid native session ID derived from the
application attempt. A scoped immutable creation receipt and settings snapshot
precede the single POST. Readback must match that ID, workspace, model and
private creation fingerprint before adoption. A missing session after an
ambiguous request is not permission to create again.

Each Submit/Steer snapshots desired settings and reserves an exact native input
ID before dispatch. The independent input observer subscribes before effects
and records native prepared-payload admission separately from consumption.
Prepared native transformations are allowed; a conflicting later payload blocks
correlation. HTTP admission alone leaves the Sedes operation pending. The
bounded consumption wait is one second after acknowledgment; the observer
continues independently of projection hydration and actor mailboxes.

Positive consumed input is published through the optional normalized
`onSubmissionObserved` callback, under the actor's current control/lifetime
fences. Shared first-Send finalization verifies the original attempt and
source. Ordinary queue and Steer reconciliation match the exact operation.
Publication work is deferred outside observer callbacks to avoid actor/mailbox
cycles. Pi, Codex, Claude and Grok retain their projected-item correlation paths.

The native prompt has `queue` or conversation-level `steer` delivery. Its
private receipt never manufactures a native turn ID. History groups busy
periods using actual native records; private consumed-user correlations supply
delivery/completion provenance even when several steers enter one period.

Stop uses one original absolute deadline for native interruption and pending
input withdrawal. Its accepted acknowledgment proves only interruption command
acceptance. Exact inbox DELETE alone is insufficient withdrawal proof: stock
OpenCode returns a successful no-op after promotion. Exact Cancelled evidence
or a gap-qualified, event-anchored Revert proves withdrawal. Positive consumed
evidence survives later history deletion and wins over absence. Cleanup failure
leaves that input unresolved; only a new explicit Stop may attempt it again.
The private Stop receipt survives handle replacement and cannot cancel later
work through replay.

On loss of the original continuous input subscription, the replacement
subscribes first, then reads inbox, then the exact native message. A surviving
pending input remains unresolved; exact user/Delivered evidence is accepted.
If neither survives, the bounded finite experimental event log is additional
evidence only. Its final `log.synced` watermark and EOF must validate, sequence
gaps remain explicit, and a watermark alone proves no event payload. Stock CLI
2.0.18 disables event persistence by default, so this read usually has no
replay payload. With no surviving proof, lost tracking becomes `failed_unknown`;
a healthy pending tracker never does so solely because time passes. There is
no automatic resend or late-acceptance path for terminal ordinary Submit.
Private lost-continuity markers and conflicting evidence stop automatic input
polling and do not retain an otherwise idle actor. They never prove withdrawal.
Explicit recovery or later exact positive native evidence can still update the
private proof; a payload conflict remains unresolved and grants no correlation.

Rename and model/effort changes reserve immutable private intent, perform one
native effect and read back its exact result. Desired settings revisions change
only on desired writes; observed native selection is separately generation- and
revision-fenced. Imported desired settings remain null until explicit selection.
Arbitrary native variants are readable but not runnable through Sedes. Model
IDs qualify provider plus model; effort mapping admits only the reviewed full
OpenAI chat/Responses variant overlay, rejecting extra conflicting settings.

Interaction mappings bind tenant, principal, thread, native session, runtime
generation and request fingerprint. Native permission IDs and form option values
stay private. Responses reserve immutable intent before their effect and
revalidate native identity around network reads. An exact terminal form answer
or cancellation can recover a lost acknowledgment; disappearance of a
permission request cannot. An external client's settlement removes the gate
without creating a Sedes operation receipt. Unsupported session-owned forms
receive one exact automatic cancellation; global unowned forms receive a notice
and no effect. Permission cancellation without native rejection is unsupported.
Known direct-child gates produce an inspection notice without granting the
parent authority to answer them; unrelated sessions are ignored. An unresolved
dispatched reply blocks any new reply, including force-reset cancellation, until
its native result can be proved. A never-dispatched attempt permits a fresh
response. Settlements observed while projection is disconnected are replayed
on re-establishment so stale interaction panels close.


## Per-call Sedes tools

`OpenCodeAgentTools` holds main-side admission independently of actor handles;
`OpenCodeHostAgentTools` owns the helper registration and routing on the native
execution host. Only an exact accepted private create receipt, matching settings
snapshot, current binding, and non-reset first-input creation attempt admit a
root. First submission uses the same exact provisional authority. Sibling
threads share a native runtime/location registration, never a mutable current
thread field. Discovery lists three conservative gateways without a session;
every call resolves an immutable client from `ai.opencode/sessionID` metadata.
The provider-private loopback ingress runs beside OpenCode, authenticates its
channel before routing, and validates exact scope, binding, runtime generation
and native location. Main applies current Sedes tool policy. Local source
references use the management audience; sidecar references use the execution
environment audience. Their authenticated presentation selects MCP or CLI.

Main admission retains an exact runtime lease until release. Host tool admission
also retains its native scope, keeping source routing and invocation evidence
available after carrier detach or main restart. Releasing a remote facade does
not revoke the host route; native-owner retirement or a newly validated admission
ends or replaces it. Routing alone does not create a main input observer.
Conversation handles and active approval invocations share one observer per
exact owner/binding, with independent reference-counted leases. Closing the last
handle releases the observer only when no invocation still borrows it. These
observers consume the host's resident journal, not one native SSE connection per
thread.

For each invocation the host synchronously captures an immutable private stamp
before awaiting native validation or relay delivery. It names the exact runtime,
generation, workspace and session binding, observation journal and sequence,
native continuity, current input and authority epoch. Host CLI ingress resolves
its already-admitted opaque source capability to the same stamp. Local MCP and
CLI use the same authority checks; remote calls cannot substitute a stamp sampled
later on main.

The private `opencode_tools` reverse operation carries that stamp beside the
canonical tool request. It requires both the OpenCode runtime capability and the
existing `agent_tools_cli` grant. Source resolution, policy, approvals, invocation
and result projection continue through the shared canonical relay; catalog and
description use its existing operations. Unstamped OpenCode invocation through
the generic reverse operation is rejected. Cancellation and carrier loss do not
replay a tool call. A lost response after dispatch reports an uncertain outcome;
a missing upstream reports unavailability.

The stdio helper is bundled as `sedes opencode-mcp`. An authenticated lifetime
stream fences child invocations with a current stream ID, emits heartbeats every
500 ms, and uses a 3-second child watchdog. Replacing or losing that stream
cancels outstanding calls/approvals. A disconnected channel can be reclaimed
within its 10-second startup window; expiry revokes it. A fresh registration
waits only until three seconds after the actual revocation, rather than starting
another watchdog interval when a later admission notices it. The registration
uses a new high-entropy name and an absence inventory preflight. Stock PUT is
unconditional and native GET has no ownership token, so no existing entry is
replaced, removed, connected or disconnected. Unknown PUT acknowledgment does
not trigger another registration. Per location there are at most eight channel
admissions per host-runtime lifetime, with 64 total and a 256-entry inventory
bound. Failed rows can accumulate across host-runtime restarts and require a
native restart.
The native MCP execution timeout is 24 hours, distinct from bounded startup,
catalog, transport and lifetime checks. No MCP readiness sleep gates messages.

`SedesMcpServer` resolves one source client per request and passes it explicitly
through catalog, description and invocation. Framing, cancellation, schemas,
gateway effects and output projection are shared with existing providers.
The private request/reply transport and child decoder use the canonical 4 MiB
plus 64 KiB envelope limit (4,259,840 bytes), so the bridge preserves a completed
canonical-size result. Shared JSON structure, node and individual-string bounds
still apply independently; this does not make every JSON shape below 4 MiB valid.
There is no generic route accepting the OpenCode channel credential. Only the
child receives it; native session environment injection carries CLI references,
not the shared channel credential.

Interactive cross-boundary access additionally acquires the provider's current
input authority. `OpenCodeInputObserver` commits evidence through the stamped
observation cut and requires the same native continuity, current input and
authority epoch. Exact private dispatched user provenance, consumed-input
evidence and prepared payload proof must agree without conflict. An intervening
native or automation input cannot borrow old user provenance, even if another
Sedes user input follows it before main handles the call. Replacement input,
terminal execution, revert, deletion, native event gaps and binding/runtime loss
invalidate pending approval leases. Cold history alone does not establish which
input was current at invocation. The generic source service checks this optional
lease before and after approval; scope-limited calls needing no access-boundary
decision do not require this input proof.

An invocation can lazily recover its observer when no actor or main admission is
resident. The current backend module reconstructs the thread, workspace and exact
native binding from durable application records, validates creation provenance,
then borrows the retained owner and catches up its journal. Recovery neither
launches a missing daemon nor registers MCP, writes session environment variables
or replays a prompt. A later ordinary runtime start separately checks current
configuration before permitting new work. Missing retained identity, mismatched
stamps or changed bindings fail closed. CLI ingress resolves this hook from the
current server-owned backend module on every call, including references issued
before a main restart.
Pi, Codex, Claude and Grok keep their existing approval authority behavior.

A pending access decision also holds the shared `ThreadRuntimeCoordinator`
approval borrow through the approved invocation's completion. This existing
canonical-operation reference blocks both retention and pressure eviction, even
when the native timeline is idle. The invocation also holds its own observer
borrow, so actor detach alone does not revoke valid approval authority. Invocation
cancellation, helper-channel revocation, carrier loss or native authority loss
ends the outstanding call; reconnect never replays it. Idle routing admission
alone holds no approval borrow.

Native permission responses retain the complete native action fingerprint;
only an exact known Sedes registration/gateway receives a readable Sedes title.
Native allow/ask/deny and Sedes policy remain independent authorities. Imported,
child and forked sessions are unmapped until a separately qualified admission
path exists.

## Thread environments and manual skills

The module-owned execution-environment service reads the thread's immutable
application snapshot. Nonempty definitions require an owned local runtime and
are rejected for external mode before secret resolution. Before explicit idle
Submit or compact, the service qualifies exact binding, runtime generation,
root location, no native pending input/interactions or running children/shells,
and a final native subagent-deny rule while preserving earlier operator rules.
It sends frozen definitions to the host, which resolves secrets and installs
the complete shell map from the applied launch baseline, thread overrides and
generated CLI values last. PATH uses that same applied baseline, with the
helper directory prepended for CLI. Values are not stored in operation receipts
or environment fingerprints. Session release ends the caller's preparation and
prevents its subsequent prompt. An already admitted host mutation may finish
within native request bounds and any original application deadline; closing
the native owner cancels it.
Compaction calls this preparation before its final native settings/control
checks and dispatch. Replaying an already admitted compaction does not rotate
secrets or send another request.

The shared presentation catalog is a backend/environment capability ceiling;
it does not qualify a particular native root. A stored CLI selection on an
external/imported root, or with an unavailable local CLI endpoint, yields no
generated credential or environment injection and publishes an actionable
unavailable-tools notice. Ordinary Submit/Steer and controls continue. Nonempty
user execution definitions on external runtimes still fail before secret
resolution; withholding an unsupported tool surface never drops those variables.

A Steer cannot rotate that map during work: it requires the already installed
current incarnation. Native children do not inherit the session map and cannot
be spawned where required variables or CLI credentials would otherwise be lost.
The volatile map is reinstalled after owned restart. An imported empty snapshot
preserves the native map; an imported owned idle root with nonempty frozen
Sedes definitions can receive them on explicit Send. Importing does not adopt
current defaults. Qualification covers stock CLI directory-root sessions. The
public location omits workspaceID, so its directory alone is not evidence that
an arbitrary native workspace-driver session has this shell-environment contract.
Stock CLI registers no workspace drivers; such custom host integrations are
outside the qualified topology.

Skill discovery uses the ordinary scoped/authenticated catalog call and exposes
bounded names and descriptions without native source paths or instruction text.
Opaque selection IDs bind the connection, native store and workspace. Send
resolves the selected ID against the fresh native catalog before dispatch, then
uses ordinary `prompt.skills` so native prepared instructions belong to the
exact input. Missing selections fail before Send; dispatched replay does not
resolve changed instructions or resend. Explicit manual selection can use skills
marked against automatic invocation, matching stock native semantics. Native
command dispatch remains unsupported because commands may launch other work or
change session state outside this exact-input path.

## Images and manual compaction

Composer attachment identity uses the scoped owner's ordered path-free evidence.
Only that owner's byte reader supplies native raster data URIs; agent paths are
never treated as Sedes-local read authority. An authenticated staged-file
manifest remains in the native prompt for filesystem operations. History strips
that carrier and emits public attachment descriptors only with the exact private
consumed-input correlation. Native-only or invalid carriers do not disclose
staging paths. Selected native model capability gates image admission.
The combined decoded image bytes in one input are capped at 16 MiB before
reading bytes, reserving its input receipt or dispatching. Multiple smaller
images may share that budget; ordinary staged-file bytes do not consume it.
Stock admission responses, events and user records inline every image, so the
generic composer's 64 MiB aggregate alone would permit an unreadable native
record. After byte validation and manifest construction, delivery also checks
the exact final native prompt's serialized UTF-8 JSON against 22 MiB before
reserving or tracking this input, or dispatching it.
This includes the 1 MiB raw prompt after JSON escaping, base64 images and data
URI prefixes, signed staging metadata, selected skill IDs and request fields;
the same bounded object is passed to the native mutation. A large escaped
prompt can therefore reduce the available image capacity below 16 MiB.
Four 22 MiB native charges plus up to 6 MiB of escaped projected user text
leave 2 MiB of the 96 MiB acquisition/projection budget for native envelopes
and normalized descriptors. The near-bound regression includes maximal
attachment metadata, one drained event, and both initial acquisition and
refresh. Each native response still has its independent 32 MiB bound.
The admission cap covers what Sedes sends: native skill/plugin expansion,
generated records and external inputs remain independently bounded and can
fail history acquisition explicitly.

Viewed-image recognition requires the exact `read` argument contract and raster
result grammar. It never rereads the path. The completed in-band bytes qualify
as `provider_input` only after a subsequent actual vision response, with a
conservative active-context inline-image bound at or below stock's 25 MiB
omission trigger. A local compaction resets that context; an opaque provider
checkpoint prevents new qualification until a later local reset. The retained
artifact association is scoped to store/session/message/tool/content coordinate
and survives source-byte disappearance; conflicting bytes cannot replace it.
The viewed row and its future child reserve stable source orders. Reads with
incomplete arguments or an extensionless path wait for a terminal result before
choosing a normalized item kind. Plugins can replace `read` or alter final model
context, and native history does not attest those producers or final media
lineage. This qualification assumes the admitted stock runtime and trusted
configuration, not arbitrary adversarial context hooks.

The pinned upstream `Prompt.Base64` schema uses a nested repetition regular
expression that exhausts V8's regexp stack on roughly 5 MiB encoded payloads.
The adapter derives its validators from the official encoded schema AST and
replaces only the identified Base64 predicate with an equivalent linear lexical
validator. All other official shapes and constraints remain intact. This needs
no native fork. An upstream stack-safe Base64 predicate would remove the local
workaround; persisted final-request media lineage would strengthen capture
provenance. The 32 MiB native response/SSE limit accommodates a 16 MiB decoded
raster's base64 expansion. Total acquisition still charges repeated reads and
projection against 96 MiB, so large or repeated native images can produce an
explicit history-limit error rather than a truncated transcript.

The acquisition increase from 64 to 96 MiB allows an admitted bounded image
input as the head through head/page/anchor reads plus one same-size drained
event and normalized projection, without adding
deduplication to cumulative work accounting. Two maximal-image events in one
undrained 32 MiB queue overflow and force resnapshot, even for the same image.
Additional history and repeated live evidence can still reach the finite bound.
The exact pinned Base64 refinement is checked during module loading; a changed
or augmented identified check throws `opencode_base64_schema_changed` and
prevents the server build from loading, rather than accepting a broader schema.

Manual compaction reserves an immutable exact native input ID before one POST.
A staged revert or existing foreign compaction blocks dispatch; a coalesced
foreign acknowledgment remains unknown. Exact typed inbox/history readback
proves admission after a lost reply, including when the native compaction later
fails. The normalized native record carries the actual terminal outcome.
Custom instructions are unsupported. Stop cancels only exact privately owned
pending controls within its original deadline; cancellation HTTP 204 never
changes admission into proof of withdrawal or successful compaction.


## Recorded usage

[`OpenCodeUsageAccounting`](../../../src/server/backends/opencode/opencode-usage-accounting.ts)
uses the installation-owned `SEDES_EXPERIMENTAL_USAGE=1` gate. Disabled capture
adds no native reads, subscriptions or normalization. Enabled capture reuses
ordinary retained history and performs bounded serialized session-counter GETs,
including on ephemeral native usage updates. Actor and read handles share one
refcounted source per exact native client/binding, with one latest pending
snapshot. Runtime generation, workspace and current application binding are
checked again before publishing. Accounting failure does not fail projection,
retry input, or block Stop.

The checkpoint is the sole session contribution. It includes native title and
compaction work, but excludes child sessions and lacks model/effort attribution
and an exact usage timestamp. Surviving terminal assistant/compaction messages
allocate only their proved busy-period turn; they never charge the session a
second time. Missing metrics stay absent; native zeros remain SDK-normalized.
Input is uncached input plus cache read/write; output is visible plus reasoning.
Safe-integer validation applies before normalization and to derived sums. Native
costs use the catalog's USD estimate; request cardinality remains unknown.

The stable accounting epoch survives reconnect and runtime restart. An accepted
private create receipt plus the exact current binding proves a Sedes-created
root's zero baseline. Other imports use their first observed lifetime counter
as an unknown baseline, charging only later increments. Copied child/fork
transcripts are withheld from turn allocation. Revert does not reduce native
lifetime totals or already captured work. Exact replay is deduplicated; a genuine
counter regression remains an accounting gap. Coverage is intentionally partial,
including explicit child/model and retained-history limits.
