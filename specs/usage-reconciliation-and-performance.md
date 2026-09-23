# Usage reconciliation and responsiveness

Status: bucket query optimization implemented and regression-tested; remaining performance and reconciliation work pending.

## Objective

Keep recorded usage useful across local and SSH sessions without requiring
perfect accounting. Prioritize large missing contributions and keep Usage-page
reads and recovery work from blocking interactive application operations.

Historical child ownership is durable accounting state, not an obligation to
attach to every child on startup or reconnect. Preserve the current targeted
Codex recovery behavior.

## Performance findings

An isolated read-only profile of an imported database with 399,693 timeline
increments reproduced the reported delay. No sources required timeline backfill.
These are diagnostic samples on one host, not portable latency guarantees.

| Request | SQL statements | Elapsed | Timer delayed by synchronous work |
| --- | ---: | ---: | ---: |
| 30-day overview, grouped by model | 51 | 25.1 s | 25.1 s |
| All-time monthly report, no grouping | 45 | 23.2 s | 23.2 s |

`normalized-app.ts` calls synchronous `UsageAnalyticsService.query` directly
from the request handler. Almost all measured request work is SQLite execution
on the main event loop. This can delay unrelated HTTP, streaming, and transport
callbacks, not just the Usage page.

The timeline queries intend to range-scan the time index per bucket. The
observed plan instead scans the principal's rows through the thread index and
iterates the JSON bucket table for each row. An isolated query rewrite using
bucket-first `CROSS JOIN` and the existing time index reduced the two main
timeline queries from 15.1 s to 0.85 s. The complete request fell from 26.0 s to
11.7 s, with an exactly equal parsed response. This query change is now applied
to application code; it does not by itself solve event-loop blocking.

Other amplification:

- Every request computes all ten breakdowns, each with multiple aggregate scans,
  plus heatmap and coverage data regardless of the visible tab.
- Opening or searching filters requests another complete report plus facets.
- Refreshes occur every minute and on focus, visibility, and online events.
  Aborting a client request does not cancel synchronous server SQL.
- A request can also replay pending timeline history synchronously. The current
  observation budget is checked between whole sources, not within a source.

## Performance work

1. **Implemented:** make the bucket query plan use bounded time-index range scans.
   Regression tests compare complete responses against the former join for
   filters, null keys, intervals, DST, and grouping, and inspect the actual
   overall/grouped/interval query plans for bucket-first scoped time ranges.
2. Run analytics in a bounded read worker, with its own database connection and
   explicit lifecycle, cancellation, and queue limits. Keep timeline rebuilds
   outside the request path.
3. Compute only the report sections requested by the current surface, and give
   facet search a bounded operation rather than recomputing the whole report.
4. Coalesce equivalent in-flight requests and avoid redundant refresh triggers.
   Any cache must include server-derived tenant/principal scope and have explicit
   invalidation as usage and display metadata change.
5. Measure Usage response latency together with unrelated HTTP/stream latency
   on a dataset of this scale. Do not accept a faster query that still freezes
   the main event loop for seconds.

## Reconciliation work

1. Produce a coverage report by backend/environment: missing sources, known gaps,
   uncertain overlap, and estimates of significant recoverable contributions.
   Inspect older Codex inherited-child counters before treating their skipped
   usage as small; counts alone do not establish missing token volume.
2. Package the existing collectors, overlap proofs, normalizers, and verification
   into a supported manual command. Preserve immutable observations and update
   selected accounting facts without replay double counting. Do not blindly
   overwrite newer counters or guess downward corrections.
3. Replace installation-specific assumptions with scoped configuration. Persist
   progress per tenant/principal, execution environment, native namespace, and
   session; keep provider parsing inside backend-owned code.
4. Cover later outages, not only the initial historical prefix. Changed-file
   detection must include children that ran entirely while the app was offline,
   even when no unresolved capture was recorded.
5. Add bounded scheduling after the manual operation is dependable. Bound CPU,
   I/O, remote concurrency, and database writes, and reuse the same reconciliation
   semantics for manual and scheduled runs. Do not open provider sessions merely
   to recover accounting.

Pi's stable native entry identities, Codex cumulative counter domains and fork
baselines, and Claude inclusive query overlap need separate backend proofs.
Grok remains explicitly unsupported until a truthful accounting implementation
exists. Missing files and unresolved ownership remain explicit skips.

The current maintenance importer requires offline application writes and has
fixed historical boundaries on some paths. It is a reusable foundation, not a
ready-to-schedule continuous reconciler. Fine recovered timeline placement must
also survive generic projection rebuilds before reconciliation becomes built in.
