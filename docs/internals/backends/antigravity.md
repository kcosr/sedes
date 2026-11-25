# Antigravity backend internals

Antigravity action persistence advertises application-owned rename separately
from its ACP capabilities (which still omit native rename). Migration 165 adds
a scoped `local_title_override` marker; local rename commits it with the title,
thread revision, inventory generation and operation receipt. Discovery honors
the marker without changing native state or model settings. Existing threads
retain native title refresh until explicitly renamed in Sedes.

The implementation is private to `src/server/backends/antigravity`. The browser
uses normalized backend contracts and the Antigravity brand, never ACP methods,
native database paths, protobuf records, or session identifiers.

## Ownership

Installation configuration selects executable/runtime compatibility. Principal
configuration selects the backend, connection, environment, model policy, and
defaults. A thread owns its desired model/reasoning/mode settings and opaque binding.
Native credentials, provider configuration, and transcript files belong to the
execution host. Bindings and submission signatures include tenant, principal,
backend, connection, execution environment, native namespace, workspace and
session identity. No browser-selected scope supplies authority.

Native namespaces identify the execution host and configured native store.
Two independent backend instances cannot claim the same native namespace.
Startup and execution environment overrides have explicit precedence; secrets
are resolved where the provider runs.

The native ownership claim reserves the entire execution environment for one
enabled Antigravity backend, regardless of configured profile path. Multiple
targets of that backend share the owner. This prevents default/explicit/symlink
profile aliases from bypassing duplicate-owner checks without filesystem I/O
during preparation. The signed binding namespace separately includes the
configured profile, so changing native stores cannot make an old binding valid
against a different profile. Distinct execution environments remain separate
execution authorities.

The versioned `antigravity.mode@1` feature saves exact next-turn native mode
preferences through principal-scoped, revision-checked application receipts.
Its closed actions expose only qualified values advertised in ACP's native
mode selector; submission rechecks that exact live selector before applying the
preference. Clearing the preference leaves the current native mode unchanged.
The feature deliberately reports desired state only, with no inferred effective
permission classification. Other backends do not advertise this feature.

## Transport and recovery

The reviewed shared ACP v1 binding owns framing, SDK validation and request
settlement. Antigravity owns negotiation and native interpretation. The same
host implementation runs locally and within the persistent SSH/outbound
sidecar. Remote adapters borrow exact runtime/owner generations and retain
operation outcomes and pending interactions independently of carrier lifetime.
A lease from a different service incarnation proves the bound runtime retired
with its predecessor. The remote port then releases its own handles locally,
and a disconnected handle stops polling for the retained owner. Background
activity confirmed idle before the disconnect becomes known-idle again unless
history read while disconnected revealed background work; anything else stays
unknown. Once replacement is proven, release needs no carrier. The handle vouches for provider-replacement
retirement only without receipts, permissions, requests or setters in flight.

The saved policy allows one Antigravity instance per execution environment. The
host registry independently reserves that native namespace. An ordinary lookup
preserves the resident configuration. A new host must match the installed
instance generation and launch digest. Adding a named target to the incumbent
takes effect on the current connection after the sidecar confirms the policy.

When a saved host had multiple enabled instances before policy migration, each
disabled candidate retains its original host and backend identity. Remote
recovery looks up those exact IDs through the authenticated sidecar, including
after the configuration is deleted. A local administrator can confirm retirement
of each unclaimed local candidate after checking its previous native processes.
This action requires a fresh impact token for that candidate and host. Its
receipt and the retirement proof commit in one transaction. A positively
identified incumbent retains ownership until its retirement is proved.

Each ACP opener records the tool endpoint used when it launched. The remote
adapter compares this opaque stamp to the current scoped route before preparing
tool instructions. After a tool withdrawal and regrant, active ACP sessions
continue and tool access requires a newly admitted native opener.

Creation uses provider-assigned identity and never blind-replays an uncertain
create. Submission evidence authenticates exact input bytes and normalized
presentation against the complete scoped binding. Identical text is not an
idempotency key. Uncertainty remains unresolved until exact evidence exists.

An acknowledged event is not an acknowledged permission response. Attachments
carry the live pending-permission inventory independently of event replay.
Each request keeps its host-assigned opening timestamp across projection
replacement and retained reconnect. An exact pending permission also supplies
active foreground authority on a cold attachment, allowing application
composition to show the approval state without requiring a fresh text chunk.
It does not make an already completed foreground turn active.
Acknowledged mutation outcomes remain readable while the host is retained,
without keeping it busy solely for an already-applied receipt.

Native permission decisions opt into a lifetime-cancellable human wait rather
than the shared ACP binding's ordinary 30-second reverse-request deadline.
Authorization and response writes remain finite, reverse-request inventory is
bounded, and session authority is checked again before publishing a decision.
Taking longer to decide does not itself close the provider or its background
work. Stop, request cancellation, and owned shutdown still cancel pending waits.

## Native history

`native-projection.json` is the reviewed field projection of protobuf
descriptors embedded in official `agy` 1.5.14. Its descriptor provenance is
recorded separately from runtime version admission; runtime compatibility is not
an executable digest allowlist. The decoder bounds bytes, nesting, fields and
integers and rejects changed wire types for known fields.

Verify a qualification artifact with `agy --version`, then run
`node scripts/antigravity/check-native-projection.mjs /absolute/path/to/agy`.
This checks projected fields and complete descriptor hashes, including protobuf
edition metadata, without executing the provider. The explicit
`--refresh-provenance` option updates descriptor provenance only after reviewing
the selected artifact; it never expands the reviewed field projection.

The SQLite reader validates native `trajectory_meta.cascade_id` against the
session, exact workspace metadata against the binding, and file ownership and
path before reading a consistent read-only snapshot. `trajectory_id` and
`root_conversation_id` are not aliases for the current session ID. Unsupported
native formats fail closed. A history read never uses `session/load` or launches
a provider to reconstruct a transcript.

The portable sidecar uses Node's built-in SQLite reader, with a read-only
connection and an explicit read transaction. Its source-ownership audit admits
`node:sqlite` only from this provider-private reader. Application repositories,
other database importers, and native SQLite addons remain forbidden in the
sidecar bundle.

Each scoped backend host owns a bounded native-history reader worker. Retained
read-only SQLite connections compare
[`PRAGMA data_version`](https://www.sqlite.org/pragma.html#pragma_data_version)
on the same connection; file identity and scope are checked before reuse.
Referenced child databases are checked independently, including previously
unreadable children. A parent database staying unchanged is not proof that its
descendants stayed unchanged. Cached reads retain the same aggregate evidence
budgets and fail-closed rules as cold reads. The worker owns SQLite acquisition,
protobuf decoding, hashing, and native validation; runtime retirement releases
its retained state and host shutdown closes it.
Caller cancellation and aggregate budget refusals preserve otherwise valid
caches. Failed passive workers restart only on later reads, with exponential
backoff from 250 ms up to 30 seconds. Explicit reader shutdown remains terminal;
worker replacement never launches or replays provider requests.
Cache hits refresh recency, and forgetting one session fences only that session's
in-flight cache publication. Serialized native size is measured once per changed
snapshot; aggregate accounting shares unchanged objects. Failed worker termination
retains ownership and shutdown can retry without reopening admission. Packaged
runtime verification performs an actual SQLite worker round trip.

History requests may supply the caller's `knownRevision`. Only exact equality
with the freshly checked native snapshot returns `null`; unconditional reads
must return a complete history. The same contract applies locally and over SSH
or outbound sidecars, avoiding unchanged payload transfer. No ACP event or quiet
interval substitutes for a native change check. The handle coalesces ordinary
refreshes to at most one per 250 ms, with fresh reads for initial projection,
submission anchors, recovery, the first post-dispatch check, Steer permission
wakeups and its final deadline check, and completed Stop. Idle polling
continues. One deferred refresh flushes a coalesced final event at the end of
the cooldown even if the next provider observation is still waiting; close or
loss of control authority cancels it. An unchanged native revision skips transcript projection, item
comparison, and successfully completed usage accounting, while transport state,
pending permissions, context usage, and retained operation receipts still
advance. Failed usage ingestion is retried against the retained snapshot.

Native step indices and fixed semantic slots provide stable timeline identities
and item ordering even when an earlier step acquires optional reasoning or text.
Ordering arithmetic rejects values outside the safe integer range. Antigravity writes
incremental output to SQLite during streaming, so live and historical views
share one projection. Prompt completion requires a terminal native planner
response or an exact executor termination receipt. Tool and standalone error diagnostics remain visible
without settling a turn or delivering its completion callback; the planner may
continue after a missing file, invalid range, or failed command. A token-usage
update, quiet interval, completed tool, or empty activity inventory does not prove
turn completion.

The reader also acquires bounded `executor_metadata` rows in the same SQLite
snapshot and includes acquired bytes in the native revision. Executor table
evidence has a separate aggregate allowance of 100,000 rows and 32 MiB across root and
child sessions, with at most 8 MiB per row; it never reduces the 100,000-step,
96 MiB history allowance. If a complete session's receipt set exceeds the
remaining allowance, all of that session's receipts are omitted and a bounded
capacity marker enters the revision. Partial receipt sets cannot prove
termination because an omitted row could contradict them. ID-less protobuf
defaults are hashed but supply no evidence. Malformed acquired records and a
missing executor table are unsupported native formats, not legacy fallbacks.
Only execution ID,
last step index, termination reason, and auto-continue disposition are decoded;
embedded native configuration and telemetry stay unprojected. A durable
`USER_CANCELED` executor receipt can finish a turn as interrupted, and an
`ERROR` receipt can finish it as failed, without a final assistant response when
it matches that turn's exact execution and last native step, all steps in that execution are terminal, and no auto-continue or conflicting
receipt exists. The final execution governs a multi-execution turn; trailing
native inputs proven unstarted do not advance the executed head. The same proof
settles background continuations and retires retained ACP tools only when no
newer activity invalidates it. A failed or cancelled tool step alone is
insufficient. Remote history carries this required evidence through `antigravity_runtime` capability
4; older peers fail capability negotiation because their derived child states
can mistake recoverable tool errors for whole-execution failure.

Executor termination reasons have explicit dispositions. The same exact
identity, frontier, terminal-step and no-auto-continue checks apply to every
supported receipt:

| Native reason | Receipt-only disposition |
| --- | --- |
| `ERROR` (1) | Failed |
| `USER_CANCELED` (2) | Interrupted |
| `MAX_INVOCATIONS` (3), `MAX_FORCED_INVOCATIONS` (6), `MAX_TOKEN_BUDGET_EXCEEDED` (11) | Failed; the executor exhausted its limit |
| `NO_TOOL_CALL` (4) | No receipt-only outcome; require the terminal planner response |
| `EARLY_CONTINUE` (7), `CHAINED` (12) | No receipt-only outcome; execution may continue |
| `TERMINAL_STEP_TYPE` (8), `TERMINAL_CUSTOM_HOOK` (9), `INJECTED_RESPONSE` (10) | Intentionally unsupported as receipt-only outcomes; the enum does not establish success, failure, or cancellation |
| `UNSPECIFIED` (0), reserved 5, or unrecognized values | No terminal proof |

Unsupported receipts leave incomplete turns reconciling and children unknown
unless a separate supported terminal response proves the outcome. Error text
never fills that evidence gap. A failed executor uses its standalone/planner
error diagnostic when present at the executed head, otherwise a generic failure;
it does not attribute the execution failure to an ordinary tool diagnostic.

Exact child-session reads apply the same executor proof before classifying a
cancelled tool tail as a cancelled child or a failed tail as terminal. Missing,
conflicting, or omitted proof keeps the child unknown and blocks quiescence. Embedded subtrajectories use
their own `Trajectory.executor_metadatas` (field 9), verified against the same
qualified native descriptor. Their bytes are already bounded and hashed inside
the enclosing step; the decoder's shared byte, field-count, and depth limits
apply to the complete embedded evidence, with no partial receipt set accepted.
Nested descendants retain their own activity and proof requirements. An
enclosing cancelled tool alone never establishes nested completion.
Ordinary terminal responses must have no outstanding tool calls;
explicit native failure and cancellation responses remain terminal evidence.
The same response rule governs consumption of child/timer wakes and retirement
of retained ACP tool work, so a tool-call response cannot bypass those fences.

Typed system-message receipts can begin autonomous continuation turns without
an application submission. They never consume a pending user operation merely
because text or timing is similar. Native child linkage and terminal receipts
govern background quiescence; finishing a child-launch tool is insufficient.

Conversation-scoped steering uses concurrent ACP prompt requests. A native user
row can be staged without consumption. Sedes requires native execution/start
evidence before publishing it, and carries each signed operation correlation
when several consumed inputs share one response. A short, one-second acceptance
window accommodates asynchronous native enqueue, but a pending permission wakes
and triggers a fresh evidence read before ending that wait so the actor can
publish and answer it. Missing
proof remains unconfirmed without replay; host dispatch is not acceptance.
Stop fences new admission and
drains its captured prompt set with repeated native cancellation until native
quiescence is proved. Only then can a retained cancelled outcome plus a fresh
native read return an unconsumed input as not sent. Permission rejection can
also cancel queued prompts: the host records their cancellation proof only after
all captured callbacks settle and a fresh native inventory proves quiescence
without intervening work. ACP callback ordering and usage fields never substitute
for that evidence. Force Reset acknowledges only terminal provider receipts whose
application operations were explicitly abandoned in the same tenant, principal,
and thread; it does not discard pending callbacks.
Queued input resets record an explicit scoped abandonment receipt before clearing
dispatch evidence, and First Send uses its creation mutation's reset marker.
Ordinary failures and historical diagnostic-only queue rows do not prove
abandonment. An absent provider operation can be cleared locally only after
explicit application abandonment; loss of carrier authority preserves uncertainty.

Stock `agy` 1.5.14 can cancel the original execution after a permission rejection
without replying to a queued concurrent prompt. Live qualification observed an
exact `USER_CANCELED` executor receipt and no queued input row while that prompt
remained pending. Sedes retains the unresolved operation: native quiescence does
not prove that the provider withdrew the queued request, and Force Reset does
not fabricate that proof. Live qualification recovered this case with an explicit
Stop, verifying the queued callback's cancellation receipt and subsequent prompt
admission. The application does not issue a hidden Stop to turn permission
rejection into cancellation of all work.

Accepted ACP events advance and acknowledge their cursor before passive history
acquisition, so a history-worker failure does not replay them. Reconnect applies
the retained permission inventory under serialization, with sequence and local
response fences preventing a stale attachment from reopening a resolved request.
After an SSH recovery attachment, selected permission options reacquire normal
configuration-checked authority on the same retained runtime. Cancel decisions
remain available through the retained control path.

## Cross-backend audit

Antigravity adds a compiled module, scoped persistence migrations, execution
configuration, normalized brand, Saved Agent and automation adapters. Existing
Pi SDK, native Pi, Codex, Claude, Grok and OpenCode retain their native protocols
and capabilities. No other backend parses Antigravity data. Unsupported
Antigravity operations return explicit errors and are absent from capabilities.
The shared recovery selector prioritizes an exact uncertain interaction response
behind an older uncertain Steer for all seven backends, only when no other
non-Steer uncertainty blocks it. Each backend retains its existing response
reconciliation implementation or explicit unsupported result. Shared client Stop
controls honor existing interrupt capabilities; no new backend capability is granted.

The [operator guide](../../operator/backends/antigravity.md) documents current
capabilities and upgrade requirements. Qualification uses fixture ACP peers,
native database fixtures, scoped persistence tests, transport disconnection
tests, and explicitly authorized disposable live conversations. Live tests must
never adopt an existing user session or expose cached authentication material.

Run the authenticated, opt-in stock-runtime suite only with explicit live
authorization. It selects an absolute executable and model, creates temporary
workspaces and fresh native sessions, references existing native authentication
without copying credentials, and deletes only its verified new session records
after proving owned process cleanup:

```sh
env -u NODE_ENV SEDES_RUN_LIVE_ANTIGRAVITY=1 \
  SEDES_LIVE_ANTIGRAVITY_EXECUTABLE=/absolute/path/to/agy \
  SEDES_LIVE_ANTIGRAVITY_MODEL=gemini-3.8-flash \
  SEDES_LIVE_ANTIGRAVITY_THINKING_LEVEL=low \
  npm run test:live-antigravity
```

Set `SEDES_LIVE_ANTIGRAVITY_GEMINI_DIRECTORY` only when the authorized execution
account uses a different absolute native profile directory. The separate
`SEDES_LIVE_ANTIGRAVITY_SSH=1` gate adds an actual loopback OpenSSH server with
new pinned host/client keys and a private temporary account home. It builds the
release sidecar, verifies background work and retained history after SSH loss,
and restores normal admission after controller replacement. This qualifies
the real SSH carrier and persistent service on one host; authentication and
executable availability on another machine remain that machine's responsibility.
The suite never changes the operator's SSH config or known-hosts file.
