# Architecture

Sedes is a self-hosted application layer over provider-owned coding-agent
conversations. It gives one local principal durable organization, policy,
recovery, and a normalized browser experience without making the browser or
application database the authority for provider transcripts.

This document is the system map. Detailed subsystem invariants live in the
[internals index](index.md), and backend contributors must also follow the
[backend integration contract rules](backend-integration-contract-rules.md).

## Contents

- [System at a glance](#system-at-a-glance)
- [Authority and ownership](#authority-and-ownership)
- [Identity and backend boundary](#identity-model)
- [Conversation lifecycle and projection](#conversation-lifecycle-and-projection)
- [Mutations and recovery](#mutations-and-recovery)
- [Execution environments](#execution-environments)
- [Persistence](#persistence)
- [Durable usage accounting](#durable-usage-accounting)
- [Agent tools and terminals](#agent-tools-and-terminals)
- [Client ownership](#client-ownership)
- [Security boundary](#security-boundary)
- [Related documentation](#related-documentation)

## System at a glance

```text
Browser / bundled Android or Electron client
  │
  │ normalized HTTP, SSE, and terminal WebSocket contracts
  ▼
HTTP routes and application services
  ├── inventory, drafts, prompts, tasks, automations, saved Agents
  ├── Files, attachments, artifacts, interactions, agent tools
  └── thread mutations, queueing, forks, and recovery
        │
        ▼
ConversationActorManager ── one serialized owner per active Sedes thread
        │
        ▼
AgentBackendRegistry ── normalized backend contracts
        │
        ├── Pi backend ───── Pi SDK
        ├── Codex backend ── Codex app-server
        ├── Claude backend ─ local worker or persistent SSH/outbound runtime / Claude Code CLI
        └── Grok backend ─── Grok ACP

ExecutionEnvironment
  ├── Local: paths, processes, channels, PTYs, and Files
  └── SSH: remote workspace authority, optional Codex UDS transport,
           managed provider workers, and optional operations sidecar

Application state
  ├── overlay.sqlite
  ├── immutable composer-attachment blobs
  ├── immutable provider-output artifact blobs
  └── checksummed terminal journals

Provider state
  └── native conversation identity and transcript, owned by each provider
```

[`src/server/backends/compiled-module-catalog.ts`](../../src/server/backends/compiled-module-catalog.ts)
is the sole shared production composition point that imports provider modules.
It compiles Pi, Codex, Claude, and Grok. Shared services depend on normalized
module and driver contracts and never import provider SDK or protocol types.

## Authority and ownership

The first design question for any state or operation is who owns it.

| Concern                                                                                                                 | Authority                                                                               |
| ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Listener, backend configuration, workspace roots, network boundary                                                      | Installation operator                                                                   |
| Tenant and principal identity                                                                                           | Server-side identity provider                                                           |
| Projects, thread inventory, drafts, stashes, prompts, tasks, automations, saved Agents, queues, receipts, and lineage   | Sedes application state, scoped to tenant and principal                                 |
| Thread target and provider binding                                                                                      | Sedes application state; target is immutable after thread creation                      |
| Provider output artifact metadata and immutable retained bytes                                                          | Sedes application state, scoped to tenant, principal, and thread                        |
| Native conversation identity, transcript, provider settings/events, and provider process or endpoint                    | Backend/provider                                                                        |
| Workspace paths and operations                                                                                          | Selected execution environment                                                          |
| Terminal metadata, ordered history, lifecycle, admissions, and controller lease                                         | Sedes application state, scoped to tenant, principal, thread, and execution environment |
| Normalized IDs, ordering, revisions, pagination, capabilities, and interaction IDs                                      | Sedes server                                                                            |
| Pane instances and layout, density, filters, expansion, scroll position, visible stack membership, and other view state | Browser presentation                                                                    |

Production currently exposes exactly one server-derived local principal. That
product limitation does not make principal-owned state global. Repository
keys, service calls, events, queues, caches, receipts, runtimes, and file roots
retain tenant/principal scope. Browser input and provider data can never select
or replace that authority. Those boundaries allow a future identity provider
to admit more than one principal without reclassifying existing application
state; they do not provide multi-user access in the current release.

Installation policy is a ceiling. Principal, Agent, and thread settings may
choose only values admitted by the current installation configuration. When
several scopes contribute to a decision, the authoritative service resolves
and persists the effective choice instead of relying on a mutable ambient
default.

Execution environments, backend instances, targets, default selections, and
optional research providers are principal-owned SQLite configuration. The
schema-11 startup file contains installation listener/state/origin admission
only. Explicit offline import adopts prior definitions and bindings atomically;
ordinary startup never reconciles a legacy JSON file over database edits.
Settings commits desired revisions, and runtime reconciliation publishes applied
revisions and truthful failure/pending states under the same principal scope.

## Identity model

These identities are intentionally distinct:

- backend kind and target kind, which are closed compiled discriminants;
- backend instance, which owns operator configuration and model policy;
- target, which selects a backend instance, execution environment, and defaults;
- execution environment, which defines path, process, and operation authority;
- Sedes thread, which owns application overlays and an immutable target;
- provider-native conversation, session, turn, message, call, or cursor;
- normalized turn and item IDs, which are browser-facing identities; and
- agent-tool caller, policy, credential generation, and active-turn lease.

A provider-native conversation ID is unique only within its backend instance
and execution-environment scope. Native identifiers and cursors stay inside
the backend. They are never browser mutation authority and are persisted only
through backend-owned binding adapters.

## Backend boundary

A backend driver projects provider behavior into normalized turns, items,
settings, usage, interactions, capabilities, and events. The server projector
assigns browser-facing IDs, revisions, order, lifecycle state, and history
bounds. The browser consumes only shared protocol types and registered,
versioned provider-feature envelopes.

Provider-specific behavior has three valid homes:

1. the backend module and its private adapter, transport, and persistence code;
2. a closed provider-feature envelope with registered server and client
   modules; or
3. an existing normalized semantic item or interaction.

Unknown backend, module, feature, and schema discriminants fail closed.
Capabilities state what is implemented and available for the exact target and
runtime generation; callers must not infer support from a provider name,
model ID, transport, or transcript wording.

Provider process topology is also private. One long-lived module runtime is
created for each tenant/principal/backend instance, but Pi, Codex, Claude, and
Grok may own processes, clients, and native sessions differently inside that
boundary.

## Conversation lifecycle and projection

`ConversationActorManager` supplies one serialized owner for each active Sedes
thread. The actor:

- resolves the immutable target and a revocable execution-environment lease;
- attaches the provider driver;
- establishes one normalized projection generation;
- serializes mutations and live provider events; and
- coordinates queueing, interactions, history, and recovery.

At attach, the backend reads one bounded, internally consistent history
baseline and begins live observation without a gap. The actor's in-memory
normalized timeline is transcript authority for that process generation.
Snapshots, SSE replay, and live deltas come from that projection rather than
rereading provider history on every request.

The thread event hub updates its materialized snapshot on each normalized
event, including older-history expansion and application overlays. A browser
reattachment receives a small contiguous replay or, when cheaper, one current
`thread-checkpoint` at an atomic watermark followed only by newer events.
Fresh or expired cursors also receive a current checkpoint. This per-client
handoff does not publish a replacement into the shared hub or recapture the
provider. The client restores controls after `thread-live`, subject to actual
capability freshness and outstanding mutation receipts.

Provider history remains the durable transcript. Runtime eviction, provider
replacement, or process restart establishes a fresh projection from provider
history. Completed compaction, changed history bounds, or contradictory native
evidence may also retire a generation. A retired generation accepts no new
transcript deltas.

Application overlays—drafts, settings, inventory, tasks, pending input,
bookmarks, and attention—are read from Sedes repositories and merged against
the current generation. Updating an overlay does not require attaching a
provider or parsing provider history.

### Events and history

Application and thread SSE streams use process-local generations and opaque
replay cursors. A cursorless application client subscribes before capture,
receives the scope's current inventory checkpoint, and then receives only
concurrent or newer changes; a fresh authoritative capture runs only when no
ready projection exists. A retained client can receive a contiguous bounded
suffix of deltas; replay loss, generation change, or overflow produces that
current checkpoint instead, as described in
[Materialized application projection](application-projection.md). Revision
checks make duplicated HTTP/SSE delivery idempotent.

Application session metadata is intentionally separate from inventory. The
small HTTP session response carries the client protocol version, CSRF token,
and installation capability metadata. React obtains authoritative application
inventory only through application SSE; an explicit point-in-time snapshot
read exists for bounded CLI and diagnostic consumers and never publishes into
or replaces a principal's replay hub. Browser-supplied replay cursors are opaque
resume hints beneath server-derived tenant/principal scope, never authority.

Older history uses opaque Sedes cursors scoped to principal, thread, and
projection generation. Provider cursors never enter the browser. Whole-turn,
item-count, and byte limits apply at backend, normalized protocol, replay, and
browser-window boundaries. Targeted history lookup, used by bookmarks and
deep links, asks the backend to resolve an application identity predicate
without exposing native IDs.

Pre-live stream failures are represented by one bounded normalized load-error
event when the socket can carry it. Provider error codes, paths, identifiers,
and causes remain server-private. A transport that cannot carry the control
event remains an ordinary disconnect.

### Browser projections

Browser activity mode is presentation, not transcript authority. The server
applies the requested `full` or `summary` projection consistently to initial
snapshots, replacement snapshots, replay, live events, older-history pages,
and targeted seeks. Summary mode emits bounded activity descriptors and only
explicit provider-supplied summary parts; it never derives a summary from or
serializes detailed reasoning, tool arguments, results, command output, file
content, diffs, or errors.

Optimistic composer rows are also presentation-only. Every delivery allocates
an application operation ID before local staging, and authoritative queue rows
or provider-projected user items reconcile that row only by the exact ID.
Text, timestamps, ordering, or provider names are not reconciliation evidence.

Sidebar stacks are another browser projection. Scope, search, visibility,
organization, and sorting first produce ordinary thread rows; stacking then
groups the resulting visible rows by persistent Group or project. The browser
may submit that exact ordered list of application thread IDs for a bulk
inventory impact check, but it does not submit tenant/principal authority,
eligibility, revisions, Task or stash counts, runtime state, or blockers. A
persistent Group, project, or fork family is not an implicit selector for that
operation.

## Mutations and recovery

Provider creation, delivery, steering, interruption, interaction answers, and
forking cross an external side-effect boundary. Sedes records durable operation
identity and the last safe state before making the call. Reconciliation may
classify an exact operation as:

- accepted or applied;
- proven not applied and eligible for bounded retry; or
- unresolved.

Unknown outcomes are not silently retried or inferred from unrelated provider
activity. An unresolved queue head blocks later delivery so Sedes does not
fabricate ordering. A user-authorized force reset abandons selected Sedes
recovery blockers; it never asserts that provider work stopped or did not
occur.

Bulk sidebar inventory changes are application-owned rather than provider
side effects. The server derives tenant/principal scope, freezes revisioned
targets during authoritative impact calculation, and rechecks runtime and
durable blockers before commit. Settle, unsettle, or archive changes every
eligible target, moves any explicitly disposed open Tasks, advances the
principal inventory generation, and records one replay receipt in one SQLite
transaction. A stale revision, changed confirmation count, invalid target, or
single blocker aborts the complete database mutation; publications occur only
after commit. Pi, Codex, Claude, and Grok therefore share this exact path and
need no provider-specific implementation or capability. Bulk archive retains
isolated execution workspaces because filesystem deletion cannot join the
database transaction, and archived threads have no bulk-stack restore path.
Archive additionally takes the affected per-thread coordinator and
actor-manager admission fences in stable order and holds them through commit.
If a stream or direct actor borrower remains busy, or closure cannot be proven,
the archive does not commit. Receipt replay retires only threads that are still
archived before republishing the receipted state.

The browser's requested delivery intent and the server's admitted mode are
separate facts. Idle or failed state resolves input to Submit. During an active
turn, Submit resolves to Steer only when the backend advertises a Steer
delivery mode and its declared `steerTarget` can be proven: a turn-scoped
target requires the exact active turn, while a conversation-scoped target
requires only the bound conversation. Otherwise it resolves to Queue. Explicit
Queue stays Queue. Pi and Codex steer the exact active turn; Claude's Steer is
conversation-scoped and is delivered at the provider's next native
opportunity, so it may join the active turn or open the next one and never
interrupts current work; Grok advertises no Steer, so its active-turn input
stays in Queue. Transitional, disconnected, stale-target, and recovery states
fail closed or retain work durably rather than guessing.

New Sedes threads exist before native creation. First send reserves creation,
binds the provider identity when known, and applies title and input through
recoverable steps. Forks use the same durable child-publication boundary; see
[native fork lineage](native-fork-lineage.md).

## Execution environments

Execution environments own path and channel semantics independently of the
conversation backend.

The local environment canonicalizes directories beneath configured roots and
owns local processes, UDS/TCP channels, PTYs, Files, and attachment staging.

An SSH workspace is admitted as a canonical absolute POSIX path beneath an
operator-configured remote root and tagged with the configuration revision.
Ordinary admission does not run an auxiliary remote `realpath` or filesystem
probe. Availability is established lazily by the required backend or sidecar
handshake. Reconfiguration revokes old leases instead of silently retargeting
them.

The optional managed SSH sidecar grants a closed subset of operations such as
Files, Compare, Pi workspace tools/context, attachment staging, and agent-tool
relay, plus an explicitly enabled interactive terminal PTY. Each operation
rechecks the exact environment lease. A successful
provider handshake does not grant sidecar capabilities, and sidecar success
does not grant a provider transport. Unsupported remote operations never fall
back to local paths.

Claude uses a digest-verified local worker or a backend-private runtime hosted
by the persistent SSH or outbound sidecar on Linux/macOS. Its SDK, CLI, credentials, and native session
store share the selected execution namespace. The remote service owns queries
across main-server and carrier loss; provider-native history remains canonical.
Runtime admission grants no Files, attachment, CLI, workspace tool, or terminal
authority. See [Claude internals](backends/claude.md).

For a Pi SSH target, Pi itself still runs on the Sedes host. Only the closed
workspace tools and bounded context operations cross the sidecar. This is not
a remote Pi runtime. See [Pi remote workspace tools](pi-remote-workspace-tools.md)
and [workspace files](workspace-files.md).

## Persistence

Sedes stores application state beneath `$APP_STATE_DIR`:

```text
overlay.sqlite                     application overlay and backend bindings
composer-attachments/              immutable user-input blobs
output-artifacts/blobs/             immutable retained provider-output bytes
terminals/                          retained terminal checkpoints and journal suffixes
```

The database does not contain a canonical provider transcript. Provider-owned
conversation stores and authentication must be backed up separately.

Migrations are ordered, checksum-locked, and one way. Startup validates
configuration before database mutation, obtains state ownership gates, backs
up a supported older database before migration, checks integrity, and rejects
a database newer than the running source.

An installation key supplies separate cryptographic domains for authenticated
control markers, encrypted restart-safe agent-tool thread references, and
principal Tool-client secret verification. Persisted references hold the
minimum stable identity and re-resolve mutable authority on each request. They
do not persist a runtime lease or turn browser/provider data into authority.

Composer attachments and Task/context references become one immutable,
path-free delivery snapshot before provider acceptance. Provider-native forks
copy correlated snapshots into the child scope so normalized user input can be
reconstructed without parsing provider-echoed text. See
[composer attachments](composer-attachments.md).

Provider output artifacts travel in the opposite direction. A backend
recognizes one reviewed native result and hands the common artifact service a
bounded byte source. Normalized history contains descriptor metadata, never
provider paths, URLs, base64, or storage paths. See
[provider output artifacts](output-artifacts.md).

## Durable usage accounting

[`UsageService`](../../src/server/usage/usage-service.ts) stores normalized
accounting on main, independently of transcript delivery. Six scoped logical
tables retain source identity, immutable observations, canonical selected facts,
turn/session projections, and capture gaps. Evidence references and ownership use
restrictive foreign keys; ordinary thread archive leaves captured evidence intact.
A single per-thread monotonic revision advances atomically with changed totals.

Backend adapters capture before lossy presentation. Pi entries are additive;
Codex native-thread checkpoints and Claude query-pipeline checkpoints replace
covered values. Derived turn allocations do not add another session charge.
Missing metrics, SDK normalization, unknown model attribution, cost estimates,
regressions, and gaps remain explicit. Token JSON uses canonical unsigned decimal
strings; money uses decimal strings and currency groups. Browser numbers never
round durable token counts.

Visible ended turns use a bounded database-only
`POST /api/threads/:threadId/usage/turn-availability` read (up to 100 IDs) to
show the action only when recorded metrics or cost exist. The authenticated
thread cache batches these presence checks; it fetches full reports on open.
Running and empty turns have no usage action. Pi normal replies are captured
from the confirmed native-message persistence path, since the SDK does not
emit `entry_appended` for assistant/tool messages.

The scoped `GET /api/threads/:threadId/usage` and
`GET /api/threads/:threadId/usage/turns/:turnId` routes read the database without
opening a backend. Visible history loads register turn stubs. A committed revision
can invalidate an already-loaded actor's usage cache under its current projection
generation; this ancillary event does not mutate the transcript or create actors.
Visible client views use single-flight reads, five-second polling, and
focus/reconnect refresh; closed transcript rows never poll.

### Usage timeline and analytics

[`usage-timeline.ts`](../../src/server/usage/usage-timeline.ts) maintains
`usage_increments`, a derived projection with one row per accepted increase of
a source's canonical session selection. It is written in the capture
transaction: an additive fact contributes its values, and a checkpoint fact
contributes the difference from its previous accepted value in the same
source. `none` facts, legacy snapshots, inherited facts, and rejected or
regressing evidence contribute nothing, so a source's rows sum to its selected
session totals. Each row records scope, thread, source, turn when proven,
backend instance and kind, environment, workspace, agent role, activity,
provider, model, reasoning effort, token columns, and cost. Cost is an integer
in 10⁻¹² currency units rounded half up; session and turn reports keep exact
decimals.

Each row also records how its time is known. `reported` uses a source
occurrence time. `observed` is a receipt within one continuous capture
incarnation (a `UsageSink.open()` with no intervening `gap()`, seal, or failed
capture write). A checkpoint that passes the frontier, lock, and regression
checks restores continuity even when unchanged, and `usage_sources.timeline_receipt`
keeps its receipt. `interval` is a delta across a gap, restart, or
reattachment and starts at that receipt. `unplaced` is a first checkpoint with
an unknown baseline. Analytics places an interval only when both ends fall in
one bucket, reports intervals that began before the range separately, and
never puts `unplaced` usage in a time range. When a replaced snapshot loses or
shrinks a member while its total grows, one model-less snapshot row records the
delta so rows keep summing to the selected totals.

A backend may attach an observation `attribution` with the effective model and
reasoning effort confirmed at capture. It is excluded from the evidence
fingerprint and stored evidence, and applies only to `reported` and
`observed` rows; a reported fact model always wins. Claude splits its
query-cost checkpoint across per-model rows only when the supplied per-model
totals add up to it. Unknown attribution stays unknown and is never copied from
current settings. Sources that predate migration 113 are rebuilt once by a
conservative replay: later checkpoint deltas become intervals, and a replay
that cannot reproduce the current records falls back to `unplaced` rows. A
background task rebuilds pending sources one per macrotask after startup, and a
read finishes what remains for its scope within a bounded observation budget.
Projection failures fall back to conservative rows or schedule a rebuild; they
never roll back accounting.

[`UsageAnalyticsService`](../../src/server/usage/usage-analytics-service.ts)
serves the principal-scoped, database-only `POST /api/usage/analytics`. It
buckets by calendar hour, day, week (starting Monday), or month in the
requested IANA zone, including daylight-saving transitions, and allows at most
500 buckets. The response carries totals, the previous equal-length period, a
series grouped by one dimension (seven plus Other, with a filter-independent
color order), per-dimension breakdowns, an optional two-dimension matrix,
faceted filter choices on request, a weekday-by-hour heatmap, placement and
coverage totals, and labels resolved from the principal's own rows. Every
aggregate reads one snapshot. The browser page lives in
[`src/client/usage`](../../src/client/usage/UsageView.tsx).

## Agent tools and terminals

Agent-tool calls use a closed internal caller union. A thread-agent caller
derives authority from the source thread, its current policy, environment, and
an exact active-turn lease when invocation requires one. A principal Tool
client derives authority from its authenticated client row, current credential
generation, policy, and explicit environment allowlist. It has no source
thread and cannot impersonate one.

Admission materializes an immutable caller, defaults, policy, and environment
grant. Later policy mutation does not rewrite already admitted domain work.
Tool-created threads, queued input, and forks persist the exact initiating
thread or Tool client as mutually exclusive provenance. See
[agent tools](agent-tools.md).

Managed terminals are separate presentation and transport surfaces with their
own admission and lifecycle. They do not relax backend or execution-environment
authority. The Codex-specific contract is in
[managed Codex TUI](codex-managed-tui.md).

Application terminal resources are independent of conversation backends and
the Codex managed TUI. A resource belongs to a thread and environment, while
browser-local panels are detachable views. One serialized terminal actor owns
the PTY, output ordering, bounded checkpoint and journal suffix, controller
lease, and gap-free attachment. Controller claims preempt the old attachment
under a new epoch; no release from another device is required. A panel close
only detaches, while explicit End waits for confirmed process cleanup and then
deletes the resource and restore state. Natural exit, failure, and interruption
remain retained for inspection.
Local environments open a main-owned PTY. Persistent SSH sidecars own remote
PTYs, their process/controller identities, and bounded retained output. Main
restart or carrier loss detaches and later reconciles those resources rather
than respawning them. Local process continuity still ends with main restart;
sidecar service restart/crash is the remote interruption boundary. Final remote
terminal output must be preserved before a safe replacement. See
[application terminal resources](terminal-panes.md).

## Client ownership

The React client maintains one reference-counted thread store per observed
Sedes thread. Multiple panes share normalized network and mutation state;
scroll position, expanded cards, open file tabs, and layout remain local
presentation. Inactive stores may be retained under bounded time, count, and
memory limits and reconnect using their opaque cursor. Client retention neither
changes provider transcript retention nor survives a browser-process restart.

Electron adds one main-process connection supervisor outside the sandboxed
renderer. It owns the app-session managed Local server and any temporary SSH
forward through one narrow native contract. Local uses code-owned packaged
server, configuration, state, environment, workspace-root, and ephemeral
loopback-port choices. Configuration and application state persist beneath the
Electron user-data directory, while the process never survives application
exit or a successful switch away. Provider executables, credentials, and
native transcript stores remain backend/provider authority.

The chooser may retain Local while a confirmed replacement is validated, but
never publishes both servers as active. Candidate failure or cancellation
restores the same Local instance; success stops Local exactly before publishing
the replacement. Browser and Android composition do not include this native
supervisor, and Android continues to own one client-local direct endpoint.

The server may separately retain an idle actor/runtime for the configured
retention interval. Server retention does not delete application data, stop
active work, or alter provider retention. One installation-owned resident actor
budget value bounds this warm state independently per tenant/principal
execution environment. Every backend and workspace targeting the same
environment shares its pool; local and distinct SSH environments do not consume
one another's capacity. New admission first retires the oldest eligible idle,
unobserved runtime in the same pool; it fails only when that pool's remaining
actors are active, observed, establishing, or fenced after uncertain cleanup.
Passive application-state reads preserve the original idle deadline rather
than extending runtime lifetime indefinitely. Eligibility is confirmed by the
actor's atomic idle-close operation; a carrier disconnect or stale coordinator
observation is not independent authority to stop a runtime.

The single-user-oriented defaults retain idle runtimes for one hour and admit
32 resident conversations per tenant/principal execution environment. Pi,
Codex, Claude, and Grok all use this same shared actor-manager and coordinator
policy; no backend receives a separate fallback or larger private product
budget. Each tenant/principal application stream maintains its current inventory
projection from normalized publications. Reconnects replay at most 32 events
within 64 KiB of encoded SSE frames; larger gaps receive one current
checkpoint. Idle application projections expire after one hour, with at most
128 idle scopes and 256 MiB of accounted projection, replay and checkpoint
bytes. The fold, checkpoint, eviction and recovery rules behind those bounds
are in [Materialized application projection](application-projection.md).
Each thread replay independently retains 4,096 events within 32 MiB. The browser keeps
up to 32 inactive thread projections for one hour within a 256 MiB serialized
desktop budget or a 64 MiB serialized Android budget; normalized object graphs
can occupy several times their serialized size in a mobile WebView heap.

## Security boundary

The HTTP listener serves the complete management UI and API for the local
principal. Exact Host and Origin validation, Fetch Metadata, CSRF, CORS,
security headers, and bounded bodies protect expected browser flows; they are
independent of client authentication. By default, production composition installs paired
client admission before protected management routes and upgrades. Public
frontend assets and the downloadable connector enable enrollment; they confer
no application authority. Same-origin browsers use HttpOnly cookies, while
packaged clients use per-profile bearer credentials held in native encrypted
storage. A server-account CLI issues five-minute single-use codes and manages
90-day revocable credentials in a separate, installation-owned
`authentication/authentication.sqlite` database beneath the state directory.
Only the private authentication directory and database files receive authentication
permission enforcement; the shared state-directory mode is preserved. Sidecar credentials are constrained to
outbound operations and bound to connector identity, independently of host
approval and execution grants. All authenticated management clients resolve
to the existing local tenant/principal; a client cannot select either scope.

Provider credentials, transport credentials, native IDs, operator paths, and
resolved secrets stay server-side. Transcript and workspace content are
sensitive user-authorized data and are not safe for logs or public exposure.
Principal Tool-client credentials authorize only canonical agent-tool routes;
they do not authenticate the management API.

Keep Sedes within one of the explicitly supported private deployment
boundaries. See [operations and security](../operator/operations.md).

## Related documentation

- [Internals index](index.md) — subsystem design and contract catalog
- [Backend integration contract rules](backend-integration-contract-rules.md)
  — normative backend contributor requirements
- [Backend internals](backends/index.md) — provider-specific lifecycle,
  protocol, persistence, and capability designs
- [Provider-owned conversation state](provider-owned-conversation-state.md) —
  transcript-storage rationale, attach projection, interoperability, and
  performance consequences
- [Developer overview](../developer/overview.md) — repository map and change
  workflow
- [Configuration](../operator/configuration.md) — operator-owned topology and
  policy
- [User documentation](../user/index.md) — user-facing concepts and workflows

## Client navigation identity

Management authentication status and pairing may include `navigationNamespace`,
an opaque HMAC of the installation's persisted key and its server-resolved
principal/tenant. Files uses it with server origin to scope local navigation
records. It contains no credential and grants no authority. Required-auth
unauthenticated status and sidecar enrollment do not expose it. An installation
that explicitly disables authentication uses its same local-principal namespace.
Changing credentials does not change the principal's navigation identity;
changing installation, tenant, or principal does. Client protocol 117 carries
the Files revision catalog contract used by this navigation restore path.
