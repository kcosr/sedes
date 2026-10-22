# Codex execution settings, Speed, and Goal

Sedes keeps a complete, durable execution tuple for each Codex thread. The
tuple is the server-owned intent for the next create, fork, or turn; it is not
derived from browser state or mutable Codex global configuration.

Speed (the Codex service tier) is one axis of that tuple. Goal is a separate
provider-owned thread
feature with its own lifecycle. Both are projected through versioned provider
features and fail closed when the current Codex generation cannot prove their
state.

For everyday controls and workflows, see [Provider features for
users](../user/provider-features.md#codex). For installation policy and target
defaults, see the [Codex operator guide](../operator/backends/codex.md) and
[Configuration](../operator/configuration.md).

## Contract at a glance

| Concern | Authority | Durable state | Mutation boundary |
| --- | --- | --- | --- |
| Model and reasoning | Installation policy plus thread selection | Desired tuple and operation snapshot | Quiet thread |
| Speed | Live catalog, installation policy, and thread selection | `serviceTier` in the desired tuple and a separate publication receipt | Idle or an exact eligible active turn |
| Sandbox, network, approvals | Installation execution-policy ceiling plus thread selection | Desired tuple and operation snapshot | Quiet thread |
| Effective settings | Complete, generation-fenced Codex observation | Latest classified observation | Provider attach or notification |
| Goal | Bound native Codex thread | Provider state; Sedes mutation receipt | May run with active or queued work |
| Managed TUI convergence | Desired tuple plus current daemon and resource generation | Desired tuple remains authoritative | Post-commit external synchronization |

Sedes agent-tool grants are a separate application policy. A Codex sandbox or
approval choice does not grant Sedes tools, and a Sedes tool grant does not
broaden Codex execution authority.

## The seven-axis execution tuple

A complete tuple contains:

| Axis | Closed Sedes values | Notes |
| --- | --- | --- |
| Model | One admitted live native model ID | Must satisfy the backend model policy. |
| Reasoning effort | One effort advertised for the model | Policy matchers may constrain model and effort together. |
| Service tier | `standard`, `fast`, `ultrafast` | `fast` and `ultrafast` each require the model's live catalog to advertise that tier. |
| Sandbox | `read-only`, `workspace-write`, `danger-full-access` | Target defaults and thread selections must satisfy installation policy. |
| Network | `disabled`, `enabled` | `danger-full-access` requires `enabled`. |
| Approval policy | `untrusted`, `on-request`, `never` | Determines when Codex requests approval. |
| Approval reviewer | `user`, `auto_review` | Retained but inactive while policy is `never`. |

The policy axes remain independent except for the native unrestricted-access
constraint. Selecting `danger-full-access` enables Network in the same durable
mutation. The server rejects an attempt to disable Network while that sandbox
is selected.

`auto_review` is an explicit reviewer value, not a persisted “Auto” permission
preset. Sedes does not store named permission profiles. When reviewer `user`
is active, eligible requests use the normalized
[blocking-interaction](blocking-interactions.md) surface; `auto_review` routes
eligible requests to Codex's reviewer agent.

For `workspace-write`, the canonical thread workspace is the implicit writable
root. Sedes sends no additional native `writableRoots`. A nonempty observed
list is custom provider state even if it repeats the working directory.

## Installation policy and defaults

Two installation-owned policies contribute to admission:

- the backend's top-level model policy admits model/reasoning selections; and
- Codex module policy allowlists sandbox, network, approval policy, and
  reviewer values.

Each target supplies a complete default tuple inside those ceilings. A model
allowlist requires a fixed admitted target default. `catalog` or a denylist may
use the live catalog default, but the resolved value must still be admitted
before execution. `danger-full-access` is accepted as a configured target
default when the execution-policy ceiling allows it and network access is
explicitly `enabled`. Changing target defaults does not replace existing
threads' durable settings.

Policy is a ceiling, not mutable thread state. The browser presents only
allowed choices, and the server revalidates the complete tuple before every
durable enqueue and provider mutation. A stale client cannot bypass current
policy. Restart-time configuration reconciliation marks disallowed historical
choices unavailable; it does not silently replace them.

New drafts combine target defaults with the policy-filtered live catalog.
Sedes does not fabricate configured-but-unavailable models or substitute a
different model or effort when a default is rejected. Changing models
preserves Fast or Ultrafast only when the replacement advertises that same
tier; otherwise the service tier is durably clamped to Standard in the same
change. Sedes never steps Ultrafast down to Fast, because that would change
usage without a choice.

Model, reasoning, and permission controls are read-only while a turn or queued
input is active, or while mutation recovery is unresolved. Speed has the
separate exact-target admission below. Enabled automations do not
own or lock the thread configuration. This quiet-thread gate is separate from the
immutable-snapshot rule: even if desired state changes after an operation has
been accepted, that operation continues with its frozen tuple.

## Desired, effective, and unresolved state

**Desired** is Sedes intent for the next operation. **Effective** is the latest
complete provider observation classified against the reviewed Codex protocol
and tied to one positive daemon generation.

The two can differ while a setting waits for the next turn or while a loaded
thread is converging. The UI must not label desired intent as provider-
effective merely because the durable write succeeded.

Imported threads do not receive guessed settings. During attach, Sedes adopts
a complete recognized native tuple only if every value is allowed. Unknown or
custom values are classified per axis and prevent a complete desired tuple
from being claimed. A model-catalog or reasoning-catalog failure also leaves
execution unresolved. Send and Queue remain unavailable until the tuple is
complete and admitted.

Once Sedes has durable service-tier intent, it replays that tier after resume
because native rollout history may omit it. When the persistent runtime cannot
reattach an existing subscription, the native resume request also carries the
saved sandbox, approval policy, reviewer, and workspace-write network
configuration after revalidating them against the current installation policy. Replacing a UDS
connection can otherwise reconstruct a read-only session even while the
external app-server process and thread inventory remain alive. Rejected saved
security settings remain unresolved rather than being replaced with defaults.

When a native resume would replay a rejected policy on an idle or unloaded
thread, Sedes opens detached history without subscribing or injecting tools.
Execution stays disabled until the user selects an admitted policy. Persisting
that selection signals the owning handle to reestablish its subscription.
Active or system-error threads fail with a retryable reconciliation error
instead of installing a static history view. Native lifecycle notifications
invalidate a detached view so it cannot remain frozen across a turn change.

The native thread configuration maps network access only for workspace-write;
restoring a read-only thread with network enabled remains unsupported and can
adopt the provider's network-disabled response.

A retained session is reattached without replaying security settings. A native
resume of a still-subscribed session preserves its live provider settings, and
Sedes adopts the actual response. First-time imports without a desired tuple
likewise obtain their settings from Codex. Sedes does not force saved security
onto a live session owned by another client. A compare-and-set settings revision
protects the durable adoption write.

Losing the Codex daemon generation invalidates effective confirmation. A
complete attach observation or settings notification from the replacement
generation must confirm it again. Stale generations and partial observations
cannot update effective state.

The persistent runtime also orders settings notifications against resume
receipts. A newer settings notification received while a resume is in flight
must survive installation of the older resume response; reattachment must not
revive that response's security settings. A newer undecodable settings notice
invalidates cached settings without discarding the live subscription. Cached
reattachment then declines, and the ordinary native resume obtains fresh
authoritative settings. An older notification cannot repair the cache.

## Mutation, persistence, and provider application

Before a create, fork, automation dispatch, or turn starts, Sedes freezes the
complete tuple under the durable application operation ID. Restart and
recovery replay the immutable snapshot, not whatever the thread desires later.
The backend immediately rechecks policy, model and tier availability, and
cross-field constraints before crossing the provider boundary.

Codex-private mapping carries every axis on the applicable native request.
Sedes neither edits Codex's global configuration nor depends on provider-global
defaults.

For a setting mutation, Sedes commits desired state first. If a bound thread
is loaded, it then asks app-server to converge. No SQLite transaction spans the
external request. A failed, malformed, or stale provider result leaves desired
intent intact but cannot mark it effective.

The managed TUI follows the same rule. Launch receives process-local CLI
overrides, never a `config.toml` write. While Sedes owns a running TUI, the
committed tuple is also pushed through the single reviewed experimental
`thread/settings/update` shape so app-server and the terminal converge before a
TUI-originated turn. Failure to converge fences the terminal rather than
creating a second settings contract. See [Managed Codex
TUI](codex-managed-tui.md#settings-convergence).

## Speed

Speed is the provider feature `codex.fast_mode@3`. Its one `set_speed` action
accepts a normalized selection (`standard`, `fast`, or `ultrafast`) and either
an exact `{ turnId, activationId }` target or explicit `null`. Native thread and
turn IDs stay in the backend. Standard sends native `serviceTier: "default"`;
Fast sends `priority`, and Ultrafast sends `ultrafast`.

Every accepted choice saves the thread preference. For an eligible active turn,
it also publishes the choice with `turn/settings/update` for the next model
step whose settings have not already been captured. A running inference keeps
its settings. The response `applied` proves publication, not actual inference
use, latency, or provider billing. Idle selections synchronize native defaults
and never call the active-turn method.

Sedes supplies `config["features.step_model_switching"] = true` on native
thread creation and fork, and normal cold resume of a thread whose Sedes
creation provenance still matches its binding. It does not edit global TOML
or hot-enable a loaded session. Experimental API negotiation remains separate.
Native under-development warnings remain visible. Discovery uses the native
thread ID and recognizes this exact under-development flag; Fast and Ultrafast
also require their independent stable feature flags and advertised model tiers.
A loaded-session gate rejection latches active Speed unavailable until native
generation changes, even if discovery rereads enabled configuration.

An activation records the exact successful Sedes start's model and starting
tier, normalized application turn, and random token. It must still own that
native turn and generation, and its model must equal the desired model.
Reroutes, ownership replacement, recovery without a retained start, externally
started turns, native continuations, and active managed TUI work withdraw active
mutation authority. External UDS/TCP daemons and sidecar routes can still carry
eligible Sedes-started turns. A bounded positive-completion tombstone permits an
exact just-finished target to save with `target_finished`; missing authority is
never completion proof. A null target while work is active conflicts before
saving.

The actor mailbox owns asynchronous preparation, synchronous final admission
and the SQLite transaction, then one bounded publication. It resolves the
application turn using the same projector mapping as Steer. It does not hold
the native-effect fence, so Stop can proceed during an outstanding publication.
The immutable parent receipt means the local save succeeded. Its scoped child
tracks `ready`, `dispatching`, `settled`, or `uncertain` and distinguishes
`published`, `target_finished`, `rejected`, `not_attempted`, and `not_requested`.
The dispatch phase is durable before native I/O. Replacement executors close
abandoned ready work as unsent and dispatching work as uncertain; neither is
resent. Remote operation identity and native generation are reserved before
sidecar submission. Only that exact retained outcome can refine uncertainty.

`desiredRevision` advances only when the seven-axis desired tuple changes.
Speed's required capability `mutationRevision` equals it. Presentation revision
is a separate process-wide increasing sequence keyed by scope/thread/content;
activation and receipt changes advance it, ordinary token streaming does not.
Same-value reapplication has a new receipt but does not advance desired or
application-thread revision. The browser retains the original request envelope
in memory for exact receipt checks, bypassing fresh-action capability guards;
reloading discards that memory and reads authoritative state. An old result
never replaces a newer saved projection.

Native defaults converge only inside the actor mailbox with current-generation
positive native idle evidence, settled actor work, and Goal positively
inactive or disabled. The actor's projected-idle transition schedules another
check when native idle arrived before transcript settlement. Known interrupted
work receives a maximum 30-second
monotonic grace after generation replacement. A completion notification alone
is not idle proof. Each desired revision, native generation, and meaningful
support state permits at most one tier-only write attempt, followed by ordered
readback. Failure, uncertainty, or mismatch consumes the budget. A same-policy
refresh cannot trigger a retry loop. Observed external drift schedules a later
admitted check; it does not replay a captured settings object.

A frozen queued start retains its original tuple; input not frozen yet sees
the newest saved choice. Every Sedes start sends its frozen tier explicitly,
so an older delayed thread-default write cannot change that root turn's tier.
Across replacement native streams, delayed defaults can still affect native
continuations and subagent inheritance. Native Goal/recovery work can race
point-in-time idle evidence; it is not a native idle lease. Sedes does not block
explicit starts indefinitely or restart an external daemon to hide this limit.
On the qualified 0.162.1 and 0.163.0 binaries, an active default write preserves
the interrupted-turn snapshot; a managed daemon restart resumes that turn at
its original tier. A changed thread default is not proof that recovery adopted
it. Sedes does not intentionally issue an active default write.

Goal continuations and subagents use native root defaults, not the parent's
per-turn publication. Active Goal alone does not disqualify a known Sedes turn,
but continuous Goal execution can defer default convergence indefinitely.
Sedes Goal Create/Resume from stable idle with no active Goal first requires
confirmed idle defaults. Create/Resume during existing active work preserves
its native lifecycle behavior. For ongoing Goal work, pause, wait for settlement
and convergence, then resume.

The composer toggles directly between Standard and Fast while idle when those
are the two choices. Three choices always use a menu; an eligible active turn
also uses the menu with two choices, allowing same-value reapplication. Mobile
uses the corresponding bottom sheet. The icon and menu checkmark represent
the saved preference, with the tooltip “Applies from the next model step. Saved
for future turns.” There is no persistent result text, explanatory help,
receipt-check action, or pending/uncertain visual indicator. Exact receipt
reconciliation remains internal; the control does not track individual steps
or claim actual inference use. Pi, Claude, Grok, and OpenCode intentionally do
not expose Speed; they explicitly retain their own mutation authorities.

## Goal

Goal is the stateful provider feature `codex.goal@1`. It stores one objective
on a bound native Codex thread and exposes a closed browser projection:

| Provider-observed state | Available Sedes actions |
| --- | --- |
| Unset | Create |
| Active | Pause, Clear |
| Paused | Resume, Clear |
| Blocked, usage limited, budget limited, complete | Clear |

Create trims surrounding Unicode whitespace, rejects an empty objective, and
enforces both 4,000 Unicode scalars and 16 KiB of UTF-8. Create and Resume may
start agent execution; Pause and Clear do not. A successfully accepted Stop
also attempts a best-effort Goal pause, but Stop acceptance does not depend on
that follow-up succeeding.

Explicit user Create, Pause, Resume, and Clear controls send native
`origin: "user"`, so Codex records their user-instruction provenance in
model-visible history. The automatic best-effort pause after Stop sends
`origin: "automatic"`. Recovery reads postconditions without replaying a
mutation or inventing a second user instruction.

Goal is absent from unbound and creating threads. On attach, reconnect, or
daemon-generation replacement, `thread/goal/get` is the authoritative read.
Goal notifications are invalidation hints only: concurrent hints are coalesced
and followed by another authoritative read. Native thread mismatch, unknown
status, unexpected fields, unsafe counters, or invalid objective bounds
withdraw the feature rather than projecting partial state.

The in-memory projection is scoped by tenant, principal, application thread,
native binding, and daemon generation, with a monotonic feature revision. Each
Create, Pause, Resume, or Clear request must match the thread revision and its
explicit capability mutation revision. Goal actions are deliberately allowed while provider work or
Sedes queued input exists; the native Goal lifecycle, rather than the generic
quiet-thread gate, decides the valid transition.

Every mutation uses a durable receipt and a closed desired postcondition. The
receipt stores only an SHA-256 objective fingerprint and bounded state metadata,
never the objective text. If delivery crosses an uncertain external boundary,
Sedes performs an authoritative Goal read and accepts only an exact
postcondition match. Otherwise the receipt remains recovery-required and the
UI reports that uncertainty instead of blindly retrying.

Goal is provider state, not a Sedes Task, automation, execution setting, or
composer draft. The thread menu's **New with same settings** action copies the
execution tuple and agent-tool policy, but not Goal or managed-TUI state.

## Automations, saved Agents, and forks

Automations may use any complete Codex tuple available to a manual turn. Sedes
does not narrow sandbox, network, or approval values for automation. An
attended approval policy can therefore leave an automated turn waiting for the
principal. The immutable snapshot is revalidated again at dispatch. Enabled
automations leave execution-setting and Speed controls editable between runs,
subject to the ordinary quiet-thread checks. Same-thread automation uses the
thread's current settings when preparing its turn; retries retain that
operation's frozen snapshot. Fork automations retain the ordinary fork
settings-inheritance contract. Thread and settings revision checks reject
stale edits that race automation admission.

Saved Agents can carry the complete tuple, subject to the destination target's
current policy and catalog. The **New with same settings** action
revision-fences the source tuple and initializes an independent unbound draft;
it does not copy provider history, Goal, TUI lifecycle, or runtime
observations.

Native Codex fork capability requires a complete recognized effective tuple
confirmed by the current daemon generation and still admitted by policy. The
same private resolver supplies both capability projection and child
initialization, and the live catalog is rechecked immediately before the
native call. A policy or generation race therefore fails before child
creation. The child inherits the confirmed tuple; Fast or Ultrafast resolves
to Standard if the child model does not offer that tier. Custom or unconfirmed settings yield a bounded
unavailable reason rather than fallback defaults.

## Change checklist and verification

Any change to these contracts must audit:

- target defaults, model policy, and all four execution-policy allowlists;
- every create, resume, fork, turn, automation, saved-Agent, and managed-client
  mapping;
- desired/effective revisions, per-axis classification, and daemon generation;
- imported, custom, partial, stale, and generation-loss observations;
- immutable snapshot replay and post-commit synchronization;
- Speed capability discovery, catalog tiers, model changes, and Standard
  reconciliation;
- Goal bounds, state/action matrix, Stop interaction, receipts, reread
  recovery, and notification coalescing;
- active-turn, queued-input, automation, archive, and recovery gates; and
- explicit unsupported behavior for every compiled backend.

Follow [Backend integration contract rules](backend-integration-contract-rules.md)
for cross-backend changes. Run deterministic unit, integration, client, and E2E
coverage through the commands in [Development and
testing](../developer/development.md). Real Codex suites consume authenticated
provider capacity and require explicit user authorization.
