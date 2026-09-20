# Provider-owned conversation state

Sedes treats each provider's native conversation as the canonical transcript.
It does not copy that transcript into `overlay.sqlite` and then make the copy a
second authority. Instead, Sedes adds durable application state around the
provider conversation and builds a normalized in-memory projection while a
thread is active.

This document explains that design methodology, the interoperability it
preserves, and the performance tradeoffs it creates. It is not a claim that
Sedes stores no conversation-related data.

## Contents

- [The decision](#the-decision)
- [What lives where](#what-lives-where)
- [Why Sedes uses this model](#why-sedes-uses-this-model)
- [Attach and projection lifecycle](#attach-and-projection-lifecycle)
- [Native interoperability and concurrency](#native-interoperability-and-concurrency)
- [Performance consequences](#performance-consequences)
- [Measurement methodology](#measurement-methodology)
- [Rejected alternative: a canonical SQL transcript](#rejected-alternative-a-canonical-sql-transcript)
- [Design invariants](#design-invariants)

## The decision

The provider owns native conversation identity, transcript, provider settings,
provider events, and the process or endpoint that interprets them. Sedes owns
the application overlay: organization, drafts, pending work, policy, recovery,
and the normalized browser contract.

The dividing line is **canonical transcript authority**, not whether data is
related to a conversation. Sedes deliberately persists conversation-adjacent
and user-authored content needed to provide its own features. It does not try
to reconstruct the provider's durable transcript from those records.

## What lives where

| Layer | Examples | Authority and lifetime |
| --- | --- | --- |
| Provider-native state | Native conversation/session ID, transcript, provider settings and events, provider credentials | Durable provider authority. Back up and operate it according to the provider backend's guide. |
| `overlay.sqlite` | Sedes threads and bindings, titles, drafts, stashes, queued input, delivery snapshots, settings, tasks, automations, bookmarks, receipts, recovery records, and lineage | Durable Sedes application authority, scoped to the server-derived tenant and principal. It is not a complete provider transcript. |
| Sedes blob stores | Immutable composer attachments and retained provider-output artifact bytes | Durable Sedes-owned bytes referenced by overlay metadata. |
| Resident thread actor | Normalized turns and items, revisions, replay state, live events, and resolved capabilities | One process-generation projection used while the thread is resident. Rebuilt from provider history after eviction, replacement, or restart. |
| Browser | Layout, scroll state, local presentation preferences, and a bounded normalized view | Presentation only; never provider or mutation authority. |

Because the overlay can contain original prompt text, structured context,
attachments, and recovery evidence, it must be protected and backed up as
sensitive application state. A Sedes backup and a provider-store backup are
both required for complete recovery; neither substitutes for the other.

## Why Sedes uses this model

### One durable transcript authority

Mirroring every provider item into SQL would create two durable histories that
could disagree after partial writes, provider upgrades, native compaction,
out-of-band provider activity, or an uncertain network outcome. Keeping the
provider transcript authoritative avoids a general dual-write protocol and
the repair rules it would require.

Sedes still records operation identities, delivery snapshots, and recovery
evidence before crossing external side-effect boundaries. Those records let it
classify an outcome as applied, proven not applied, or unresolved without
pretending to be the transcript owner.

### Native conversations remain native

Existing eligible provider conversations can be discovered, imported into the
Sedes inventory, and resumed without exporting and re-importing their
transcripts through a Sedes database format. The provider's own installation,
credentials, retention behavior, and native session files remain meaningful
outside the Sedes UI.

This also lets Sedes put one normalized front end over different existing back
ends. Provider-specific IDs, events, history rules, and transports stay inside
each backend module; the browser receives normalized turns, items,
capabilities, interactions, and cursors.

### Provider changes do not become transcript migrations

A provider may evolve its native schema, compaction, paging, or event model.
The corresponding backend adapter must understand the supported version and
project it truthfully, but Sedes does not need to migrate a second durable copy
of every historical item merely to preserve transcript ownership.

## Attach and projection lifecycle

When a Sedes thread becomes active, one serialized conversation actor attaches
its backend and establishes a projection generation:

1. The backend resolves the immutable target and provider binding.
2. It acquires an internally consistent provider-authoritative history
   baseline and starts live observation without a gap.
3. Sedes normalizes that history into one bounded in-memory timeline and merges
   the durable application overlays needed by the UI.
4. Initial snapshots, replay, live deltas, and older-history requests use that
   generation rather than rereading the provider store for every browser
   request.
5. Eviction, process restart, provider replacement, or contradictory native
   evidence retires the generation. A later attach builds a fresh projection
   from provider history.

The exact history acquisition strategy is backend-private. “Bounded” is a
contract about admitted data, bytes, turns, paging, and memory; it does not mean
every provider can supply a constant-size cold attach.

## Native interoperability and concurrency

Provider ownership means native conversations do not have to be converted into
a Sedes transcript format. It does **not** mean every provider store or native
session is safe for simultaneous writers.

| Backend | Current same-installation and same-session rule |
| --- | --- |
| Pi | Sedes holds the canonical writer lock for an active native session. Another Pi or Sedes process must not operate that session concurrently. |
| Owned Codex | Sedes locks the configured native Codex store. Do not run another owner against that store concurrently. A managed Codex TUI is a client of the same operator-owned app-server, not a second store writer. |
| Claude | One runtime may query different sessions concurrently within its configured limit, but Sedes denies attaching the same native session twice. This is not a guarantee that an independent CLI may mutate that session concurrently. |
| Grok | Sedes owns one local ACP process per resident session. There is no supported independent same-session writer contract. |

Native tools may continue to use the same provider installation for other
sessions when that backend permits it. For the same store or session, follow
the locking and lifecycle rules in the relevant
[backend guide](../operator/backends/index.md); never bypass a native lock to
force concurrency.

## Performance consequences

This model favors a single durable authority and native interoperability over a
locally indexed SQL transcript mirror. The tradeoff is most visible on a cold
attach or reattach, when the backend may need to open a provider process or
store, acquire history, normalize it, establish live observation, and publish
the authoritative first snapshot.

Cold behavior varies by backend and protocol generation:

| Backend | Relevant cold-history behavior |
| --- | --- |
| Pi | Reads the complete active-branch suffix admitted by the backend. |
| Codex | Legacy resume retains the complete native resume result; the paginated history path loads bounded turn shells and items per page. |
| Claude | Its environment-owned SDK worker acquires complete authoritative history once per attach; the backend retains it for the handle lifetime and pages the normalized result. |
| Grok | Loads a bounded provider window and reads older pages request-locally while retaining a bounded newest whole-turn window. |

Users with long or content-heavy native histories, slow storage, remote
provider topology, expensive provider startup, or constrained CPU and memory
may therefore find current cold-load or reattachment performance unacceptable.
Warm behavior can be materially different because a resident actor serves its
existing projection. Sedes does not currently publish a cross-provider
performance target or claim that one sample predicts another backend, host, or
conversation.

SQL transcript mirroring could make some read patterns cheaper, but it would
not remove provider attach, live-subscription, reconciliation, or native
authority work. It would also add synchronization and correctness costs that
the current design intentionally avoids.

## Measurement methodology

Performance reports should separate cold attachment from warm reuse and record
enough context to compare like with like.

1. Record the Sedes commit or version, backend, provider version, configured
   topology, and whether the provider process/store is local or remote.
2. Record approximate thread age, turn count, item count, and native store size
   when available. Do not include transcript content, credentials, private
   paths, provider-native IDs, or private hostnames in a public report.
3. Measure a warm resident thread first if that is the slow interaction being
   reported.
4. Restart Sedes immediately before the first sample only when a guaranteed
   cold runtime attach is the subject of the measurement.
5. Run at least three read-only samples against the same thread and server:

   ```sh
   npm run measure:thread -- THREAD_ID --repeats=3 \
     --url=http://127.0.0.1:4784
   ```

6. Report the application session measurement, each thread
   `headersMilliseconds` and `snapshotMilliseconds` value, received bytes, and
   normalized turn/item counts. Do not collapse a cold first sample and warm
   later samples into one unexplained average. The JSON also contains the Sedes `threadId` and
   `baseUrl`; redact the thread ID and any non-loopback or private URL before
   posting raw output publicly.
7. When browser-perceived latency remains larger than the first-snapshot time,
   use the bounded diagnostics in [Debug diagnostics](../developer/diagnostics.md)
   to distinguish provider/runtime, transfer/parse, client-store, and
   render/paint time.

`measure:thread` stops after the first SSE snapshot or current checkpoint and
does not send provider input. A checkpoint measures delivery of the current
retained projection; mutation authority still requires the following
`thread-live` frame. This script does not measure that final live transition or
browser rendering. It is a focused diagnostic, not a standardized benchmark: it
does not define acceptance thresholds, simulate a fresh provider account, or
make different threads and machines directly comparable.

## Rejected alternative: a canonical SQL transcript

Sedes could ingest provider history into SQL and make that copy canonical for
the UI. That approach was rejected for the current architecture because it
would require:

- a durable mapping for every provider-native identity and event shape;
- atomicity or reconciliation across SQL and provider side effects;
- rules for native edits, compaction, forks, out-of-band activity, and partial
  or paginated history;
- migrations for both Sedes and provider transcript evolution;
- a conflict policy whenever the SQL copy and provider store disagree; and
- an export/import boundary before the provider's existing conversation could
  be used by native tooling and Sedes at different times, or otherwise within
  the backend's documented locking rules.

Those costs may be justified for a different product whose primary authority
is its own collaborative conversation service. They do not fit Sedes' current
role as a personal ADE layered over provider-owned coding-agent systems.

## Design invariants

- Provider-native identity and transcript remain provider/backend authority.
- `overlay.sqlite` is a durable application overlay and recovery/correlation
  store, not an independent canonical transcript.
- One resident projection generation owns normalized transcript state for an
  active Sedes thread; the browser never does.
- Initial history and live observation form one coherent, gap-free generation.
- History, replay, and browser projections enforce explicit turn, item, byte,
  and retention bounds appropriate to the backend.
- Unknown delivery outcomes remain unresolved until exact evidence proves a
  safe classification; overlay records never manufacture provider history.
- Same-session concurrency is supported only when the backend explicitly
  defines and tests it.
- Backups cover Sedes application state and provider-owned state separately.

For the broader ownership and lifecycle map, read
[Architecture](architecture.md). Backend contributors must also follow the
[Backend integration contract rules](backend-integration-contract-rules.md).
