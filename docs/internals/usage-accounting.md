# Usage accounting

Sedes records the tokens and cost estimates that providers report for work it
observes, stores them on the main server independently of any browser, and
serves per-turn, per-session, and principal-wide views from the database. This
page is the maintained contract for that subsystem: its authority, storage,
capture, selection, reads, analytics projection, and limitations.

It records **observed work**, not billing. Sedes counts what a supported backend
reported while Sedes was attached, plus what later supported evidence recovers.
It does not reproduce a provider invoice, infer subscription charges, or price
tokens itself. Missing values are unknown, never zero.

Provider-specific evidence and its caveats are summarized in
[Backend dispositions](#backend-dispositions) and detailed in the operator
guides for [Pi](../operator/backends/pi.md#recorded-usage),
[Codex](../operator/backends/codex.md#recorded-usage),
[Claude](../operator/backends/claude.md#recorded-usage), and
[Grok](../operator/backends/grok.md#recorded-usage). Visible behavior is
described in [View recorded usage](../user/conversations.md#view-recorded-usage)
and [Usage and spend](../user/usage.md). Cross-backend obligations are in the
[backend integration contract rules](backend-integration-contract-rules.md).

## Contents

- [Principles](#principles)
- [Authority and ownership](#authority-and-ownership)
- [Storage](#storage)
- [Evidence contract](#evidence-contract)
- [Capture transaction](#capture-transaction)
- [Selection and reports](#selection-and-reports)
- [Backend dispositions](#backend-dispositions)
- [Forks, inherited turns, and subagents](#forks-inherited-turns-and-subagents)
- [Reads and live updates](#reads-and-live-updates)
- [Timeline projection](#timeline-projection)
- [Analytics read](#analytics-read)
- [Recovery, migration, and retention](#recovery-migration-and-retention)
- [Limitations](#limitations)
- [Changing this subsystem](#changing-this-subsystem)

## Principles

- **Capture before presentation.** Backends normalize native usage evidence
  before any lossy transcript or live-snapshot projection. Live `UsageSnapshot`
  and `usage_changed` carry only context occupancy and transcript counters; they
  are never token, cost, or request authority.
- **Unknown is not zero.** A metric that was not reported stays `null` with
  `unreported` quality. An SDK default is not proof that a provider reported
  zero, and a missing observation is not zero usage.
- **Never double count.** Cumulative checkpoints replace earlier checkpoints
  of the same series; turn allocations are views of session evidence, not
  additional charges; covered lower-scope evidence is retained but not added.
- **Evidence is immutable.** Observations are append-only. Corrections need a
  source-proven newer revision or order. Conflicts are recorded, not resolved
  by last arrival.
- **Accounting never blocks provider work.** A capture failure is logged and
  surfaced as a quality reason; it never throws into provider delivery, retries
  provider work, or vetoes stop, restart, or upgrade.
- **Reads never open providers.** Every usage read is database-only and
  available while a backend is disconnected, disabled, or unavailable.

## Authority and ownership

Accounting is tenant/principal-owned application state, further scoped to the
admitted backend instance, execution environment, and application thread.

| Concern | Authority |
| --- | --- |
| Which thread a source charges | The admitted durable conversation binding, or a provisional binding owned by an active creation attempt |
| Native evidence parsing and identity | The backend adapter; native IDs never leave the backend except as opaque, hashed source keys |
| Canonical selection, quality, and revisions | [`UsageService`](../../src/server/usage/usage-service.ts) |
| Session and turn reports | Materialized per thread from selected records; rebuildable |
| Principal-wide analytics | The derived `usage_increments` projection and [`UsageAnalyticsService`](../../src/server/usage/usage-analytics-service.ts) |
| Scope for every read | The server-derived `RequestScope`; the browser selects a thread or filters, never a tenant, principal, or source |

Every query, cache key, and invalidation includes tenant and principal. A
foreign or unknown thread returns not found; a foreign turn ID returns not
found for turn reports and `available: false` for availability checks, without
revealing which case applied. Workspace, environment, and backend IDs are
recorded at capture time: later moves, renames, or model changes do not rewrite
history.

## Storage

All tables live in the main application database (migrations 110–113) and are
covered by its backup boundary. Ownership and evidence foreign keys use
`ON DELETE RESTRICT`; usage is never cascaded away.

| Table | Contents |
| --- | --- |
| `usage_thread_state` | One row per scoped thread: the sole monotonic usage `revision`, the materialized session `report_json`, and any legacy Claude snapshot. |
| `usage_turn_state` | One row per scoped thread and normalized turn: turn status, materialized turn `report_json`, and optional `origin_thread_id`/`origin_turn_id` for inherited turns. |
| `usage_sources` | One row per accounting series: owning thread, backend instance, environment, workspace, native namespace and session (hashed into the ID), counter or query `epoch`, normalization version, initial `baseline` (`proven_zero` or `unknown`), `capture_state`, ordered `frontier`, `agent_role` (`main` or `subagent`), and timeline state and receipt. |
| `usage_observations` | Immutable evidence keyed by source, observation ID, and revision: semantic fingerprint, canonical evidence JSON, normalization version, reported occurrence time, and receipt time. Update and delete triggers abort. |
| `usage_records` | Canonical current facts keyed by source and fact ID, referencing the selected observation, with the normalized fact JSON, application turn ID, and integer token columns. Checkpoint replacement is transactional. |
| `usage_gaps` | Known capture gaps, conflicts, rejected evidence, and limitations per source, with an optional turn subject and whether the gap affects session scope. |
| `usage_subagents` | Codex child sessions: native session, native parent, root native session, and owning root thread. Each native child has exactly one owner. |
| `usage_increments` | The derived analytics projection described in [Timeline projection](#timeline-projection). |

A source ID is a hash of the scope, native namespace, native session, and
epoch (Codex children add the backend instance and environment). Reaching the
same native session through another connection therefore does not create a
second series, and a transport reconnect does not start a new epoch.

## Evidence contract

Backends receive a scoped [`UsageSink`](../../src/server/usage/contracts.ts)
through module composition and never touch the tables directly.

| Operation | Contract |
| --- | --- |
| `open({binding, nativeNamespace, nativeSession, epoch, normalizationVersion, initialBaseline, subagent?})` | Admits the binding and returns a `UsageCapture` for one series. Each call is a new capture incarnation. |
| `registerTurns(turns, inherited?)` | Registers normalized turn stubs and verified inherited-turn relationships. |
| `capture(observations)` | Validates and applies a batch in one transaction. Returns `false` on failure without throwing. |
| `reconcile()` | Called only after authoritative history or a cumulative child snapshot was fully ingested; clears `capture_gap` and `capture_failed` for the source. |
| `gap(reason)` | Records a known gap or limitation for the source. |
| `seal(reason)` | Ends the incarnation: `detached` marks the source disconnected, `closed` idle, and `reset` records `source_reset`. |
| `listSubagents` / `listSubagentRoots` | Indexed reads of latest unresolved child captures and their roots, used by Codex recovery. |
| `findSubagent` | Exact scoped historical ownership lookup when current provider activity identifies a child; no historical enumeration. |

An observation has an ID, a revision, an optional source-proven `order`,
`live` or `history` provenance, an optional reported `occurredAt`, a
`replaceCheckpoint` flag, up to 10,000 facts, and optional `attribution`.
Serialized observations are limited to 64 KiB; malformed or oversized
evidence records `invalid_evidence` and is skipped.

Each fact declares:

- `kind`: `operation`, `auxiliary`, `cumulative`, or `turn_aggregate`.
- `sessionContribution`: `additive` (adds to the session), `checkpoint`
  (replaces the series value), or `none` (evidence only, such as turn
  allocations and lower-scope message usage).
- `coverageDomain`, which bounds what a checkpoint covers.
- Tokens: `input` (inclusive of cache), `uncachedInput`, `cacheRead`,
  `cacheWrite`, `output` (inclusive of reasoning), `reasoning`, `total`, and
  `requests`. Each is a canonical nonnegative decimal string within signed
  64-bit range, or `null`.
- `costs` (decimal amount, ISO currency, `estimated` or `reported`, and
  provenance) and optional `pricing` metadata, which is evidence and never an
  additional charge.
- `models` (provider and model, each nullable), measurement `basis`
  (`provider_reported`, `sdk_normalized`, `derived`), provider-presence
  certainty, `complete` or `partial` quality, and quality `reasons`.
- `activity`: `model`, `tool`, `compaction`, `branch_summary`,
  `cache_warming`, or `auxiliary`.
- `turn`, when the backend proves ownership: native turn ID, scope
  (`whole_turn`, `main_loop`, or `partial_interval`), and whether it adds to or
  replaces the turn's allocation.
- `inheritedFrom` for verified copied evidence, which is never charged again.

Money is canonical decimal text with at most 38 significant and 18 fractional
digits. SDK floats are normalized once by `nativeUsageMoney`; sums use decimal
arithmetic, and rounding happens only for display.

### Attribution

`attribution` names the provider-confirmed model and reasoning effort in force
when the evidence was produced. It is validated separately: an invalid
attribution is dropped without affecting the evidence. It is excluded from the
semantic fingerprint and from stored evidence, so a replay with different
attribution is still a no-op, and it never changes accounting. Only the
[timeline projection](#timeline-projection) uses it. Backends must never derive
it from desired, draft, or current composer settings.

## Capture transaction

Each `UsageCapture` call runs one synchronous transaction:

1. Re-admit the binding against durable ownership. A binding that no longer
   matches, a native session owned by another thread, or a child claimed by
   another root fails the call.
2. Ensure the thread state row, admit a Codex child relationship when
   applicable, and insert or reuse the source row.
3. Record `capture_failed` if an earlier write for this thread failed in the
   current process, and rebuild the source's timeline if it predates the
   projection.
4. Apply the action. For each observation:
   - An identical observation (same ID, revision, and fingerprint) is a no-op.
     A different fingerprint for the same identity records
     `conflicting_evidence` (turn-scoped when every fact is turn-owned).
   - A replacing checkpoint older than the source `frontier` is ignored.
   - A source locked by a session-scoped `counter_regression` or
     `conflicting_evidence` accepts no further checkpoints.
   - A replacing snapshot whose per-metric sum or per-currency cost decreases
     records `counter_regression` and changes nothing.
   - Additive facts are written once. A changed additive fact is a conflict.
     Turn checkpoints with a newer source order replace older ones; equal or
     unordered replacements are conflicts.
   - Accepted facts update `usage_records` and the timeline projection.
5. Rematerialize the thread's session and turn reports, advancing the
   revision only when a report actually changed, and rematerialize threads with
   inherited turns from it.

Listeners (the usage revision hint) run after commit. On failure the service
keeps an in-memory failure flag for the thread (or child source), logs bounded
metadata, and reports `capture_failed` until a later write for that source
succeeds. Failures are never retried as provider work and are not buffered
durably.

## Selection and reports

Reports are computed from `usage_records`, never from a generic `SUM` over
observations.

**Session selection.** For each metric, a source's checkpoint facts are
selected and its additive facts for that metric are excluded; sources without
checkpoints contribute their additive facts. Separate sources sum. Costs group
by currency, kind, and provenance; reported and estimated amounts for the same
work are alternatives, not additions. Turn allocations and `none` facts never
contribute to session totals.

**Turn selection.** Only main-agent records with a turn ID are considered.
Within one coverage domain a turn checkpoint supersedes additive message
evidence. Child records never enter parent turns.

**Metric quality.** Each metric reports its known value, quality
(`unreported`, `partial`, `complete`, or `conflict`), contributing basis tags,
and whether every contributing fact had provider-reported presence. Quality is
`conflict` when a regression or conflicting-evidence reason applies, `partial`
when any incomplete reason applies or a contributing fact is partial, and
otherwise `complete`. `main_loop_only` and `model_coverage_unknown` describe
scope and do not by themselves make counts partial.

**Report state.** A report is `unavailable` with no recorded metric or cost,
`complete` when every recorded metric and cost is complete with no incomplete
reason (and, for a turn, the turn completed with a single `whole_turn` or
`main_loop` scope), and otherwise `partial`. `support` is `unsupported` for
Grok. `captureState` is `active`, `disconnected`, `idle`, or `failed`.
`lastRecordedAt` is the latest receipt of a contributing fact. Codex session
reports add a `breakdown` of main-agent and subagent summaries.

| Reason | Meaning |
| --- | --- |
| `capture_gap` | Capture was interrupted; work may be missing. |
| `capture_failed` | A write failed in this process; later evidence may be missing. |
| `history_partial` | Evidence came from history that cannot cover the whole scope. |
| `unknown_baseline` | A cumulative series started from an unproven value. |
| `counter_regression` | A counter decreased without a proven reset; the last valid value is kept. |
| `conflicting_evidence` | Two different facts claimed the same identity. |
| `ordering_unknown` | Evidence order could not be established. |
| `main_loop_only` | The measurement covers the main agent loop only. |
| `unknown_attribution` | Evidence could not be attributed to additive session work. |
| `inherited_baseline_unknown` | Copied fork history could not be separated from new work. |
| `legacy_coverage_unknown` | Pre-accounting Claude totals with unknown coverage. |
| `child_coverage_unknown` | Child work may be incomplete. |
| `source_reset` | The provider reset the series; its segment was sealed. |
| `invalid_evidence` | Evidence failed validation and was skipped. |
| `unsupported` | The backend does not report usage. |
| `model_coverage_unknown` | The source did not report which model did the work. |

Gaps carry an `affects_session` flag: turn-only conflicts mark the turn
without degrading session quality. A session-wide gap marks every turn of that
source, so a disconnect can make earlier completed turns partial too.

Reports are cached as JSON in the state rows and rebuilt on demand when a
migration clears them. The revision is the only ordering authority for
clients; it advances atomically with changed reports.

## Backend dispositions

| Backend | Evidence captured | Session scope | Turn scope | Model and cost | Attribution |
| --- | --- | --- | --- | --- | --- |
| Pi | Each usage-bearing native entry: assistant messages (one request each), tool results, compaction and branch summaries, and built-in cache warming. Other extension usage entries are retained without being added. | Additive entries, including inactive branches and idle work | Sum of the turn's entries (`whole_turn`) | Reported per entry; SDK cost estimate per entry | Thinking level from the entry's native branch |
| Codex | Cumulative `thread/tokenUsage/updated` totals as a session checkpoint, the latest call as lower-scope evidence, and derived turn intervals | Latest valid checkpoint of one native counter series across reconnects | Differences between continuous, owned checkpoints (`main_loop`, or `partial_interval` without a proven baseline) | Not reported; no cost | Provider-confirmed effective model, provider, and effort for the current runtime generation, withheld while a tuple-changing `turn/start` awaits its receipt |
| Codex subagents | Each child's cumulative lifetime counter under the root thread | Included once in the root session with a main/subagent breakdown | Never allocated to parent turns | Not reported; no cost | None |
| Claude | Per-query cumulative `modelUsage` checkpoints and the query cost estimate; per-turn result usage; main-loop assistant messages | Sum of disjoint query epochs' latest checkpoints | Result `usage` as `main_loop`; messages until the result arrives | Reported per model; SDK cumulative estimate | Applied effort for the confirmed model's row |
| Grok | None; declares `usageAccounting: "unsupported"` | Unsupported | Unsupported | — | — |

Epochs: Pi uses its native entry store, Codex a single native counter series
per thread, and Claude one epoch per actual SDK query (its startup probe
identity), preserved across reattachment. A new Claude query starts from a
proven zero; a retained query reattaches with an unknown baseline. A Claude
conversation reset seals its segment with `source_reset`; a known synthetic
startup failure never replaces real counters with zeros.

## Forks, inherited turns, and subagents

Copied history is inherited evidence, not new spend.

- **Pi** excludes entries up to the authenticated Sedes branch marker for the
  child. Without a verified marker, every copied entry is excluded and the
  source records `inherited_baseline_unknown`.
- **Codex** forks mark the child's session counter as non-contributing, since
  its baseline includes the parent, and charge only continuous turn intervals
  observed in the child. The source records `inherited_baseline_unknown`.
- **Inherited turns** are registered with `origin_thread_id` and
  `origin_turn_id` after the service verifies scoped lineage and an existing
  source turn. Their reports copy the origin turn's report with
  `inherited: true` and are refreshed when the origin changes. They never
  contribute to the child's session totals.

Codex children are separate `subagent` sources. Ownership requires native
spawn evidence descending from an admitted root binding: a completed
collaboration spawn or a multi-agent v2 `subAgentActivity` start. Send, wait,
and unrelated thread events never establish ownership, and a native session
bound to an ordinary Sedes thread can never become a child. Child capture is
owned by the runtime rather than the parent's presentation handle, so it
continues after the parent handle closes. Historical ownership remains durable
without creating a live monitoring obligation. On restart or reconnect, indexed
queries select only children whose latest source is `active`, `disconnected`, or
`failed`, and only roots with such children. A later idle source supersedes an
older unresolved source. Recovery does not scan every historical child.

Recovery resumes eligible loaded children with `excludeTurns`; it never reads
transcripts or starts unloaded threads. Absence from the loaded inventory ends
monitoring while retaining any accounting gap. Idle ancestors need no capture
or attachment for an unresolved descendant's durable ownership to remain valid.
Current native activity can rediscover a historical child through an exact
tenant/principal/backend/environment/namespace/profile-scoped lookup, including
ownership retained without a usage source. That lookup reuses existing ancestry;
it does not turn unrelated native events into new ownership evidence. Cleanup
releases only an attachment the coordinator actually acquired in the current
connection generation. Idle historical children cause no remote cleanup work.

This monitoring lifecycle is implemented by Codex. Pi retains its native-entry
capture, Claude pipeline totals already include SDK subagent work without a
separate child monitor, and Grok usage accounting remains unsupported.

## Reads and live updates

| Route | Purpose |
| --- | --- |
| `GET /api/threads/:threadId/usage` | Session report, including the Codex breakdown and any legacy snapshot |
| `GET /api/threads/:threadId/usage/turns/:turnId` | Turn report for a registered turn |
| `POST /api/threads/:threadId/usage/turn-availability` | Up to 100 turn IDs; returns which ended turns have recorded metrics or cost |
| `POST /api/usage/analytics` | Principal-wide aggregates; see [Analytics read](#analytics-read) |

All four use the ordinary scope, send `Cache-Control: no-store`, and never open
a backend. Strict schemas live in
[`usage-accounting.ts`](../../src/shared/protocol/usage-accounting.ts) and
[`usage-analytics.ts`](../../src/shared/protocol/usage-analytics.ts); token
counts, revisions, and money are decimal strings.

Visible turns are registered as stubs whenever a snapshot, history page, or
live turn upsert makes them visible, for every backend, so a known turn without
evidence reads as unavailable rather than not found. Registration failure never
fails a transcript read.

After a commit, the service notifies the loaded thread runtime, which publishes
`usage_revision_changed` under the binding's current projection generation. It
is a transcript no-op and only a refetch hint; no actor, hub, or projection is
created to send it. The per-thread
[`UsageQueryCache`](../../src/client/stores/UsageQueryCache.ts) batches
availability checks, fetches full reports only when opened, ignores stale
revisions, polls every five seconds while visible, and refreshes on focus,
visibility, and reconnect. The Usage page polls analytics every minute while
visible and refreshes on focus. A failed read keeps the last successful data.

## Timeline projection

[`usage-timeline.ts`](../../src/server/usage/usage-timeline.ts) maintains
`usage_increments` inside the capture transaction: one row per accepted
increase of a source's selected session totals.

- An additive fact contributes its values once.
- A checkpoint fact contributes its difference from the previous accepted
  value of the same fact in the same source. A fact first seen after the
  series began started from zero within it.
- A replaced snapshot that drops a member, shrinks one, or stops reporting one
  of its metrics or its cost while the total still grows is written as one
  model-less snapshot row for the whole delta, so rows still sum to the selected
  totals.
- `none` facts, legacy snapshots, inherited facts, and ignored, locked, or
  regressing evidence contribute nothing.

Each row records scope, thread, source, turn (when the fact or a sibling
interval proves one), backend instance and kind, environment, workspace, agent
role, activity, provider, model, reasoning effort, the seven token columns
(uncached input derived when the components are known), and cost. Cost is an
integer in 10⁻¹² currency units rounded half up. An amount outside the integer
range is stored as unknown. `costed` marks rows whose cost is recorded on the
row or on a sibling cost summary, so token rows priced by a summary are not
counted as unpriced.

### Time placement

| Placement | When | Charted |
| --- | --- | --- |
| `reported` | The source reported an occurrence time (Pi entries) | At that time |
| `observed` | Additive evidence without an occurrence time, or a checkpoint received while the capture incarnation stayed continuous | At receipt |
| `interval` | A checkpoint delta across a gap, restart, or reattachment; starts at the previous accepted receipt | Only when the whole interval falls in one bucket |
| `unplaced` | The first checkpoint of a series with an unknown baseline | Never; reported separately |

Continuity belongs to one `open()` incarnation. The first checkpoint is
continuous only for a proven-zero source with no accepted checkpoint yet. A
`gap()`, seal, failed write, observation dropped as invalid evidence, or
rejected checkpoint breaks continuity, since the next delta may then cover an
unobserved checkpoint. A checkpoint that passes the
frontier, lock, and regression checks restores it, even when no value changed,
and `usage_sources.timeline_receipt` records its receipt as the start of any
later interval. Members of one snapshot share the continuity in force before
it, and an accepted snapshot continues the next one in the same batch.

### Model, effort, and cost attribution

- A fact-reported model always wins. Attribution names a model only for a
  single-model fact whose own model is unknown (Codex). Cost summaries and
  snapshot rows stay model-less.
- Attribution applies only to `reported` and `observed` rows; work recovered
  across a gap may span a settings change and stays unknown.
- Effort applies when attribution names no model, or when the row's model
  matches the attributed model (case-insensitive, ignoring a bracketed variant
  such as `[1m]`). Helper and subagent models in the same Claude delta receive
  none.
- A Claude query-cost summary is split across per-model rows only when the
  supplied per-model totals add up to it within 10⁻⁹ per row, the previous
  snapshot of the series was split the same way (or there was none), and no
  model's total fell since that snapshot. Otherwise the summary's cost delta is
  recorded on a model-less row, so a series that starts reporting per-model
  totals is never charged twice, and a correction that lowers one model's
  estimate while raising another's nets out instead of keeping only the rise.
- Codex attributes nothing while a `turn/start` that changes the model or
  effort awaits its receipt, since that turn's usage can arrive before the
  receipt confirms the new tuple.

### Rebuilds

Sources that existed before migration 113 are marked `backfill`. After
startup a background task rebuilds pending sources one per macrotask. An
analytics read finishes what remains for its own scope within a budget of
about 50,000 replayed observations, and live capture rebuilds a pending source
before applying new evidence. The rebuild:

- writes additive records at their reported or receipt time;
- replays checkpoint observations in insertion order with the service's
  frontier and regression rules. The first checkpoint is `observed` for a
  proven-zero source and `unplaced` otherwise; later deltas become intervals;
- falls back to one `unplaced` row per current checkpoint record when the replay
  cannot reproduce the current records (for example, a locked source, a
  non-replacing checkpoint, or unreadable evidence).

Rebuilds never attribute effort or unreported models. A replay or write
failure runs in a savepoint and falls back to conservative rows; a failed
projection write during capture schedules a rebuild. The projection never
rolls back accounting.

## Analytics read

[`UsageAnalyticsService`](../../src/server/usage/usage-analytics-service.ts)
answers `POST /api/usage/analytics` from `usage_increments` in one read
transaction. The strict request contains:

- `from` (an ISO instant, or `null` for everything placed) and `to`;
- an IANA `timeZone` and `bucket` (`auto`, `hour`, `day`, `week`, `month`);
- `filters`: up to 50 values for each of `environment`, `backend`,
  `backendKind`, `provider`, `model`, `effort`, `workspace`, `thread`,
  `agentRole`, and `activity`, where `null` selects an unknown value;
- `groupBy` for the series, `crossBy` for the matrix, `breakdownLimit` (at
  most 100), and `facets`.

Buckets are calendar hours, days, Monday-start weeks, or months in the
requested zone, computed on the server across daylight-saving transitions.
An hour bucket starts at each local :00 and at each wall-clock jump, so a
repeated hour is its own bucket and a 30-minute shift (Lord Howe Island)
leaves a half-hour bucket before the next local :00.
Automatic granularity is hourly up to 3 days, daily up to 93 days, weekly up to
two years, and monthly beyond; any request is coarsened to stay within 500
buckets. The resolved `from` is the first bucket's start; the previous period
is the same length immediately before it.

The response contains:

- **Totals and previous-period totals** of placed usage whose whole interval
  falls in the range. "Tokens" is input plus output per row; missing
  components count as missing, never zero, in `missing` per metric
  (including `uncachedInput`, which is unknown whenever a reported input's
  cache components are).
  `uncostedTokens` sums tokens with no recorded cost.
- **Timeline**: ungrouped points per bucket and, with `groupBy`, the top seven
  keys plus Other with per-bucket points, and a filter-independent all-time
  color order. Cost points use the most common currency in range.
- **Breakdowns** for every dimension (top `breakdownLimit` rows, Other, and a
  distinct count), an optional **matrix** of `groupBy` × `crossBy` (up to 2,000
  cells), and optional **facets** (up to 60 choices per dimension, each ranked
  under every other dimension's filter but not its own). `facetSearch` narrows
  one dimension's choices by ID, model name, or the principal's own thread
  title, project name or path, environment label, or backend label, so values
  outside the top 60 stay reachable. Other dimensions have few values and are
  searched in the client.
- **Heatmap** of local weekday by hour from `reported` and `observed` rows,
  aggregated at 15-minute resolution so every zone offset maps exactly.
- **Placement**: reported, observed, placed intervals, intervals spanning more
  than one bucket, intervals that began before the range (`straddling`), and
  all-time unplaced usage.
- **Coverage**: threads with usage, threads whose session report is partial or
  in conflict, active Grok threads that report no usage (narrowed by
  thread-level filters), and tokens with unknown model or effort.
- **Labels** for environments, backend instances, projects, and threads,
  resolved from the principal's own rows. Removed items keep their IDs and are
  labelled as removed or archived.

Every aggregate is scoped to the requesting tenant and principal. Grouping uses
explicit null-aware predicates so unknown keys fold into Other correctly.

## Recovery, migration, and retention

- **Startup.** Sources left `active` by a crash are marked `disconnected` with
  `capture_gap` and their threads are rematerialized. Timeline rebuilds then
  start in the background.
- **Reattachment.** Backends reconcile through their existing attach,
  history, or resume paths in bounded batches. Reading usage never opens a
  provider, scans a filesystem, or launches recovery. Codex does not reread
  history for accounting; Claude retained replay and history can repair
  message evidence but cannot reconstruct pipeline totals.
- **Legacy Claude totals.** Migration 110 moved the old per-thread Claude
  ledger into `usage_thread_state.legacy_json` with a legacy source and
  observation. Session reports expose it separately with
  `legacy_coverage_unknown`; it is excluded from selected totals and from the
  timeline.
- **Migrations.** 110 creates the store, 111 adds session-scope gap flags, 112
  adds Codex child ownership and clears cached reports for rebuild, and 113 adds
  the timeline projection and marks existing sources for rebuild. Migration 114
  adds indexes for unresolved child recovery and latest-source selection without
  changing accounting evidence or totals. Applied migrations are checksummed
  and never edited.
- **Retention.** There is no automatic purge. Archive, restore, rename,
  environment disablement, provider disconnection, and native history pruning
  keep recorded usage. The only deletion path is aborting a proven-uncreated
  fork, which asserts that no evidence exists and removes its empty
  reservations. A future scoped purge must remove observations, facts,
  projections, and gaps together while preserving other threads' inherited
  references.

## Limitations

**Coverage**

- Only work observed while Sedes owned an admitted runtime subscription is
  captured. Work done while detached appears only if a later supported
  checkpoint recovers the session total, and then without per-turn, model, or
  exact time attribution.
- Session-wide gaps also mark earlier turns of that source partial. Codex does
  not reconcile them through history.
- Grok reports no usage and is excluded from every total.

**Backend evidence**

- Codex reports no cost. Its usage never appears in cost totals and is counted
  as unpriced; Sedes does not price tokens.
- Codex notifications carry no model. Model and effort are known only for
  continuously observed usage captured after this attribution existed; child
  usage never has a model.
- Codex turn usage needs a proven boundary. The first interval of a turn after
  a warm resume or reattachment can remain partial or missing, and native
  history has no per-turn usage to backfill.
- Codex children that completed while disconnected, and children never
  discovered, may be incomplete.
- Claude turn usage covers the main loop only. Pipeline, subagent, compaction,
  and helper usage and all cost stay at session scope. Result facts keep a
  conservative `partial` classification pending a replay-safe normalization
  update.
- Claude per-model cost in analytics depends on the SDK's per-model estimates
  adding up to the query estimate.
- Pi extension usage entries other than built-in cache warming are retained
  but not added, since their overlap with messages is unproven. Request counts
  exist only for Pi assistant messages and cache warming.
- Legacy Claude totals have unknown coverage and appear only in Session stats.

**Time and attribution**

- Cumulative sources have receipt times, not occurrence times. A continuously
  observed delta is placed when received, which can trail the work slightly.
- Recovered intervals are charted only within one bucket and are excluded from
  ranges they straddle. Unplaced baselines belong to no range, so a range total
  can be lower than the sum of session totals.
- Usage recorded before the timeline existed, or recovered across a gap, has no
  reasoning effort, and model only where the fact reported one.
- Estimated costs are SDK or provider estimates, not invoices, and say nothing
  about subscription billing. The projection rounds to 10⁻¹² units.

**Scale and bounds**

- Analytics aggregates are computed on each request (roughly thirty indexed
  range scans). Very large all-time ranges are the most expensive reads.
- Series show seven keys plus Other; breakdowns at most 100 rows; the matrix at
  most 2,000 cells; facets 60 choices per search; filters 50 values per
  dimension; charts 500 buckets. Only the most common currency is charted.
- Per-request drilldown, a pricing engine, provider invoice reconciliation, and
  multi-principal administration are not implemented. Production exposes one
  local principal.

## Changing this subsystem

- Preserve the [backend contract rules](backend-integration-contract-rules.md)
  for usage capture and attribution, and give every compiled backend an
  explicit disposition.
- Add accounting schema changes as new migrations; update checksum-lock and
  upgrade tests like
  [`usage-timeline-migration.test.ts`](../../tests/unit/usage-timeline-migration.test.ts).
- Keep the timeline invariant: a source's `usage_increments` rows sum to its
  selected session totals.
- Change the browser contract with a client protocol version bump.

Coverage lives in
[`usage-service.test.ts`](../../tests/unit/usage-service.test.ts) (selection,
conflicts, scope, forks, subagents),
[`usage-analytics.test.ts`](../../tests/unit/usage-analytics.test.ts) (timeline,
placement, rebuilds, analytics, time zones), the backend adapter tests
(`pi-usage-accounting`, `codex-usage-capture`, `codex-subagent-usage`,
`claude-usage-accounting`), the HTTP contract in
[`normalized-http-api.test.ts`](../../tests/integration/normalized-http-api.test.ts),
the client under [`src/client/usage`](../../src/client/usage/UsageView.tsx), and
[`usage-analytics.spec.ts`](../../tests/e2e/usage-analytics.spec.ts). Live
Codex child accounting is exercised by
[`codex-subagent-usage-live.test.ts`](../../tests/integration/codex-subagent-usage-live.test.ts)
when `SEDES_REAL_CODEX_SUBAGENTS=1`.
