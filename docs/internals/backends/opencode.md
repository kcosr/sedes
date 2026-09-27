# OpenCode v2 runtime and native history

The OpenCode module and its native runtime are implemented under
`src/server/backends/opencode`. The production catalog registers the module alongside Pi, Codex, Claude,
and Grok. It supports discovery, attachment, native history, creation, Submit,
conversation-scoped Steer, Stop, rename, reviewed model/effort settings,
permissions, and expressible native forms. Attachment/image delivery, Sedes MCP
tools, manual compaction, usage accounting, and forks remain unavailable.
The normalized backend identity is `opencode`, its connection kind is
`opencode_http`, and the browser brand is `opencode`. Client protocol 128
includes these closed-enum additions and terminal Stop diagnostics.

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
An abrupt Sedes crash can leave a stale lease that requires operator inspection
and removal after confirming the prior owner and its work have stopped.
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
startup that yielded no owned-process handle still requires operator inspection.

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
Owned launch also removes ambient `SEDES_AGENT_TOOL_*`,
`SEDES_OPENCODE_*PASSWORD*` and `SEDES_CODEX_*TOKEN*` variables so native tools
cannot inherit another Sedes thread's capabilities or another backend's secrets.

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
projection and cannot consume live events. It does not write a transcript mirror. Limits are 16 MiB per
HTTP response, 64 MiB aggregate decoded acquisition/projection, 100,000 acquisition
records and 60 seconds through final selection. SSE buffering and the normalized
event journal are each bounded to 4,096 records/16 MiB. A single whole turn must
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
