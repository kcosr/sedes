# Native voice and direct input

The Android `NativeVoice` Capacitor plugin exposes settings, snapshots, and
actions. `NativeVoiceRuntime` owns the state machine on one handler thread.
Native snapshot version 12 includes `active.recording` (ID, Keep listening and
Reconnecting), native-authoritative `canSetKeepListening`/`canSend` actions, the
Keep listening blocked reason, and an independent `recordingRecovery` item.
Recovery exposes identity, revision, target, stage, incomplete/unrecognized
flags, eligible actions, and optional admission identity; it carries no PCM or
transcript. It remains visible when Off and across restart. Commands use the
expected connection generation plus recording ID and, for recovery, expected
recovery revision. Retarget takes the recording ID; Stop, `skipCurrentPlayback`
(Next), and `recordDuringPlayback` take the interaction ID. The required
`canRecordDuringPlayback` action combines speech-phase and local recording
readiness. The strict bridge accepts only this version. The snapshot also includes
`cleanSpeechText` and registered `clientConnectionToken` alongside `originClientId`.
The `inputDevice` preference is a nullable type/address/name identity rather than
an Android connection-local device ID. The device-owned `pinDefaultVoiceThread`
setting defaults to false; its selected default thread is scoped to the exact
Sedes profile, origin, and authenticated identity.
Pinning supplies the initial in-app target from the saved default without
falling back to another thread. The nullable native `nextRecordingTarget`
contains a thread ID/title chosen through generation-fenced
`setNextRecordingTarget`. This transient state is independent of navigation and
saved settings. Explicit start arguments take priority, then this pending
choice, then the pin/retained/foreground/default policy. In-app starts consume it
when the interaction is admitted, before asynchronous target validation. Headset
and notification Start use the pinned default, otherwise the retained voice
destination, otherwise the saved default. They ignore the foreground and preserve
the pending in-app choice. The idle notification label and open action use that
same resolver. An unpinned retained target works without a saved default; a missing
pinned default cannot fall back to another thread. Local readiness rejection
preserves the pending choice; Off and
connection changes clear it. The setter rejects an active interaction or Off.
Automatic notification replies preserve it and retain their own targets.

`retainedVoiceTarget` is nullable session state containing a thread ID, a bounded
nullable title, and a revision. Every new interaction advances its revision,
including another interaction for the same thread. Playback retains the spoken
thread; accepted follow-up validation replaces it with the actual recording
destination. Silent automatic follow-ups preserve the previous destination until
their validation is accepted. Manual and recovery activations retain their
destination, and successful retargets update it after durable acknowledgement.
Current input-context titles refresh this metadata independently of announcements. Pure
threadless notices preserve the previous ID/title while advancing the revision.
Completion, Stop, cancellation, and a drained queue preserve retention. Off,
disconnect or connection-identity changes, session teardown, service detach, and
pinning clear it. Pinning suppresses retention; unpinning during an interaction
seeds its spoken thread or accepted recording destination. Nothing is persisted to settings,
the default-thread selection, or the input journal.

Idle `releaseRetainedVoiceTarget` takes the expected connection generation and
`expectedRetainedRevision`. Native `canReleaseRetainedTarget` is independent of
capture readiness; unavailable targets remain releasable. A stale revision or
an active interaction makes release a no-op, preserving queued work, settings,
and the explicit pending app selection. An idle headset Next or notification Next
performs the same release. `idleTargetRevision` also advances on default/pin edits
and session teardown. Notification identities and extras, and headset dispatch,
capture both revisions alongside generation and interaction/recording IDs, so an
old idle Start or Next cannot act on a later idle session, even after an
idle/active/idle or same-target transition. Ordinary manual/headset starts that
match retention use fresh manual-input eligibility and activity-token validation
before and after the cue, even with announcements off. They fail on that exact
unavailable target without selecting a fallback, and preserve ordinary capture
and deferred-admission behavior while client controls reconnect.
During speech, Record cancels the current playback and reserves a new manual
recording for the spoken source thread before queued work can drain. It clears
deferred client switch actions and consumes the pending in-app choice, while
the spoken thread remains the exact destination. It validates current
`manualListenEligible`, then rechecks that eligibility and the fresh activity
token after the cue. An unavailable target ends this start without fallback.
This explicit request is independent of Auto-listen and notification policy;
it preserves queued speech. Next ends current speech and its optional follow-up,
while preserving deferred agent switch/listen actions as distinct pending work.
It signals normal reply drain, including when the skipped item was a mid-turn
progress notice. A Next captured during speech still discards that interaction's
unsent follow-up if validation, cues, recording preparation, or capture begins
before the command arrives, including a held default. It cannot cancel a new
manual Record interaction or undo an admitted input. The UI offers playback Next
during speech and a separate release Next while idle with a retained target.
Notification and headset playback Next require the null recording ID
captured before recording starts. A fresh headset Next carrying the current
recording ID leaves capture unchanged; other recording commands retain exact
recording-ID equality.
Both bridge commands reject stale
connection generations or interaction IDs. The expanded notification exposes
Record, Next, and Stop. Headset Play/Pause during speech invokes Record only
while Auto-listen is on and recording is available; otherwise it invokes Next.
Dedicated headset Next skips during speech or releases an idle retained target;
active recording retains its
existing Cancel/Stop behavior.
The device preference `announceRecordingThread` defaults to false. A new
recording start validates the exact target's normalized input context and projects
its required canonical `threadTitle` (a string up to 4,096 UTF-16 units, including
blank) into native nullable, trimmed, 512-unit target metadata without splitting
a surrogate pair. It never substitutes the spoken source thread for a different
automatic recognition destination. When enabled, a separate `announcing` phase
speaks “Replying to {title}.” before the existing recognition start cue and capture
sequence. Blank titles use “Untitled thread”; spoken titles compact whitespace
and controls and are limited to 160 Unicode code points with an ellipsis.

The announcement has its own request ID, shares the normal TTS transport and audio
owner, and waits for physical audio drain. Its total synthesis/drain deadline is
60 seconds. Failure, empty audio, Stop, Off, disconnect, provider changes, or audio
focus loss end preparation without microphone capture. Dedicated headset Next
can cancel this phase, including a manual start. A Next captured during a manual
announcement still cancels that same unsent interaction if delivered after the
cue, recording preparation, or capture begins; a fresh key carrying a recording
ID remains a no-op. The UI offers Cancel during announcement, not Record or Next.
All late speech/drain callbacks are fenced by interaction and request identity.
Manual starts that add this asynchronous phase also revalidate fresh manual-input
authority after the cue. This target revalidation is independent of client-control
registration: ordinary manual/headset and automatic recording can still capture
while client controls reconnect, with their durable input waiting for registration
before submission. Explicit Record during playback, replay, and client-initiated
starts retain their existing client-readiness checks. Announcements happen once
per user-level start, never for internal empty-transcript retries, recognition
segments, reconnects, adoption, retargeting, or saved-audio retries. Changing the
preference affects future starts without cancelling an active recording. Titles
remain display metadata and do not contribute to activity-token authority.

`NativeVoiceRuntimeService` supplies Android foreground execution and controls;
it does not run a WebView. `NativeSpeechTransport` connects directly to OpenAI
or the OpenAI-Compatible Speech Server. `NativeVoiceHttp` owns authenticated
Sedes requests and live SSE.

The native owner restores a saved active mode when authenticated connection
bootstrap completes while the app is visible, or when the activity becomes
visible after bootstrap. It requires existing microphone permission and a
configured speech provider and credential; startup does not request permission
or capture audio.
Cached settings can appear before bootstrap finishes. Resume remains unavailable
until then; mode edits are saved and start the selected mode after bootstrap.
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
With permissions already granted, an explicit enable or Resume rechecks the
current activity on the main thread before dispatch. Only a resumed, nonfinishing
activity is visible; paused, stopped, and destroyed activities clear the cached
visibility gate. A stale connection generation is rejected before this check.
The client resends its current foreground thread and composer mode after settings
writes and readiness changes, including Resume without a document visibility
event. Foreground replies change neither trigger, so a paused activity cannot
cause a retry loop.

Recognition cue PCM is generated locally. Each recognition consumes its final
result once, stops capture, and retains its active slot until completion feedback
drains. Cue callbacks are tied to that active item and a unique cue ID; cancellation
invalidates them. Cue failure or a bounded drain timeout continues the recognized
input path, while a late provider result cannot replay feedback or input. A
blank final transcript after locally detected speech re-arms the same item
after its failure cue; that pending retry remains dependent on the original
provider and current voice policy. A no-speech timeout cancels without commit
and ends the item after the failure cue, with no retry. External focus loss
cancels a pending retry without re-arming. No cue audio
or metadata is submitted to the agent.

See [Android voice](../operator/clients/voice.md) for setup, defaults, controls,
and the isolated `test:voice` lane. Backend authors must also follow the
[integration rules](backend-integration-contract-rules.md).

## Ownership and boundaries

Notification configuration, silence, deduplication, direct-input receipts,
queued inputs, and initiating client origins are tenant/principal scoped in
SQLite. Scope comes from normal authenticated request admission. The currently
single-user identity provider does not make these records installation-global.

General Android voice preferences belong to the device. `NativeVoicePreferences`
stores them in one atomic encrypted record under `native-voice-device/`, with
default-thread selections partitioned by profile ID, exact normalized server
origin, and authenticated navigation namespace. A single revision covers both
parts, so a settings mutation changes its device and connection fields atomically.
Only the exact authenticated binding's thread selection enters the runtime
snapshot. Switching connections changes that selection without resetting ordinary
preferences.

The device-wide `onlyVoiceThread` preference remains enabled across connections.
If the active binding has no default thread, automatic voice remains filtered
out, and the idle card, quick sheet, and Voice settings show the missing-thread
condition instead of reporting automatic voice ready. Manual recording remains
independently available.

Input journals and advisory speech catalogs retain their binding under
`native-voice/<SHA-256 of profile ID>/<SHA-256 of binding>/`. An Android Keystore
AES-GCM key protects atomic records in the app's backup-excluded directory;
record type and binding are authenticated associated data. Removing a profile
prunes its default-thread selections and deletes its input journals and catalogs
for every binding of that profile. Both cleanup steps are attempted even when
one fails; a device-preferences storage failure cannot prevent journal deletion.
General preferences and other profiles'
selections survive. The input journal holds at most 64 entries and 8 MiB.

A server registration supplies the shared native/WebView client ID. Paired
registrations use the authenticated management-client ID; authentication-off
registrations receive temporary server IDs. Browser and Electron windows use
the same registration API. There is no independently generated playback UUID.
An in-memory server resume secret preserves the ID across reconnects within
five minutes. Each successful reconnect refreshes the session and resumes enabled
voice/recovery work; a temporary control-channel outage clears deferred actions
without cancelling active capture or playback. Replaced paired windows stop
reclaiming the connection automatically and expose an explicit reconnect action.
Reattaching the WebView preserves the native binding during a control outage.
Inputs prepared in that live process wait for registration before transmission;
an explicit `client_registration_required` response also proves no admission
and permits retry after reconnect. Other uncertain outcomes remain read-only
recovery until the user requests Resume. Capacity failures are retryable
unavailability, distinct from connection replacement.
`X-Sedes-Client` carries an opaque connection token, checked against authenticated
scope and paired identity before the server stamps input attribution. The token
is a connection fence, not a replacement for authentication. Native and browser
registration remain live while voice is Off. Old advisory origins retained in
historical inputs do not become live client authority.

Agent `client.switch_thread` requests share the existing turn-settlement and
reply-drain queue. A background request with `listen: true` requires an already
ready native voice session and starts one recognition on the exact target;
`listen: false` remains a no-op. The runtime captures the voice-only disposition
at acceptance, so returning to the foreground cannot turn it into navigation.
That request never queues `openThread` or changes the default or pending in-app target.
Visibility changes alone do not cancel that recognition request; explicit manual
supersession, Off, expiry, and connection loss still do. Foreground navigation
keeps its visibility fence. Native readiness and recording blockers are checked
again at execution, and normal recording preferences, including Keep listening
by default, remain in effect. No background service start is attempted.
Agent `replay_turn` commands bypass that queue; see
[Turn reply replay](#turn-reply-replay).

The device preferences envelope has format version 1 and carries the strict
settings `RECORD_VERSION` 8. Older preference records reset to defaults, including
scoped default-thread selections. Separately stored device speech credentials
and version-2 dictation manifests remain readable. Restore the speech endpoint
and model settings before retrying saved audio when the provider requires them.
Earlier per-binding settings and profile-bound speech credentials are not imported;
native initialization deletes the obsolete `speech-credentials/` tree without
decoding its records. A
record that exists but cannot be authenticated, decoded, or validated is moved
aside as `<name>.corrupt` and replaced with defaults. Native reports
`voice_settings_reset` or `voice_journal_reset`. Only a
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

`SpeechCredentialStore` binds each speech credential to the provider and
normalized API endpoint, with a separate purpose and Keystore
alias from Sedes authentication. AES-GCM ciphertext lives in backup-excluded
native storage. A native masked dialog saves, tests, or removes the credential;
the WebView sees only whether one is configured. Native checks connection and
settings revisions again after the dialog and before a mutation. Changing the
provider or endpoint cannot reuse another destination's credential. Ciphertext
lives under `device-speech-credentials/`. Removing a Sedes profile does not remove
device speech credentials; the native credential dialog removes a selected key.
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

## Turn reply replay

The turn footer's speaker reads the reply text through
`GET /api/threads/:threadId/turns/:turnId/reply-speech`. That route returns the turn's stored
completion classification filtered by the principal's `assistantResultPhases`. When no
selected section has non-blank text, it returns the turn's stored whole reply as one
`unclassified` section. It returns `null` only when Sedes stored no reply text for the
turn. The WebView then sends the Copy response text as one bounded `unclassified` section.
A failed read sends nothing. The agent tool `client.replay_turn` uses the same server
selection, and fails when it returns `null`.

The user-initiated `speakReply` bridge method queues one ended turn's reply for
speech. Its strict keys are `threadId` (1–512 characters), `turnId` (1–160), an
optional `threadTitle`, and a required `assistantResult` with the same shape and
bounded-text validation as a notification's: only `provisional`, `unclassified`,
and `final`, each null or bounded text. `threadTitle` is validated like
`setForegroundContext`'s: absent, null, or a 1–512 character string. Arguments
are validated first. It then requires a started session, ready speech
configuration and credential, and a bound connection; otherwise, including with
Audio mode Off, it fails with `voice_not_ready`, whose message is "Voice is not
ready yet." Microphone permission and notification policy are not required. It
returns the published snapshot.

Native speaks the sections in notification order (provisional, unclassified,
final) with the same per-part `NativeSpeechText` cleanup and truncation notice
as a completion notice, but never a context line, whatever
`readNotificationContext` says. Empty prepared text fails with
`voice_reply_empty`. The active item's title, shown on the voice card and the
media notification, is display-only. It is the WebView's `threadTitle` when that
is not blank. Otherwise it comes from the visible foreground thread, retained
voice target, or saved default thread when one matches, and is otherwise null. The title is kept
with the stored request, so a settings rebuild keeps it.

The replay is a local queue item with no server envelope. Its event, shown as
`active.eventKind`, is `replay`. Its ID is a fresh UUID that never enters
notification deduplication. Its playback is user-requested and independent of
notification policy. At speech completion, current `autoListen` can authorize
one new recording on the replay's thread in either Manual or Response mode.
The runtime validates fresh `manualListenEligible` through `input-context`,
captures that response's activity token, and rechecks both after the start cue.
It never compares the historical replay turn with the current source turn or
uses a notification's historical activity token. Dormant and running threads
can accept a reply when current manual-input policy allows it; ordinary input
admission and the existing Queue/Steer preference remain authoritative. Invalid
current availability or changed activity before capture ends the replay without
recording. Playback remains available for unwritable threads.
The replay's target is independent of foreground/default/pinning and preserves
`nextRecordingTarget`. Auto-listen Off during validation, arming, or ordinary
capture cancels the continuation; explicit retargeting or Keep listening adopts
it under the existing manual recording rules. Late callbacks cannot reopen it.
Its identity is the thread and turn ID; a request for a turn whose speech is
already queued or playing returns the current snapshot without adding. Once
speech finishes, another replay can queue behind its follow-up recording.
It counts against the
64-item and 256 KiB queue limits after normal progress eviction. Before evicting
anything, native checks whether the replay would fit once every pending progress
item had yielded. If it would not, the request fails with `voice_queue_full` and
the queue is left unchanged; no progress is evicted for a refused replay. Queue
drop counts report automatic items only.

A replay joins the queue behind current speech, recording, or saved-recording
recovery, and plays in Manual and Response mode. Drain skips notification
eligibility for it, so `onlyVoiceThread`, `ignoreOtherDevices`, notification
enablement, silence, and policy generation do not apply. Stream loss, a policy
change, and Manual/Response switches keep pending and active replays, and a pending
replay starts once a cancelled automatic item has left; Off and connection changes
clear them with the rest of the queue. When the foreground
service stops, for example when Android destroys it while the process survives,
native cancels the active item and clears pending replays without counting
them as drops. Drain would not filter a replay later, so it would otherwise play
whenever the service next started. Pending automatic items stay queued and face
notification eligibility when drain resumes. A settings change rebuilds a
pending replay from its stored request with the current cleanup setting, and the
speech text limit chunks it when it starts. Next ends the replay's speech and
skips its follow-up; Record starts an explicit reply to its thread regardless
of Auto-listen. Stop cancels the interaction. Ending a replay never discards
client turn actions, completes a notification ID, or signals reply drain. Like
any playback, a speech configuration change or focus loss ends it, and an
explicit Stop still clears pending agent client actions.

An agent's `client.replay_turn` reaches native as a `replay_turn` client
command, whose strict keys include `turnId` and `assistantResult`. The server
resolves the tool's defaults, the source thread and its most recent ended
turn, so the command always names both. Native builds
the bridge request from the command's `threadId`, `turnId`, `assistantResult`,
and `threadTitle` alone and validates it exactly as `speakReply`'s, so a
malformed command fails with the same field code, such as `invalid_turnId`. An
expired command is a `noop` with `expired`, as for other commands. Audio mode
Off is then a `noop` with `voice_off`, checked before readiness. Otherwise the
command calls the bridge's queue function and publishes state before answering:

| Outcome | Result |
| --- | --- |
| The replay is the active item after queueing | `applied`, `replay_playing` |
| The replay waits behind other voice work | `applied`, `replay_queued` |
| That thread and turn's speech is already playing or pending | `noop`, `replay_already_queued` |
| No started session, speech not ready, or no binding | `noop`, `voice_not_ready` |
| Empty prepared text | `failed`, `voice_reply_empty` |
| The replay does not fit the queue | `failed`, `voice_queue_full` |

The command applies at once and is never staged in the turn-settlement queue.
Staging keys on the agent's source turn, so it would suppress that turn's
completion follow-up listen and replace the turn's other staged actions. The
queued item is the same local replay the speaker creates, so everything above
applies to it unchanged, and one turn's replay is a duplicate whichever path
queued it. The bridge still treats a duplicate as success.

## Activity authority and live progress

`GET /api/threads/:threadId/input-context` returns current non-attaching runtime
authority, activity token, run state, automatic- and manual-listen eligibility, and any
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
  "runningPolicy": { "mode": "queue" }
}
```

The request requires `X-Sedes-Client` from registration; a supplied `origin` body
field is rejected. Server admission adds the registered client ID to the internal
request before computing its durable receipt identity.

Steer uses `{ "mode": "steer", "target": { "kind": "turn", "turnId": "..." },
"onUnavailable": "queue" }`, or a normalized `{ "kind": "conversation" }`
target where supported. A stale valid target becomes queue delivery. It is
never silently replaced by a newer turn target. Blocking queue work, as defined
for input-context above, also queues a valid Steer. A Steer request for an
unbound thread or for a backend without Steer is rejected with
`invalid_transition`, as are unsupported target shapes. Idle delivery submits
immediately under normal backend capabilities.

Text has a 262,144-byte UTF-8 limit. The route's 2,097,152-byte JSON parser runs
before the ordinary smaller parser so JSON escaping cannot reject otherwise
valid bounded text. Both limits are enforced. Admission is serialized with
other thread mutations and rechecks runtime generation and inventory inside
the observed-runtime commit boundary. The transaction commits a principal-wide
immutable receipt with either first-send preparation or queue insertion. No
provider call is awaited inside that transaction. Unbound threads use the
ordinary creation coordinator; bound threads use the ordinary durable queue.
Neither path reads, consumes, or overwrites the composer draft.

For a bound thread, the browser presents an admitted ordinary user `submit`
as a provisional transcript message once its complete content is available.
This presentation is shared with other out-of-composer user submissions; it
does not change delivery semantics. Incomplete queue summaries are never rendered
as truncated transcript bubbles. The thread-scoped
`GET /api/threads/:threadId/queued-inputs/:queuedInputId` reads immutable full
content and retained delivery state under the authenticated principal. It is
read-only and does not attach a runtime. A missing queue row alone does not
establish acceptance or cancellation: the browser retains the provisional
message until an exact delivery-operation match or authoritative retained
state resolves it. Queue, Steer, attributed inputs, and failed or uncertain
deliveries retain their existing presentation and controls.

Local full-text presentation and **Seek on send** use the transient
`inputSubmitted` bridge event.
Only a current, uncancelled ordinary Submit from the active interaction may
emit it while its target is the visible foreground thread. The event carries
the receipt's exact operation/thread IDs, its queued-input ID when present,
the native binding/generation, and the exact finalized text from the authenticated
request before journal cleanup. Text is nonblank and bounded by the 256 KiB
direct-input limit. The event is neither journaled nor replayed, and routine
snapshots continue to omit transcript content. Native
rechecks visibility and ownership before dispatch, and the WebView rejects
stale, duplicate, unhydrated, or foreign events. Hidden Chat, targeted history,
late receipt recovery, and submissions from another device do not trigger a
seek. The handoff seeds or enriches the exact operation's complete provisional
content, including when the receipt precedes the queue event. An already
materialized or retired operation cannot be resurrected. Native content is
presentation data, not proof of provider acceptance. Typed Send and this local
event share the same animation and pinning
path, including when the user item appeared before the receipt. Routine
sending states stay internal; complete provisional bubbles have no preview label.
Unresolved delivery still carries its required indication, and failed inputs
retain their recovery controls.

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

## Recording coordinator and recovery

`NativeVoiceRecording` owns both ordinary and held dictation; there is no separate
one-recording/one-transcription path. Interaction, recording, physical capture,
segment, recognition attempt and admission mutation identities are distinct.
The audio callback feeds a bounded 64-frame/307,200-byte queue. Storage and
recognition run off the runtime actor and microphone callback. Queue overflow
stops capture and retains the accepted prefix; it never silently drops PCM.
`finishRecord` unblocks AudioRecord without invalidating its generation and
publishes capture-ended only after accepted callbacks return and hardware cleanup.
Cancel invalidates the generation instead.

The device-owned `keepListeningByDefault` setting defaults to
false and is shared by the quick sheet and Settings → Voice. Each new manual or
automatic recording freezes that preference. When enabled, durable adoption and
held capture policy must succeed before the microphone starts; unavailable
storage or a saved recording occupying the slot blocks capture. Preference
edits affect future recordings, while the infinity control changes only the
current recording. The strict settings contract requires the field.
Freezing an enabled default immediately clears automatic-policy and client-action
authority, before asynchronous preflight or adoption can race a policy change.
An unresolved retained dictation blocks default-held manual and automatic starts
before target validation or the start cue, and makes `actions.canStart` false.

The first accepted Keep listening enable adopts the complete recording,
suppresses ordinary endpoints while adoption becomes durable, and
makes automatic notification policy changes unable to cancel it. A late command
cannot revive an ended recording. Turning it off retains the audio/results and
resets ordinary speech-wait, completion, and silence clocks. Prior detected speech
or recognized text chooses the fresh clock phase. Frozen `longDictationTimeoutMs`
defaults to 3,600,000 and accepts whole minutes from 60,000 through 86,400,000.
The first adoption starts a `SystemClock.elapsedRealtime()` deadline, including
suspend; no toggle resets it. Expiration drains recognition into a retained ready
draft without admission. Recording settings edits apply to future recordings.

The voice toolbar preserves its existing 60 px row at normal text scale, including
320 px layouts. The left status icon opens the quick sheet and carries a small
caret. The title/status area opens the voice target thread; a separate chevron
opens an anchored **Choose target thread** popup for native retargeting or the
next manual recording, regardless of pinning. Choosing a target does not navigate
or save a default. Quick and full settings share its search/list presentation in
a **Default voice thread** modal or mobile sheet. On mobile, initial picker focus
stays outside its search input to avoid opening the keyboard. Infinity is a full-size button
beside the title/status area, and the right-side Cancel and Send controls are separated.
Touch regions remain distinct and at least 44 px. Reconnecting and error details
use the existing status line. An older saved draft marks the quick-controls icon
and opens the same recovery sheet without adding another row.
Idle retention adds Next before the right-aligned Start control. Releasing it
keeps that action space for the remainder of the idle interval, so Start does
not move while the target label returns to ordinary selection policy.
The title and status retain the Ready state's left alignment and gap from the
status icon when recording controls appear, including narrow layouts. The
icon-to-text gap is 8 px in every state. Input preparation, capture, recognition,
and admission reserve the Send button's space and preserve the action sizes
and right inset. Neither toggling Keep listening nor a repeated Start/Send tap
moves Cancel/Stop under the user's last tap. The extra right-gutter space is
limited to docks at most 315 px wide; 360 px phones keep their normal inset and
control gaps. Every saved-dictation stage reserves Retry and Send space so
Discard never moves into their former hit regions, and an old Retry tap cannot
navigate through the expanded title. At the narrowest width,
Retry/Resume uses its icon and the saved-state label uses the standard control
text size. Retry-to-Discard and Discard-to-Send gaps remain at least 4 px with
distinct 44 px touch targets; 360 px phones keep their normal gaps.

`NativeVoiceSegmenter` counts real 24 kHz samples and analyzes absolute 100 ms
frames. RMS 0.012 identifies likely pauses, never disposable audio. A 1,200 ms
quiet run after speech seals a segment; after `min(30 seconds, hard limit / 2)`,
200 ms quiet is sufficient. Hard limits are at most 60 seconds, rounded down to
100 ms frames against provider capacity, and must allow at least five seconds.
One second remains local for a hard cut at the lowest-energy eligible frame in
that tail, with ties choosing the latest frame. Cuts cannot retract uploaded
samples. Silence without detected speech reaches the hard limit. Every accepted
real sample belongs to exactly one segment; a short final tail is zero-padded
to 100 ms with padding tracked separately. No overlap, word deduplication, or
text rewriting is applied. Results remain verbatim in storage; assembly trims
outer whitespace per result and joins nonblank segments with one space.

Only whole-recording completion produces feedback or input. Explicit Send is
literal, including a spoken stop command, and blank Send does not rearm. Ordinary
automatic completion applies the existing whole-utterance stop-command rule and
speech-detected blank retry. Send freezes the target and waits for every accepted
sample to resolve before preparing one immutable ordinary direct input.

`NativeDictationStore` owns encrypted, backup-excluded recording files under the
profile and authenticated Sedes binding. Independent one-second PCM blocks,
checkpoint watermarks, bounded metadata, and recognized-prefix records use
AES-GCM with owner/type/identity authenticated data. The serial storage executor
orders adoption, accepted PCM, result persistence, reclamation, and tombstones.
Manifest version 2 freezes the preferred microphone identity with the recording
configuration. Encryption framing and checkpoint format remain version 1.
Older manifests are unsupported and their recordings remain unavailable, with
files preserved for explicit discard; there is no migration. Finish or copy saved
dictation before upgrading.
Successful text is durable before corresponding audio is deleted. Each recording
allows 32 MiB unresolved PCM and 128 unresolved segments; the global 64 MiB disk
budget includes ciphertext, metadata, temporary writes and reserved staging.
Complete direct input allows 256 KiB UTF-8; individual results allow 64 KiB.
Overflow retains the bounded recognized prefix and offending result for Copy
and Discard. Nothing is silently truncated to make Send succeed.

Interrupted adopted recordings release hardware and block new capture/queue drain
before admission handoff. An interruption with no retained audio samples,
recognized text or send request releases its empty slot after serialized
settlement; it reports the interruption without publishing an empty ready draft.
Audio that failed to reach storage does not keep an otherwise empty record alive
only until restart. Startup cancellation settles its never-captured journal
directly, without an intermediate interruption write.
Unreadable storage remains preserved. Restart restores only the draft and immutable admission
request; it cannot resume the microphone, recognition, or POST automatically.
Missing interior audio blocks Send. `captureIncomplete` records an abnormal end
or a storage gap; it does not prove that meaningful speech was lost. The UI
reports **Recording interrupted**. Explicit recovery Send accepts the saved
trailing boundary and durably records that intent before admission; its bridge
command has no separate acknowledgement flag. No background retry can accept it.
Key, corruption, and disk failures
preserve recording files and expose unavailable recovery, rather than resetting
them. Unknown targets are null and cannot open a thread. A bootstrap storage
failure without a recoverable item reports storage readiness with an explicit
reconnect action; it does not invent a saved-dictation phase. Profile removal
revokes its write generation before serialized deletion and reports deletion
failures even when credential cleanup succeeds.

Recognition Retry uses the frozen provider/endpoint/model and fresh effective
limits. It needs an enabled, ready voice session (including that service's
microphone permission prerequisite) but opens no microphone and sends no message.
Copy and Discard need no speech readiness. Complete recovery Send needs Sedes
admission readiness. A recognition failure after Send revokes automatic admission,
even when recognition later succeeds; the user presses Send again.
Normal finish intents (Send, automatic completion, and Retry) are not presented
as failure reasons. The original live Send keeps its live controls, including
Stop during admission; an active recovery Retry or Send uses the recovery controls.

**Add to composer** explicitly reads recognized text through
`readRecognizedRecordingText`. Native checks the connection generation, binding,
recording ID and recovery revision before and after the storage read. Text is
returned only by this command, never by routine state snapshots. The client
opens the original thread and waits for its active composer, cancelling stale
handoffs and timing out a view that never finishes loading, reconnecting or
navigating back from a historical turn. Known read-only, archived, unavailable or recovery views refuse the
handoff immediately with guidance. That composer appends to its
current local draft, retaining skill, attachments and context, and rejects an
oversized result without truncation. Draft adoption updates the current values
before registration can accept a waiting handoff. Its existing autosave owns persistence;
the native recovery item is retained. A successful insertion is remembered for
that recording revision in the current voice store, preventing repeated taps
from appending duplicates. Connection changes invalidate pending handoffs.

The recording and final-input journal merge into one recovery item as soon as
an immutable mutation is allocated. Adopted input entries independently authenticate
their recording ID, preserving ownership if the recording manifest becomes unreadable.
Startup checks the recording, mutation, target, and request identities and repairs
a crash between journal save and handoff before publishing state. Generic
`resumeInput`/`discardInput` reject a recording-owned mutation with
`recording_recovery_required`. Recovery
Send first looks up the receipt and reuses the immutable request only when
eligible; Discard also works during an active recovery Retry or Send. It fences
matching callbacks and stops matching work, then durably records retirement
before removing the linked admission entry and recording files. Failure before
durable retirement preserves the draft for recovery. Startup completes interrupted
retirement before exposing generic recovery. A definitive pre-admission rejection
retains adopted text for Copy/Discard with Send disabled. A found receipt releases
the local recording and journal: subsequent dispatch belongs to the thread.
After handoff, uncertain admission releases the active slot for ordinary capture
and playback, while the older draft still blocks adoption of another recording.
Its callbacks cannot change a newer interaction's phase or resources. Stop during
recovered Send or recognition Retry preserves the draft; only its explicit
Discard action deletes it. First-handoff preparation excludes concurrent receipt
reconciliation. Never-adopted recordings release their spool as soon as the
durable input journal owns the request.

## Speech protocol and capability discovery

`NativeSpeechTransport` is a pure-Java OkHttp client shared by host tests and the
Android runtime. It opens `/realtime?intent=transcription` beneath the configured
API base, uses the GA session shape with PCM16LE mono at 24 kHz, and disables
provider turn detection/noise reduction. Capture starts only after the matching
`session.updated` acknowledgment. A connection is reusable across segments and
renews at a safe boundary before its monotonic lifetime expires.

At most one committed job and one following upload buffer exist on the provider.
The next buffer opens only after the previous commit acknowledgment. Match
results by connection, segment attempt and item ID, and track `previous_item_id`
within each connection. Persist commit intent before transmission; the per-job
result deadline includes the acknowledgment wait. Deltas never submit partial
input. The upload pump retains unsent PCM in the spool and pauses at the 512 KiB
WebSocket queue bound. Buffer accounting resets after acknowledged commits;
there is no ten-minute cumulative recognition cap. Synthesis keeps its separate
limits.

An adopted recording continues capture during allowlisted transient network,
timeout, model-busy and retryable provider failures. It retries unresolved work
at delays of 1, 2, 4, 8 and 16 seconds, bounded by 60 seconds from the first
failure through recovery, including handshakes. An affected prepared or committed
segment requires a durably saved matching result. When only an open upload was
affected, a ready replacement session that accepts that upload ends the episode;
the next segment boundary does not extend an already recovered outage. A fresh
connection/attempt fences stale responses. Possibly committed recognition can
repeat and incur provider cost; providers offer no durable recognition receipt
or idempotent replay key. Already resolved audio is never replayed. Permanent
failure, exhausted recovery, configuration or queue/storage failure interrupts
capture and retains the draft. Never-adopted recordings use ordinary failure
behavior. Transport cancellation closes the actual socket/call, including a
request waiting for headers.

`NativeSpeechCatalog` keeps advisory picker discovery separate from capture
preflight. Its encrypted one-hour cache is scoped to the binding, provider,
endpoint, credential and selected STT/TTS models. Refresh never rewrites choices,
requests microphone permission or starts capture. Authentication rejection
invalidates the catalog; temporary refresh errors retain matching choices.

Every own-server recording start and explicit recognition Retry makes a fresh
authenticated `/audio/capabilities` request. Its selected transcription entry
must include the required numeric `realtime` fields: `max_buffer_bytes`,
`max_message_bytes`, `max_output_bytes`, `idle_timeout_seconds`, and
`max_session_seconds`. Require at least 8,192 message bytes, 524,288 output
bytes, 40 idle seconds, and five seconds of PCM after rounding. Byte limits are integers; finite positive timeout seconds may be fractional and
are conservatively rounded down to milliseconds. Buffer capacity is the
server/model effective minimum. Fresh-session timing must fit 30 seconds of
microphone arming, 1.1 seconds before the first upload, the greater of the hard
segment and full previous result deadline, a new result deadline, and a
30-second margin. Frozen capabilities, not picker data,
authorize the operation. Retry refuses immutable saved ranges that no longer fit
lowered limits.

Hosted transcription supports exactly `gpt-live-transcribe`, `gpt-transcribe`,
`gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, and `whisper-1`. Each start/Retry
opens and validates a fresh configured session without depending on `/models`.
The hosted policy uses at most 60-second segments and a one-hour session ceiling.
A valid upgrade Date and session expiry establish a conservative monotonic
deadline; own-server deadlines use the advertised lifetime from the instant
before connection creation. Lifetime checks use an injected suspend-inclusive
clock and leave enough time for committed and buffered work. Model-list hints
cannot authorize unlisted models or substitute missing expiry information.

Fixture coverage does not establish live provider compatibility or segmentation
quality. The default and every enabled hosted model require real repeated-commit,
Date/expiry, session-renewal and audio-corpus validation before release, including
quiet speech, names, repeated words, long pauses and forced boundaries. Do not
work around failed validation with transcript deduplication or disabled default
voice.

## Audio output and focus

`NativeSpeechText` converts each complete notification part from CommonMark/GFM
to speech text before assembly and request chunking. Context, result sections,
and truncation notices are independent documents, joined with paragraph pauses;
an unfinished code fence in one part cannot swallow another. The
device-owned `cleanSpeechText` setting defaults to true. It removes formatting delimiters,
reads link labels and image descriptions, preserves code contents and ordinary
symbols, and keeps paragraph/list pauses, ordered-list numbers, table cell
separators, checkbox meaning, and footnote contents with numbered references.
Hidden link destinations and code-fence language labels are omitted. Literal HTML
source is preserved. Parser nesting is bounded.
Disabling cleanup preserves the original single-newline assembly. Original envelopes,
transcripts, and shared backend notifications are never rewritten; the speech
server receives the prepared text without a second cleanup pass. Changing this
setting rebuilds pending utterances from their original envelopes or replay
requests and applies to future items without interrupting the active utterance.
An empty result makes no speech request and retains any eligible follow-up
listen.

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
ducking loss lowers playback volume. Every capture focus loss, including ducking,
interrupts microphone input; other playback focus loss ends playback. Adopted
recordings retain their accepted audio and results, with a best-effort failure
cue only when it can play without reclaiming lost focus. Ordinary playback or
never-adopted capture keeps its quiet external-stop behavior. Focus loss after
graceful capture finish cannot discard recognition already draining. The active
item retains its identity while automatic listening revalidates its target;
a late validation response cannot restart interrupted capture.
If usable text was already captured and only its success cue was interrupted,
the runtime continues
submitting that text exactly once. An unrelated error awaiting its failure cue
still reports that original error. Queued items retain their normal advancement
policy.

`NativeVoiceInput` stores a preferred input's type, usable stable address, and
product name. Each capture resolves it against fresh Android device enumeration;
connection-local device IDs never define the saved preference. With a stable
address, type/address must match uniquely; otherwise type/name must match uniquely.
Transient USB card addresses and redacted Bluetooth addresses are excluded.
No match or multiple matches report `microphone_device_unavailable` and retain
the preference. `inputDevicesChanged` refreshes the open picker after device
callbacks; reconnecting only affects future capture and never resumes an
interrupted recording. A null preference explicitly delegates input choice to
Android.

A Bluetooth SCO or LE input enters communication mode. On API 31 and newer,
the preference identifies the communication output. Native selects that output
and lets Android select its paired input for `VOICE_COMMUNICATION`; their
product names need not match. Before accepting audio, native verifies the
preferred output is uniquely resolved and active, the routed input has the
same Bluetooth type, and any addresses visible on both endpoints agree.
Capture then stops if the input ID or selected communication output changes.
Earlier versions start SCO and resolve the preferred input after the link is
ready. Recording waits up to five seconds for the route, then fails with
`microphone_route_failed`. Playback failures report `speech_timeout`,
`audio_focus_unavailable`, `empty_pcm_stream`, `playback_drain_timeout`, or the
fallback `playback_failed`. Capture failures report
`microphone_permission_required`, `audio_focus_unavailable`,
`microphone_device_unavailable`, `microphone_route_failed`,
`microphone_silenced`, `microphone_format_unavailable`,
`microphone_read_failed`, or the fallback `microphone_failed`. Failure to
obtain focus (`audio_focus_unavailable`) remains an error; losing focus after
acquiring it interrupts an adopted recording with recovery. Routing is monitored
on every supported API (24+): allow initial establishment, validate an explicitly
selected input, then freeze the actual route and interrupt on loss/change.
On API 29+, AudioRecordingCallback plus the initial active recording configuration
detect Android client silencing even while zero PCM continues. API 24–28 lack
that signal and retain route/focus/read/progress checks. Quiet PCM alone is not
microphone failure. Callbacks are capture-generation fenced and unregistered on
cleanup. The service renews its bounded ten-minute wake lock every five minutes
only during active capture/drain; a retained draft holds no wake lock.

Speech synthesis sends one complete bounded text chunk to `/audio/speech` and
consumes its raw 24 kHz PCM response incrementally. Outgoing transcription
buffers, request deadlines, and streamed audio bytes are bounded. The incoming
WebSocket message limit is the smaller of 512 KiB and the provider output limit,
checked before JSON parsing; OkHttp has already
buffered that message before delivering it to the listener. Local Next/Stop
intent remains authoritative even if a provider completes concurrently.
Recognition reconnection and replay follow the coordinator's bounded policy above. OkHttp may repeat a pre-upgrade WebSocket GET after HTTP 503 with
`Retry-After: 0`; no session or audio has been sent at that point.

Return to [Internals](index.md).
