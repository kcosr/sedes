# Backend integration contract rules

This is the normative contributor guide for adding a compiled conversation
backend or changing a contract that reaches one. Sedes currently compiles Pi,
Codex, Claude, and Grok, but these rules are intentionally backend-neutral.

Sedes owns application identity, policy, durable overlays, and normalized
browser presentation. A provider-private adapter or server-private standardized
binding owns the wire protocol; the backend owns provider conversation
identity, event meaning, and authoritative history interpretation. A change is
complete only when that boundary remains true through configuration, runtime
composition, delivery, recovery, persistence, and presentation.

For the system-level model, see [Architecture](architecture.md). For current
operator-facing topologies, see [Configuration](../operator/configuration.md),
[Pi](../operator/backends/pi.md), [Codex](../operator/backends/codex.md),
[Claude](../operator/backends/claude.md), and
[Grok](../operator/backends/grok.md).

## Contents

- [Sources of authority](#sources-of-authority)
- [Classify the change first](#classify-the-change-first)
- [Assign ownership and scope](#assign-ownership-and-scope)
- [Preserve backend privacy](#preserve-backend-privacy)
- [Reuse provider infrastructure at the narrowest valid layer](#reuse-provider-infrastructure-at-the-narrowest-valid-layer)
- [Compose one coherent module](#compose-one-coherent-module)
- [Publish compatible runtime drift as an active advisory](#publish-compatible-runtime-drift-as-an-active-advisory)
- [Capabilities are promises](#capabilities-are-promises)
- [Normalize history and live events](#normalize-history-and-live-events)
- [Treat mutations as recoverable operations](#treat-mutations-as-recoverable-operations)
- [Discovery and pagination](#discovery-and-pagination)
- [Interactions, input, and interruption](#interactions-input-and-interruption)
- [Provider output artifacts](#provider-output-artifacts)
- [Creation, binding, and forks](#creation-binding-and-forks)
- [Execution environments and files](#execution-environments-and-files)
- [Agent tools and managed terminals](#agent-tools-and-managed-terminals)
- [Model policy is backend authorization](#model-policy-is-backend-authorization)
- [Configuration and persistence](#configuration-and-persistence)
- [Required cross-backend audit](#required-cross-backend-audit)
- [Verification expectations](#verification-expectations)
- [Review checklist](#review-checklist)
- [Related documentation](#related-documentation)

## Sources of authority

Use current typed contracts and production composition for exact behavior:

- [`src/server/backends/contracts.ts`](../../src/server/backends/contracts.ts) and
  [`src/shared/protocol/backend.ts`](../../src/shared/protocol/backend.ts)
- [`src/server/backends/module.ts`](../../src/server/backends/module.ts), the
  [module catalog](../../src/server/backends/module-catalog.ts), and the
  [compiled catalog](../../src/server/backends/compiled-module-catalog.ts)
- [`src/server/runtime/backend-module-startup.ts`](../../src/server/runtime/backend-module-startup.ts)
  and [production composition](../../src/server/production-application.ts)
- the normalized [conversation](../../src/shared/protocol/conversation.ts),
  [application](../../src/shared/protocol/application.ts), and
  [API](../../src/shared/protocol/api.ts) protocols
- provider implementations under
  [`src/server/backends/pi`](../../src/server/backends/pi),
  [`src/server/backends/codex`](../../src/server/backends/codex),
  [`src/server/backends/claude`](../../src/server/backends/claude), and
  [`src/server/backends/grok`](../../src/server/backends/grok)
- the shared [model policy](../../src/server/backends/model-policy.ts),
  [Saved Agent adapter](../../src/server/backends/saved-agent-adapter.ts),
  [automation policy](../../src/server/runtime/automation-execution-policy.ts),
  historical fork-boundary interpretation,
  staged attachment and Task/context contracts, and agent-tool runtime/source
  capability contracts
- conformance, provider, integration, persistence, browser, and migration tests
  under [`tests`](../../tests)

Design plans, milestone records, branch handoffs, test counts, screenshots, and
private supplemental context are not implementation authority. When code and
prose differ, establish the production path and tests, then update the prose.

### Current compiled backends

The production catalog contains exactly four backend modules. This table is a
navigation and audit baseline, not a substitute for the capability document
of a configured target.

| Backend | Private implementation                                           | Maintainer contract                    | Operator guide                           |
| ------- | ---------------------------------------------------------------- | -------------------------------------- | ---------------------------------------- |
| Pi      | [`src/server/backends/pi`](../../src/server/backends/pi)         | [Pi internals](backends/pi.md)         | [Pi](../operator/backends/pi.md)         |
| Codex   | [`src/server/backends/codex`](../../src/server/backends/codex)   | [Codex internals](backends/codex.md)   | [Codex](../operator/backends/codex.md)   |
| Claude  | [`src/server/backends/claude`](../../src/server/backends/claude) | [Claude internals](backends/claude.md) | [Claude](../operator/backends/claude.md) |
| Grok    | [`src/server/backends/grok`](../../src/server/backends/grok)     | [Grok internals](backends/grok.md)     | [Grok](../operator/backends/grok.md)     |

Every backend-facing change must give all four an explicit implemented or
intentionally unsupported disposition.

Application inventory catch-up is implemented for Pi, Codex, Claude and Grok
through the shared scoped publication boundary. Backend adapters continue to
publish normalized changes; they must not create private inventory projections
or replay policies. The boundary folds validated deltas before fanout and uses
current checkpoints for large reconnect gaps. Any mutation that changes group
counts, bounded fork selection, lineage, targets or other multi-entity facts
must admit an authoritative replacement. Bulk structural hints must be admitted
before per-thread runtime waits. Capture-equivalence tests must cover these
facts; matching the client reducer alone cannot prove producer completeness.

The principal-scoped application thread summary carries the durable binding's
`backendSessionId` as an opaque copy-only value, absent before a binding exists.
Pi, Codex, Claude, and Grok all implement this through the shared scoped binding
projection. Bootstrap and thread-upsert publication must agree, without opening
a provider session or loading history. The browser must not parse this value,
use it as application identity or authority, or fall back to a loaded thread
snapshot for sidebar copying. Test unbound-to-bound publication and wrong-scope
reads whenever changing this projection.

An actor must replay current authoritative pending interactions to late
subscribers, including the interaction broker. Remove resolved requests and
rebuild the pending view from the handle's replay on projection replacement;
neither resolved requests nor obsolete projection state may be resurrected.
A thread event-stream reader retains its hub subscription after setup and
releases its execution borrow. Viewing a thread prevents idle eviction without
blocking an explicitly confirmed backend Stop. Confirmation revisions track
new provider work, output, and failed cleanup; successful retirement of an idle,
fully acknowledged presentation must not invalidate the confirmation itself.
Explicitly confirmed Stop, Restart, and Upgrade may abandon retained delivery
records after bounded best-effort archival of scoped operation identities and
known dispositions. Archive failure is diagnostic, not a new admission veto.
Never turn abandonment into provider success or a claim that a sent mutation
did not execute. Actual owned-process cleanup remains required; external Codex
Stop closes Sedes's client only. Automatic retirement keeps its acknowledgement
and cleanup requirements. Pi's remote workspace operations use these same
explicit lifecycle rules; Grok remains local-only.

The optional backend `stopBeforeConversationCleanup` hook runs only for explicit
Stop/Restart, after the scoped remote control attempt and before actor cleanup.
Codex uses it for direct local connections: external UDS/TCP closes the client
without interrupt, shutdown, unsubscribe, or late approval replies; owned
stdio first attempts a bounded interrupt of cached current-generation active
turns, then closes the owned transport. Sidecar Codex performs these steps on
its owning host instead; its main-side hook only detaches the presentation,
also when the host refuses the command. Pi, Claude, and Grok need no additional main-side hook;
their existing owned runtime cleanup remains authoritative. Disconnect and
ordinary actor eviction do not invoke this hook.

After a refused host command, retire any closed local module once actor and
binding cleanup are proven, preserve the original command failure and remote
presence evidence, and clear its applied configuration fingerprint. Explicit
Connect must be able to create a fresh presentation for the retained runtime
without replaying submitted work. Unproven local cleanup keeps acquisition
fenced; it must not advertise a usable replacement.

A known pre-native send refusal must remain distinguishable from transport loss
or a failure after admission. It must not alone close a live conversation or
classify delivery as uncertain. Persistent owner failure is state, not merely
an acknowledgeable event: later attachments must retain it and cannot advertise
a dead query as usable from transcript activity. Claude implements these rules
in its private persistent send/attachment contracts; Pi, Codex, and Grok retain
their existing delivery and lifecycle contracts and do not consume those
Claude-private wire shapes.

Provider-private replay reclamation must preserve exact unacknowledged delivery
and unresolved operation/permission evidence. A main-process ACK alone is not
proof that a replacement main can reconstruct transient output. Claude's
persistent host compacts fully covered acknowledged streams and retires complete
content only after matching native history; disposable progress frames have an
explicit ACK-time policy. History transfer pages belong to one bounded, expiring
acquisition snapshot with scoped continuation identity and validated progress.
Do not treat an offset as a stable snapshot or repeatedly reconstruct the full
history for each page. These are Claude-private rules: Codex, Pi, and Grok retain
their existing history and delivery contracts, and no browser capability or
protocol changes.

Backend runtime control adapters expose `BackendRuntimeControlRejectedError`
only for positively received, known provider refusals, normalized as stale
confirmation, blocked, or cleanup unproven. Keep provider refusal codes private
and preserve the original cause. Live and retained-runtime recovery paths must
classify identically. A positively returned cleanup failure permits a fresh
explicit Stop to retry the same retained owner; it never proves process cleanup
or permits a replacement owner. A transport loss or unrecognized response
remains an unknown outcome and cannot silently reopen control admission.
Codex and Claude implement this boundary; Pi and Grok have no remote provider
administration contract.

When a pending environment revision outlives its carrier, remote backend
clients may reacquire only an existing daemon in recovery mode. Revalidate
principal/environment scope, operator connection intent, and current transport
availability; fence the exact previously admitted service and provider runtime
incarnations. Never use ensure/start as a fallback for missing retained work.
Recovery can replay known sessions, read their history, acknowledge outcomes,
and answer exact pending requests. It cannot admit new sessions, turns, roots,
or unrelated provider mutations. Ordinary Files, tools, and new backend
acquisitions still reject stale revisions. Pi retains its existing shell
recovery contract and Grok remains local; neither receives backend recovery
launch authority.

Current runtime topology is explicit: Pi SDK runs its model loop on main Sedes
with optional remote workspace operations; Codex and Claude support admitted
local and persistent-sidecar runtimes; Grok executes locally only. SSH and
approved outbound connectors use the same admitted sidecar operations:
Pi keeps its model loop and native store on main Sedes; Codex and Claude execute
through the remote sidecar. Remote Grok admission fails closed for both
transports. Claude requires Node.js 24.18+ and POSIX process-group supervision;
native Windows Claude is unsupported. Windows outbound definitions can retain
disabled Claude bindings, but cannot enable them, and Windows sidecars omit the
Claude runtime capability. Node versions below 24.18 also omit that capability
without disabling independently supported Files, Pi workspace, or Codex operations.
Availability of an outbound environment requires a current paired
connection; cached backend health never grants execution authority while it is
disconnected. Carrier loss must retire attachment authority without changing
operator intent; automatic recovery reports transient transport unavailability
separately from a persisted disabled preference or explicit Disconnect. Codex
and Claude preserve remote sessions and pending decisions through that loss;
Pi workspace operations become unavailable until connection returns, and Grok
remains local. Optional native terminal support is a negotiated runtime fact.
A terminal request may initiate the first lazy handshake; retain the last
verified inventory across idle carrier retirement so opening a terminal can
reconnect. A known absence of PTY support, explicit disconnect, or unavailable
outbound carrier still blocks admission. Every terminal effect checks the
newly acquired session inventory before sending an operation; configuration
grants alone never authorize PTY effects or advertise Codex managed-TUI
support. Missing native PTY support leaves admitted Files operations usable.
Re-evaluate support on each attached runtime generation.

Remote paths use the execution host's declared platform, including native
Windows drive/UNC roots. Never resolve remote absolute paths using the main
server OS, account home, or filesystem. Sidecar relative wire paths remain
slash-separated. The remote host verifies canonical path identity and allowed
roots before filesystem effects. Pi's local native session files preserve the
admitted remote cwd spelling even when the SDK normalizes it using the main
host's path grammar.

Disabled historical remote Claude definitions
retain their IDs and native bindings until explicitly enabled, without a local fallback. Cursor is not
compiled. Visible Pi SDK naming does not rename the internal `pi` kind.
 A new compiled module must be added to
this inventory, the production catalog, the required audit, and relevant
operator and developer navigation in the same change.

## Classify the change first

Every backend-facing addition belongs to one of these layers:

| Layer                                        | Use it for                                                                                                       | Required treatment                                                                                                                                                                                                               |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normalized shared contract                   | A precisely defined Sedes concept with the same meaning for every provider                                       | Add a closed typed shape, define lifecycle and failure semantics, audit every compiled backend, and expose truthful capabilities.                                                                                                |
| Versioned provider feature                   | A bounded, intentionally provider-specific user feature                                                          | Register a `featureId` and schema version, validate state and actions, declare effects and confirmation, add an explicit client renderer, and fail closed on unknown versions.                                                   |
| Server-private transport or protocol binding | Execution-channel framing, assured delivery, correlation, or a published protocol used without backend semantics | Keep it below backend interpretation and outside application/browser contracts; expose a strict facade, closed codecs, release provenance, bounds, and conformance tests. Backend-owned extensions and semantics remain private. |
| Provider-private implementation              | Native protocol, process, transport, identifiers, history interpretation, or credentials                         | Keep it under the provider directory and project only normalized records or a registered feature envelope.                                                                                                                       |

Do not generalize one provider's method names or event shapes merely to make
them appear shared. Do not hide a genuinely shared lifecycle concept in an
untyped provider-feature payload to avoid a cross-backend audit.

Provider feature operations and normalized operations are closed unions. Never
introduce arbitrary action names or unvalidated payloads.

A provider feature that presents immutable metadata on one conversation item
must declare the `conversation_item` presentation slot and register an exact,
bounded item-payload schema and projector. Attach only the shared
`{ ref, payload }` item envelope: do not copy provider-native fields into the
universal item union, reuse mutable thread feature state, or add an item
revision. Every item envelope must match an advertised capability at the same
feature/schema version, and that capability must declare the item slot. Unknown
versions, duplicate envelopes, mismatched slots, invalid provider payloads, and
oversized projections fail closed.

Validate the native item at the provider codec boundary before projecting it,
and use the same projection for authoritative history and live lifecycle
events. Tests must cover native exactness and bounds, history/live equivalence,
registry slot/schema consistency, normalized envelope closure, capability
matching, and each compiled backend's implemented or intentionally unsupported
disposition. Passive item presentation must not enter an interaction broker or
grant authority; any response remains an ordinary user input unless a separate
reviewed operation contract says otherwise.

## Assign ownership and scope

Classify every setting, record, event, side effect, and cache by the narrowest
authoritative scope:

- installation system;
- tenant and principal;
- backend instance and target;
- execution environment;
- workspace;
- Sedes thread; or
- one operation or runtime generation.

The browser never supplies tenant or principal authority. Production currently
derives one local principal on the server, but all repositories, runtime keys,
receipts, queues, caches, and denials must preserve the tenant/principal
boundary.

A configured execution environment, backend instance, target, workspace, and
thread are principal-owned application state. Bootstrap listener, installation
identity, state-directory selection, and protected credential policy remain
installation-owned. Provider-native conversation IDs remain
backend-private. Never let a broader scope become a fallback for missing state
at a narrower scope.

A browser-derived collection may select an explicit bounded set of
principal-owned application objects, but it never becomes scope or eligibility
authority. For example, a visible sidebar stack may submit its exact ordered
application thread IDs for a bulk inventory impact check. The server must
derive tenant/principal scope, load authoritative revisions, Tasks, stashes,
runtime state, and durable blockers, freeze the confirmed targets, and reject
the complete mutation if any target changes or becomes unavailable. Do not
reinterpret a browser collection as every member of a persistent Group,
project, lineage family, or provider-native hierarchy.

Settle, unsettle, archive, and similar inventory operations remain
application-owned when their meaning is identical across providers. Perform
an all-or-nothing principal-scoped database mutation with one replay receipt
and publish only after commit. External execution-workspace deletion cannot be
included in that atomic boundary; bulk archive keeps those workspaces. This
path is implemented uniformly for Pi, Codex, Claude, and Grok through shared
application composition and must not add provider methods, native identifiers,
provider-name branches, or a fabricated capability. Archived threads are not
members of a visible working stack, so stack bulk restore is a separate product
contract rather than an inferred inverse operation.

For a fresh archive, acquire the shared per-thread maintenance fences in a
deterministic order and hold every affected fence through the all-or-nothing
database mutation. Fence both coordinator acquisition and direct actor-manager
acquisition so capture, fork, lifecycle, or other direct borrowers cannot
resurrect a handle during commit. An atomic idle-close race aborts before
commit; an unproven close fails closed rather than allowing competing
ownership. For idle retirement, allow existing direct borrowers (including
snapshot readers and cancelled cold attachments) up to five seconds to release
under the acquisition fence;
an outstanding read alone is not evidence of new provider work. Recheck idle,
background activity, and provider cleanup blockers after draining. A borrower
that remains held at the deadline still blocks retirement. This shared behavior
is implemented for Pi, Codex, Claude, and Grok; their native close dispositions
are unchanged. Explicit detach keeps its immediate borrowed-runtime rejection.
Publish only after the commit and fence release. On receipt replay,
retire only targets whose current state remains archived before republishing
the receipted result. Release all generic fences before any
execution-workspace deletion that takes its own retirement fence. Retirement
closes only resident handles, processes, subscriptions, and leases; it never
deletes provider-native durable conversation history. Audit this close
disposition for Pi, Codex, Claude, and Grok whenever archive or runtime
ownership changes.

Provider residency can outlive Sedes' handle, as a Claude query owned by a
persistent sidecar service does. A backend with such residency implements the
optional driver method `releaseConversationResidency`. Inside each thread's
retired fence, archive calls it for a thread with a bound, enabled target. The
method must report `busy` rather than stop outstanding provider work, and
`busy` refuses the archive before commit. An unreachable provider is logged
and left to the provider's own residency limit. Claude implements it through
the persistent `retire` command, and its local worker owns no residency beyond
the handle. Pi, Codex, and Grok omit it; retiring their handles already
releases what they hold for the thread.

If policy and preference meet, document precedence explicitly. Installation
policy is a ceiling; principal or thread state may select only admitted values.
Persist the complete selection needed to reproduce behavior rather than
relying on a mutable provider-global default.

## Preserve backend privacy

Provider-specific SDK types, RPC methods, extensions, event payloads, native
identifiers, cursor formats, filesystem layouts, executable paths,
authentication material, and topology stay inside their backend or its
server-private binding adapter. A published standardized protocol may have one
reusable server-private binding when its base semantics are genuinely shared,
but that binding never becomes an application or browser contract.

Skill discovery follows the same topology rule. Prefer the provider's native
remote skill protocol when one exists. A backend without one may consume a
server-private execution-environment capability that returns bounded metadata
and resolves one exact selected body, but provider-private prompt construction
must remain in that backend. Never expose native paths or bodies to the
browser, make the Sedes host read an execution-host path, or silently widen
workspace authority to account-global roots. Account-global roots require an
explicit installation-owned capability and a fixed documented allowlist.

The shared application and browser may receive only:

- normalized IDs, capabilities, messages, turns, interactions, and errors;
- opaque bounded cursors where a shared contract requires paging; and
- registered provider-feature envelopes with a known version.

The principal configuration administration API is a separate, versioned
management contract. It may expose closed, provider-specific configuration
schemas to registered Settings editors, including executable paths, endpoint
topology, and approved host-scoped credential references. Credential values,
native conversations, provider RPCs, and unvalidated extension payloads remain
excluded. Central server-derived management authorization covers reads, edits,
probes, and lifecycle actions. This exception grants no provider-specific
fields to normalized conversation, application snapshot, or event contracts.

Do not branch in shared client or service code on provider names. Branch on a
normalized capability, a registered feature, or an execution-environment
capability.

Every change to a normalized browser wire shape must advance
`SEDES_CLIENT_PROTOCOL_VERSION`. That version fences cached or packaged
clients through the actionable protocol-mismatch path before they parse a
snapshot with an incompatible schema. A provider-private codec change that
does not alter the browser contract does not advance the client version.

Keep application session metadata and application inventory as non-overlapping
normalized contracts. The HTTP session handshake carries protocol
compatibility, CSRF, and installation capability metadata only. React obtains
inventory through the principal-scoped application SSE stream: cold attach
receives one snapshot, a retained opaque cursor receives a contiguous bounded
suffix, and replay loss or generation change receives one replacement
snapshot. An explicit point-in-time snapshot read for bounded CLI or diagnostic
consumers must not publish into, reset, or otherwise acquire authority over the
application replay hub. A browser cursor is only a resume hint under
server-derived tenant/principal scope. This is shared application composition
for Pi, Codex, Claude, and Grok; it adds no backend method, capability, native
identifier, or provider-specific fallback.

Thread catch-up uses the runtime hub's incrementally maintained normalized
projection, including already expanded older pages. Client protocol 104 supports a
`thread-checkpoint` SSE control frame with that state, its exact transport
watermark, retained runtime notices, and the last actual capability projection
revision and run state. Capture state and watermark synchronously before subscriber-count
callbacks can publish, and install the live listener without an asynchronous
gap. A checkpoint is local to one connection: it does not publish an event,
advance the shared cursor, reset replay, or reload provider history. Replay
small contiguous suffixes; use a current checkpoint when that costs less than
a large suffix, or when the requested cursor cannot be replayed. Cursor hints
never change the route's server-derived tenant/principal/thread authority.

Only newer events follow a checkpoint, and controls become authoritative at
`thread-live`. Replacing a pending SSE queue also resets its flush cursor;
backpressure on a recovery live frame or heartbeat must not skip later events.
Thread transport subscriptions must provide a checkpoint handler rather than
silently retrying a frame their consumer cannot apply.
Replace the retained projection exactly; never union absent
history back into a true replacement. Keep notices bounded, refresh the
question inbox, and preserve the last actual capability revision and run state
so a checkpoint cannot pretend stale capabilities were refreshed. Controls
also wait for capabilities matching the current run state. Bound slow-client
pending events independently of one checkpoint frame. Overflow recovery may
capture another per-client checkpoint, but must not disturb other subscribers
or repeatedly regenerate snapshots for an indefinitely slow client. This
catch-up path is implemented for Pi, Codex, Claude, and Grok through shared
normalized stream composition; provider transports and canonical history
ownership remain unchanged.

An auxiliary provider behind a canonical Sedes agent tool is not a
conversation backend merely because it invokes a model. Keep its executable,
arguments, native session IDs, authentication home, and output codec behind a
narrow provider interface. The canonical tool owns provider-neutral input,
output, effects, and trusted caller scope. Runtime availability must fail
closed for discovery and execution while management UI may truthfully retain
a disabled catalog entry. Continuation must bind an exact provider session to
the trusted Sedes caller; never fall back to provider-global “latest” state.

## Reuse provider infrastructure at the narrowest valid layer

Use this dependency direction:

```text
execution-environment channel
  -> assured framed transport
    -> protocol binding
      -> backend semantics
        -> normalized application contract
```

Shared transport owns framing, bounds, generation fencing, write-boundary
classification, closure, and owned-resource cleanup. It does not own method
catalogs, session meaning, capabilities, history, policy, or recovery.

An installation-managed provider worker is a digest-verified, statically
registered artifact, not an arbitrary remote command facility. Local and remote
launchers must run the same worker protocol and provider semantics. The
execution-environment channel owns artifact admission, carrier lifecycle,
framing, generation fencing, and cleanup; the backend owns the worker method
catalog, SDK/CLI release checks, native namespace, session meaning, history,
permission callbacks, and recovery. A target authorizes its provider worker
independently of optional Files or operations-sidecar capabilities. Worker
protocol or build mismatch, carrier loss, and uncertain child cleanup fail
closed without compatibility decoding or local fallback.

Share correlated request machinery only when envelope parsing, remote errors,
cancellation, duplicate handling, and reverse requests are explicit injected
contracts. If reuse requires a provider or protocol mode switch, keep separate
protocol peers over the common transport.

A standardized protocol binding owns only the published base protocol.
Backend-specific extensions, authentication, release profiles, session and
history interpretation, policy, mutation recovery, and normalized capability
projection remain backend-owned.

Sharing a carrier or protocol never creates a generic `BackendKind`, generic
conversation driver, shared process pool, or shared native-session identity.
Backend identity follows the product and its conversation semantics, not its
wire protocol.

A successful protocol handshake or advertised capability proves structural
availability only. Each backend must still prove the exact semantic,
durability, recovery, authority, and concurrency contract before projecting a
normalized capability.

Negotiated capabilities are an authority boundary in both directions. Reject a
known but unadvertised reverse request before dispatch or resource resolution;
recognizing its method or schema does not authorize filesystem, terminal,
permission, elicitation, or other client-side effects.

Prefer pinned official SDKs, generated types, and generated schemas when they
match the exact product surface, protocol dialect, topology, and supported
release. An official high-level SDK targeting a different execution mode is
not an authoritative replacement.

Keep official dependencies and generated artifacts behind a narrow
server-private facade. Sedes retains execution-environment, transport,
credential, lifecycle, pooling, shutdown, delivery-boundary, and recovery
authority unless the dependency is explicitly proved to satisfy each contract.

The operator-selected provider process is a trusted but fallible protocol
participant, not a hostile network peer. Sedes still validates every inbound
response, active notification dependency, reverse request, consumed extension,
and error because TypeScript types do not validate runtime data and provider
bugs or version drift must not acquire authority. Use bounded projection followed
by closed runtime validation and release-specific semantic refinements. Projection
must finish before capability, ordering, authorization, handler, persistence, or
normalized backend code can observe the value. Recapture decoder output as
bounded prototype-free JSON before semantic validation; trusting a generated or
backend extension decoder to return an already safe object is not a valid
boundary. Repository, terminal, tool, web, MCP, and model content transported by
that provider remains non-authoritative data and must be safely encoded.

Size every pre-projection semantic bound against the provider's reviewed wire
representation as well as the normalized data Sedes retains. In particular,
a provider may encode bounded binary or terminal output as a JSON number array;
an encoded frame limit can safely remain the effective resource boundary while
array and node-count limits are high enough to admit every representation that
can fit inside that frame. Do not impose a smaller representation-specific cap
that rejects a known message before its route decoder projects unconsumed output
away. Keep frame bytes, nesting depth, strings, keys, routing, and consumed route
fields independently bounded and fail closed when any of those contracts fail.

Use one shared 128 MiB maximum framed-message capacity for owned NDJSON, ACP,
Codex framing, and WebSocket framing. A deterministic sizing invariant must
prove that the maximum legal normalized request—including base64 expansion,
worst-case text escaping, attachment descriptors, authenticated metadata, and
JSON structure—fits without constructing that request in every test. Do not
add backend-specific smaller frame or string overrides. Expose effective
carrier capacity to protocol peers, and reject a binding limit that exceeds
its carrier.

An agent-to-client notification with no active consumer dependency—an exact
registered descriptor, active profile, and registered handler—may be treated as
unused protocol traffic rather than an unsupported operation. Apply generic
envelope and frame bounds, then discard it without route-specific parsing,
authorization, dispatch, logging, persistence, or payload retention. Keep only
payload-free saturating diagnostic counters; ignored notification count or bytes
must not become a cumulative connection-generation failure budget. This
disposition may apply before, during, and after initialization, but it never
applies to malformed envelopes, responses, reverse requests, protocol
cancellation, or an active notification dependency. An active notification
remains schema-validated and fail-closed; an active pre-initialize notification
remains unavailable unless an explicit bounded release profile permits deferred
handling.

An unknown or unavailable reverse request receives a static method-not-found
response and grants no authority; do not make the request itself connection-fatal.
Unknown responses, malformed or cross-kind ambiguous envelopes, and compromised
correlation remain fatal. Failure or uncertain delivery of the terminal error
response may still fence the connection.

Treat reverse-request concurrency as a current-work watermark. Reject excess
concurrent requests request-locally with a static protocol overload response
before authorization or dispatch rather than closing the provider connection.
Keep active IDs and a bounded rolling window of recent completed or rejected IDs
fail-closed against duplicates, but do not retain every ID for the connection
lifetime or turn replay protection into a cumulative valid-traffic failure.
Replay protection retains IDs only, never request payloads.

Method stability and artifact profile are separate decisions. Enabling an
experimental provider capability can add fields to otherwise stable methods,
responses, reverse requests, or notifications. Inventory the wire actually
used under the negotiated capability and select exactly one stable or
experimental generated definition for each direction; never try one profile
and fall back to another. When an official schema deliberately permits
additive properties, retain explicit Sedes closure and projection refinements
at every consumed boundary, while leaving reviewed record/map fields open.
Project additive provider fields away at the consuming backend boundary unless a
reviewed normalized contract or registered provider feature consumes them. Do not
retain unconsumed additive fields as capability, lifecycle, durability, or other
semantic evidence.

Keep closed metadata key inventories aligned with their selected generated
types. Use exhaustive typed key maps where all generated fields are consumed,
and exercise non-null optional containers in decoder tests. For example,
Codex thread sections include nullable `appearance` with `icon` and `color`;
rejecting that declared field breaks cold reads of sectioned threads even when
the official response schema passes. Unknown fields and malformed declared
values still fail closed at the consuming boundary.

Record artifact provenance: dependency or generator version, provider release
or commit, generation command, relevant inputs, and deterministic drift check.
Do not generate protocol artifacts by invoking an operator-installed runtime
during application startup.

Use one structural authority for each wire shape. Characterization or
equivalence tests may compare an old and new parser during development, but a
production route must cut over atomically and remove the former parser. Never
retain silent parser, SDK, or schema fallbacks.

If an SDK offers useful types or codecs but insufficient transport or lifecycle
guarantees, consume only those parts. Do not surrender the complete connection
merely to claim SDK use.

Characterize an existing backend before extracting common infrastructure,
migrate it without semantic changes, and verify it independently before making
a new backend the next consumer of the extraction.

Private Unix channel assurance may admit a final owned symlink only when its
canonical parent and the resolved socket's canonical parent are owned `0700`
directories and the socket is owned `0600`. Reject directory symlinks and alias
chains; retain both alias and target filesystem identities across inspection,
connection, and Upgrade, and connect to the inspected target. Keep the configured
selector stable for backend identity and accounting rather than persisting a
daemon's changing resolved path. Codex consumes this channel locally and on
sidecar hosts; SSH tunnel delegates also retain its socket validation. Pi,
Claude, and Grok do not expose external Unix endpoints through this primitive.

## Compose one coherent module

A compiled backend module owns its configuration parser, preparation,
factories, persistence adapters, discovery behavior, presentation metadata,
feature contributions, and runtime resources as one bundle.

Preparation validates configuration without acquiring provider resources. An
invalid or unreachable configured backend must not prevent administration of
other backends or the configuration itself. Runtime construction must be scoped
to the server-derived backend instance, target, execution environment, tenant,
and principal. Global singletons must not accidentally combine separate
targets or principals.

Dynamic configuration publishes one complete runtime bundle after successful
startup, using stable live contribution maps rather than snapshots retained by
consumers. The principal-scoped runtime collection owns native-store claims and
leases. Replacing/removing a runtime requires the caller to fence admission and
retire its existing borrowers through the entire change; the collection does
not infer idleness. Validate candidate scope and namespace conflicts before
withdrawing a healthy runtime. Withdrawn driver generations reject new work.
A failed close retains its native namespace claim and leases until cleanup is
proven; it must not release ownership and launch a replacement. Backend-local
startup failure leaves unrelated runtimes available and records a per-backend
failure. This shared composition applies to local Pi, Codex, Claude, and Grok;
it neither grants remote topology support nor changes provider protocols.

The runtime owns everything it starts: SDK clients, daemons, sockets, SSH
forwards, subprocesses, watchers, and temporary secrets. Startup is bounded;
shutdown stops new work, aborts cancellable work, waits for owned
continuations, and then disposes dependencies. Viewer presence must not own a
shared provider process.

A persistent service that hosts SDKs with process-global account or provider-home
configuration must isolate those namespaces in independently owned workers. A
shared carrier or daemon is not evidence that several backend namespaces can
safely share one SDK process. Embed and verify installation-owned worker bytes
with the sidecar artifact, and keep operator-installed executables outside that
digest-pinning authority.

Every required module contribution must be explicit. Unsupported behavior uses
the typed fail-closed implementation expected by the contract, never an absent
property that causes another backend's default to run.

This includes the runtime's Saved Agent adapter, automation execution policy,
and managed-provider-terminal authority. Adding a backend kind also requires an
audit of every total identity, topology, policy, persistence, and presentation
mapping. Replace implicit `else` defaults that could grant a new backend
another backend's behavior with an exhaustive disposition or a module-owned
contribution.

An owned provider subprocess receives authority at process launch, before any
conversation-scoped request. Construct its executable, arguments, working
directory, and environment from closed typed configuration and an explicit
environment allowlist. User-defined variable overlays use the bounded, typed
`EnvironmentVariableOverrides` contract; never accept an unvalidated process
environment or arbitrary arguments. Preserve reserved Sedes authority, provider
identity directories, loader controls, and platform process controls.
Prove the effective disposition of auto-update, telemetry, shared-daemon or
relay behavior, project configuration, hooks, plugins, MCP servers, external
authentication commands, and other side channels that can alter authority.
Standard output used for protocol framing must contain protocol traffic only.
Treat standard error and malformed protocol payloads as secret-bearing
untrusted input: drain and bound them, redact configured sensitive values, and
never expose raw tails to the browser. Bound frames and queues, classify
partial writes as sent-unknown, and own descendant cleanup through bounded
graceful, terminate, and kill phases.

Treat inbound and outbound frame-queue limits as flow-control watermarks, not
evidence that valid provider traffic is malformed. Both resolved queue-byte
watermarks must be at least the maximum frame size. When either queue reaches
its watermark, pause or await admission until capacity is available; waiting
must wake on dequeue, cancellation, close, and shutdown. Retain absolute
per-frame, retained-byte, outstanding-request, and semantic projection limits.
A semantic-handler quota may still fence a stalled or side-effecting
dependency, but ordinary finite bursts must backpressure rather than close a
healthy provider. Assemble partial NDJSON frames with a chunk accumulator and
one final concatenation, never by repeatedly concatenating the growing frame.

An asynchronous active-notification watermark may propagate ordered
backpressure through a single framed-protocol reader. The binding retains only
admitted work, one awaiting-admission envelope, and the bounded carrier queue;
later inbound frames resume when handler capacity opens. Do not create an
unbounded lookahead queue, disk spool, or semantic reordering solely to let a
later control frame bypass earlier active traffic. A depended-on route that can
emit high-rate replaceable deltas and must leave response demultiplexing live
uses a reviewed synchronous incremental reducer: authorization and reduction
finish inline, allocate no continuation per delta, and never initiate or await
protocol work. Locally initiated outbound cancellation remains independently
serviceable while the inbound reader is backpressured.

Lifetime bytes read/written and frame counts are diagnostics, not retained
resources. A production transport may leave those cumulative ceilings disabled
when per-frame size, partial-frame buffering, inbound/outbound queue bytes and
frames, pending work, and write deadlines remain bounded. Saturate lifetime
diagnostic counters rather than turning an otherwise healthy long-lived process
into an inevitable protocol failure. Probe and test transports may retain
explicit cumulative ceilings when total traffic is itself the bounded operation.

Do not use a fixed wall-clock response deadline as a turn-duration limit when
the provider's prompt RPC resolves only after the model turn completes. Bound
the outbound frame write, startup, cancellation delivery, and shutdown
separately; after accepted prompt traffic, keep the correlated completion
pending until a provider terminal, explicit cancellation, transport loss, or
owned shutdown settles it. A long-running tool or subagent turn is ordinary
work, not a protocol timeout.

For a read-only acquisition whose result is request-local, a protocol binding
may expose one explicit abandon-on-cancellation option. Once cancellation wins,
a crossed request must settle its bounded protocol cancellation before retiring
the exact pending request, releasing its uncommitted notification cutover, and
delivery-classifying the local cancellation; a proven-unsent request may retire
immediately. Ignore a late correlated response through a bounded disposition
tombstone. Do not weaken unknown-response or ordinary duplicate-response failure,
and do not apply abandonment implicitly to prompts, mutations, or administrative
requests whose uncertain outcome requires connection-level recovery.
An acquisition with a streamed notification side channel may use abandonment
only when its adapter keeps one bounded, payload-free draining disposition
until the exact source-defined end marker, discards the abandoned stream under
that disposition, and refuses a successor acquisition of the same stream in
the meantime. When the reviewed source legitimately emits no side-channel item
for an empty result, a synchronous one-shot abandoned-settlement observer may
release that disposition when the exact late response envelope arrives. The
observer receives no response payload and must not perform protocol work.
Without either exact end signal, keep the request correlated through its
settlement cutover instead of risking late-stream adoption.
If the source promises a tail end but never delivers it, a bounded adapter
deadline must retire the retained drain and replace the unsafe connection
generation. Do not simply admit a same-stream successor: without a native
request identity, a late tail cannot be distinguished from that successor.

Do not assume that a request response is a delivery barrier for side-channel
notifications merely because the provider queued those notifications first.
When the response advertises an exact chunk count, the adapter must keep the
acquisition active until it observes that count and the source-defined final
marker, or fail/abandon it through the same bounded request-local path. This is
especially important when the provider uses fire-and-forget notification
forwarding: the response can reach the transport before already-queued chunks.

A persistent runtime carrying several native conversations must preserve each
conversation's notification/receipt fence without making unrelated conversations
wait for its output. Derive scheduling affinity only from reviewed provider
routes and bounded pending-operation/request correlation. Runtime lifecycle
changes and unclassified messages retain a runtime-wide fence. Keep this
scheduling private to the backend; it does not grant conversation authority or
replace native generation and snapshot-cursor checks.

When a provider instead defines a resume response as an exact durable snapshot
cursor and assigns newer records to the live notification stream, hydrate only
from that cursor. Buffer matching post-response notifications in inbound order
under explicit count and byte limits, atomically install the cursor-bounded
snapshot, and replay the buffer through the ordinary live reducer before
switching to direct delivery. Overflow, undecodable input, generation change,
sequence contradiction, or replay failure must fail closed. Do not page from an
unbounded moving head and repeatedly wait for a quiet interval: an active turn
may produce output continuously, so quiet-window reconciliation can starve
correct attachment indefinitely.

When a backend irreversibly fences or closes a conversation handle, it must
publish a backend-neutral invalidation before releasing its dependencies. A
cached conversation actor must retire that handle and reacquire a fresh one on
the next open; repeatedly returning a known-closed handle is never a valid
retention policy. Emit `provider_handle_closed` exactly once on every such
terminal path before clearing raw subscribers; deliberate owner-requested close
does not fabricate that provider invalidation. Normal idle retention remains
separate, and active turns are never eligible for idle eviction.

Bound resident conversation runtimes through one backend-neutral actor-manager
budget value, not independent per-backend session limits. Apply that value
independently to each tenant/principal execution environment: all backends and
workspaces on one environment share its pool, while distinct local or SSH
environments do not. Admission must reserve a slot synchronously, compare
eligible idle candidates across direct and coordinator-owned actors in the same
pool, and await proven cleanup of that pool's oldest candidate before attaching
another provider handle. Only the actor's atomic idle-close operation authorizes
pressure retirement; carrier loss, a cached disconnected state, or a
coordinator observation alone does not. Preserve the original idle deadline
across passive loaded-state reads, and fail closed when cleanup cannot be
proved. A provider worker may retain a substantially higher fixed hard guard
solely as a last-resort leak boundary, but it is not an independent product
concurrency policy.

Inventory whether the provider protocol can inject or update a scoped shell
environment or equivalent execution configuration after process launch. This
is distinct from the daemon's ambient process environment and can be the safer
carrier for per-thread or per-turn Sedes endpoints and capabilities when one
provider process serves multiple sessions. Use it only after proving the exact
scope, application boundary, child-process inheritance, update/rotation,
replay/persistence, redaction, and generation-loss behavior. Prefer a
least-privilege opaque, transport-bound capability that re-resolves current
server authority; never inject a principal bearer token or long-lived ambient
credential merely because the provider accepts an environment map. Prevent
provider config, transcript/history, diagnostics, and unrelated sessions from
retaining or exposing injected values. If the backend lacks a safely scoped
native carrier, omit that presentation or isolate it behind a narrower process
boundary—do not silently fall back to a process-global secret.

User variables have two distinct application boundaries. Environment and
backend **startup** definitions merge only when Sedes owns provider launch.
Externally owned Codex sockets and in-process Pi do not support that boundary.
Saving startup definitions while a provider exists must preserve its launch
environment and expose `startupEnvironmentPending`; only explicit restart
applies them. A provider that proves it has never launched may be prepared with
new definitions before first launch. Unknown process state must not be treated
as stopped. Include host-inherited startup definitions in provider fingerprints,
but never resolved secret bytes. They are not sidecar transport configuration.
After a main-server restart, reattach to a retained remote provider by stable
native configuration identity even when startup definitions have changed. Keep
its applied launch environment and report the pending definitions until an
explicit provider restart. Initial observation must recover the retained
fingerprint without launching a provider.

Provider work can outlive main in a service-owned runtime that journals
per-thread events until main acknowledges them. The runtime's administrative
inspection then reports `retainedThreadIds`: the application threads whose
retained work (a running turn, a pending interaction or input, or
unacknowledged output) needs a main attachment. Whenever main inspects the
runtime, which it does soon after startup, after the service's controller
changes, and for every lifecycle preview, it opens those threads one at a time
within the shared conversation-runtime budget. Their output is then applied and
acknowledged instead of overflowing the owner's retention bound. A pass cut
short at the budget retries at the next inspection. Inspection uses the
existing recovery attachment and never launches a provider. The inspection
may also report bounded `activity` counts (running turns, background work,
pending interactions, and conversations with unacknowledged output) that
interruption previews show; absent counts are not zero. Claude's persistent
host reports both. Codex's runtime-wide attachment already records and
acknowledges retained outcomes without a thread handle, and Pi, Grok, and
local Claude workers end with main, so they report neither.

**Execution** definitions are principal-owned Environment → Backend → Saved
Agent → Thread layers. Capture definitions and provenance transactionally before
native creation, fence the preview's configuration and agent revisions, and
persist the immutable snapshot. Agent and template records retain only their
own overrides. Forks inherit the source snapshot; a supplied thread map replaces
the source thread layer, and mutation retries must reject a different map.
Keep that retry fingerprint with the durable fork attempt and preserve it in
the abort tombstone when deleting an uncreated child. Requests rejected before
reservation must not consume a separate lifetime quota for future forks.
Absent override restores inheritance; `unset` removes a variable, and a literal
empty string is a present value. Ordinary terminals use environment execution
defaults at launch. Existing processes and snapshots are not edited by a save.

Resolve secret references on the actual execution host at the execution boundary
through admitted operations, never in browser responses, durable snapshots,
receipts, diagnostics, command-line arguments, or configuration fingerprints.
Native Codex/Grok stderr is drained without retaining raw text; bounded byte
counts, exit status and classified transport errors remain available. Codex
mutation fingerprints combine immutable definition identity with sanitized
shell-policy metadata. Pi shell admission retains an opaque invocation identity
and variable names, while excluding resolved values.
Preserve protected file ownership/mode and replacement checks. Merge generated
Sedes capability variables after user variables. Apply explicit deletions too.
Codex uses session shell policy on start/resume/fork, independent of agent tools;
Claude uses per-query subprocess environment; Grok uses per-session process
environment; Pi applies it to local, remote and isolated Bash. Never mutate
`process.env` to implement thread scoping. Native managed-terminal handoffs with
unproven snapshot preservation must be explicitly unavailable for configured
threads rather than silently dropping variables.

Never assume a generic config or `_meta` map is a secret channel, a resume call
updates an already-loaded session, a session value can rotate per turn, or a
fork, subagent, MCP server, hook, remote executor, or tool subprocess inherits
(or does not inherit) it. Prove merge precedence, each destination, and
redaction/persistence behavior against the admitted executable/profile. Reissue
and reinject scoped capabilities at the authoritative lifecycle boundary
rather than mutating a shared daemon environment.

Prefer a provider-supported shared process or client when its protocol can
truthfully multiplex the required sessions. Do not choose one process per
thread merely as a conservative implementation shortcut. If a requested
per-thread feature cannot be narrowed inside the shared topology—for example a
process-scoped sandbox, network, environment, credential, or tool policy—stop
before changing the topology and discuss the product tradeoff with the user.
The explicit choices include one uniform shared policy, separate pools keyed by
the fixed policy axis, one process per thread, or leaving the feature
unsupported. Record the selected boundary and test multi-session routing,
failure blast radius, resource ownership, and cleanup accordingly.

One Sedes module runtime per principal/backend instance permits internal
multiplexing; it does not prove that one provider process is safe for every
workspace or thread in that runtime. A shared process or client may serve only
sessions that share every authority fixed at creation, including execution
environment, native home/config authority and any provider-exposed account
binding, startup working directory, configuration sources,
sandbox/network/tool policy, and enabled extension surfaces. Include every axis
the provider cannot narrow later in the pool key.
Route responses, notifications, reverse requests, interactions, and
cancellation by exact session identity, document the failure blast radius, and
invalidate every affected generation together. A later session `cwd` or
workspace parameter does not narrow authority already acquired at process
startup.

The normalized Force reset control is also a runtime recovery boundary, not
only a database cleanup operation. Its preview must fingerprint the exact
server-derived application runtime entry or actor generation, normalized run
state, and active turn when present. A commit may reset a loaded runtime even
when no other unresolved Sedes record exists, but only while that evidence
still matches. After commit, retire that exact actor and its bindings even when
it is running or has browser subscribers, then attach the replacement to the
same retained event hub and publish an authoritative baseline. A still-starting
entry needs its own generation and cancellation controller; wait for its
establishment cleanup before replacement. If close or cleanup is not proved,
retain a fenced/poisoned entry and never create a competing runtime or
synthesize idle. Receipt replay is observational and must never retire a newer
generation. This contract is backend-neutral and shared code must not branch on
provider identity.

The scoped thread event registry must retain the same hub while a runtime
owns it, including establishment and periods without browser subscribers.
Quiet application reads and cache eviction cannot remove that owned hub:
application events and actor projection events must reach the same stream.
Release runtime ownership only after binding cleanup; browser subscriptions
remain an independent reason to retain the hub. This shared lifecycle applies
to Pi, Codex, Claude, and Grok without changing their capabilities.

A provider may announce a subordinate native session and immediately emit that
child's frames on the same owned connection. Do not create a Sedes thread,
durable binding, or independently visible conversation merely to consume those
frames. If Sedes consumes the parent-side announcement, project it through
the normalized collaboration/tool activity contract. Durable lifecycle
updates retain their provider event identity for replay conflict checks, while
metadata-free live progress may compact the already-authenticated activity but
must not invent a durable event identity. Keep one stable normalized item as
that activity advances, retain only compact hidden state if an unsettled
activity leaves the display window, and release it at settlement. Boundedly
ignore unconsumed child transcript and tool notifications without persisting
child identity or merging child content into the parent timeline. This passive
notification disposition grants no reverse-request, permission, session,
persistence, or side-effect authority; those paths remain exactly scoped and
fail closed.

Do not expand that blast radius merely because one known notification has
malformed provider-owned parameters. Validate the bounded envelope and one
exact release-selected parameter definition once. If that structural failure
still leaves one release-reviewed, bounded session identity, publish only a
closed failure marker to that session and require an authoritative resnapshot;
other sessions and pending RPCs may continue. The routing path must be explicit
per method/profile and drift-tested against the pinned artifacts—never inferred
by generic property probing—and the marker must contain no provider parameters,
validator output, cause, or stack. Unknown methods, malformed envelopes,
snapshot failures, and missing, ambiguous, or invalid routing evidence remain
connection-fatal.

Keep a compiled SDK/protocol pin distinct from operator-runtime admission.
Generated artifacts and the production parser profile must have exact,
reproducible provenance, but an operator-managed provider subprocess should not
be rejected solely because its executable version differs from the artifact's
release. Where the provider promises backward compatibility, admit a documented
compatible runtime floor or range and verify the required protocol profile and
capabilities at startup. A newer compatible executable continues to use the one
pinned parser/profile; it does not silently enable new methods, fields, or a
fallback schema. Reject runtimes below the floor, malformed or explicitly
excluded releases, and any runtime that fails the required behavioral/profile
checks.

Do not digest-pin an operator-installed provider executable. Canonical path,
regular-file and execute permission checks, bounded release probing, closed
server-owned arguments/environment, and required behavioral validation are the
appropriate admission boundary; replacement by the same operating-system
account remains within that account's authority. Digest and build-identity
verification belongs to Sedes-owned artifacts that Sedes builds, transfers, or
installs, such as managed workers and sidecars.

When an externally maintained runtime identity outlives a product rename,
compatibility may admit only the exact inventoried historical runtime prefix
while continuing to require the current client identity returned by the same
handshake. Keep current writes and initialize requests current-only; do not
admit an old client suffix, unrelated prefix, or permissive product-name
fallback.

An exact executable-version pin is an exceptional safety restriction, not the
default. Use one only when evidence shows that compatibility cannot be
established—for example, an unstable wire contract or a release-specific
security, delivery, lifecycle, or persistence invariant. Document that
evidence, the affected surface, operator-facing failure, and the process for
admitting the next release. Expanding compatibility requires artifact review
and focused conformance (plus an authorized live-provider check when the
behavior cannot be proved offline), never a second parser or permissive
fallback.

Treat the protocol or SDK profile as immutable code-owned metadata of the
compiled backend module, not as operator configuration or durable backend
identity. Production composition must materialize that metadata before
provider-native or Sedes state opens and pass the exact resolved configuration
through preparation, migration, and reconciliation. Startup reconciliation
persists a changed compiled profile atomically, increments the backend
configuration revision once, and preserves the backend ID, connection profiles,
thread bindings, and provider-native identities. The database may constrain
the stored profile's shape but must not duplicate provider-release values whose
authority belongs to the compiled module. Direct and non-adjacent Sedes upgrades
or deliberate rollbacks follow this same reconciliation path; changing an
existing backend ID to a different backend kind remains an identity conflict.

Keep the shared operator configuration parser provider-neutral at this
boundary. It must not import provider release constants, duplicate an exact
release or compatibility line, or accept an operator-selected protocol profile.
Production composition must resolve every configured backend through the
compiled module catalog before acquiring provider-native or Sedes state
authority and before database migration or reconciliation. Enabled and disabled
backends receive the same code-owned profile and must validate their complete
provider-owned configuration and target shapes. A disabled backend contributes
no native namespace or store and remains impossible to instantiate. For every
compiled backend, test that catalog resolution supplies its exact profile and
that stale or tampered persisted profile evidence fails the runtime-generation
integrity gate before a runtime can acquire provider authority. Also test that
normal startup reconciliation replaces an older persisted profile with the
compiled value without changing backend, profile, thread, or provider-native
identity.

For a provider-owned native store, derive one deterministic namespace from the
effective provider home/config authority and prove every discovery, history,
create, and resume helper uses it. When provider configuration permits omitted
path overrides, resolve native defaults in the account and execution environment
that own the provider. Document explicit-over-native-default precedence and
validate the resulting authority before opening the SDK or native store; never
resolve an SSH default through the main server's environment. Treat native authentication as opaque
provider-managed state: preserve reviewed native home/config selectors, let the
provider read and refresh its credentials, and do not copy, parse, persist, or
rotate provider secrets. Establish availability through a bounded
provider-native auth/status operation or a classified auth-required protocol
response; never require Sedes to inspect credential files.

A native-store namespace identifies storage/config authority, not authenticated
account identity. Credential refresh or account replacement within that home
therefore preserves the namespace unless the provider exposes a stable opaque
account identity and the backend explicitly binds to it. Document that
continuity limit and do not claim cross-account isolation that cannot be
proved. If a feature semantically requires fixed-account continuity, it must
fence or rekey on provider-supplied opaque identity change or remain
unsupported.

Production should use the operator-selected native provider installation and
its normal home/config/authentication lifecycle by default, matching the
provider's own CLI or SDK. A disposable provider home, copied test credential,
synthetic config tree, or process/filesystem sandbox belongs only to an
explicitly isolated probe or test profile. Keep that machinery outside
production runtime composition and registration; evidence collection must not
silently become the application's credential or native-store manager.

For a provider with a base protocol plus optional or private extensions,
maintain a reviewed protocol profile that lists every required method,
notification, reverse request, metadata field, terminal signal, and capability
probe. A successful base-version handshake does not prove an extension. Parse
each used extension through a closed provider-private schema and release guard.
A missing or changed core profile requirement is an incompatible runtime and
an application-startup failure. An optional extension is omitted from
capabilities unless operator configuration explicitly requires it, in which
case the runtime is incompatible. Unknown events may be ignored only where the
protocol permits forward compatibility and must never serve as mutation
acceptance, turn completion, interaction recovery, or settings evidence.

Classify runtime-start failures before converting them into unavailable health.
Scope mismatch, invalid or incompatible configuration, native-store ambiguity,
persistence failure, and inability to establish a required security invariant
are application-startup failures. A syntactically and securely configured
provider that is merely unreachable, unauthenticated, or temporarily unhealthy
may remain registered as unavailable only when the module publishes that state
and every driver mutation fails closed. Backend-local recovery must not hide a
structural safety failure from shared startup composition.

## Publish compatible runtime drift as an active advisory

A runtime that remains compatible but is newer than Sedes has tested stays
available. Its backend module contributes one bounded, provider-neutral active
installation advisory scoped to the stable backend instance ID and configured
display label. Provider-native assessment data does not cross that boundary.

Active installation advisories are process-local computed state. They refresh
the authoritative application snapshot when the assessment changes, but are
not persisted and have no dismissal, unread, acknowledgement, or resolved-
history semantics. Use a stable advisory ID within the backend instance and
replace the current assessment rather than accumulating one warning per probe,
connection, target, thread, or observed version. Every compiled backend must
explicitly contribute either its source or the shared empty source.

The composite projection is bound to one authenticated tenant/principal scope,
includes an explicit application-level source for non-backend conditions, and
denies cross-scope reads and subscriptions. One shared maximum applies to each
final aggregate; explicit application and per-backend-instance quotas are
chosen so the application source plus all 32 configurable backend sources
cannot exceed it. The final projection still rejects aggregate overflow and
duplicate normalized IDs. Assessment bursts use latest-state dirty-bit
publication: at most one snapshot is in flight and one follow-up is pending.

## Capabilities are promises

A capability may be advertised only when the exact resolved backend instance,
target, execution environment, workspace, thread, and runtime generation can
perform it now. Projection and mutation enforcement must consume the same
authority.

Capability checks must cover:

- current configuration and policy revision;
- provider/runtime health and generation;
- thread lifecycle and active operation;
- required execution-environment facilities;
- feature registration and schema version; and
- any concurrency or confirmation rule.

Unsupported behavior is a normal disposition. Omit the capability and reject a
direct request. Do not expose disabled imitations, infer support from a provider
name, or silently route to another target or environment.

Provider-feature capability revisions and application capability revisions are
distinct. A feature action uses the feature revision for compare-and-swap and
receipt replay; application-owned gating such as read-only state advances the
application revision without inventing a new provider revision.

Provider-feature lifecycle coupling is owned by that backend or feature
module. Shared mutation services must not hard-code a provider feature ID for a
post-submit, post-interrupt, copy, fork, or cleanup effect. Each feature defines
whether and how its state transfers or reacts; an unrelated backend must not
inherit the behavior.

## Normalize history and live events

Confirmed failed turns carry bounded `failure.message` metadata, separate from
provider transcript items and transient runtime notices. Backends select a
provider-authored diagnostic; the shared projector supplies a generic explanation
when none was retained. Failure metadata is valid only on failed turns. Snapshot,
live update, older history and targeted seek must agree; enriching a missing
diagnostic publishes a turn revision, while replacing an observed diagnostic
requires an authoritative resnapshot. Never infer failure from a retry warning,
a tool error, cancellation, or unknown delivery outcome.

Pi derives the final diagnostic after retry settlement and reconstructs it from
native assistant records. Cancellation during retry backoff is retained as
conversation-authenticated non-message metadata, since Pi does not append an
aborted assistant record in that case. It remains interrupted after reopening.
Codex uses native turn errors and retains terminal
notification details for its existing exhausted-recovery projection; cold reads
show only evidence retained by the provider. Claude stores the selected diagnostic
in its existing scoped write-once terminal receipt; old receipts have no detail.
Claude maps declared startup-failure reasons to fixed explanations instead of
storing startup stderr, and selects one non-stack diagnostic line from other
terminal results.
Grok exposes no confirmed failed-turn outcome in its current admitted protocol;
its submission errors and unknown-outcome recovery remain separate.

The current error presentation follows authoritative failed run state and the
newest failed turn. New admitted work clears the current display; a rejected Send
does not. Historical details remain quiet and do not drive the sidebar. Dormant
thread summaries retain their existing loaded-runtime-only status behavior.
Diagnostics use selected plain text with bounds and narrow credential-pattern
scrubbing, not raw errors, provider payloads, stacks, or stderr. This is not a
claim that arbitrary provider text is secret-free. Failed-turn diagnostics remain
visible in both activity modes without exposing hidden operation details.

The store, selection rules, and timeline behind these rules are described in
[Usage accounting](usage-accounting.md).

Recorded accounting is opt-in through the installation-owned
`SEDES_EXPERIMENTAL_USAGE=1` main-server environment setting. A disabled
`UsageSink.enabled` must prevent creation of usage normalizers, history scans,
and usage-only runtime leases or subscriptions, not merely discard database
writes. Pi, Codex, and Claude implement this gate; Grok remains explicitly
unsupported. Provider delivery acknowledgements, normal conversation history,
and live context occupancy must continue when accounting is off. Main-server
recovery, report routes, and browser query subscriptions obey the same setting;
existing accounting remains persisted. No provider or sidecar protocol flag is
needed, and native provider recording is outside this policy's authority.

Provider-billed work outside an assistant response must enter the normalized
[`UsageSink`](../../src/server/usage/contracts.ts) without fabricating a message
or changing run state. Capture native evidence before lossy presentation, under
admitted tenant/principal/thread ownership and a native namespace independent of
connection aliases. A reconnect is not a new accounting epoch. Retain metric
presence, normalization version, model/provider dimensions, and coverage; absent
values are not zero and native correlations do not prove request cardinality.

Pi, Codex, and Claude implement durable capture through this boundary. Grok
explicitly declares `usageAccounting: "unsupported"`. Live `UsageSnapshot` and
`usage_changed` contain only context occupancy and transcript counters; token,
cost, and request totals come solely from accounting reads. Query-wide cumulative
facts cover lower-scope evidence rather than being added to it. Turn allocations
must establish native identity and attributable intervals; session completeness
never silently upgrades turn completeness. Copied ancestry requires scoped proof.
Completeness is relative to the declared measurement scope: complete main-agent
counts do not imply captured subagents. Keep scope restrictions and unknown model
metadata distinct from numerical capture gaps; neither alone makes counts partial.
Explicit partial facts remain authoritative. Claude's current normalizer retains
its conservative partial result facts pending a replay-safe normalization update:
reclassifying the same stable result receipt would otherwise conflict with saved
evidence. This is a deferred classification correction, not an SDK claim of
missing main-loop tokens.

Codex child capture uses native spawn ancestry under an admitted root binding,
with independent lifetime counters and durable parent/root ownership. Children
are accounting sources, not fork ancestors or fabricated application turns.
Main-agent turn summaries exclude child measurements and child-only gaps.
Session reports include each child's checkpoint once and expose a normalized
main/subagent breakdown. Capture and runtime residency outlive presentation
handles. Durable historical ownership must not imply live monitoring work.
Reconnect recovery uses indexed latest-source eligibility (`active`,
`disconnected`, or `failed`), excluding idle children and roots with no unresolved
children. It only subscribes eligible loaded children, does not read full history,
and ends monitoring for unloaded children while retaining gaps until a new
cumulative snapshot proves recovery. Current native activity may rediscover an
existing child through an exact scoped ownership lookup; idle or source-less
ancestors remain valid ownership metadata without being monitored themselves.
Release only attachments actually acquired by the coordinator in the current
connection generation; never send cleanup for historical registry entries alone.
Codex implements this child lifecycle. Pi's capture is unchanged; Claude retains
its inclusive query-pipeline totals without adding child counters a second time;
Grok remains unsupported.

An observation may carry `attribution`: the effective model and reasoning
effort in force when the evidence was produced, as confirmed by the backend at
capture. Never copy it from desired, draft, or current composer settings, and
never put it into the fact or its revision hash; replayed evidence must stay a
no-op. The timeline applies attribution only to source-timestamped or
continuously observed increments, and a fact-reported model always wins.
Backends that cannot establish a value pass `null`. Audit per backend:

| Backend | Attribution |
| --- | --- |
| Pi | Thinking level from the latest `thinking_level_change` ancestor on the entry's native branch; model and provider stay fact-reported. |
| Codex | The generation-fenced, provider-confirmed `#model` tuple. Attribution is withheld while a `turn/start` that changes the tuple awaits its receipt, and after one whose delivery outcome is unknown until a new confirmation. Subagent counters carry none. |
| Claude | The effort applied and confirmed before the result arrives, for the confirmed model's `modelUsage` row only; helper and subagent models in the same delta keep none. |
| Grok | Unsupported; no usage is captured. |

Register visible normalized turn stubs with ordinary snapshot/page loading.
Accounting failure must not retry submitted provider work or break an otherwise
valid transcript read. Retained native replay/history may repair evidence; do not
add an accounting sidecar spool or silently scan private rollout logs. Generation-
bound `usage_revision_changed` is a transcript no-op and only a refetch hint for
visible usage views. Never create or wait for an actor solely to publish it.

Provider system prompts and tool declarations remain private even when stored
in the native transcript. Accounting retains bounded normalized measurements and
provenance, not raw transcript, request bodies, credentials, or tool output.

Ordinary user and assistant text is authoritative conversation content. Preserve
it exactly with the message-text contract in history, live deltas, terminal
replacement, and replay; never pass it through tool or display preview clipping.
Each serialized text and complete message item is bounded to 16 MiB, including
JSON escaping and UTF-8 encoding. Backend pages remain bounded to 16 MiB and
normalized pages to 32 MiB, so their metadata and other items also consume the
budget. Unsupported individual message sizes fail explicitly as
`incompatible_protocol`, non-retryably, with a provider-private
`*_message_payload_too_large` code; they must not produce a partial successful
message. Keep this error distinct from an aggregate page-size limit: reducing a
page must not hide an oversized individual message. Live ingestion must invalidate
or fail the retained projection and request resnapshot/recovery, rather than
continue from partially mutated state. Grok retains a sticky recovery failure
and clears its mutable projection and identity state before accepting another
acquisition. Preview/reasoning/tool limits remain independent. This is
implemented by Pi, Codex, Claude, and Grok; provider-native acquisition bounds
continue to apply before normalization.

Retained native user messages may contain up to 10,000 content parts, subject to
the same complete-message byte limit and each backend's native structural
bounds. This history guard is independent of composer request limits for
attachments, context excerpts, and Task references. Do not impose the composer's
34-part request bound on history authored in another provider client, or clip
excess native parts into a successful partial message.

This contract belongs to the existing tenant/principal-scoped thread projection
and adds no persisted transcript, provider capability, configuration, or authority.
Client protocol 104 accepts complete message text and the retained-history part
bound, and rejects the old truncated message shape. Update bundled Android and
Electron clients together with the server; older clients fail the protocol
compatibility check rather than applying shapes they cannot validate.

The provider remains authoritative for transcript history. Sedes maintains a
bounded in-memory normalized projection for the active provider generation;
SQLite stores application overlays, identities, bindings, settings, receipts,
and recovery evidence rather than a second canonical transcript.

A backend must define:

- native-to-normalized identity mapping;
- initial snapshot bounds and ordering;
- live-event parsing and correlation;
- duplicate and reconnect behavior;
- unknown or forward-compatible native events;
- generation changes and stale-event rejection; and
- the point at which a normalized turn is complete.

When a provider exposes multiple persistence or observation rails, such as a
model transcript, UI replay updates, terminal notifications, usage telemetry,
or summary indexes, record which rail is authoritative for each normalized
concept and how they correlate. Do not treat replay visibility as model-history
authority or a transient notification as durable completion evidence. Stable
normalized identities must come from durable native identities or a persisted
provider-private identity map, never array position, file offset, prompt index,
or a newly generated stream UUID. Raw offsets are not durable cursors across
append, rewind, compaction, or branch filtering unless the provider proves that
stability. If one cursor envelope can contain multiple semantic records, define
stable identity below the envelope as well.
Do not assume a provider event identifier is unique across a session, process,
or reconnect unless the reviewed runtime proves that scope. Key duplicate and
conflict evidence by the narrow durable native authority that actually owns the
identifier (for example, prompt plus event ID), and include that same scope in
private record identity. Keep an event with no reviewed correlation fail-closed
rather than guessing which prompt or generation owns it.

Browser activity summarization is a shared post-normalization projection, not a
provider protocol or backend history mode. Backends must always produce the
complete normalized item required by execution, lifecycle, history, forks, and
internal consumers. They must not omit native detail based on a browser's
`full` or `summary` selector, and provider-specific identifiers or summary
shapes must not bypass the normalized contract.

When a provider supplies an explicit reasoning summary separately from detailed
reasoning content, preserve its bounded ordered parts as the optional normalized
reasoning summary. Never derive that field from raw reasoning, thinking, or
other provider text. Summary browser projection may retain only those explicit
parts while omitting detailed reasoning content and every operation payload; a
backend without an explicit summary leaves the field absent.

A normalized compaction item marks a provider-proven compaction boundary. Its
optional summary is content authored and retained by the provider for that
boundary, not a Sedes status sentence, compact instructions, or text inferred
from nearby history. A backend whose durable compaction item carries no summary
must omit the field. The browser renders every boundary as a static marker and
offers expansion only when the optional summary is present.

Every new backend-neutral normalized activity kind must receive an explicit
browser-presentation audit disposition. It must either define an
`activityKind`, its fixed client-derived label and count category, and the
status/timestamp fields that survive summary projection, or be classified as a
non-activity boundary that breaks an activity group. Enumerate every omitted
detail field, including error text; a failed status may contribute to the
aggregate without exposing its diagnostic. Apply that disposition consistently
to initial and replacement snapshots, live incrementals, replay and overflow
recovery, older-history pages, targeted seeks, and direct thread snapshots.
Raw-wire tests must prove that unique markers placed in omitted fields are
absent from the serialized summary responses, not merely hidden by the client
renderer.

Initial history and live subscription must form one coherent stream. Events
cannot be lost between snapshot and subscription or applied twice after a
reconnect. Native identifiers and raw payloads must not leak as browser
authority.

At the common older-history boundary, a backend page must satisfy the
normalized page schema and the requested whole-turn limit. An invalid or
over-limit backend page fails that request without adaptive retries. Adaptive
page-size reduction applies only to a valid page that exceeds the remaining
normalized item or byte window; if one valid whole turn still cannot fit, fail
that acquisition retryably instead of publishing an empty page or fabricating
end-of-history. An empty page with another cursor is likewise non-progress,
not authoritative absence.

Normalized item-count ceilings are wide resource-safety guards, not ordinary
turn-duration budgets. They must leave room for each backend's reviewed source-
specific acquisition or compaction bound instead of accidentally becoming the
smaller authority. Serialized backend-page and normalized snapshot/page byte
ceilings remain the effective content bound; raising a count ceiling must not
remove those byte checks or split one native turn to make it fit.

The normalized history contract does not prescribe one provider acquisition
strategy. A backend adapter may retain one complete provider history for an
attachment and serve normalized pages locally, or retain a bounded native
window and reacquire older pages when the provider has a genuinely paged
authority. Choose the simplest truthful provider mechanism; do not repeatedly
invoke a nominal page route that internally rebuilds the complete history, and
do not add native paging solely for cross-backend symmetry. When a provider
reports multiple history modes, branch on that exact closed discriminator
without probing or silent fallback. Migration between provider modes is an
explicit maintenance operation, not a side effect of attach or page loading.

Targeted turn location is a required server-internal history operation, not a
loop over normalized older-history pages. Sedes supplies a pure predicate
that derives application identity from each backend-private turn identity; the
backend enumerates native turn candidates newest first and returns exactly one
whole matched turn without a continuation cursor. It must distinguish an
exhaustive authoritative absence from exhaustion of the caller's explicit
candidate bound, while transient transport, cursor, and generation failures
remain retryable errors. A retained-history backend locates against that one
authoritative acquisition. A genuinely paginated backend enumerates lightweight
native turn shells and hydrates only the matched shell; it must not hydrate
every intervening turn or fall back to repeated normalized page projection.
Completed historical turns remain independently readable while a newer head is
active. The operation shares history-read cancellation and mutation preemption,
and native identities never enter application or browser protocols.

Pi, Claude, and Grok implement targeted location over their retained
provider-private history. Legacy Codex scans its retained native thread, while
paginated Codex follows bounded `thread/turns/list` shell pages and calls the
turn-filtered item route only for a match. The in-memory conformance backend
implements the same contract. No compiled backend uses a persistent locator
index or the generic older-page loop as a fallback.

Projection replacement uses two distinct observation rails. The actor detaches
the active sequenced projection before capturing its replacement, and the
backend buffers or journals the gap for `subscribeFromNext`; a handle must not
require overlapping projection subscribers. The independent raw handle-event
subscription remains attached across that gap so an irreversible
`provider_handle_closed` invalidation is latched synchronously and forces handle
replacement instead of installing a snapshot from a fenced generation. Audit
both rails for every backend and test exclusive-subscriber replacement as well
as closure during an in-flight capture. A backend that can invalidate its
handle during capture must observe the projection abort signal across every
asynchronous establishment wait and settle promptly after cancellation;
checking only at entry is insufficient.

Enforce native history/replay acquisition bounds before retention and projection.
A backend must page at the provider boundary where supported or use an abortable
incremental decoder with per-acquisition frame, byte, event-count, item, and time
bounds. Receiving an unbounded replay and only then synthesizing bounded
normalized pages is not a memory bound. Acquisition overflow may fail that one
history, attach, or replacement request retryably, but it must not fabricate
authoritative absence, become a conversation-lifetime quota, or fence an
otherwise healthy conversation or provider process. Release acquisition-local
replay/live interleave state on success, abort, replacement, or request-local
failure. Normalized history, indexes, and dedupe state must remain proportional
to the current display window and unsettled operations rather than conversation
age. A provider mode whose only authoritative acquisition is one complete
bounded snapshot may retain that provider-private snapshot for the attachment
and page it locally; do not duplicate it into a complete normalized snapshot,
second cache, or persistence mirror.

History paging is request-local read work and must not delay an admitted user
mutation. The conversation actor registers cancellation before enqueueing each
history read and synchronously aborts every queued or in-flight read before a
turn-starting mutation enters its mailbox. A queued read must observe the abort
before provider work; an in-flight backend acquisition must propagate the same
signal through every abortable provider wait and promptly release its
request-local state. This preemption does not reorder mutations: the cancelled
read settles at its existing mailbox position before the already-enqueued
mutation runs.

Initial attach failure is also part of the normalized stream contract. Before
the live marker, runtime acquisition, history projection, replacement capture,
schema validation, encoding, and frame-bound failures must produce one bounded
browser-safe `thread-load-error` SSE event and end that attempt. Native
EventSource cannot inspect non-2xx JSON bodies, so a thread route must not leave
these failures to ordinary HTTP middleware or an opaque reconnect loop.
Provider-private codes and causes stay on the server; only the normalized API
error, retryability, and Sedes request ID cross the boundary. Every compiled
backend must classify invalid authoritative history and an individual normalized
field that cannot satisfy the product contract as non-retryable. A bounded native
acquisition that overflows before retention, and transient timeout, overload, or
availability failures, are retryable and request-local; they do not fence the
conversation. Tests must cover both pre-header runtime acquisition and post-header
pre-live projection or encoding failure.

The shared thread route applies a finite deadline to runtime acquisition,
releases an acquisition that resolves after its caller has timed out, and emits
the timeout as retryable normalized evidence. The browser may retry a
classified transient failure only a bounded number of times before requiring
an explicit user retry.

Thread viewing has a 90-second outer runtime-acquisition budget for all four
compiled backends. Codex establishment shares one 60-second cancellation
deadline across metadata reads, resume or retained-session attachment,
hydration, and stabilization retries, in both legacy and paginated history
modes. Individual history reads retain their 60-second request budget; each
subsequent paginated bootstrap, older-page acquisition, or detached-head load
also has a 60-second aggregate deadline. Starting another read or stabilization
attempt must not restart the establishment clock. Pi, Claude, and Grok inherit the outer viewing
budget with their existing provider-specific deadlines unchanged. This is a
server-owned request policy, not a persisted thread setting or new capability.
Keep provider read budgets below the outer viewing budget, propagate existing
caller cancellation through the read chain, and release late acquisitions.
Longer viewing budgets must not extend mutation, acknowledgement, control,
discovery, or best-effort live-refresh deadlines.

The control event applies while the response remains writable. A socket close
or initial-write drain timeout cannot carry a second frame behind blocked
bytes; it remains a transport failure handled by EventSource reconnect rather
than server-classified application evidence.

High-rate provider deltas must be coalesced before any expensive history-wide
projection work. A backend may keep a bounded, generation-scoped private live
overlay and project only its dirty item slices, while lifecycle boundaries
continue to run complete authoritative projection. Such an overlay must use
the same item interpretation as full history; fence provider generation and
projection-install epoch; bound accepted and retained bytes, pending items,
and scheduled work; cancel synchronously on terminal state and replacement;
and suppress byte-identical normalized replacements. Terminal provider items
always replace provisional reconstruction. Audit this structurally: ordinary
delta acceptance and flush must not validate, serialize, clone, enumerate, or
project the complete history merely because a downstream event coalescer will
later reduce browser updates.

Native token/chunk boundaries are not semantic history records. Compact
contiguous deltas into the stable normalized block they update while retaining
the provider identities needed for duplicate/conflict detection. Dedupe evidence
is retained state too: canonicalize it to fixed-size fingerprints and bound it
by both entry count and charged identifier/fingerprint bytes, including aliases
for semantically duplicate terminal events. Apply semantic record and byte
limits to the compact block representation rather than repeatedly counting raw
chunk envelopes; otherwise a provider's tokenization becomes an accidental low
conversation-lifetime cap. Live publication may carry accepted deltas, but
authoritative snapshots, replay, history paging, and terminal replacement must
all read the same compact block state and preserve stable turn/item IDs across
different replay chunking.
Release fingerprints and completed records after they leave the current whole-
turn window and no unsettled operation or in-flight page still needs them; a
dedupe watermark must never fail the conversation merely because it is old.

Treat provider notifications that replace a complete semantic collection,
such as a plan, as full replacements of one stable bounded item rather than as
an append-only event list. Preserve the item's first source position and stable
entry identities defined by the normalized contract, while charging only the
latest bounded replacement plus the fixed duplicate evidence required by the
current window. A metadata-free cosmetic cleanup is not durable completion
evidence; ignore only that exact reviewed shape and derive terminal settlement
from the provider's durable turn terminal when the two rails are equivalent.
Live projection, replay, paging, and reopen must converge on the same normalized
item without introducing a provider-specific browser shape.

A provider turn-terminal record establishes final turn status; it is not, by
itself, proof that the provider's event journal or notification queues cannot
later deliver another record for that same native turn. Group delayed records
by the provider's reviewed turn identity and retain them in the terminal turn.
Only a reviewed different-turn boundary closes that grouping. Continue to
reject conflicting duplicate terminals, closed-turn identity recurrence, and
records whose native turn cannot be identified without guessing.

Classify a known notification's bounded routing identity before admitting it to
an asynchronous semantic-handler queue. Frames for an unowned child session or
another resource with no consumer dependency are passive traffic: ignore them
without allocating per-delta work, while retaining structural frame and route
bounds. For owned high-rate traffic, enqueue only bounded incremental work and
apply carrier backpressure at queue watermarks. Tests must cover a legitimate
burst larger than each watermark and prove eventual ordered delivery without
connection teardown, unbounded retention, or full-history work per delta.

Treat provider-reported tool locations and diff paths as bounded display
metadata, not filesystem authority. A provider may report a workspace-relative
path even when its protocol describes an absolute path; that representation
difference must not terminate the session when Sedes does not depend on the
path. Before any later file operation, resolve and canonicalize the value under
the backend's exact workspace and environment authority instead of reusing the
display field as an authorized path.

Interpret provider tool updates as stateful patches keyed by the provider's
reviewed tool-call identity. Omitted fields retain prior state and provider
replacement collections replace rather than append; live deltas and replayed
consolidated state must converge on the same normalized item identity and
meaning. Terminal tool state is monotonic. Conflicting identity reuse, terminal
regression, or an unresolved tool dependency requires authoritative recovery
unless a reviewed provider turn-terminal contract also settles its child tool
activity.

Run state is likewise semantic rather than a direct copy of a provider process,
transport, or input-pump state. Do not clear the normalized active turn,
interrupt target, or Stop availability from a generic idle notification while
the backend's reviewed durable projection still has an in-progress turn. Keep
them latched until the exact reviewed turn-terminal result or recovery evidence
settles that turn; then publish the terminal turn and idle run state in order.

Normalize provider titles, text, and errors at the backend boundary. Apply
shared length and payload limits before persistence or broadcast. One malformed
provider item must not turn a bounded page into false evidence that other
conversations are missing.

## Treat mutations as recoverable operations

Any operation that can outlive a request—create, bind, send, fork, settings
change, provider action, interrupt, or discovery reconciliation—needs a stable
operation identity and explicit recovery semantics.

Classify failures as:

- proven not accepted by the provider;
- accepted and correlated to native evidence; or
- unresolved.

Retry a provider mutation only when non-acceptance is proven or the provider
offers a reviewed idempotency contract. Timeouts, disconnects, and malformed
responses do not prove rejection. Preserve unresolved evidence and reconcile by
exact operation correlation; do not guess from nearby timestamps, titles, or
prompt text.

Persist durable Sedes identity and intent before an external side effect when
the operation requires later reconciliation. External synchronization that
follows an accepted SQLite change runs after commit; never hold a database
transaction open across provider RPC.

Receipts are scoped, bounded, and replay the result of the exact accepted
operation. They are not a cross-principal cache and cannot be reused across a
configuration or runtime generation that invalidates their authority.

A persistent Codex transport may compact a reconciled receipt only by atomically
moving its bounded deduplication proof onto the existing final application
creation attempt or submission observation. Replays must consult that proof by
exact scope, runtime, operation, and request fingerprint. Pending and uncertain
receipts never expire. Application retention changes must preserve this proof
for every operation that can still be retried. A rejected steer is releasable
only with a normalized no-active-turn or expected-turn-mismatch rejection;
proved-unsent delivery is also releasable. Arbitrary provider errors are not
proof of no effect. This transport handoff is Codex-private; Pi, Claude, and
Grok retain their existing application recovery paths.

Native title synchronization uses the normal registered rename action. For a
provider-assigned conversation, apply the initial application title only after
the exact native identity is durably associated with the creating thread and
before first input. A response proves acceptance; a proved-unsent request may
be attempted later; a sent request with a lost response remains unresolved and
must be reconciled from authoritative native title metadata before any retry.
Persist the application title only after provider acceptance is proved and
fence that write by the expected application-thread revision. Native titles,
operation caches, and reconciliation reads remain bound to the exact tenant,
principal, backend, target, environment, workspace, and conversation. Do not
project provider rename payloads or native identifiers into browser contracts.
When the provider title bound is narrower than the normalized application
title, define one deterministic safe native projection, retain the full
application title locally, and reconcile against that projection. Never let a
valid application title wedge first-send creation merely because the provider
accepts fewer characters.

## Discovery and pagination

Discovery is bounded by provider namespace, workspace, backend instance,
environment, tenant, principal, and generation. Only an exhaustive terminal
scan can prove that a previously known conversation is missing. Bounded-recent
or interrupted scans may add and refresh records but may not reconcile unseen
records away.

Rediscovery that only refreshes the reconciliation timestamp must preserve the
application thread revision. Changes to the effective title, availability, or
last activity advance that revision and publish to both the application summary
and any retained thread stream. If discovery overlaps initial thread snapshot
composition, refresh the application overlay before granting stream authority;
do not attach a dormant provider or make discovery wait for provider startup.
Pi, Codex, Claude, and Grok use this shared, principal-scoped inventory and
publication boundary; their private discovery protocols remain unchanged.

Backends must honor the discovery abort signal. Provider operations that cannot
actually be cancelled remain owned and awaited during shutdown.

When native stable pagination is unavailable, a backend may synthesize it from
one bounded enumeration. The ephemeral snapshot and its cursors must be:

- scope- and generation-bound;
- opaque, sequential, single-use, and expiring;
- limited by item count and projected bytes; and
- removed on completion and runtime shutdown.

A continuation never re-enumerates a changing namespace behind the same cursor.
Bind a continuation to stable caller, policy, environment, resource, and
generation authority. Do not bind it to the complete invocation input digest
when the continuation request necessarily changes that input by adding the
cursor itself.

## Interactions, input, and interruption

Background work is a separate, thread- and runtime-generation-owned observation
from main-turn readiness. The optional normalized `backgroundActivity` snapshot
and `background_activity_changed` event carry bounded category counts and a
display description. Absence explicitly means this observation is unsupported;
`unknown` means the supporting backend lacks authoritative current inventory.
Only a known empty inventory proves no observed work remains. Snapshot replacement
must replace this observation, and browser disconnection must suppress claims
that a retained count is current. Neither historical launch rows nor main-turn
completion establish background liveness. Outstanding or unknown activity must
block automatic idle eviction without changing Send, Queue, or main-turn Stop.
When a provider clears its live inventory before delivering the terminal
bookend, its handle's `retirementBlocked` observation keeps cleanup from
destroying the unsettled outcome. This private lifecycle hold does not invent
visible running work and clears after either supported terminal bookend has
been consumed. Inventory membership must never be used to pair native edge
identities when the provider does not guarantee that correlation; hold only
observed top-level launches for which the backend can persist an outcome.
Send and queue dispatch use the actor's `authoritativelySettled` main-turn
observation; `canEvict` is exclusively a cleanup-safety check. A thread may
accept a new ordinary message while its background work or notifications still
prevent retirement.

Claude implements this observation from native inventory events in local and
persistent runtimes. Codex keeps its existing collaboration interactions but
intentionally omits this inventory: individual tool results cannot reconcile
all child work across reconnect. Pi and Grok intentionally omit it as well.
The shared UI keys off observation support, never provider names. Provider-native
task identities and lifecycle interpretation remain private; terminal bookends
may use scoped durable receipts for history presentation, but those receipts
never restore live work or produce another main-turn completion. Native forks
copy lifecycle receipts only for main-thread tool calls in the retained prefix,
under the authenticated owner and exact child thread/session identity.
Preserve provider-authored message provenance across live, worker, persistent,
and history paths when it determines transcript presentation. A user-role
transport record is not by itself proof of human input. Internal task bookends
may establish an assistant continuation boundary without becoming a visible
user message, submission receipt, prompt ordinal, or empty running turn. Never
hide user text merely because it resembles a provider notification envelope.

Decision prompts and bounded questionnaires use the normalized interaction
contract described in [Blocking interactions](blocking-interactions.md).
Primitive provider prompts do not become questionnaires by inspecting their
labels or option order.

Each backend advertises supported interaction kinds independently. It must
cover open, response, provider resolution, stale generation, reconnect, user
interrupt, and shutdown. Browser-generated nested response IDs are opaque
correlation values, not provider authority. Sensitive answers remain ephemeral
unless a separately reviewed contract says otherwise.

Transport completion of an interaction response is distinct from provider
confirmation. Releasing a forwarded request must not abort an already submitted
response that still awaits its provider acknowledgment. Test that boundary
through the real transport with confirmation delayed, including disconnect,
timeout, and unanswered-request expiry. Codex's persistent runtime uses
`server_request_settled` for forwarding cleanup and `serverRequest/resolved`
for provider confirmation; other backends retain their own private completion
semantics.

Pending interactions, application run state, and response capabilities must
converge at the same publication boundary. A provider's active/running event
must not overwrite an application waiting state while an interaction remains
pending. Interaction open, resolution, capability refresh, and reconnect
checkpoints must all agree; test producer output through the real client
authority reducer rather than only constructing matching fixtures. This shared
rule applies to Pi, Codex, and Claude interactions and application-owned
decisions. Grok intentionally has no provider blocking-interaction capability.

Optional invocation context belongs to the exact thread-scoped pending
interaction and is read-only presentation, never response or execution
authority. Codex derives it from the request's explicit tool-approval metadata;
the browser receives only bounded, redacted normalized values. Never correlate
an approval to the latest transcript tool or parse its title to infer arguments.
Missing metadata means absent context. Pi and Grok intentionally omit this
context; Claude retains its existing bounded decision details. Keep invocation
parameters separate from editable response content for every generic renderer.

An interaction option that persists a provider rule or preference is also a
policy mutation at its actual installation, principal, workspace, or thread
scope. Model that side effect, confirmation, receipt, recovery, precedence, and
transfer behavior separately. If the broader mutation is not reviewed, omit
the persistent option even when the provider offers it.

Provider safety hints are part of pending interaction authority. Preserve them
through private transport and reattachment: a default-deny request must not gain
an approval shortcut, and a suppressed reusable grant must be rejected by the
server even if a caller forges its action ID. Descriptive tool provenance does
not authorize execution. Verify both normalized presentation and provider response.

Classify every provider-side queue, pending interaction, approval gate, usage
accumulator, and active-mode observation as durable, replayable, or
generation-volatile. Provider loss closes volatile interactions and invalidates
volatile observations; do not recreate them from nearby transcript events or
resurrect provider-private queue entries after restart. Restore a pending gate
only from exact durable provider evidence. If a metric resets across provider
generations, expose a discontinuity or absence rather than zero or a falsely
cumulative value.

Send, steer, queue, and interrupt must correlate to the exact Sedes thread
and active normalized operation. An interrupt must not cancel an adjacent or
newly started provider turn. Queue dispatch observes durable ordering and
readiness barriers; backend adapters do not invent a parallel queue.

Application completion consumers must bind to one exact authenticated target
operation and consume the backend-neutral authoritative completion rail. The
completion observation records the normalized application turn, terminal
outcome, and one immutable bounded assistant-result snapshot before any
consumer side effect. Consumers register and materialize durable obligations
idempotently; they must not infer completion from queue disappearance, browser
presence, text equality, provider-native identifiers, or a later thread turn.
This common rail supports current attention state and thread-completion
callbacks and passive external notifications. A consumer does
not add provider callbacks, provider-name branches, or a second completion
state machine. Adding this rail does not itself expose a generic HTTP hook.

Passive external notifications consume finalized observations on this same rail,
including enrichment after recovery first records an incomplete observation.
Pi, Codex, Claude, and Grok all use this normalized path; none adds a private
notification callback or exposes provider identifiers in a script payload.
Successful-turn notifications may opt into a separate immutable classified
assistant-result snapshot captured alongside the callback aggregate. Keep the
aggregate callback contract unchanged. Backend assistant items may carry
server-only `responsePhase` (`provisional`, `final`, `unclassified`); omitted
phase means no evidence, not final. Strip this field at browser projection.
Classify all text blocks of one native message together. Codex preserves native
phase labels; Pi uses settled native assistant-message evidence; Claude uses
native message groups and terminal evidence/receipts. Grok intentionally remains
unclassified because ACP chunks do not establish a final-message boundary.

The authoritative completion transaction freezes the three nullable sections.
Historical rows with unavailable classification remain unavailable on replay;
never re-read a mutable transcript at notification dispatch or change an already
finalized snapshot. Classification is principal/thread-owned completion data;
the existing principal notification preference controls delivery only. Preserve
wrong-scope denial, event eligibility, generation fencing, and disabled-path
avoidance of result copying. Partition before bounding with one 16 KiB text
budget, prioritizing final, then provisional, then unclassified. The serialized
64 KiB notification limit can further shorten sections or omit the result
without dropping otherwise valid metadata. Notification version 3 carries these
selected sections, omitting unselected keys; scripts must not accept obsolete
shapes as aliases. The principal-owned `assistantResultPhases` selection defaults
to empty and shares notification revision/generation fencing. It is the sole
response-inclusion control; no separate master boolean is accepted. Filtering
precedes response copying: unselected sections must not be read or cloned. An
empty phase selection produces metadata-only delivery.
Notification event consumption is deduplicated per principal and normalized
thread/turn, separately from UI attention acknowledgment. Wake hooks consume
committed snooze deadline transitions; automation-start hooks require actual
input acceptance after any pre-check. Transport errors and uncertain operations
must not masquerade as terminal failures.

Interaction notifications observe first acceptance of a normalized pending
request in the shared interaction broker, including application-owned decisions.
`decision` and `confirmation` produce `approval.requested`; `choice`, `text_input`,
`editor`, and `questionnaire` produce `input.requested`. Never infer the category
from provider names, display labels, or option text. Pending-dialog publication,
reconnect replay, answers, and resolution are not notification sources. Emit only
application-owned request identity/kind and thread/workspace context; exclude
prompt text, commands, options, answers, and secrets. The hook is independent of
browser presence and failure must not interfere with interaction acceptance.
Pi, Codex, and Claude use their existing normalized interaction paths. Grok has
no provider blocking-interaction surface and does not synthesize one; shared
application decisions remain eligible. Nonblocking questions are excluded from
these blocking-interaction notifications.

Nonblocking questions use the typed, bounded assistant-item
`nonblockingQuestions` facet and an explicit backend capability. Provider-native
validation and stable identity remain inside the backend. The application owns
principal/thread-scoped durable pending requests and resolved source identities;
only newly observed live items create requests. History hydration must not
reopen old questions or create a notification backlog. Ordinary later messages
and terminal turns do not resolve these requests. A pending batch retains stable
original question indices. Responses supply answer indices and text; the server
validates these against the stored pending request and generates labeled ordinary
user text from authoritative titles. Answer admission and partial resolution
share a transaction and revision check, leaving unanswered siblings pending and
preserving the composer draft. Dismissing resolves the remaining questions
silently. Neither action answers a blocking provider request.

Inline question resolution presentation uses application-owned per-index evidence,
recorded atomically with reply admission or dismissal. Null historical payloads
are not evidence of dismissal: remembered, skipped, and legacy entries remain
unknown. The principal/thread-scoped status lookup accepts at most 100 normalized
source item identities per request and returns only those entries; do not append
an unbounded ledger of resolved identities to question events or snapshots.
This mechanism is backend-neutral: Codex supplies the normalized facet; Pi,
Claude, and Grok currently declare nonblocking questions unsupported.

Application summaries expose only the count of unanswered questions, aggregated
from principal/thread-scoped durable requests. Creation, partial answers, and
dismissal publish this summary independently of a browser's thread subscription.
Archive impact includes pending counts for the root and descendants so every
archive entry point can show the same confirmation. Archiving preserves pending
requests. These application-owned rules apply across Pi, Codex, Claude, and Grok;
they require no new provider operation or inferred capability.

Replies use the shared delivery gateway to resolve steering, idle submission,
or queued delivery. A steer admitted outside the composer must use the same
active-turn dispatch scheduling as a composer steer, without waiting behind
the submission it is meant to steer. Return the durable admission identity and
delivery state so immediate browser feedback can reconcile with queue/history
events without duplicates or fabricated delivery success.

Question-response provenance is a closed `question_response` delivery origin,
owned by the principal/thread and retained in the immutable delivery snapshot.
The queue must preserve it across retries and recovery. History rendering restores
it only through the existing authenticated delivery-operation correlation, never
by guessing from a text prefix or trusting a provider-selected origin. It retains
the request/source identity and answered question/answer pairs after pending data
is removed. The provider receives ordinary labeled text; Sedes retains styling
metadata. Existing provider support for authenticated delivery snapshots carries
this origin without inventing a provider-specific answer operation.

A newly committed question batch produces `question.requested` through the
shared notification observer, independent of browser presence. Use only the
application request ID, count, and generic thread/workspace context. Exclude
question text, options, and answers. Replay, history, send, and dismissal do not
notify. Every compiled backend must explicitly advertise supported or unsupported
nonblocking questions; never infer this workflow from assistant prose.

Unlike durable thread callbacks, passive script hooks intentionally provide no
delivery guarantee, retries, outbox, or receipts. Only configuration, silence,
and bounded event-consumption markers persist. Installation-owned process
execution policy runs scripts on the server irrespective of thread topology;
principal-owned settings choose events and a local executable. Observer failure
must never interrupt conversation, inventory, or automation lifecycle work.

`thread.send@2` completion callbacks are application-owned one-shot consumers.
Registration is atomic with admission of the exact send and is authorized only
for an authenticated thread-agent caller; a principal Tool client has no
calling thread and fails closed for `callback: true`. Delivery returns to the
calling thread/session rather than the registering turn. If that thread has a
current active turn, Steer uses the backend’s advertised targeting mode: an
exact turn for Codex/Pi, or the conversation for Claude. A proven stale exact
target demotes the same durable callback input to Queue. Without Steer, or while
idle, normal durable Queue and Submit lifecycle starts a new turn when possible. The provider receives ordinary
user-role input. Every authenticated thread-agent send also snapshots
`agent_message` provenance from its initiating thread, while completion
delivery snapshots `agent_result` provenance from its completed source thread.
The application adds the agent-message source label to model-facing text but
keeps that framing out of canonical browser content. Both origins remain
separate from provider history, so the UI never attributes inter-agent input
to the human or fabricates a provider system/developer message.

The browser's delivery mode is intent, while authoritative server admission
records a separate resolved mode. Apply this matrix atomically with draft
acceptance:

| Authoritative admission state                       | Requested intent        | Resolved mode                                  |
| --------------------------------------------------- | ----------------------- | ---------------------------------------------- |
| Idle or failed                                      | Submit, Steer, or Queue | Submit                                         |
| Running, exact Steer supported                      | Submit                  | Steer against the server-observed current turn |
| Running, conversation Steer supported             | Submit or Steer         | Steer to the conversation at its next opportunity |
| Running, Steer unsupported                          | Submit                  | Queue                                          |
| Running                                             | Queue                   | Queue                                          |
| Running, explicit Steer target is stale or replaced | Steer                   | Queue; never retarget                          |

Transitional, disconnected, recovery, or otherwise uncertain state fails
closed instead of choosing a row from the matrix. The receipt, durable queue
summary, and later fallback retain the requested intent and expose the current
resolved mode so clients reconcile presentation by authority rather than by
their original guess.

Delivery capabilities declare `steerTarget: turn | conversation | null`.
Explicit browser Steer carries a discriminated target and is admitted as a
durable, FIFO application intent. A turn target binds it to the exact normalized
active turn observed by the browser before the provider call. A conversation
target deliberately carries no turn ID: the provider may incorporate it in
current work or start the next turn if current work has already settled.
The application never fabricates a turn ID for conversation delivery.

For turn-targeted Steer, the server must never replace that explicit target
with whichever turn is active when the request arrives. This does not constrain a requested Submit
that resolves to Steer: that operation intentionally targets the current turn
observed by authoritative server admission. Multiple admitted Steers may
coexist, but Sedes invokes the backend serially. An adapter must reject a
stale target and must never retarget it to a later turn. When Sedes proves
during application admission, or an adapter proves before its submission
boundary, that the exact target is no longer active, Sedes preserves the same
durable operation, immutable target, payload, and replay identity while
demoting its effective delivery to ordinary next-turn queue work. An adapter
reports that proof through the normalized `target_no_longer_active` Steer
rejection. Generic rejection, timeout, disconnect, malformed response, or any
crossed-boundary outcome must not take this fallback.
Application admission must reject a target-bound Steer behind ordinary active
queue work instead of durably accepting a guaranteed-stale intent; existing
target-bound Steers may stack in FIFO order. Pending and proven-unsent intents
remain application-mutable; after the submission boundary, cancellation is
unsupported unless a backend
adds a separately normalized, truthfully advertised cancellation operation.
Provider-private queues are not application authority.

A successful provider mutation receipt irrevocably crosses the submission
boundary. Validation, projection, event publication, or local persistence that
runs after that receipt may return an accepted result or a crossed-boundary
failure, but must never expose a clean `invalid_state` or other proven-unsent
classification. The adapter must also fence same-process replay of that
operation until exact reconciliation proves its outcome; a post-receipt local
failure must never cause the same authenticated operation to be submitted as a
new provider turn.

A transport timeout, EOF, or lost response after a mutation was admitted is not
evidence of rejection or non-execution. Preserve the exact owner-scoped operation
receipt until an authoritative inspection or explicit, recorded disposition
settles its outcome. Reconnect and main-process retirement must not discard that
receipt, mint a replacement operation, or blindly replay the mutation. Report
the outcome as unknown when evidence is insufficient; transport loss alone cannot
establish an unsent classification. This rule covers provider mutations
and persistent-sidecar lifecycle, file, attachment, and terminal operations.

Do not infer Steer support from a provider accepting a second prompt request,
from its native UI accepting input during a turn, or from another adapter
folding concurrent requests into one displayed turn. The reviewed provider
contract must prove the advertised targeting semantics: exact active-turn
targeting (or an authoritative pre-boundary target check), or native incorporation
at the conversation’s next opportunity. Both require authenticated operation
materialization, terminal
and replay grouping, serial-dispatch behavior, and interrupt races. A provider
that supports only a next-turn queue continues to omit Steer; Sedes's durable
provider-neutral Queue may still be derived from ordinary Submit and dispatches
only after the active turn settles.

An earlier queue-owned Steer may already have crossed its provider boundary or
be awaiting exact reconciliation when the next target-bound Steer is admitted.
That uncertainty blocks provider dispatch, not durable admission: the later
intent remains bound to the same exact normalized turn and waits behind the
earlier row. Legacy draft-source Steer recovery retains its exclusive mutation
barrier.

An uncertain queue entry must keep a persistent queue-paused explanation and
an available reconciliation action visible, including when its user message
already appears in history. Later queued messages and the current draft remain
intact. The existing thread recovery command also reconciles an ordinary queue
head without requiring a separate uncertain mutation receipt. Automatic checks
may close uncertainty only on authoritative acceptance; absence of evidence must
not cause another send.

For a Sedes-authored Send or Steer, every compiled backend must project the
authenticated application delivery operation ID on the resulting normalized
user message. Durable queue snapshots and events must expose that same required
operation ID separately from the queue entity ID. Browser presentation may use
the operation ID to show immediate client-owned input, but it remains outside
authoritative normalized turns and items and reconciles only by exact identity.
Matching text, time, adjacency, queue set difference, or backend name is never
sufficient. Durable queue acceptance is positive evidence: disappearance of a
healthy accepted queue row before the normalized user item arrives does not
prove rejection and must not retire the client-owned correlation bridge.
Replacement snapshots and incremental events have the same reconciliation
obligation.

Codex and Pi implement this contract through their existing exact-target Steer
operations, pre-boundary stale-target classifications, and authenticated
delivery correlation. Active Submit may therefore resolve to Steer for these
backends. Codex's provider-private adapter recognizes only its exact reviewed
`turn/steer` no-active-turn and expected-turn-mismatch rejection responses;
unknown wording fails closed. Pi may additionally remain pending until provider
materialization is observed. Claude implements conversation-targeted Steer via
native `priority: "next"`. Native enqueue is pending materialization until exact
user-message UUID evidence identifies incorporation and the receiving turn.
Earlier assistant activity is never acceptance evidence for a new steer.
The owner-scoped operation and native message identity survive reconnects;
uncertain delivery never triggers a replacement send. Grok advertises no Steer;
active Submit resolves to durable Queue and direct Steer fails closed.

For conversation Steer, terminal loss of the original delivery tracker may be
reported as `failed_unknown` reconciliation. This proves neither acceptance nor
nonacceptance and must never authorize an automatic resend. Atomically close the
scoped receipt with that distinct outcome and mark its queue item failed with a
diagnostic that explicitly preserves the unknown outcome. Retain the operation
identity to reject duplicate mutation replay. Existing failure acknowledgment
and restoration to the draft provide user recovery; restoration itself does
not send. Late exact consumption evidence may still accept an untouched,
unacknowledged failed item; it must not revive one already restored or
acknowledged by the user. A live or merely unreachable tracker remains unresolved. Codex/Pi
exact-turn reconciliation retains its existing conservative uncertainty
handling and does not adopt this terminal Steer recovery path.

An ordinary queued Submit whose explicit or recovery reconciliation returns
`failed_unknown` follows the same user recovery. Its uncertain head becomes a
failed, unacknowledged item with a diagnostic that preserves the unknown
outcome and asks the user to review the conversation first. It still blocks
later queued input until the user dismisses, deletes, or restores it;
restoration returns the text to the draft and sends nothing. The automatic
dispatch check still closes uncertainty only on acceptance. Tracking is
terminal, so there is no late-acceptance path for a failed Submit. `unresolved`
keeps the head uncertain. Only Claude returns `failed_unknown` for Submit,
when its remote delivery owner ended and tip-correct history shows no
acceptance; Codex, Pi, and Grok return only accepted, not accepted, or
unresolved, and a new backend must return `failed_unknown` only for terminally
lost tracking.

The same disposition applies explicitly to completion-callback delivery. Pi
and Codex use their already-audited application delivery correlation and
exact-target Steer paths when the calling thread is active. Claude uses its
conversation-targeted Steer path; Grok uses shared durable Queue. All four
consume the same normalized authoritative-completion observation and require
no provider-native callback API. Grok's callback result is limited to ordinary
assistant-message text finalized before its normalized terminal event; later
tool-only enrichment is outside this callback contract and must not delay or
rewrite the materialized result.

A provider queue priority, fold-now hint, second-prompt API, input UUID echo, or
command-lifecycle notification is not by itself exact-target Steer evidence.
The provider boundary must atomically accept both the immutable expected active
turn and authenticated application operation, then return a typed receipt that
either proves acceptance for that exact turn, with any pending materialization
state modeled explicitly, or proves before submission that the target is no
longer active. Durable provider history must preserve the same
operation-to-turn association for restart reconciliation. Interrupt must also
expose reviewed semantics for every accepted but not-yet-materialized input,
including whether it survives, is cancelled, or is fenced from a later turn. If
any of target admission, receipt, history grouping, or interrupt-race evidence
is absent, advertise only provider-neutral next-turn Queue and omit Steer.

Text, context excerpts, attachments, and structured Task references are
normalized application input, not provider-native IDs or browser-selected
paths. Before provider delivery, the application materializes one immutable,
ordered delivery snapshot containing the original text, context, Task
snapshots, and path-free attachment descriptors. That snapshot and its
`deliveryOperationId` are authoritative for operation fingerprints, queues,
retries, restart reconciliation, and normalized history restoration. Retain it
for accepted or uncertain outcomes; remove it only after authoritative evidence
proves non-acceptance. A backend must not create a second input snapshot,
attachment or Task store, replay record, or security policy.

Before crossing the provider boundary, Sedes resolves scope and ownership,
stages immutable attachment bytes through the exact execution environment, and
rechecks descriptor equality, byte count, and digest. An execution-environment
path may be remote and is never a Sedes-local byte source. Scope, integrity,
open, and read failures must settle before provider delivery. The backend then
performs only the provider-supported wire projection: for example, plain text,
a staged path or resource reference, or native image bytes. Provider history
decoders report exact native correlation as a `deliveryOperationId`; the common
application layer restores the authoritative original text, context, Task, and
attachment parts from the delivery snapshot. Provider text, echoed manifests,
or fuzzy text/time matching are never used to reconstruct normalized input.
When a provider-native fork retains correlated source messages, copy the
corresponding application delivery snapshots into the child thread atomically
with its durable fork reservation. The child must not depend on a
provider-private Task or attachment write carrier for normalized fork history.

When a staged image is both model-visible content and a user-addressable file,
project both facets when the provider supports them: native image content for
visual understanding and the exact staged path/resource for explicit file
operations such as copying it into the workspace. Tell the model that native
pixels are already present and that the path is for requested filesystem work,
so it does not need to reread the file merely to inspect the image. The path
remains read-only staging authority, never normalized browser content or a
Sedes-local byte source.

A provider-native image item may already carry a usable path, or the provider
may materialize and disclose its own session copy. Treat that as the file facet:
do not also inject a Sedes staging path, duplicate resource link, or redundant
guidance. Preserve a Sedes path carrier only for backends whose native image
bytes do not otherwise give the model a usable filesystem location. Ordinary
file attachments keep their independently reviewed path/resource projection.

## Provider output artifacts

Provider-produced output is a different authority from composer attachments.
An input attachment is principal-authored application state prepared before a
provider boundary; an output artifact is immutable provider result data
observed after that boundary. Do not route provider output through the composer
upload, draft, staging, delivery-snapshot, or Task paths, and do not infer one
capability from the other.

A backend may contribute a standalone normalized image only from an exact
reviewed native item and an exact byte source. The backend owns native item
parsing, completion semantics, correlation, and any native result, URL, or
path. The shared `OutputArtifactService` owns server-derived
tenant/principal/thread scope, stable identity, the 16 MiB canonical byte
ceiling, byte and media validation, digesting, immutable storage, duplicate
observation, and content retrieval.
Provider bytes, base64, URLs, and paths stay out of normalized history,
diagnostics, logs, and browser event payloads; the normalized item carries only
the opaque artifact ID and bounded media, size, digest, filename, and alt-text
metadata needed by the common renderer.

Markdown image destinations are presentation text, never provider-output byte
authority. The common Markdown renderer must not fetch or display pixels from
relative, same-origin, remote, `data:`, or `file:` image destinations. A backend
may remove an exact reviewed provider echo from normalized text, but displaying
the pixels still requires a normalized image item backed by the common scoped
artifact service. Do not turn a provider path or Markdown URL into a browser
fetch or an implicit artifact fallback.

Every backend capability document must state
`providerOutputArtifacts.nativeImage` explicitly. Advertise it only when the
selected backend/profile can project a reviewed native image item through this
durable contract. Backends that only accept image input, expose bounded
tool-result image metadata, or have no reviewed output path report `false`.

History replacement, pagination, replay, reconnect, and repeated live/history
observation must resolve the same artifact rather than write another copy or
briefly expose provider-private content. An invalid, oversized, incomplete, or
unavailable native result projects a bounded unavailable item or the backend's
truthful non-image fallback; it must not fabricate bytes, follow an
unreviewed URL, or reread an unrelated path. Tool-result image content already
accepted by the bounded tool-result projection remains a separate transient
presentation and does not become a durable output artifact implicitly.

Byte access must occur in the namespace that owns the result. An in-band native
result can be validated without filesystem access. A backend that exposes only
an execution-environment path needs a separately implemented local or remote
reader with bounded no-follow, identity, size, and digest checks. Never treat a
provider path as local to the Sedes server, silently fall back from SSH to
local access, or claim a sidecar operation that is not implemented and
configured.

Path-based provider image capture goes through the backend-neutral
`ViewedImageCaptureService`. The backend supplies its scoped binding, a stable
opaque publication key derived from native coordinates (never the path,
filename, bytes, or a rewritable native ID), the absolute path, and
cancellation; it never receives a general Files provider. The service derives
workspace and environment, reads only through that exact environment's Files
provider, and rechecks binding and environment authority inside the
publication transaction. A retained association wins over rereading on every
observation, even after the source changes or disappears, and it is presented
as a snapshot at capture time rather than provider-byte identity. Keep the
native notice, add the image as a separate child in a reserved source-order
position, and deliver a late child as a new item before its turn update rather
than mutating a terminal item or forcing a resnapshot. When the native item
cannot attribute a path to the configured execution host, document that
topology limit instead of guessing.

The current reviewed dispositions are: Codex supports completed native
`imageGeneration` PNG results and captures completed `imageView` paths on the
thread's configured execution host; owned-local Grok supports exact completed
`ImageGen` and `ImageEdit` JPEG results. Codex and Grok generated-image paths
are unchanged by viewed-image capture. Pi and Claude intentionally report
unsupported and gain no image-view capture. `providerOutputArtifacts.nativeImage`
describes supported output images only; it is not proof of Files availability
or native-executor attribution. The complete byte and topology contract is in
[Provider output artifacts](output-artifacts.md).

## Creation, binding, and forks

Sidebar project-name scope is a viewer-local browsing preference over the
principal's normalized inventory. Equal names may span environments and
directories; they never establish shared workspace identity or grant authority.
Creation must resolve that preference to an exact workspace and target, asking
for an environment or directory when ambiguous. All compiled backends (Pi,
Codex, Claude, and Grok) continue to receive the existing exact-ID creation
contract. Tasks, Files, tools, Projects grouping, and project stacks retain their existing
workspace identities.

Creating or importing a thread establishes a durable binding between one
Sedes thread and one provider-native conversation under the exact target,
environment, and workspace. Partial success must be recoverable without
creating duplicate provider conversations.

A same-settings configuration copy is ordinary unbound draft creation, not an
import, binding, or fork. Scope, workspace, target, and configuration are
derived from the authorized source on the server. Every compiled backend must
capture its complete durable desired next-turn configuration into canonical
Saved-Agent-style overrides, revision-fence that capture inside the child
creation transaction, and revalidate it through the current catalog and policy;
incomplete, custom, stale, or disallowed state fails closed without substituting
defaults. The exact Sedes tool policy is captured and fenced in the same
transaction. The new thread receives independent revision-zero settings and
tool state, while drafts, history, bindings, provider identity, lineage,
attachments, queues, Tasks, automations, managed clients, and runtime-generation
observations do not transfer. Creation capabilities are recomputed from the
current target rather than persisted from the source.

Forks preserve application ownership while using provider-native ancestry when
supported. Selected-turn identity and provider acceptance must be proven. The
source may stay active, but only provider-persisted copied history and immutable
lineage cross the [native fork boundary](native-fork-lineage.md); drafts,
queued input, pending interactions, and active runtime callbacks do not
transfer. A backend must not synthesize a user message, hidden prompt, or other
model-visible reset instruction as part of fork creation.

Treat exact completed-turn and provider-acceptance snapshots as separate
normalized capabilities and lineage boundaries. A
`completed_turn_inclusive` fork must retain the selected application turn and
revision. A `provider_snapshot_at_acceptance` fork must leave the application
`sourceTurnId` nullable and let one reviewed native operation choose the latest
provider-persisted history at acceptance; never pre-label it as a completed
turn, include unpersisted streaming deltas, or approximate it with replay.
Backend capability projection must make the generic UI choose the snapshot only
where it is truthfully implemented and otherwise choose the authoritative
newest completed turn without silently falling back to an older one. Exact
transcript and agent-tool selectors remain completed-turn boundaries unless
their contracts explicitly change.

A backend that cannot copy history exactly through a completed turn marks that
turn with a bounded user-facing `forkUnavailableReason`. Currently only Claude
does so, for turns without a final answer and turns before its latest
compaction. The turn's fork action shows the reason instead of forking. Only a completed
turn carries a reason, and the normalized projector publishes a change to the
reason alone as a turn revision. The
normalized actor and the backend both resolve `latest_completed` to the newest
completed turn; interrupted and failed turns are not completed. If that turn
carries a reason, the fork fails with it before any provider call rather than
falling back to an older turn. The actor passes the backend turn it resolved,
which lineage records as the source, in the `latest_completed` selection. The
backend fails retryably, with `invalid_state`, when its own newest completed
turn differs, so it never forks a turn other than the recorded one. Pi, Codex,
Claude, and the in-memory conformance backend implement this check; Grok does
not support forks.

A definite fork failure that another fork of the same boundary would repeat,
such as a deterministic history mismatch or an unsupported runtime, sets
`forkRestart: "futile"` on its `BackendError`. The aborted result is then not
restartable, and clients do not offer to start the same fork again.

Recovery must preserve the same distinction. Completed-turn forks may be
adopted from exact authenticated parent-and-turn evidence. An acceptance-time
snapshot without a durable provider-turn anchor must remain nonretryable and
non-adoptable unless the backend supplies a separately reviewed uniqueness and
snapshot-boundary proof. Authenticated operation-only discovery evidence must
still quarantine the possible child; dropping that correlation and importing
the child as unrelated would violate application ownership.

A backend without reviewed native fork semantics must report unsupported. It
must not approximate a native fork by replaying history as fresh user input.
Fork fidelity must account for provider-history leaves the backend cannot copy,
especially attachments, file-history snapshots, instructions, and settings.
Do not advertise a checkpoint after an invisible or uncopyable leaf.

## Execution environments and files

Backend connectivity and workspace file access are separate capabilities of an
execution environment. A working SSH carrier does not imply file access, and a
Files sidecar does not imply a provider transport.

Environment availability may aggregate independent, typed backend and
operations-carrier observations only at the execution-environment scope. Keep
backend scopes exact; never invent a synthetic backend identity for shared
sidecar evidence. Serialize publications across sources, fence them by the
current environment revision, let any current positive source win, and reserve
negative sidecar evidence for transport-shaped failures. Lazy sidecars validate
on first use rather than through an automatic startup probe, and deliberate
idle retirement or shutdown is not negative availability evidence. Before the
first observation, a configured lazy SSH environment remains admitted for the
foreground operation that can validate it, and its internal not-yet-validated
diagnostic is not presented as a user-facing failure. Only a genuine negative
observation makes the environment unavailable and blocks foreground work.
Persist an accepted availability transition before publishing it, but hand the
application-snapshot refresh to its owning boundary instead of synchronously
joining it. Target health is read during snapshot capture and may itself emit
availability evidence; awaiting a replacement from that read would re-enter
the same serialized publication and deadlock application snapshot capture.

Resolve executable, endpoint, secret, PTY, and filesystem authority inside the
same execution namespace where each operation runs. Host paths and credentials
must never be reused for an SSH or future container environment.

Persistent sidecar ownership is environment-scoped under the exact installation,
tenant, and principal. One configured SSH environment identifies one
single target lifetime at a time: management, bootstrap, and daemon invocations
enter the same stable PID and time-namespace context, and target replacement
retires the prior instance. There is no container detector, host-mount requirement, or shared
service identity across concurrently live targets.

Bootstrap and artifact-independent management use the same target-local
lifetime identity: host boot ID, own PID namespace, namespace-init start time,
and exact boottime offset (canonical seconds plus nanoseconds). Verify that
`/proc` is procfs and its self `NSpid` contains exactly the current process PID,
so an ancestor process view cannot masquerade as the target. The active and
child time namespaces must match before reading `timens_offsets`, since that
file describes the child namespace. Only absence of all three time-namespace
proc entries establishes a kernel without that feature and a zero offset;
partial absence, denied reads, malformed offsets, or changing observations fail
closed.

A changed boot or PID namespace establishes target replacement under the
single-target contract. Within the same boot and PID namespace, compare exact
boottime offsets before any process timestamps: even a sub-tick offset change
must hard-fence every path, including stopped descriptors and startup locks.
With equal offsets, a changed init start time establishes replacement despite
kernel reuse of a namespace inode number. A missing supervisor in an unchanged
target lifetime never proves all children exited. Old or invalid descriptor
shapes fail closed.

Recorded-process matching checks boot/start time before ptrace-gated namespace
links; a matching but uninspectable process requires recovery. A stopped-daemon
or startup-lock zombie owner can retire only when its thread group is fully
exited. Startup-lock reclamation must pin the inspected directory inode before
unlinking its owner, so a delayed reclaimer cannot remove a new contender's
lock. See [SSH target restart recovery](../operator/operations.md#ssh-target-restart-recovery)
for the operator contract and one-time old-record cutover.

This ownership mechanism is shared by Codex and Claude persistent runtimes
and remote workspace operations. Grok remains intentionally unsupported for
remote execution and never acquires sidecar ownership through a fallback.

A live caller recovering a persistent workspace shell must inspect the exact
existing shell identity rather than replay its launch. A running result keeps
that caller pending under a finite budget derived from the original command
deadline plus bounded cleanup/recovery time. Reacquire only current authorized
carriers and revalidate recovery authority throughout the wait; explicit
environment disconnect or configuration revocation stops automatic recovery
even when a carrier lease remains held. Carry cancellation to the same shell
after reconnect, and require terminal evidence before claiming completion or
cleanup. Concurrent automatic recovery operations share one controller with
independent leases, so one caller cannot disconnect another by cancelling its
wait. Fence stale callbacks and release the original operation lease and all
failure-path recovery leases on settlement. A successful completion may retain
its completing carrier solely for receipt acknowledgement, bounded by the
cleanup allowance. Release it on acknowledgement or expiry without discarding
an unacknowledged receipt.

Retained output recovery must track delivered byte offsets separately for
stdout and stderr, consume only unseen retained bytes, and await output
consumers before terminal settlement. Mark actual gaps or truncation explicitly.
When separate retained prefixes cannot prove their original stdout/stderr
interleaving, conservatively mark combined recovery incomplete even if every
byte is retained. Exact single-channel recovery remains complete; a carrier
disconnect alone is not proof of missing output. Missing receipts,
sidecar death, revoked recovery authority, and budget exhaustion remain unknown
outcomes, never rejection evidence or permission to rerun a command.

Pi SSH workspace Bash implements this recovery while its local SDK turn remains
alive. It does not resume Pi turns after main-daemon restart. Direct-local Pi
is unchanged; isolated Pi shares the shell adapter but may inspect only its
original ephemeral worker session, with no replacement or host fallback.
Codex and Claude keep native provider execution and their backend-private
persistent-runtime recovery; Grok keeps local execution and unsupported SSH
admission.
This server-private recovery introduces no settings or normalized browser
contract. See [Remote Pi workspace tools](pi-remote-workspace-tools.md).

An executor adapting provider-facing semantic paths to a workspace-relative
wire protocol must translate root requests and contained absolute paths before
serialization. Interpret semantic prefixes once, using execution-host authority
for home expansion; wire path segments remain literal. Keep canonical and
symlink containment checks on the execution host. Validate this boundary with
provider tool calls and the real wire schema, not only a mocked executor.
Pi SSH and isolated Pi implement this adaptation with the SSH account home and
fixed sandbox home respectively. Direct-local Pi and the native Codex, Claude,
and Grok tool paths do not consume this adapter.

Local UDS assurance may use local ownership, mode, link, and parent-directory
checks. SSH UDS authority is different: the configured OpenSSH alias and remote
StreamLocal destination are operator authority, while Sedes owns and verifies
the local private forward. Do not claim a remote `realpath` or `stat` proof that
the SSH carrier does not perform.

Workspace Files always resolves against the exact workspace environment and
its provider. No local fallback is permitted when remote capability is absent
or unhealthy. Supplemental roots, opaque file URLs, compare-and-swap writes,
and link-only results follow [Workspace Files](workspace-files.md).

Git-linked worktree roots are Files-provider topology, while the preferred
linked worktree is first-class thread application state; neither is
conversation-backend state. Discover worktrees only from the stable canonical
Primary root's own Git metadata; never infer them by scanning sibling
directories or by importing a provider's session CWD. Local and remote
providers must return the same bounded, canonical identity and Primary-relative
provenance contract, while the application persists only scoped opaque root
IDs and a principal/thread preference. The preference may change Files,
Compare, and relative chat-file resolution, but it must never change a
provider, agent process, or terminal CWD. Reconcile deletions and clear
preferences only after a successful complete discovery. Failure or truncation
must retain the last admitted topology, and path reuse must never resurrect a
tombstoned root ID. Browser and agent mutations accept an opaque linked-root
ID, not a path or caller-selected environment.

Treat broad filesystem enumeration as explicit bounded work. Interactive Files
browsing lists one directory's immediate children and loads descendants only
on expansion. If a complete-tree operation is offered, require an explicit
user action, propagate cancellation through every transport, and page one
retained bounded snapshot; a continuation must never repeat the traversal.
Keep this behavior in the shared Files engine so local and remote providers
have identical containment, exclusion, truncation, and cursor semantics. Do
not run Git discovery or status merely to render the Browse tree.

Exact file download is a separate descriptor-backed operation, never a reuse
of bounded preview bytes. Require the caller's displayed revision, reapply
root, path, sensitivity, no-follow, containment, and regular-file checks, and
hold both root authority and the opened descriptor through transfer cleanup.
Stream with bounded memory, backpressure, cancellation, and an explicit size
ceiling. A provider must retain the final bounded chunk until descriptor
identity and revision are revalidated, so a changed or truncated source cannot
complete with the advertised length. Remote workspaces require an equivalent
versioned sidecar byte stream and must never fall back to a local path.

A sidecar reached through SSH or an approved outbound connector contributes
only the exact configured operation providers:
directory browsing, Files/Compare, workspace tools/context, attachment
staging, or agent-tool CLI relay. Document each provider's authority,
lifecycle, idempotency, and sent-unknown behavior. Never start an unconfigured
provider or silently fall back to local execution.

Pairing and authentication are separate boundaries. Resolve the tenant and
principal on the server, then bind the durable connector identity to one
immutable environment. Hostname, address, account, and comparison code are
observations, never principal authority. Approval and revocation commit with
configuration and scoped mutation receipts. An IP change does not replace an
identity; revocation removes access without claiming remote process cleanup.

The shared sidecar owner and client session use a transport-specific provisioner
for installation, management, and byte-stream attachment. A provisioner returns
the installation actually serving the connection, including the execution
account's resolved paths and release. Never reconstruct those paths on main or
substitute a newly staged release for an older compatible daemon retaining work.
Outbound runtime tickets are single-use and fenced by current principal,
pairing revision, configuration fingerprint, and control-connection generation.
Losing control revokes current execution admission immediately; a reconnect
establishes fresh tickets and reattaches retained resources. Keep lifecycle
preference changes out of the configuration authority fingerprint so a command
does not invalidate its own management channel. HTTP/WS and HTTPS/WSS follow
the configured origin; pairing must not introduce a TLS-only assumption or an
implicit authentication claim.

Windows local operations must prove the same authority using Windows primitives.
Files and workspace tools validate canonical paths against the open handle's
volume/file identity, reject missing identity evidence, and check directory
type and reparse-point replacement explicitly. Browser absolute-path contracts
must admit normalized Windows paths without allowing device namespaces or
alternate data streams. Attachment staging creates private directories with
Windows ACLs and verifies owner, inheritance, and access entries; a POSIX mode
check or a blanket permission-check bypass is not an equivalent boundary.
Batch ACL evidence must preserve each request's exact path and operation under
the installed Windows PowerShell 5 runtime, including singleton arrays and
Unicode paths. Parse JSON arrays without nesting pipeline output and emit
UTF-8 evidence; retain exact result identity, current-owner, and ACL checks.
Exercise this contract with native filesystem fixtures, including a mixed batch
and rejection of an actual foreign owner, rather than only mocked JSON output.

Owned Windows stdio processes require a Job Object whose ownership survives the
root process exiting. Assign the process to the job at creation, retain
kill-on-close ownership, and confirm all job processes have exited before
reporting cleanup success. Parent-PID liveness and a successful signal request
are not cleanup evidence. Keep supervision control separate from provider byte
streams, authenticate it, and fail closed if its completion evidence is lost.

These local filesystem and attachment primitives are shared by Pi, Codex,
Claude, and Grok through execution-environment providers. They do not expand
provider runtime availability: ordinary local Pi and owned Codex use their
existing admitted paths; Pi isolation still requires Linux/Bubblewrap, and
native Windows Claude worker and Grok runtime paths remain explicitly
unsupported by their existing platform guards. SSH sidecars retain their
Linux-only filesystem contract and never substitute Windows host operations.

An application terminal is likewise an execution-environment capability, not
a conversation-backend capability. Resolve its thread, workspace, environment,
initial CWD, and tenant/principal scope on the server. Do not introduce a fake
backend instance, import provider-native identifiers into its browser contract,
or make the presence of a Pi, Codex, Claude, or Grok runtime a prerequisite.
The initial CWD is a launch location, not a filesystem sandbox.

Every environment provider must give `interactiveTerminal` an explicit
implemented or intentionally unsupported disposition. Local and remote
providers implement one normalized process contract for bytes, resize, input
delivery classification, exit, and an explicit termination effect. Local End
requires bounded process-group cleanup; SSH Disconnect and remove requires
verified closure of the dedicated owned carrier and makes no remote-process
cleanup claim. Persist these distinct completion evidence types independently
and match them to the resource's immutable provider-derived termination effect
both during deletion and restart recovery. Never infer carrier closure from a
signal request, timeout, or synthetic failure. A remote
provider requires the exact configured and negotiated Sidecar
`interactive_terminal` capability and revision. Missing, stale, unhealthy, or
wrong-environment capability fails closed before process creation and never
falls back to a local PTY.

Keep terminal resource and panel lifecycles separate. Server-owned metadata,
history, process incarnation, actor, admissions, and controller lease retain
tenant/principal/thread/environment scope. Browser-owned panel instances and
viewport state only reference a resource. A viewer disconnect must not stop a
process; server or owned-transport loss must publish truthful interruption
rather than implying durability or respawning. See
[Application terminal resources](terminal-panes.md).

Within the current single principal, an explicit controller claim must
atomically demote the prior controller and advance its fencing epoch; control
transfer must not depend on a release action from another client. Bound fresh
attachment work with a verified server checkpoint and ordered suffix. When the
terminal itself emits `CSI 3 J`, apply it before advancing the restore floor so
erased scrollback cannot reappear on another client. Keep local panel close,
explicit End, and process-originated terminal lifecycle distinct: close only
detaches; End waits for its effect's required evidence and then deletes resource history;
natural exit, failure, and interruption retain verified restore state for
inspection.

## Agent tools and managed terminals

Agent tools use the normalized, principal-scoped contract in
[Agent tools](agent-tools.md). Eligibility is checked at execution time against
the current thread, backend generation, effective policy revision, and tool
capabilities. Exact-ID exposure and the thread-wide
`accessBoundary` rule are independent: every canonical
tool declares resource-to-environment authority, and the shared admission layer
resolves it relative to the source thread and execution environment. `environment`
is the default; `unrestricted` bypasses only the application access prompt, never
identity, resource, turn, policy, capability, or provider checks. Provider-native
tool injection and approval remain private to the backend.

Environment discovery is not environment entry. `environment.list` may expose
only the bounded principal-scoped directory needed to address tools—no routes,
credentials, hosts, or topology. Environment-scoped workspace and thread lists
default to the source environment. Each compiled canonical operation must have
an explicit source-only, public-information, directory, neutral, direct-resource, scoped-query, or
scope-transition disposition; omission must fail closed.

Only a user-originated active agent turn can open an application access
decision. The decision is ephemeral, admits one exact invocation, has no user
response deadline, and must be revalidated after approval. Automation
access outside the configured boundary that requires approval fails closed. Delegated
agent-control work uses the destination thread's own policy. Cancellation
follows the exact invocation/turn/runtime signal; browser presence is not
authority and must not be polled to infer cancellation.

CLI presentation receives an opaque, unguessable, restart-safe thread source
reference—not a caller-selected thread ID. Resolve it beneath server-derived
tenant/principal authority and re-resolve the thread's current workspace,
environment, backend, inventory, and policy on each request. The reference is
stable across runtime replacement and grant changes; it does not encode the
granted tools or a provider turn. Bind each reference to exactly one ingress transport so local HTTP
and the managed sidecar relay cannot accept one another's capabilities or
alternate source claims, and to exactly one presentation, CLI or MCP. Derive
the calling adapter from the resolved reference, never from a request field,
so the CLI and `sedes mcp` share routes and relay frames without either
satisfying the other's surface. The remote relay uses only the
strict `agent_tools_cli@3` contract advertised for the enabled
`agent_tools_cli` capability; unsupported or stale versions fail closed.
Discovery may retain a bounded transport deadline, but invocation
must propagate caller abort so an indefinitely waiting approval is not turned
into an artificial CLI timeout.

Sidecar CLI callback endpoints remain private to the execution runtime. Unix
uses an owner-only directory and socket with inode-checked retirement. Windows
uses one incarnation-scoped named pipe and a random 256-bit TLS PSK; its exact
`npipe://./pipe/sedes-agent-tools-<sha256>#<capability>` endpoint binds the pipe
name to the capability digest. Never accept arbitrary named pipes or disguise
Windows paths as Unix URLs. The private fragment must never enter browser
contracts or logs. Authenticate and encrypt the named-pipe stream with the
PSK-only TLS cipher before transmitting source references or tool frames;
a pipe name alone provides neither privacy nor peer identity. Bound pending
handshakes, admitted clients, and frame deadlines, and close all of them when
the ingress retires. TLS admission must complete before an invocation reaches
the potentially uncertain delivery boundary. This local transport leaves
backend tool eligibility unchanged: admitted sidecar Codex and Claude use the
relay over SSH or outbound connections; remote Pi CLI and remote Grok remain
unsupported.

When adding canonical tools or catalog groups, validate the complete canonical
catalog against the CLI transport schema and render individual root help from
it. A group omitted from that schema can reject the entire discovery response,
including help for unrelated tools. Partial service fixtures do not cover this
integration boundary.

Agent-tool presentation is an orthogonal `{ surface, mode }` contract. Every
backend/environment disposition must enumerate supported modes beneath each
supported `native` or `cli` surface. `progressive` means compact discovery plus
generic invocation; `individual` means one named native tool or typed CLI
command per granted operation. Capability metadata, Saved Agent resolution,
thread persistence, browser controls, environment construction, and runtime
adapters must all preserve the same exact pair. A selector with one supported
value may be hidden, but the value remains explicit policy. Never flatten the
pair into compound enum values, infer an unsupported pair, or fall back across
surface or mode when admission fails.

Each backend's Native surface has exactly one mechanism: Pi SDK tools in the
Sedes process for Pi, the stdio `sedes mcp` server for Codex and Claude, and
none for Grok. Admission maps the calling adapter against the thread's backend
kind, so one backend's mechanism can never satisfy another's Native
presentation. A provider-launched MCP server receives its reference only
through a channel proven to expose it no more widely than the CLI environment
does: Codex's per-thread server `env`, or Claude's query environment behind a
placeholder in the argument-borne MCP config. Keep the provider's MCP permission
controls in force, derive tool hints only from declared effects, and never
write operator provider configuration.

For managed CLI presentation, inject `SEDES_AGENT_TOOL_CLI_MODE` only after
stripping its ambient value. The variable is a presentation hint available to
the agent-controlled process, not an authorization boundary. Catalog/help and
every invocation must re-resolve the current server-owned grants and policy;
adding or removing a grant through the UI changes subsequent discovery and
authorization without trusting or rotating the environment hint.

Provision the CLI environment for an eligible CLI presentation independently
of the master enable flag or selected IDs. For unchanged CLI surface/mode,
allow revision-checked edits to enablement, exact IDs, and access boundary
during active turns and queued input without retiring the runtime. This shared
application-policy path applies to local Pi SDK, local/Sidecar SSH Codex and Claude,
and local Grok; Pi remote/isolated CLI and Grok SSH remain unsupported.
Removed authority blocks subsequent admission, not work already admitted.
Revalidate pending environment decisions against the policy revision before
execution. Native-tool policy changes remain idle-only.

A bound thread's provider process or session may capture environment and tool
presentation only at establishment. Therefore an idle presentation-policy
change must prove the complete normalized thread runtime retired before the
policy commit; the next attach reconstructs provider-private state from the
new policy. Apply this invariant uniformly to Pi, Codex, Claude, and Grok.
Never update durable presentation while retaining a provider runtime with the
old mode, and never fall back to another surface when retirement is busy or
cannot be proved.

Durable transitions from an earlier flat presentation contract belong in a
one-time migration, not a runtime compatibility parser. The historical `cli`
value maps to CLI/Progressive, while `native_progressive` and
`native_individual` map to their corresponding Native pairs. Do not accept the
old strings in normalized APIs, repositories, provider adapters, or Saved
Agent JSON after migration.

Every backend must record an implemented or intentionally unsupported
disposition for Saved Agent configuration/resolution, agent-tool presentation
surfaces and modes, local/SSH transports, and skill catalog or filtering
behavior. A
copied Saved Agent policy becomes independent thread state. Its environment
rule remains relative to the new thread's selected environment and cannot
exceed the current target or installation ceiling.

The normalized `thread.messages` active-turn projection is based only on
ordinary user and assistant items already marked `completed` inside the current
`in_progress` turn. Item completion means that item's text is final and will
receive no more deltas; it does not mean the turn succeeded, settled, or is
idle. Preserve stable normalized item IDs. Exclude streaming, failed, and
interrupted items and all reasoning, tool, command, file-change, plan, notice,
image, and provider-private message phases. A fresh read must capture active and
settled projections from one actor snapshot; continuation reads must omit live
state and remain fixed to their settled-history boundary. The active window is
the newest bounded tail, does not consume settled-turn page size, and shares the
overall output byte bound.

All compiled backends implement this invariant through their existing
normalized item lifecycle. Pi completes assistant messages on native
`message_end`; Codex emits normalized completion when a native streaming item
terminalizes; Claude emits completion when a projection delta changes an item
from streaming to terminal; and Grok projects every completed visible text
block while retaining the last non-user block as streaming until later history
or terminal evidence makes it final. None exposes provider-native deltas or
identifiers through this contract.

Managed terminals require both backend-native lifecycle support and explicit
environment capabilities for an executable, endpoint, secret handling, PTY,
and bounded cleanup. PTY support alone is insufficient. Admission is tied to a
server-derived normalized thread and runtime generation. See
[Codex managed TUI](codex-managed-tui.md) for the current provider-specific
implementation.

### Thread access boundary

Agent tool policy uses `accessBoundary: "thread" | "environment" | "unrestricted"`.
All compiled backends share source-scoped invocation enforcement and the
application decision broker. Thread mode requires approval for project/global
resources and other threads, including same-environment descendants. Source
context and explicitly classified public research are exempt. Resource
classification must be explicit in the canonical manifest; empty authority
sets are not evidence of source-thread access. Mutable scope facts and their
revisions must remain bound into approval and continuation digests. Principal
Tool clients keep environment allowlists and cannot request interactive
approval. Automations and unavailable interaction bindings fail closed.

Workpads are application-owned Markdown documents, revision history,
attribution, and user drafts; providers receive only normalized canonical tools.
Pi native/CLI, Codex and Claude CLI/Native MCP, and Grok CLI paths are
implemented through the shared source-scoped facade. Tool clients use the same canonical operations
with their environment allowlists. Workpad history is authorized from current
scope, not historical scope. Approval binds current resource identity/revision;
document updates additionally check the expected revision atomically. Backend
adapters must not introduce provider-specific Workpad storage or bypass these
checks. Unsupported tool transports remain explicitly unavailable.

Committed Workpad writes publish revision invalidations on the existing
principal application stream. Browser panels subscribe and reconcile after
stream replay/replacement; they must not poll continuously or depend on a
provider turn event to notice application-owned document or draft changes.
Publication failures must retain a retry without misreporting a committed write
as failed. Event payloads stay normalized and do not carry provider identifiers
or full document bodies.

## Model policy is backend authorization

Every backend instance owns exactly one installation-level `modelPolicy`.
Targets, execution environments, workspaces, principals, Saved Agents, threads,
queues, and automations may carry defaults or durable selections, but none may
broaden or narrow that policy. A backend policy change participates in the
backend configuration fingerprint and revision so stale prepared work is
fenced across runtime generations.

The shared modes are unrestricted `catalog`, positive `allowlist`, and
subtractive `denylist`. Allowlist and denylist entries are partial exact
matchers over native provider ID, model ID, and reasoning effort: values within
a dimension are ORed, present dimensions are ANDed, matchers are ORed, and an
omitted dimension means any value. Match native identifiers at the provider
boundary. Never compare policy to labels or to a normalized connection
namespace that merely occupies the browser's provider field. Backends without
a truthful native provider dimension reject configured provider matchers.

Catalog projection and authoritative mutation checks must compile and consume
the same policy semantics. Filter every advertised model/effort selection, do
not fabricate configured-but-unavailable values, and do not substitute another
model or effort. An effort-specific matcher does not match a model without a
configurable effort axis. Retain a model when at least one advertised effort is
admitted (or its effortless selection is admitted), and retain an advertised
default only when that exact selection is admitted. Recheck immediately before
every new provider effect that selects, inherits, synchronizes, or invokes a
model, including create, submit, queue dispatch, retry, Steer, fork/clone,
automation, and managed terminal paths where supported. Evidence-only
reconciliation and receipt replay still report prior truth before applying
current policy to a genuinely new effect.

If a provider proves model/effort selection only at native conversation
creation, expose the normalized selectors only while the Sedes thread is
unbound. Persist the complete creation tuple, verify the provider-reported
effective tuple after create/load, and present bound settings read-only. Never
advertise a bound-thread setting action, restart, replace, or silently rebind a
conversation to imitate a post-creation mutation that the native protocol has
not proved.

Policy tightening preserves existing threads, queued input, Saved Agents,
automations, imports, settings, and history. Present a stored disallowed
selection as unavailable and block new work until it is explicitly repaired.
An empty live intersection is a settings/admission condition, not a fabricated
backend outage. Denylists intentionally admit future unmatched selections;
allowlist matchers that omit a dimension intentionally admit future values in
that dimension. Document that future-admission behavior wherever operators
choose between the modes.

Each runtime must contribute backend-owned synchronous automation admission
that validates the complete durable model/effort selection without provider
I/O. Production routes that check by the thread's scoped backend-instance ID
when enabling or updating an enabled definition, starting a manual or
scheduled run, and capturing or reserving an automation clone. Presentation
uses the same durable policy result plus any currently known catalog support
to hide attach/run controls for a known-invalid thread; reading, editing a
paused definition, disabling, and removing automation remain available. This
early rejection does not replace the authoritative backend check immediately
before provider dispatch, and it must not introduce a parallel automation
lifecycle state.

Automation schedules when a normal thread input is submitted; it does not
define a narrower execution mode. Every durable sandbox, network, approval,
tool, model, and reasoning configuration admitted for a manual turn on the
same target must remain admissible for automation. Attended approval modes use
the ordinary interaction lifecycle and may leave the thread waiting for the
principal. Do not add an automation-only "safe" tuple or silently replace the
thread's selected execution settings.

### Isolated workspace execution

A durable workspace sandbox is an execution-environment authority boundary,
not a provider prompt convention or a narrower filesystem helper. Assign every
allocation to the exact server-derived tenant, principal, environment,
workspace, and thread scope. Persist an opaque allocation identity and native
path, but never accept a browser-selected path or provider conversation id as
allocation authority. Revalidate the exact state-root child without following
symlinks before create, open, import, cleanup, or deletion; destructive cleanup
must never target a root, home, workspace root, unresolved variable, or glob.

An isolated clone must not share writable filesystem identity with its source.
For local Git clones this requires `--no-hardlinks`; a linked worktree is not an
independent clone. Construct clone and worker launches as executable argument
vectors rather than shell strings, bound cancellation and output, avoid host-
authority checkout hooks and filters, and clean a partial clone only after
exact-target revalidation.

A read-only source sandbox must keep its writable allocation home distinct from
the source. Mount the exact server-authorized source read-only at the semantic
workspace path inside that home, revalidate both canonical paths and reject
overlap before every launch. A shared home-rooted executor may retain shell and
structured mutation access to private-home and temporary paths; the read-only
workspace mount itself must remain the write-denial authority for every tool.
Its lifecycle must never present clone-only Git handoff or delete the source
when retiring the private allocation.

Treat model output, repository content, and every model-invokable executable as
untrusted. Use a closed tool allowlist and route every admitted workspace tool
through the same sandbox executor. Provider discovery, project extensions,
arbitrary custom tools, management CLIs, and future SDK tools grant no
workspace authority by default. Canonical Sedes application agent tools may
remain host-owned only when they execute through the existing scoped facade and
authentication, and the thread's exact enabled-tool policy and native
presentation mode remain authoritative. They must never substitute a host
filesystem or shell implementation for a workspace builtin. Assert the
complete workspace builtin catalog after initial resource loading and reload.
If a workspace tool cannot use the sandbox execution channel, declare it
unsupported; never invoke a host implementation as fallback.

When an embedded provider SDK supplies a built-in tool catalog, pin an explicit
backend-private disposition for every built-in in the integrated release.
Classify built-ins by authenticated or SDK-owned source identity, not by name
alone. Exclude each known unsupported tool at SDK construction without using a
closed provider allowlist that would conceal project extensions or future
catalog drift. Independently audit the resulting registry at construction and
after reload: unknown future built-ins, malformed identities, untrusted
overrides, and residual host implementations in executor-backed topologies
must fail closed before acquiring tool authority.

Build the sandbox mount and environment tables as allowlists. Expose one
private writable home, mount either its writable checkout or the exact
read-only source at a stable child path, expose minimum read-only runtime
dependencies, a new PID-scoped `/proc`,
minimal `/dev`, and ephemeral temporary storage. Outside an explicitly selected
read-only source mount, do not expose the source checkout, host home, broad host root, unrelated state,
ambient credential files, agent/container/display sockets, or session/system
buses. Clear the environment and reintroduce only reviewed semantic values.
Credentials, socket selectors, environment injection hooks, and opaque
capabilities do not belong in inherited environment variables or command
arguments.

When the sandbox asks Bubblewrap to disable nested user namespaces, it must
also assert that the restriction took effect. A best-effort request without the
corresponding enforcement check is not a proved boundary.

Network profiles are explicit authority. An isolated profile creates a network
namespace; an execution-host profile deliberately includes the host's network
and loopback services and must be presented as such. Missing sandbox support,
failed namespace probes, launch or handshake failure, malformed protocol,
worker loss, and unknown operations all fail closed without an unsandboxed or
best-effort namespace fallback.

Treat the installation's configured profile list as a strict authority ceiling.
Default that ceiling to isolated networking only; execution-host networking
requires an explicit operator opt-in and cannot be inferred from target kind,
browser selection, or a previously persisted allocation. Advertise only the
intersection of current policy and a functional runtime preflight, validate it
again before allocation reservation, and revalidate it when acquiring an
existing allocation so policy removal fails closed.

Own each worker generation and its complete process group. Cancellation and
shutdown stop admission, reject pending calls, fence stale responses, and use a
bounded graceful stop followed by forced descendant cleanup. Never replay a
mutating operation whose outcome is unknown. Stopping a worker and deleting a
persistent allocation are separate lifecycle actions: keep is the safe default,
while deletion requires exact-scope authorization, dirty/untracked/unpublished
work evidence, explicit confirmation, and durable retry semantics.

Audit every compiled backend and topology explicitly. A first local-provider
implementation does not imply SSH, sidecar, automation, terminal, Saved Agent,
fork, or other-backend support. Advertise support only when allocation,
tool-routing, sandbox, persistence, cancellation, recovery, retention, and
deletion semantics are all implemented at the selected execution environment.
Use a real sandbox integration test on every supported platform to prove host
sentinels and source paths are unavailable, the private checkout is writable,
network profiles differ as promised, and descendants die on cancellation;
argument-only mocks are not sufficient security evidence.

For each compiled backend, record whether native provider, model, and effort
identities are implemented or unsupported, then audit catalog filtering,
defaults/preferences, settings mutation, create/submit/queue/Steer/retry,
fork/clone, Saved Agents, automation dispatch, managed terminals, recovery,
and no-live-intersection behavior. Unsupported paths must remain typed and
fail closed.

## Configuration and persistence

Supplemental Files roots are principal- and workspace-scoped application
state, independent of backend conversation cwd. File-capable local and SSH
environments must admit authorized roots above or below Primary, including
nested repositories with their own Compare view. Exact Primary duplicates and
overlap between supplemental roots remain rejected. Resolve overlapping file
links through the most-specific authorized root and serialize edits by
canonical destination. Apply these rules consistently at attachment,
persistence, and availability revalidation; environments without Files support
must continue to reject attachment.

Configuration schemas are strict and versioned. The database is authoritative
for principal-owned desired configuration, while bootstrap files contain only
installation settings. File import is an explicit atomic one-time operation
that preserves IDs and reconciles principal ownership; normal startup never
reimports an old file. Reject unknown keys, malformed releases, unavailable
compiled modules, unsafe endpoints, and unsupported topology combinations
before applying a revision. Keep Settings available when no runtime is usable.
Import must include all retained scoped backend, environment, and target
definitions before adopting legacy ownership, including disabled definitions.
Projection requires the matching immutable identity reservation. Runtime
snapshots expose only current definitions; retained observations remain usable
for receipt recovery. Settled configuration receipts may expire only behind
the monotonically advanced expected revision; pending and unknown lifecycle
receipts must retain their recovery evidence.
Do not add aliases,
dual-shape parsers, or implicit migration paths unless a compatibility period
is explicitly requested.

Secrets are never sent to the browser, logged, placed in error details, or
persisted in ordinary application rows. Persist fingerprints or bounded
metadata only when recovery needs to prove which authority was used.

Execution-settings inventories and detail navigation share one principal-owned
configuration snapshot. Preserve lifecycle receipts independently of visible
rows and selected sections; filtering must not cancel or replay commands. A
receipt-triggered refresh updates runtime observations without silently rebasing
an open configuration draft onto a newer revision. A temporarily busy refresh
must continue checking the original receipt until both outcome and configuration
revision are confirmed. This client presentation rule applies to Pi, Codex,
Claude, and Grok without widening any backend's runtime capabilities.

Desired revision, observed runtime state, applied revision, controller epoch,
and service incarnation are distinct. Persist intentional disconnect/stop
before its side effect, and honor it during reconnect and automatic upgrade.
A persistent sidecar owns its resources across upstream attachment loss;
provider-native stores still own canonical history. Before replacing an
execution environment, check every bound main-side actor before withdrawing
any sibling backend. Active work leaves the change pending. Backend effective
revisions cannot advance while their environment configuration remains pending;
new driver admission rejects a stale backend configuration with a retryable
runtime-unavailable result. Offer backend Disconnect only when the provider
runtime persists independently of its main-side attachment. This excludes Pi
SDK (including remote workspace operations) and local Codex, Claude, and Grok;
persistent remote Codex and Claude retain their disconnect controls. Unchanged
reconciliation must not republish application snapshots, replace advisory subscriptions, or
invalidate target health.

Idle eviction is a thread-owned release decision, distinct from main shutdown,
operator Stop, and carrier loss. Use the existing conversation retention policy
(default one hour); do not introduce a shorter process timer. Retained handles,
creation-to-attachment handoffs, and complete backend operations keep a shared
runtime resident. Last eviction releases it after operations drain. New use
waits for proven cleanup and a fresh generation, without replaying a request or
changing the configured backend's enabled/automatic-start preference. Idle
residency is available-on-demand, not an outage. Cleanup failure fences future
launches; it must not replace an authoritative operation result.

An empty Codex creation can be memory-only and remains retained while its
application creation/recovery handoff is pending, until attachment or an
explicit runtime Stop/restart. Do not expire that protection on a shorter timer.
A successful native fork already copies durable history and may never be
opened: release its temporary remote subscription when the main-owned fork
operation finishes instead of retaining a creation-to-attachment lease.

Codex holds one shared stdio process or external connection per principal/backend
instance. Idle teardown stops only owned stdio; external UDS/TCP servers remain
running. Claude evicts each query/CLI child separately and releases the shared
worker/supervisor after its last query and semantic operation. Pi and Grok keep
their existing per-conversation cleanup; they have no shared provider subprocess
to retire. Persistent Codex and Claude hosts require explicit eviction from the
current scoped controller: main/carrier detach alone never authorizes retirement
of retained queries, active work, pending interactions, or unacknowledged results.
The remote runtime protocol must distinguish idle from failed or stopped and
must fence older incompatible carriers when adding these release operations.
Required provider-private response changes also advance the sidecar wire
version: matching build metadata alone does not protect attachment to an older
service retaining work. Deliberate shutdown may retain final receipts for
reattachment and acknowledgment; observing a closed native process during that
handoff must not manufacture an unexpected-failure receipt.

Automatic upgrades require
fenced, authoritative idle and cleanup evidence for every owned resource,
including terminal checkpoints and unsettled mutation outcomes. Unknown state
blocks automatic replacement. Persistent terminal termination waits for the
host's exit evidence; failed signal delivery cannot manufacture an exit or a
cleanup receipt. A reachable host's exact-incarnation-unknown rejection records
lost continuity with no exit code or cleanup claim. Keep control admission
rejections distinct from uncertain effects and carrier failure. Repeated final
history recovery must preserve matching journal/database heads and acknowledge
only after the checkpoint and final status are durable. A stable management protocol must remain usable
when the runtime protocol is incompatible. Explicit confirmed Stop is independent
of provider history handoff: fence admission, interrupt owned execution or detach
an external provider, retain bounded disposition evidence where possible, and
report incomplete outcomes as unknown. Evidence retention failures must not veto
intentional Stop; actual owned-process cleanup failures still block replacement.
Codex and Claude persistent hosts implement this policy. Pi keeps its model loop
on main and uses the shared actor shutdown plus remote workspace cleanup; Grok
uses shared local actor shutdown and has no persistent provider host. Disconnect
continues to preserve independently hosted work. Controller replacement must
fence stale writers.

Database changes use one-way migrations and preserve scope in keys and foreign
relationships. A newer schema fails closed. A migration does not change the
provider's ownership of native history.

Treat applied migration SQL, persisted opaque-ID derivation domains, and
credential/key-derivation domains as versioned storage formats rather than
product copy. Never edit checksummed historical migration SQL or mechanically
rename a domain whose output is already persisted or held by an external
client. Leave such a domain byte-stable, document why its historical product
name remains, and make an end-state schema change through a new forward
migration.

Provider-owned history is not application state available for an in-place
rename. When an explicitly approved migration requires compatibility with
authenticated historical carriers, markers, or correlation IDs, accept only
the exact inventoried legacy formats under their original authentication
domains and continue emitting only the current format. Legacy recognition must
remain fail-closed, backend-private, and covered through the consuming history,
reconciliation, recovery, and presentation paths rather than only by an
isolated parser test.

### Project registration removal

Project removal is principal-owned workspace lifecycle state (`removed_at`),
independent of thread Active/Snoozed/Settled/Archived state and environment
filesystem grants. Pi, Codex, Claude, and Grok share its application admission
and retirement boundaries; no provider-specific delete operation is invoked.
Preserve native bindings/history and all workspace-related application records.
Only explicit validated open/restore can revive a removed registration at its
original environment/canonical-path identity. Background revalidation and
in-flight discovery must not restore it.

Removal fences terminal admission, thread runtimes, and Files operations;
rechecks project revision, exact thread membership, durable pending work, live
terminals, and enabled schedules at commit; then publishes an authoritative
application replacement. Queue/creation/fork/automation admission must also
check workspace state at reservation, so earlier validation cannot admit work
after removal. List projections omit removed projects and member threads while
retained read identities remain valid. Restore never enables paused schedules.

## Required cross-backend audit

For every backend-facing change, record an implemented or intentionally
unsupported disposition for every compiled backend. Audit at least the
surfaces that apply:

| Surface                            | Questions to answer                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Configuration and startup          | Is the shape strict? Does preparation fail before mutable startup? Who owns resources?                                                                                                                                                                                                                                                                               |
| Protocol binding and artifacts     | Does the selected official artifact match the exact surface and topology? Are provenance, runtime validation, extension ownership, bounds, facade authority, drift checks, and single-parser cutover explicit?                                                                                                                                                       |
| Capability projection              | Is support truthful at exact scope and generation? Does direct invocation fail closed?                                                                                                                                                                                                                                                                               |
| Discovery/import/create            | Are namespace, paging, binding, titles, partial success, and recovery covered?                                                                                                                                                                                                                                                                                       |
| History and streaming              | Are snapshot bounds, ordering, correlation, reconnect, duplicates, and stale events covered?                                                                                                                                                                                                                                                                         |
| Input lifecycle                    | Are send, steer, queue, stop, attachments, Task references, immutable acceptance snapshots, and active-turn races explicit?                                                                                                                                                                                                                                          |
| Completion consumers               | Does each obligation bind one exact operation, register atomically, consume one immutable normalized terminal snapshot, materialize idempotently, recover after restart, retain authenticated provenance, and give Pi, Codex, Claude, and Grok an explicit Steer, Queue, or unsupported disposition without provider-native leakage?                                 |
| Provider output artifacts          | Are exact native completion and byte authority, immutable scoped storage, duplicate live/history observation, normalized metadata, content retrieval, bounds, unavailable projection, topology, path-capture authority and host attribution, and input/tool-result separation explicit?                                                                              |
| Settings and provider features     | Are policy, desired/effective evidence, generation, turn-boundary application, persistence, native mapping, revisions, receipts, Saved Agents, and unsupported paths covered?                                                                                                                                                                                        |
| Model policy                       | Is it backend-owned and fingerprinted? Are native provider/model/effort matcher dispositions, catalog intersection, defaults, every new provider-effect boundary, stale stored selections, empty intersections, denylist future admission, and receipt/reconciliation ordering covered?                                                                              |
| Interactions                       | Are kinds, answers, interruption, reconnect, and sensitive data covered?                                                                                                                                                                                                                                                                                             |
| Forks                              | Are ancestry, exact selected turns, latest-provider-snapshot capability, lineage boundary/source-turn nullability, acceptance races, active-leaf interruption, immutable context, provider-history fidelity, backend fallback, and unresolved outcomes covered?                                                                                                      |
| Environments and Files             | Are local/remote authority, exact sidecar providers, no-fallback behavior, paths, idempotency, and cleanup covered?                                                                                                                                                                                                                                                  |
| Application terminal resources     | Are all environment providers explicitly implemented or unsupported? Are process/panel/End separation, initial-CWD authority, bounded checkpoint and `CSI 3 J` floor semantics, output ordering, preemptive epoch-fenced control, input reconciliation, zero-viewer lifetime, retained interruption truth, Sidecar revision, and no-local-fallback behavior covered? |
| Agent tools, skills, and terminals | Are presentations/transports, native scoped environment/config injection, Saved Agent bootstrap, catalog filtering, eligibility, executable/endpoint authority, secrets, PTY, admission, and lifecycle covered?                                                                                                                                                      |
| Persistence and tenancy            | Are all keys and caches scoped? Are migrations and wrong-scope denials tested?                                                                                                                                                                                                                                                                                       |
| Browser-derived bulk collections   | Is exact visible membership explicit and bounded? Does the server rederive scope, revisions, eligibility, Tasks, stashes, and blockers; reject selector expansion; commit all-or-nothing; retain external workspaces; and give every backend an explicit shared-application or unsupported disposition?                                                              |
| Shutdown and recovery              | Can admitted work outlive disposed dependencies? Are unresolved mutations reconciled safely?                                                                                                                                                                                                                                                                         |
| Browser and documentation          | Is the UI capability-driven? Are user/operator claims current and provider-neutral?                                                                                                                                                                                                                                                                                  |

“No code path exists” is not enough for required contributions: provide a typed
unsupported implementation or a capability test that proves the request is
rejected at the authoritative boundary.

### Packaged client boundary

Bundled Android and Electron clients are deployment shells around the same
normalized React application, not backend integrations. They load committed
web assets locally, save presentation-owned server profiles separately from
native encrypted credentials, and must
not embed provider SDKs, native identifiers, backend configuration, or a
server. A new packaged platform requires its own code-owned application origin,
explicit installation opt-in, exact CORS/Host/Fetch Metadata/CSRF treatment,
and real API, SSE, and WebSocket runtime evidence. A browser-selected server
URL never selects tenant, principal, backend, target, or execution environment
authority.

### Paired-client admission

Production HTTP management routes, content routes, event streams, and
WebSocket upgrades require shared paired-client admission by default before provider or
workspace operations. Browser cookies and native per-profile credentials map
to server-derived scope; never derive a tenant or principal from a client
profile, origin, pairing label, or connector-supplied ID. Sidecar credentials
are independently bound to connector identity and restricted to outbound
routes. Registration approval, environment grants, and runtime tickets do not
substitute for authentication. Preserve revocation across active carriers and
fail closed on absent, expired, wrong-kind, or wrong-connector credentials.

Pi, Codex, Claude, and Grok all use this shared ingress boundary; their provider
protocols, native login credentials, capabilities, history, and runtime semantics
are unchanged. Agent-tool source references and Tool-client credentials retain
their dedicated admission and do not authenticate unrelated management APIs.
The installation-owned `SEDES_AUTH_REQUIRED=false` startup override bypasses
paired-client checks only; retain Host/Origin, CORS, CSRF, host approvals,
execution grants, and dedicated Tool/source-reference admission. Retain stored
credentials across toggles and revalidate expiry and revocation when required
authentication resumes. Do not add automatic first-client claim authority.
Manual enrollment uses the shared short-code parser and installation-wide durable
guessing and request limits; endpoint-specific or provider-specific pairing must
not bypass them. Enrollment codes and persistent client credentials are distinct
contracts. Private managed Local grants retain their high-entropy IPC authority.
Public frontend and connector assets contain no authority. Add each new API or
upgrade route to the authentication audit and test unauthorized admission as
well as the normal scoped operation.

## Verification expectations

Use focused unit and integration tests plus the reusable backend-driver
conformance fixture where applicable. Cover success, malformed native input,
unsupported capability, wrong scope, stale revision/generation, timeout,
disconnect, shutdown, and recovery.

Then run the deterministic repository sequence in
[Development](../developer/development.md). Real Pi, Codex, Claude, and Grok
suites consume provider capacity and require explicit user authorization;
never cite them as evidence unless they were actually run for the final change.

## Review checklist

Before calling a backend-facing change complete:

- the contract layer and every ownership scope are written down;
- native shapes and secrets remain private;
- shared transport and protocol layers contain no backend semantic defaults or
  protocol-mode switches;
- official or generated artifacts have pinned provenance, runtime validation,
  and exactly one production parser;
- executable admission is separate from artifact provenance, permits documented
  compatible upgrades by default, and records evidence for any exact-version
  exception;
- operator-installed provider executables are never digest-pinned, while
  Sedes-owned workers and sidecars retain exact artifact verification;
- native per-session/per-turn environment or capability injection is explicitly
  implemented with scoped authority or intentionally unsupported without an
  ambient process-environment fallback;
- every compiled backend has an explicit disposition;
- capability projection and mutation enforcement share one authority;
- failure, ambiguity, recovery, reconnect, and shutdown are specified;
- configuration and persistence are strict and scope-safe;
- normalized browser wire-shape changes advance the client protocol version;
- every normalized activity kind has an explicit full/summary browser
  projection and grouping disposition;
- unsupported and wrong-scope paths fail closed;
- focused tests cover each backend and the shared contract;
- current user, operator, architecture, and backend docs agree; and
- historical plans or milestone records are not presented as current truth.

## Related documentation

- [Architecture](architecture.md) — shared authority, lifecycle, persistence,
  and security map
- [Backend internals](backends/index.md) — current provider-specific design
  documents
- [Operator backend guides](../operator/backends/index.md) — configuration,
  prerequisites, and operational behavior
- [Developer overview](../developer/overview.md) — repository map and test
  selection
