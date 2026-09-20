# Materialized application projection

The server maintains one current, normalized application-inventory projection
per server-derived tenant/principal scope with an admitted application stream,
so catch-up stays bounded: a client returning after a long absence receives one
current checkpoint instead of a long historical replay, and without forcing
another cross-cutting authoritative capture. The projection holds normalized
inventory only; transcripts, provider-feature envelopes, blocking interactions
and provider-native identifiers stay with their owners, as described in
[Provider-owned conversation state](provider-owned-conversation-state.md).
Nothing is persisted: restart discards every projection and stream generation.

## Ownership and lifetime

The materialization key is exactly the tenant and principal of the request
scope. No replay cursor, workspace ID, thread ID or backend instance selects or
widens it. The scoped registry creates the projection, its event hub, replay
buffer, timers and byte accounting as one aggregate and destroys them together.

The first subscriber needing a ready projection drives one single-flight
authoritative capture; concurrent handshakes join it. Capture reads inventory
repositories, the execution-target catalog, installation advisories, terminal
summaries and loaded-runtime state, and never attaches a dormant provider
conversation. A producer publication is a state-change hint, not a request to
instantiate a projection: publication looks the aggregate up without creating
it, and a hint for a scope with no retained aggregate, or an unseeded one with
no subscriber, is discarded because the next seed reads authoritative state.
A failed seed or recapture discards the aggregate and closes its streams; the
server does not retry, and the next reconnect seeds a new generation.

## Fold and epoch model

An aggregate is `unseeded`, `seeding`, `ready`, `recapturing` or `closed`. The
application publication boundary is its only writer and serializes every turn
for a scope in one per-principal lane. Preparing a seed or replacement may
await repositories and runtime readers in that lane; committing an already
validated delta is synchronous.

Fold-and-publish is atomic. Validation, resolving the prior value, checking
affected invariants, computing the byte delta and encoding the SSE frame all
complete before installed state changes. The hub then assigns `watermark + 1`,
installs the replay record, and a pre-fanout hook applies the prepared fold and
installs the projection before any subscriber callback runs, so a subscriber
never observes an event ahead of the checkpoint that includes it. A failure
before the commit changes nothing; a failure inside it closes the aggregate.

Environment, workspace, thread and Task upserts and removals and inventory
counts fold incrementally; a Workpad invalidation advances the position without
changing snapshot values. Execution targets, advisories, Groups, fork origins
and lineage have no incremental event and change only through a full
replacement, as do cross-collection changes one delta cannot carry, such as a
grouped thread crossing the archived boundary, a thread moving workspaces, or a
fork whose bounded selection membership can change. Folding is bounded work: ID,
reverse-reference and lineage reference-count indexes and a per-entity byte
ledger let a delta serialize only the incoming entity and reject a projected
total above the 32 MiB snapshot limit. Regressed thread or Task revisions,
dangling references and inserts beyond 256 environments or 10,000 other entries
are rejected, and at most 64 dependent entities are inspected before
recapturing rather than scanning a collection.

Captures coalesce by epoch. A structural hint or explicit client recovery
advances the requested epoch; a capture records that epoch when it starts and
covers it once installed, so waiters at or below the covered epoch are
satisfied by it and later requests need at most one follow-up. Ordinary deltas
admitted during a capture do not advance the epoch: they wait outside the lane,
reread their source, and fold against the installed replacement.

Full validation is periodic. The next complete materialization after a
value-changing fold re-parses the strict snapshot schema, recomputes the byte
total, rebuilds and compares the indexes, and confirms no stored entity was
mutated in place. It is due after 1,024 folds, 8 MiB of examined entity bytes,
or 60 seconds from the first unaudited fold, and is scheduled only while the
aggregate has subscribers, so an idle projection defers it. A due audit blocks
serving a checkpoint but not an otherwise valid small replay.

## Replay window and compaction

Application replay retains at most 32 events and 64 KiB of encoded SSE frames;
thread hubs keep their own larger policy. Each retained frame is cached with
its byte length, so accounting, replay and live fanout never encode an event
twice. Snapshots are never retained: installing a seed or replacement clears
the suffix and makes its sequence the replay floor, and an individually
oversized delta likewise folds, advances the position and clears the suffix.
Prefix eviction stays safe because the only cursor that loses history is older
than the floor, and it receives a checkpoint that already includes every
evicted event.

## Catch-up and checkpoints

A handshake registers its live listener and chooses its baseline synchronously,
before any capture or socket wait; events published after registration enter
the connection's bounded pending queue and are filtered against the baseline
sequence. `Last-Event-ID` takes precedence over the explicit query cursor. The
retained suffix is served only when the aggregate is ready, no uncovered
replacement is pending, and the cursor sits inside the contiguous retained
suffix within both the 32-event and 64 KiB limits; retention uses the same
bounds, so a cursor inside the window is within budget by construction. A
cursor at the watermark receives only the live marker.

Every other case — an absent cursor, a foreign-generation, future or evicted
cursor, or an over-budget suffix — receives the current checkpoint: an ordinary
`snapshot` envelope whose event ID is the current stream position. It is
synthesized for that subscriber, so it is not appended to replay, does not
advance the watermark, and is not broadcast; the next reconnect asks only for
events after that position. One materialized checkpoint and its encoded frame
are cached per position and shared by concurrent handshakes until the next
publication drops that cache, and this clean ready path performs no capture and
no repository or backend read. The explicit authoritative-replacement
handshake, honored only when the client sent no `Last-Event-ID`, bypasses the
checkpoint and publishes a fresh capture as a replacement.

## Idle eviction and accounting

Admitting a subscriber cancels idle expiration. Losing the last subscriber
starts the one-hour idle interval and sets the aggregate's recency; producer
traffic neither extends the deadline nor refreshes recency, although cheap
valid deltas still fold into a retained idle aggregate. An aggregate that loses
its last subscriber while seeding, recapturing or carrying an uncovered
replacement request is discarded rather than captured for nobody. The registry
keeps at most 128 idle scopes and 256 MiB of accounted bytes, evicting
least-recently-idle first and never evicting a subscribed aggregate for the
idle budget. Accounted bytes cover the projection's serialized size, retained
replay frames, and any cached checkpoint frame plus the materialized snapshot
behind it; they bound serialized size, not JavaScript heap use.

## Consistency and fail-closed recovery

A checkpoint is served only when the aggregate is the one the registry holds
for the authenticated scope, its generation equals the hub generation, its
position equals the watermark at the atomic read, every position since the seed
folded exactly once in order, retained replay is a contiguous suffix ending at
that watermark, the last full validation established the complete normalized
invariants and byte limits, every later fold passed its bounded checks, and no
failed producer handoff, rejected fold or lifecycle race was observed.
Ownership, generation and state are rechecked after every await.

Any failed statement moves the aggregate to `recapturing`, drops the cached
checkpoint, and stops serving checkpoints or replay from that baseline. Without
subscribers it is retired instead of recaptured. With subscribers, one
coalesced recovery capture starts at least one second after the preceding
capture, doubling up to 30 seconds per further recovery cycle without a clean
interval and resetting after 60 seconds of uninterrupted ready state;
structural replacements use epoch coverage rather than this failure spacing. A
failed recovery retires the aggregate and closes its streams rather than
serving a projection the server can no longer prove current, and invalidation
reasons stay server-private: the browser sees a replacement snapshot or a
disconnected stream. Current means current through the published stream
position, so a change committing while its publication is pending follows the
checkpoint as a later event.
