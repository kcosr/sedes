# Codex execution settings, Fast mode, and Goal

Sedes keeps a complete, durable execution tuple for each Codex thread. The
tuple is the server-owned intent for the next create, fork, or turn; it is not
derived from browser state or mutable Codex global configuration.

Fast mode is one axis of that tuple. Goal is a separate provider-owned thread
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
| Fast mode | Live catalog, installation policy, and thread selection | `serviceTier` in the desired tuple | Quiet thread |
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
| Service tier | `standard`, `fast` | `fast` also requires reviewed live-catalog support. |
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
preserves Fast only when the replacement advertises the reviewed Fast tier;
otherwise the service tier is durably clamped to Standard in the same change.

Settings and Fast controls are read-only while a turn or queued input is
active, while mutation recovery is unresolved, or while an enabled automation
owns the thread configuration. This quiet-thread gate is separate from the
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
because native rollout history may omit it. Other recognized settings remain
provider-authoritative during imported-thread adoption. A compare-and-set
settings revision prevents a concurrent browser change from being overwritten
by adoption.

Losing the Codex daemon generation invalidates effective confirmation. A
complete attach observation or settings notification from the replacement
generation must confirm it again. Stale generations and partial observations
cannot update effective state.

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

## Fast mode

Fast is the provider feature `codex.fast_mode@1`. The normalized contract has
only Standard and Fast; reviewed native tier identifiers remain private to the
Codex backend.

An unbound Codex draft advertises Fast only when:

- its selected live-catalog model explicitly advertises the reviewed tier;
- installation policy admits the model and effort; and
- the desired seven-axis tuple is complete.

The draft choice is durable intent. There is no native provider mutation before
first submission; the frozen create snapshot carries the tier through
`thread/start`.

After binding, Fast additionally requires authoritative thread-scoped feature
support for the current runtime generation. A transient discovery failure may
leave a known control visible but read-only. A definitive disabled observation
withdraws the capability and reconciles both app-server and managed-TUI state
to Standard. Null, duplicate, unknown, or custom native tiers fail closed.

Fast changes use revision-fenced, durable provider-feature receipts. Desired
state is updated atomically before any runtime synchronization, accepted
replays do not repeat the mutation, and a request fingerprint prevents reuse
of a mutation ID for different input.

Pi, Claude, and Grok do not consume this feature contract. Their model,
reasoning, and permission behavior remains backend-private.

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

Goal is absent from unbound and creating threads. On attach, reconnect, or
daemon-generation replacement, `thread/goal/get` is the authoritative read.
Goal notifications are invalidation hints only: concurrent hints are coalesced
and followed by another authoritative read. Native thread mismatch, unknown
status, unexpected fields, unsafe counters, or invalid objective bounds
withdraw the feature rather than projecting partial state.

The in-memory projection is scoped by tenant, principal, application thread,
native binding, and daemon generation, with a monotonic feature revision. Each
Create, Pause, Resume, or Clear request must match the thread revision and that
feature revision. Goal actions are deliberately allowed while provider work or
Sedes queued input exists; the native Goal lifecycle, rather than the generic
quiet-thread gate, decides the valid transition.

Every mutation uses a durable receipt and a closed desired postcondition. The
receipt stores only an SHA-256 objective fingerprint and bounded state metadata,
never the objective text. If delivery crosses an uncertain external boundary,
Sedes performs an authoritative Goal read and accepts only an exact
postcondition match. Otherwise the receipt remains recovery-required and the
UI reports that uncertainty instead of blindly retrying.

Goal is provider state, not a Sedes Task, automation, execution setting, or
composer draft. The thread menu's same-settings **New** action copies the
execution tuple and agent-tool policy, but not Goal or managed-TUI state.

## Automations, saved Agents, and forks

Automations may use any complete Codex tuple available to a manual turn. Sedes
does not narrow sandbox, network, or approval values for automation. An
attended approval policy can therefore leave an automated turn waiting for the
principal. The immutable snapshot is revalidated again at dispatch. An enabled
automation makes interactive execution-setting and Fast controls read-only to
prevent configuration races.

Saved Agents can carry the complete tuple, subject to the destination target's
current policy and catalog. The same-settings **New** action revision-fences the
source tuple and initializes an independent unbound draft; it does not copy
provider history, Goal, TUI lifecycle, or runtime observations.

Native Codex fork capability requires a complete recognized effective tuple
confirmed by the current daemon generation and still admitted by policy. The
same private resolver supplies both capability projection and child
initialization, and the live catalog is rechecked immediately before the
native call. A policy or generation race therefore fails before child
creation. The child inherits the confirmed tuple; Fast resolves to Standard if
the child model cannot use it. Custom or unconfirmed settings yield a bounded
unavailable reason rather than fallback defaults.

## Change checklist and verification

Any change to these contracts must audit:

- target defaults, model policy, and all four execution-policy allowlists;
- every create, resume, fork, turn, automation, saved-Agent, and managed-client
  mapping;
- desired/effective revisions, per-axis classification, and daemon generation;
- imported, custom, partial, stale, and generation-loss observations;
- immutable snapshot replay and post-commit synchronization;
- Fast capability discovery, model changes, and Standard reconciliation;
- Goal bounds, state/action matrix, Stop interaction, receipts, reread
  recovery, and notification coalescing;
- active-turn, queued-input, automation, archive, and recovery gates; and
- explicit unsupported behavior for every compiled backend.

Follow [Backend integration contract rules](backend-integration-contract-rules.md)
for cross-backend changes. Run deterministic unit, integration, client, and E2E
coverage through the commands in [Development and
testing](../developer/development.md). Real Codex suites consume authenticated
provider capacity and require explicit user authorization.
