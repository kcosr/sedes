# Native voice and direct input

The Android `NativeVoice` Capacitor plugin exposes settings, snapshots, and
actions. `NativeVoiceRuntime` owns the state machine on one handler thread.
`NativeVoiceRuntimeService` supplies Android foreground execution and controls;
it does not run a WebView. `NativeVoiceAdapter` connects directly to the media
adapter, and `NativeVoiceHttp` owns authenticated Sedes requests and live SSE.

Recognition cue PCM is generated locally. Each recognition consumes its final
result once, stops capture, and retains its active slot until completion feedback
drains. Cue callbacks are tied to that active item and a unique cue ID; cancellation
invalidates them. Cue failure or a bounded drain timeout continues the recognized
input path, while a late adapter result cannot replay feedback or input. No cue
audio or metadata is submitted to the agent.

See [Android voice](../operator/clients/voice.md) for setup, defaults, controls,
and the isolated `test:voice` lane. Backend authors must also follow the
[integration rules](backend-integration-contract-rules.md).

## Ownership and boundaries

Notification configuration, silence, deduplication, direct-input receipts,
queued inputs, and initiating client origins are tenant/principal scoped in
SQLite. Scope comes from normal authenticated request admission. The currently
single-user identity provider does not make these records installation-global.

Android settings and recovery records bind profile ID, exact normalized server
origin, and authenticated navigation namespace. An Android Keystore AES-GCM
key protects atomic records in the app's backup-excluded directory. Record type
and binding are authenticated associated data. The advisory client-origin ID
is stable within that binding and shared with the WebView; it never authorizes
an operation. Browser origins are scoped to endpoint and identity in browser
storage. No provider identity enters the shared client protocol.

Native reads the existing credential vault directly. Plugin methods never take
a bearer token. Authenticated GETs and mutations preserve the normal endpoint
and CSRF rules. Redirects are disabled. Adapter requests use a separate client
with no Sedes credential.
Every mutating bridge command carries the caller's `expectedConnectionGeneration`;
native validates it on its owner thread, including after permission prompts.
A delayed command from an earlier profile cannot mutate the newly active one,
even if both profiles have the same settings revision.

## Transient notifications

Notification payload schema 4 includes `turn.progress`. Each event's delivery
has independent `script` and `voice` actions. `NotificationService` consumes one
scoped event identity, then dispatches the two channels independently. Voice
does not wait for script execution or share its pending capacity.

`GET /api/application/events` carries two additional named frames:

- `notification_policy`: `{ generation, settings }`.
- `notification`: `{ payload, sourceEventId, voice, generation, origin?,
  recognitionTarget?, subjectId? }`.

These frames have no SSE `id`, replay entry, projection fold, or inventory
checkpoint. Policy is subscribed and delivered before voice. Inventory snapshot
replacement cannot erase pending transient frames. The same connection's
bounded backpressure closes an unhealthy stream instead of building an
unbounded queue. Disconnecting loses notifications by design.

Every policy change increments a persisted generation; server restart also
invalidates the prior generation. Native treats a lost connection as unknown
policy, clears pending automatic work, and waits for new policy on reconnect.
It never requests missed notifications. A policy change cancels active
automatic work, including further POST attempts for an admission whose result
is uncertain; existing admissions continue read-only receipt reconciliation.
An explicit or explicitly retargeted recording remains independent. Normal
inventory clients simply ignore these named frames.

For completion notifications that precede runtime idle, `ThreadActivityService`
waits at most five seconds outside the actor/mailbox. The transient envelope
retains its original event token, policy generation, and exact subscribers.
New subscribers cannot receive an old completion. Authority loss or timeout
produces an announcement without a recognition target. A newer activity token
leaves the old target stale rather than granting access to the newer work.

## Activity authority and live progress

`GET /api/threads/:threadId/input-context` returns current non-attaching runtime
authority, activity token, run state, automatic-listen eligibility, and any
available normalized steering target. Reading it never attaches a backend.

Activity tokens are independent of inventory revisions. Admission and lifecycle
changes advance a durable activity revision. Runtime generation, authoritative
run state, terminal turn, and blocking interactions also contribute. An
authoritative terminal bookend and its matching idle settlement share one
token. Metadata-only edits do not invalidate it. Runtime eviction, restart, or
newer work prevents token reuse. Eligibility additionally checks available
workspace/project/thread state, pending queue work, and mutation recovery.

Only a provider-qualified `liveProgress` event can trigger progress. The actor
checks that the projected item is complete, nonempty provisional assistant text
on the active turn and that projection generation survived applying the event.
The manager resolves normalized identities; the notification lifecycle requires
a currently admitted Sedes submission. Item/turn identity supplies deduplication.

Codex marks completed commentary, Pi marks live tool-call message completion,
and Claude marks the completed tool-use group or its later live classification.
History replay, replacement snapshots, and terminal backfill do not carry this
provenance. Grok and OpenCode intentionally have no live-progress producer.

## Direct input admission

`POST /api/threads/:threadId/inputs` accepts one strict shape:

```json
{
  "mutationId": "a UUID",
  "text": "Recognized text",
  "origin": { "clientId": "a UUID" },
  "runningPolicy": { "mode": "queue" }
}
```

Steer uses `{ "mode": "steer", "target": { "kind": "turn", "turnId": "..." },
"onUnavailable": "queue" }`, or a normalized `{ "kind": "conversation" }`
target where supported. A stale valid target becomes queue delivery. It is
never silently replaced by a newer turn target. Unsupported target shapes fail
closed. Idle delivery submits immediately under normal backend capabilities.

Text has a 65,536-byte UTF-8 limit. The route's 524,288-byte JSON parser runs
before the ordinary smaller parser so JSON escaping cannot reject otherwise
valid bounded text. Both limits are enforced. Admission is serialized with
other thread mutations and rechecks runtime generation and inventory inside
the observed-runtime commit boundary. The transaction commits a principal-wide
immutable receipt with either first-send preparation or queue insertion. No
provider call is awaited inside that transaction. Unbound threads use the
ordinary creation coordinator; bound threads use the ordinary durable queue.
Neither path reads, consumes, or overwrites the composer draft.

`GET /api/input-receipts/:mutationId` returns `{ status: "found", receipt }` or
`{ status: "notObserved" }`. The receipt contains immutable `admittedMode`,
thread, operation, and optional queue identity alongside current dispatch mode
and status. Reusing an ID with different text, origin, policy, or target conflicts,
including when the changed target is another thread. Lookup is principal scoped.
The bounded identity proof survives queue/thread retention so an old ID cannot
create a second input elsewhere.

Origins are committed with admission. Turn attribution follows the first
normalized user item and is immutable once established; a subsequent steer
cannot transfer ownership of an active turn to another device.

## Native cancellation and recovery

Native freezes text, target, origin, and delivery policy when recognition
finalizes. It persists `prepared`, then `possiblySubmitted` before crossing the
network boundary. A response must match the same mutation and thread. Lost
responses retain the record and use read-only receipt reconciliation. Explicit
Resume may retry the same immutable request when no receipt has been observed.

Stop, Off, logout, or profile departure persist cancellation intent before any
later retry can occur. Callbacks are fenced by connection, adapter, and request
generation. Read-only reconciliation can still settle a cancelled record; a
missing receipt is not evidence that the original request cannot arrive later.
Only a new explicit Resume authorizes another POST with that same identity.

Adapter TTS completion is distinct from AudioTrack drain. A logical item stays
active through all chunks, actual drain, recognition, and input admission.
The PCM producer writes an app-private cache spool; a single 64 KiB playback pump
reads it. A request is bounded by ten minutes of PCM and 256 MiB of disk data.
Drain, cancellation, or error removes the spool, and process initialization
prunes files left by process loss without deleting other live audio owners.
The adapter's `media_stt_started` event describes ASR processing after capture, not
permission to start sending PCM. ASR cancellation uses the adapter HTTP cancel
endpoint because WebSocket cancel does not cover its finalizing state. Local
Skip/Stop intent remains authoritative even if the adapter labels late TTS
termination as completed.

Return to [Internals](index.md).
