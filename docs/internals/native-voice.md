# Native voice and direct input

The Android `NativeVoice` Capacitor plugin exposes settings, snapshots, and
actions. `NativeVoiceRuntime` owns the state machine on one handler thread.
`NativeVoiceRuntimeService` supplies Android foreground execution and controls;
it does not run a WebView. `NativeSpeechTransport` connects directly to OpenAI
or the OpenAI-Compatible Speech Server. `NativeVoiceHttp` owns authenticated
Sedes requests and live SSE.

The native owner restores a saved active mode when authenticated connection
bootstrap completes while the app is visible, or when the activity becomes
visible after bootstrap. It requires existing microphone permission and a
configured speech provider and credential; startup does not request permission
or capture audio.
One pending service start is allowed at a time. Each launch carries its own
identity and connection generation, with visibility rechecked before starting
the foreground service. Off and disconnect invalidate pending launches; stale
service callbacks cannot attach to a newer start. A rejected launch or a
15-second service-attachment timeout leaves
**Resume voice** available without retrying on duplicate visibility callbacks.

`MainActivity` resume, pause, and stop callbacks are the activity visibility
source. A microphone permission result, which Android delivers before resume,
also marks a started activity visible, so the first enable after a permission
prompt starts voice. A session start always enters the foreground before
checking whether the launch is stale, then stops if it is.

Recognition cue PCM is generated locally. Each recognition consumes its final
result once, stops capture, and retains its active slot until completion feedback
drains. Cue callbacks are tied to that active item and a unique cue ID; cancellation
invalidates them. Cue failure or a bounded drain timeout continues the recognized
input path, while a late provider result cannot replay feedback or input. An
uncancelled `empty_transcript` failure re-arms the same item after its failure
cue; that pending retry remains dependent on the original provider and current
voice policy. External focus loss cancels it without re-arming. No cue audio
or metadata is submitted to the agent.

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
key protects atomic records in the app's backup-excluded directory, under
`native-voice/<SHA-256 of profile ID>/<SHA-256 of binding>/`. Record type and
binding are authenticated associated data. Removing a profile deletes its
settings, origin IDs, and input journals, including recognized text, for every
binding of that profile. The input journal holds at most 64 entries and 8 MiB.
The advisory client-origin ID is stable within that binding and shared with the
WebView; it never authorizes an operation. Browser origins are scoped to
endpoint and identity in browser storage. On Android, the WebView sends no
origin until native supplies one. No provider identity enters the shared
client protocol.

The settings record carries an explicit `RECORD_VERSION` and validates strictly
against it. Version 2 replaces the adapter URL and text-limit contract with
provider, endpoint, model, voice, speed, text-limit, and result-timeout settings.
The old settings shape is not retained; an upgrade resets it with voice Off. A
record that exists but cannot be authenticated, decoded, or validated is moved
aside as `<name>.corrupt` and replaced with defaults. Native reports
`voice_settings_reset`, `voice_origin_reset`, or `voice_journal_reset`. Only a
failed authentication tag, bad framing, malformed JSON, or failed validation
counts as corruption. Any other keystore failure is retried once and then
reported as `voice_storage_unavailable`, keeping the record.
Atomic reads restore interrupted-write backups before deciding a record is
absent. Permission and other filesystem read failures preserve both voice
records and credentials; they never initialize an empty replacement record.

Native reads the existing Sedes credential vault directly. Plugin methods never
take a Sedes bearer token. Authenticated GETs and mutations preserve the normal
endpoint and CSRF rules. Speech requests use a separate client and a dedicated
speech credential; neither client follows redirects.

`SpeechCredentialStore` binds each speech credential to the device profile,
provider, and normalized API endpoint, with a separate purpose and Keystore
alias from Sedes authentication. AES-GCM ciphertext lives in backup-excluded
native storage. A native masked dialog saves, tests, or removes the credential;
the WebView sees only whether one is configured. Native checks connection and
settings revisions again after the dialog and before a mutation. Changing the
provider or endpoint cannot reuse another destination's credential. Removing a
profile also removes its speech credentials.
Every mutating bridge command carries the caller's `expectedConnectionGeneration`;
native validates it on its owner thread, including after permission prompts.
A delayed command from an earlier profile cannot mutate the newly active one,
even if both profiles have the same settings revision. Commands validate every
argument before changing state.

A failed `setConnection` reports `authentication_required` only for a 401 or an
unauthenticated status response. Network failure, a 5xx response, or a
malformed reply reports `connection_unavailable`. An unreadable credential
reports `credential_storage_unavailable`, and unreadable voice storage reports
`voice_storage_unavailable`. Credential writes and removals first disconnect
the matching voice binding on a best-effort basis; the credential operation
proceeds even if that disconnect fails or times out.

## Transient notifications

Notification payload schema 4 includes `turn.progress`. Each event's delivery
has independent `script` and `voice` actions. `NotificationService` consumes one
scoped event identity, checks that notifications are enabled and unsilenced,
and fixes the voice recipients at emission. It builds the payload, copies
assistant result text, and captures voice context only when at least one
channel can deliver. Script and voice then dispatch independently. Voice does
not wait for script execution or share its pending capacity.

Voice context capture and the strict voice-frame parse are voice-only. A
failure there skips voice and never blocks the script. `ThreadActivityService`
context capture never throws; a failure degrades to an announcement without
an origin or recognition target. A `turn.progress` payload over the 64 KiB
payload limit keeps a shortened `progress.text` with byte-limit truncation
metadata. It is dropped only if its metadata alone exceeds the limit.

`GET /api/application/events` carries two additional named frames:

- `notification_policy`: `{ generation, settings }`.
- `notification`: `{ payload, sourceEventId, voice, generation, origin?,
  recognitionTarget?, subjectId? }`.

These frames have no SSE `id`, replay entry, projection fold, or inventory
checkpoint. Policy is subscribed and delivered before voice. If policy cannot
be read at subscription, that stream carries inventory without a transient
lane and the failure is reported. Inventory snapshot replacement cannot erase
pending transient frames. Transient frames share the connection's bounded
backpressure: overflow during the handshake or behind a live drain closes the
whole stream instead of building an unbounded queue, and the client reconnects.
Disconnecting loses notifications by design. The stream writes a heartbeat
comment every 20 seconds.

Every policy change, including silencing, increments the principal's persisted
dispatch generation. Each server start also increments the generation of every
stored settings row, so a previous process's policy cannot authorize a new
native interaction. A principal with no stored settings row reports generation
0 across restarts. Its default settings have notifications disabled, and the
first save or silence change creates the row and advances the generation.

Native treats a closed stream as unknown policy. It clears queued notices,
cancels automatic work whose recognition has not finalized, forgets the last
policy generation, and waits for new policy on reconnect. It never requests
missed notifications. The server ends its inventory handshake with an
`application-live` frame, after any transient frames queued during the
handshake. If no valid policy has arrived 2 seconds after that frame, native
treats the stream as failed and reports `notification_policy_unavailable`. A
slow handshake or a silent connection is left to the 50-second read timeout, so
a half-open connection fails instead of blocking. Reconnects back off from
2 seconds, doubling to 60, and reset when policy arrives. Persistent stream
rejection or missing policy is reported once per failure streak. A policy change
likewise clears queued notices and cancels automatic work whose recognition has
not finalized. A finalized transcript, including one whose completion cue is
still playing, and input that is submitting or admitted continue. An explicit
or explicitly retargeted recording remains independent. Normal inventory
clients simply ignore these named frames.

Native measures a notification payload as the UTF-8 size of ECMAScript
`JSON.stringify` output, the server's measure, and accepts up to 65,536 bytes.

Snapshot readiness reports `notificationsConnecting` until the stream delivers
policy and `notificationsUnavailable` after a failed stream attempt. `ready`
requires known notification policy. `actions.canStart` depends only on the
session, speech configuration, permission, and settings, so explicit recording works during
a notification outage.

For completion notifications that precede runtime idle, `ThreadActivityService`
waits at most five seconds outside the actor/mailbox. Beyond 256 waiting
completions, a new one is announced without a recognition target. The transient
envelope retains its original event token, policy generation, and exact
subscribers. New subscribers cannot receive an old
completion. Waiting continues while an in-place replacement snapshot is
installed. Authority loss, a failed replacement, or timeout produces an
announcement without a recognition target. A newer activity token leaves the
old target stale rather than granting access to the newer work.

## Activity authority and live progress

`GET /api/threads/:threadId/input-context` returns current non-attaching runtime
authority, activity token, run state, automatic-listen eligibility, and any
available normalized steering target. Reading it never attaches a backend.

Activity tokens are independent of inventory revisions. Admission and lifecycle
changes advance a durable activity revision. The conversation owner's
generation, whether authority is current or being re-established, run state,
settlement, the source turn and its status, and blocking interactions also
contribute. Projection generation does not. An in-place replacement snapshot
that preserves those facts keeps the token. An input-context read during an
in-place replacement waits up to five seconds for its outcome, without
attaching or calling the provider. After an equivalent replacement it answers
with the same token and current authority; after a failed or unfinished
replacement it answers `unavailable`. A failed replacement, and recovery after
one, count as loss of authority. An authoritative terminal bookend and
its matching idle settlement share one token, including when either is observed
through a replacement snapshot. Metadata-only edits do not invalidate it.
Runtime eviction, restart, or newer work prevents token reuse. Eligibility
additionally checks available workspace/project/thread state, pending queue
work, and mutation recovery.

Steering is advertised only when admission would accept it. Pending, retrying,
dispatching, or uncertain non-Steer queue work, or any unacknowledged failure,
blocks a new Steer, and input-context then reports Steer unavailable.

Only a provider-qualified `liveProgress` event can trigger progress. The actor
checks that the projected item is complete, nonempty provisional assistant text
on the active turn and that projection generation survived applying the event.
The manager resolves normalized identities; the notification lifecycle requires
a currently admitted Sedes submission. Item/turn identity supplies deduplication.
The projector retains updates to server-private turn completion correlations
even when no visible turn field changes. Such updates produce no browser delta
but immediately become available to live-progress admission checks.

Codex marks completed commentary. Pi marks a completed assistant message that
contains a tool call and ended for tool use; an aborted or errored message is
not progress because its tools never run. Claude marks the completed tool-use
group or its later live classification. History replay, replacement snapshots,
and terminal backfill do not carry this provenance. Grok and OpenCode
intentionally have no live-progress producer.

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
never silently replaced by a newer turn target. Blocking queue work, as defined
for input-context above, also queues a valid Steer. A Steer request for an
unbound thread or for a backend without Steer is rejected with
`invalid_transition`, as are unsupported target shapes. Idle delivery submits
immediately under normal backend capabilities.

Text has a 65,536-byte UTF-8 limit. The route's 524,288-byte JSON parser runs
before the ordinary smaller parser so JSON escaping cannot reject otherwise
valid bounded text. Both limits are enforced. Admission is serialized with
other thread mutations and rechecks runtime generation and inventory inside
the observed-runtime commit boundary. The transaction commits a principal-wide
immutable receipt with either first-send preparation or queue insertion. No
provider call is awaited inside that transaction. Unbound threads use the
ordinary creation coordinator; bound threads use the ordinary durable queue.
Neither path reads, consumes, or overwrites the composer draft.

For a bound thread, the browser presents an admitted ordinary user `submit`
as a provisional transcript message instead of a queue row. This presentation
is shared with other out-of-composer user submissions; it does not require a
native bridge callback or change delivery semantics. The thread-scoped
`GET /api/threads/:threadId/queued-inputs/:queuedInputId` reads immutable full
content and retained delivery state under the authenticated principal. It is
read-only and does not attach a runtime. A missing queue row alone does not
establish acceptance or cancellation: the browser retains the provisional
message until an exact delivery-operation match or authoritative retained
state resolves it. Queue, Steer, attributed inputs, and failed or uncertain
deliveries retain their existing presentation and controls.

Local **Seek on send** uses a separate transient `inputSubmitted` bridge event.
Only a current, uncancelled ordinary Submit from the active interaction may
emit it while its target is the visible foreground thread. The event carries
the receipt's exact operation/thread IDs and the native binding/generation;
it contains no message content and is neither journaled nor replayed. Native
rechecks visibility and ownership before dispatch, and the WebView rejects
stale, duplicate, unhydrated, or foreign events. Hidden Chat, targeted history,
late receipt recovery, and submissions from another device do not trigger a
seek. Typed Send and this local event share the same animation and pinning
path, including when the user item appeared before the receipt. Routine
sending states stay internal; an incomplete preview or unresolved delivery
can still carry its required indication.

A first send to an unbound thread requires interactive presentation and the
thread's required first-submission settings, as the composer does. If the
thread revision changes between that validation and the commit, readiness and
backend validation run again, up to three attempts. A concurrent rename
therefore passes, while continued changes return a retryable 503. Once the
receipt commits, a failed provider step becomes the receipt's dispatch outcome
rather than an error response. Replaying the same mutation ID resumes that
send's unfinished creation reservation and returns the receipt. Native voice
does not replay after it has read a receipt, because it treats a `submitting`
receipt as delivered. An interrupted voice first send is therefore recovered
from the thread's first-send recovery card, like a composer first send.

Admission responses separate transient from definitive refusals:

- 503 `runtime_unavailable` with `retryable: true` means the input was not
  admitted yet and the same mutation ID can be retried. It covers a change of
  runtime authority, a transitional runtime (starting, awaiting idle, in-place
  replacement, or stopping), a thread still being created, a supported delivery
  mode that is currently unavailable (including a queue at its 500-item limit),
  and a thread revision that kept changing through three first-send validation
  attempts.
- 400 `invalid_transition` is definitive. It covers an unavailable, archived,
  or snoozed thread; an unsupported or wrong-kind Steer target; Steer to an
  unbound thread; a non-interactive thread or one without the required delivery
  mode; missing first-send settings; and a thread whose creation needs recovery.
- 409 `operation_outcome_uncertain` means an uncertain thread operation or a
  Steer awaiting materialization must be resolved first.

`GET /api/input-receipts/:mutationId` returns `{ status: "found", receipt }` or
`{ status: "notObserved" }`. The lookup is read-only. The receipt contains
immutable `admittedMode`, thread, operation, and optional queue identity
alongside current dispatch mode and status. An explicit queue retry carries the
same input forward, and the receipt reports the latest row in that retry chain.
A force-reset creation attempt reports `failed`. Diagnostics are bounded to 500
UTF-16 units without splitting a surrogate pair. A stored receipt or an
input-context response that cannot be presented is a server error, never a
client error that could read as a rejected admission. Reusing an ID with
different text, origin, policy, or target conflicts, including when the changed
target is another thread. Lookup is principal scoped. The bounded identity proof survives queue/thread retention so
an old ID cannot create a second input elsewhere.

Origins are committed with admission, and an explicit retry inherits the
original origin. Turn attribution follows the first normalized user item and is
immutable once established; a subsequent steer cannot transfer ownership of an
active turn to another device.

## Native cancellation and recovery

Native freezes text, target, origin, and delivery policy when recognition
finalizes. Blank text, using the same whitespace as ECMAScript `trim()` on the
server, is not submitted. Native persists `prepared`, then `possiblySubmitted`
before crossing the network boundary. A response must match the same mutation
and thread.

A found receipt, including one still `queued` or `submitting`, is a definitive
admission: native removes the journal entry, and dispatch belongs to the
thread. A receipt that reports failure, recovery, or cancellation is surfaced
as an error. A completed 4xx response is a definitive rejection unless it is a
401, a CSRF 403 (`csrf_token_invalid`), 408, 429, or a 409
`operation_outcome_uncertain`, which the user can resolve before an explicit
Resume. For a definitive rejection, native removes the entry, finishes the
item, and reports `input_rejected` with the server's message, bounded to 500
UTF-16 units. A transient 503 admission refusal is not a rejection; it is an
unknown outcome. A CSRF rejection refreshes the session and
resends the same request once. If cancellation intent exists by then, nothing
was admitted and the entry resolves silently.

Any other outcome is unknown and starts read-only receipt reconciliation. If
the first lookup is uncertain, native releases the active slot so queued notices
and explicit recording continue. The entry stays in recovery, and native
reports `input_outcome_uncertain` once for it. It then reads the receipt again
with backoff from 2 seconds, doubling to 60, for at most eight attempts.
Session establishment and the first policy frame of each notification stream
restart that budget. A POST that completes after a reconnect to the same
binding is reconciled read-only in the same way; another binding's entry waits
until that binding reconnects. Recovery status is `possiblySubmitted` while a POST or CSRF
refresh is in flight, `reconciling` while a receipt read is in flight, and
otherwise `uncertain`.

Native never resends automatically. Explicit Resume reads the receipt and may
resend the same immutable request when none is observed. `discardInput`
(`{ expectedConnectionGeneration, mutationId }`) cancels any in-flight POST,
CSRF refresh, or receipt read for the entry, removes it, and finishes the
active item it owned. It cannot withdraw input Sedes already received.

Stop, Off, logout, or profile departure persist cancellation intent before any
later retry can occur; a POST already in flight still reports its own outcome.
Callbacks are fenced by connection, provider configuration, and request identity. Read-only
reconciliation can still settle a cancelled record; a missing receipt is not
evidence that the original request cannot arrive later. Only a new explicit
Resume authorizes another POST with that same identity. A speech provider change
cancels only media-dependent work; a usable finalized transcript, including its
success cue, submission, or admission continues. Failure cues and pending
recognition retries are cancelled.

## Speech protocol and local recording

`NativeSpeechTransport` is a pure-Java OkHttp client shared by host tests and the
Android runtime. A recognition attempt owns one WebSocket at
`/realtime?intent=transcription` under the configured API base. It uses the GA
transcription session shape, requests mono signed PCM16 little-endian at 24 kHz,
and disables provider turn detection and noise reduction. Capture begins only
after the provider acknowledges the configuration with `session.updated`.

Android streams Base64 PCM through `input_audio_buffer.append` while
`NativeVoiceCapturePolicy` evaluates fixed 100 ms frames. Its normalized RMS
threshold is 0.012. Sample counts measure waiting for speech, maximum recording
after speech begins, and trailing silence; a separate watchdog bounds a stalled
microphone. Ending capture stops the microphone and commits once. A separate
recognition result timeout bounds processing after commit. The committed item
ID identifies the final transcription event. Optional deltas do not submit
partial input, and reconnecting never replays recorded audio.

Stop cancels the actual WebSocket or HTTP call, including a request waiting for
headers. A new attempt has a fresh request identity. There is no persistent
speech-provider socket whose connection state determines idle voice readiness.
Provider configuration and credentials are required; network/model failures
belong to individual operations and catalog requests.

`NativeSpeechCatalog` uses `/models` for OpenAI account availability hints and
maintained metadata for known model voices and controls. The server preset uses
its own `/audio/capabilities`. Model IDs stay configurable; model-list entries
alone do not establish a model's audio capabilities. Unknown or unavailable
catalog information is reported without fabricating supported controls.

## Audio output and focus

HTTP TTS completion is distinct from AudioTrack drain. A logical item stays
active through all chunks, actual drain, recognition, and input admission.
A blank chunk or a successful response that produces no audio is skipped;
speech continues and keeps the follow-up listen. Provider request failures
remain errors. The PCM producer writes an app-private cache spool; a single 64 KiB
playback pump reads it. A chunk may end inside a sample: its odd byte is carried
into the next chunk, and a trailing half sample is dropped. A request is bounded
by ten minutes of PCM and 256 MiB of disk data. Startup pre-roll applies only to
a cold start; a track opened within 1.4 seconds of earlier playback skips it.
At end of stream, bounded nonblocking silence primes the output buffer when
short audio or a final tail after underrun cannot reach Android's start threshold.
Drain waits only for the original audio frames and discards remaining silence;
the shared drain deadline and generation checks bound priming and cancellation.
Drain, cancellation, or error removes the spool, and process initialization
prunes files left by process loss without deleting other live audio owners.

Playback requests transient audio focus and capture requests exclusive
transient focus. One focus entry is held across consecutive chunks, cues, and
capture, and released 1.4 seconds after the last request ends unless another
starts. Changing between playback and capture requests the new focus before
abandoning the old entry. Callbacks from a replaced entry are ignored. A
ducking loss lowers playback volume; any other loss ends the current audio
request with `audio_focus_lost`. The runtime treats this as a quiet external
stop of the current item, without an error, failure cue, or recognition retry.
The held focus entry retains its latest request identity, so loss after capture
stops still cancels recognition waiting for its result. The active item retains
that identity while automatic listening revalidates its target, including when
cues are disabled; a late validation response cannot restart interrupted capture.
If usable text was already captured and only its success cue was interrupted,
the runtime continues
submitting that text exactly once. An unrelated error awaiting its failure cue
still reports that original error. Queued items retain their normal advancement
policy.

A Bluetooth SCO or LE input enters communication mode. On API 31 and newer,
native selects the communication device with the same type and address as the
chosen input and fails if Android refuses it; earlier versions start SCO.
Recording waits up to five seconds for the route, then fails with
`microphone_route_failed`. Playback failures report `speech_timeout`,
`audio_focus_unavailable`, `empty_pcm_stream`, `playback_drain_timeout`, or the
fallback `playback_failed`. Capture failures report
`microphone_permission_required`, `audio_focus_unavailable`,
`microphone_device_unavailable`, `microphone_route_failed`,
`microphone_limit_reached`, or the fallback `microphone_failed`. Failure to
obtain focus (`audio_focus_unavailable`) remains an error; losing focus after
acquiring it does not report an error.

Speech synthesis sends one complete bounded text chunk to `/audio/speech` and
consumes its raw 24 kHz PCM response incrementally. Outgoing transcription
buffers, request deadlines, and streamed audio bytes are bounded. The incoming
WebSocket message limit is checked before JSON parsing; OkHttp has already
buffered that message before delivering it to the listener. Local Skip/Stop
intent remains authoritative even if a provider completes concurrently.
The transport does not reconnect a transcription session or replay captured
audio. OkHttp may repeat a pre-upgrade WebSocket GET after HTTP 503 with
`Retry-After: 0`; no session or audio has been sent at that point.

Return to [Internals](index.md).
