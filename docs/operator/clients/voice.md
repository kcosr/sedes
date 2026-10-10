# Android voice

Android's native voice service speaks Sedes notifications and sends recognized
text directly to a thread. It owns its network connections, audio playback,
microphone capture, and input recovery while the WebView displays settings and
controls. Browser and Electron clients do not show the Voice page.

Speech connects directly to OpenAI through Realtime transcription and streamed
HTTP speech. For local Parakeet transcription and Kokoro speech, use the
[OpenAI-Compatible Speech Server](https://github.com/kcosr/openai-speech-server).
Model setup and server operation are documented in that repository.

## Agent controls

Enable the **Client controls** group in a thread's Agent tools settings to let
its agent inspect basic voice settings, change the mode/default voice thread,
finish an interaction without follow-up listening, or switch to another thread.
The current device is the client that started the turn. Steering from a second
device does not transfer ownership. The agent targets another listed client only
when you explicitly request it.

Registration also works when server pairing is disabled and remains connected
while Audio mode is Off. General voice preferences stay on the Android device;
the default thread stays with the selected Sedes connection and user.
Enabling voice through an agent cannot grant Android permissions or supply
missing speech configuration; the result reports any local step still needed.

An end-interaction or thread switch waits for the turn to complete and the reply
to finish playing.
Switching can request one listen even with Auto-listen disabled, but it does not
turn voice on or change the default/pin. Recording preferences, including **Keep
listening by default**, still apply.

While Android is in the background, a switch with `listen: true` can start
recognition on the requested thread if the native voice session is already ready.
It leaves the screen alone, even if you reopen the app before the request runs.
A background switch without listening does nothing. Navigation requires the app
to remain in the foreground. Manual actions and closed or replaced connections
supersede pending actions. Actions have a 24-hour turn-completion limit and a
separate one-hour reply-playback limit after completion. Browser and Electron
clients support navigation and report voice controls as unavailable.

With **Replay turn reply** ticked in the same group, the agent can queue an
ended turn's reply on the current device, as if you had tapped that turn's
**Play response aloud**. Unless you name a thread or turn, it replays the
agent's own previous reply in this thread; ask for another thread to hear its
latest reply, or for a specific earlier turn. Threads that enabled Client
controls before this tool existed get it only when you tick it. The request runs at once rather than after
the agent's turn, so the replay plays before that turn's own completion notice.
It joins the voice queue like any replay and never opens the thread. With
**Auto-listen** on, it can listen afterward for a new message to that thread;
the agent's turn keeps its normal follow-up listen. The agent
learns whether the reply is playing, queued, or already queued. While Audio
mode is Off, or voice is not ready, for example because the session needs
**Resume** or speech setup is incomplete, nothing is queued and the agent is
told which; this tool cannot turn voice on. A reply with nothing to speak or a
full queue is reported as a failure. Browser and Electron clients report voice
as unsupported.

## Configure a session

1. Pair the Android app with Sedes as described in [Android](android.md).
2. In **Settings → Voice**, choose **OpenAI** or **Own speech server**.
   OpenAI uses its hosted API; the server option uses an HTTP or HTTPS
   API base you supply, including `/v1`. The speech endpoint is separate from
   Sedes and is not inferred from the Sedes connection.
3. Save the provider key or server token in the native credential dialog.
   Models and voices load automatically. Choose the models and voice, then
   select **Manual** or **Response** and grant microphone access. Enable
   notifications for visible service controls. The initial mode is Off.
4. In **Settings → Notifications**, enable notifications and choose each event's
   Voice action. These are server-side settings for the current user. Voice
   preferences are local to the Android device and survive switching Sedes
   connections, including changing between LAN and Tailscale addresses.
   Default thread selections, active work, and recording recovery remain scoped
   to the exact connection profile, server address, and authenticated identity.

For USB development, reverse the speech server's port as well as Sedes's port with
`adb reverse tcp:PORT tcp:PORT`. No example private endpoint is built into Sedes.
The server API base may include a reverse-proxy path, such as
`https://voice.example/speech/v1`. HTTP speech requests and the transcription
WebSocket stay under that base. Query strings, fragments, and embedded
credentials are not accepted.

Direct OpenAI access requires outbound TCP 443 to `api.openai.com`, including
HTTPS requests to `/v1/models` and `/v1/audio/speech` and a secure WebSocket
upgrade at `/v1/realtime?intent=transcription`. Proxies must allow that upgrade
and the ongoing bidirectional connection. This implementation uses no UDP,
WebRTC, STUN, or TURN media transport.

HTTPS speech servers may use a private certificate authority installed in Android's
user certificate store. That trust is app-wide: the app also accepts such a CA
for its Sedes connections, which carry the paired credential. See
[Android HTTPS connections](android.md#connect-through-a-private-https-boundary).

The OpenAI preset starts with `gpt-live-transcribe`, `gpt-4o-mini-tts`, and
`coral`. Hosted recognition accepts exactly `gpt-live-transcribe`, `gpt-transcribe`,
`gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, and `whisper-1`; dated or custom
recognition IDs are unsupported. The catalog supplies availability hints and
maintained voice/control metadata. Your speech server publishes available models,
voices, controls, and required per-model Realtime limits at `/audio/capabilities`.
Upgrade it to a version publishing the `realtime` capability object before using
this client. Each recording and recognition retry reads fresh server limits;
the saved picker catalog cannot authorize capture. Failed or incompatible
capabilities report an error without starting the microphone.

The app keeps the last successful model and voice catalog on this device and
refreshes it in the background at startup and after speech configuration changes.
Opening Voice settings or enabling voice also refreshes missing or stale choices.
Use **Refresh** to pick up changes made on the server immediately. A temporary
refresh failure keeps the saved list available; changing the endpoint or
credential invalidates it. Discovery never changes the selected model or voice
and does not start recording.

Recognition model, Speech model, and Speech voice open searchable pickers; choosing
an option saves it immediately. On touch screens the options open in a scrollable
sheet. Choose **Custom…** to type an ID, then **Save**; **Cancel** leaves the saved
choice unchanged. Voice choices follow the selected speech model.

Speech credentials are stored only on this Android device, encrypted with an
Android Keystore-protected key and excluded from backups. The credential dialog
can save, test, or remove a key without returning it to the WebView. Each key is
bound to its provider and API endpoint. Switching Sedes connections preserves
that credential; switching speech providers or endpoints requires a credential
for that destination. Removing a Sedes server profile preserves device voice
preferences and speech credentials. Remove a speech credential explicitly in
the native credential dialog.

The current preference format (version 8) resets older voice preferences and
default-thread selections. Configure voice again after upgrading; separately
stored device speech keys remain available for their provider and endpoint.
Current saved dictation (manifest version 2) also remains available. Restore the
matching speech endpoint and model before retrying saved audio when needed.
Earlier per-connection preferences and profile-bound speech credentials are not
imported; obsolete profile-bound keys are deleted during initialization. Older
recording manifests remain unavailable until discarded, with their files retained.

The app opens without waiting for voice. While voice connects, **Settings →
Voice** shows "Connecting voice to this server…". If voice cannot connect, the
page shows the error and **Retry voice connection**. The app also retries on
its own, from 2 seconds doubling to 60 while visible, and immediately when it
resumes, becomes visible, or comes back online. Messages sent from the composer
before voice connects carry no client-origin metadata.

The status line in the Voice settings **Voice session** section reports the
first unmet requirement: the Sedes connection, voice Off, microphone
permission, speech configuration and a credential, a service start that needs
**Resume voice**, then the notification stream. **Connecting to Sedes
notifications…** appears until the server sends notification policy. **Sedes
notifications are unavailable. Explicit recording still works.** appears after
a failed stream attempt; voice keeps retrying. **Voice is ready.** requires all
of them.

| Mode | Completion | Other selected events | Explicit microphone |
| --- | --- | --- | --- |
| Off | Disabled | Disabled | Select Manual or Response first |
| Manual | Silent; may listen afterward | Speaks; does not listen afterward | Available |
| Response | Speaks selected text and context; may listen afterward | Speaks | Available |

Automatic recognition requires **Speak then listen**, **Auto-listen**, and a
still-current eligible target. In Manual mode only completions listen
afterward. Progress, approvals, blocking input, and nonblocking questions are
speak-only. They never answer a structured form with free text.

Fresh completion settings select Final and Unclassified response text.
Provisional is optional and can repeat live progress. Codex, Pi, and Claude
emit progress only for completed live provisional assistant items. Hydrated
history and text classified only at settlement do not produce progress. Grok
and OpenCode do not advertise this live signal; their unclassified completion
text remains available.

## Speech text

**Settings → Voice → Clean up formatting for speech** is on by default. It reads
Markdown as text, including link labels and code contents, with pauses between
paragraphs and list items. Tables use cell separators; task lists retain checked
and unchecked status. Footnote contents are read with numbered references.
Code symbols, ordinary punctuation, and literal HTML source
are preserved. Hidden link destinations and code-fence language labels are omitted.

Turn it off to send the original assembled text to the speech provider. The choice
is local to this Android device, applies to queued and future speech,
and does not interrupt a reply already playing. Displayed conversations and
stored transcripts are unchanged. A reply containing only formatting can still
start an eligible follow-up listen without making a speech request.

## Replay a reply

While voice is set to Manual or Response and speech is configured, each
finished turn's footer shows **Play response aloud**, a speaker after **Copy
response**. It is absent while voice is Off or speech setup is incomplete, and
in browser and Electron clients. Read-only and archived threads show it too.

The replay reads the turn's stored completion text in the phases that
**Response text** under **Turn completed** currently selects, as a spoken
completion would. Sedes stores that text when any turn it submitted ends,
whether it completed, failed or was interrupted. When none of the selected
phases holds text, the replay reads the turn's stored whole reply: every agent
message, bounded to 16 KiB. That happens when **Response text** selects no
phases, or when the turn has text only in unselected phases, such as only
Provisional commentary under the default Final and Unclassified selection.
A turn Sedes didn't submit has no stored text, so the button reads the same
text as **Copy response**.

If Sedes cannot return the turn's text, the button shows a failure instead of
reading different text.

A replay joins the voice queue behind current speech or recording, and starts at
once when voice is idle. The card then shows **Speaking · Replay**. It plays in
Manual and Response mode and ignores the filters for automatic playback:
notification enablement, per-event Voice actions, the Silence bell, **Only play
from default voice thread**, and **Ignore voice started on other devices**.
**Clean up formatting for speech** and the speech text limit apply. A replay
reads the reply only, without a context line whatever **Read notification
context** says. After playback, the current **Auto-listen** setting controls
whether it starts recording a new message to the replay's thread. This uses the
thread's current ability to accept ordinary input, so it can reply to an older
answer or queue a message behind a running turn. An unavailable, archived,
snoozed, read-only, or recovering target is still playable but does not start
recording. New thread activity during the start cue also prevents recording.
The default thread, pin, and viewed thread do not redirect this reply. Existing
Queue/Steer and Keep listening preferences still apply. With Auto-listen off,
replay remains speak-only. **Record** ends speech and starts an explicit reply
to that thread even with Auto-listen off; **Next** skips the speech and its
follow-up recording. **Stop** cancels the interaction and clears queued playback.
Tapping again while that
turn's speech is queued or playing adds nothing. Once speech finishes, you can
queue it again behind the reply recording. A replay counts against the queue limits; when it does not fit, the
button reports a full queue. Off and connection changes clear pending replays
with the rest of the queue; losing the notification stream, a policy change, or
switching between Manual and Response does not.

An agent can queue the same replay; see [Agent controls](#agent-controls).

## Targeting and controls

Automatic listening after a notification stays attached to its source thread and
activity token. Before opening the microphone, Sedes verifies that the thread
is idle, available, has no blocking interaction or pending input recovery, and
has not begun newer activity. A missing or stale target leaves an announcement
without recording. Notifications without client-origin metadata, such as
automation, remain eligible when explicitly configured to speak then listen.
**Automation started** set to **Speak then listen** behaves as **Speak** in
practice: any target it carries is the automation's thread while that run's
turn is still in progress, and the turn's completion makes the target stale.
Readiness follows the server's current conversation owner even when no thread
view is open. Reading readiness does not start or reconnect a conversation.

With pinning off, the idle voice bar and the next manual recording follow the
visible thread as you browse. An explicit choice in the voice target picker
takes priority. Voice also keeps the last active voice thread when playback or
recording ends in the background, including after Stop or Cancel. In-app,
headset, and notification starts use the same destination. When you leave the
app, its last idle visible destination remains selected. With no visible thread,
starts use this retained destination before the saved **Default voice thread**
or a picker.
An unavailable visible thread opens the chooser rather than redirecting to
the retained or default thread.
Recording can target a running thread. While
voice is listening, the target picker on the voice card changes the target before
finishing starts. Pickers list the visible thread first as **This thread**;
when choosing a default, the saved thread comes first as **Current default
voice thread**. Ordinary navigation does not change an active target. **Only play
from default voice thread** filters automatic playback and listening. This
preference follows the device, but each connection needs its own default thread.
Until one is selected, the idle card says **Default thread needed** and
the voice settings and quick sheet explain how to resume automatic voice.
Explicit recording remains available. The filter does not change its target.
**Ignore voice started on other devices** filters progress
and completion from another initiating client. Steering an existing turn does
not take over its origin.

**Pin default voice thread** supplies the initial target for new manual
recordings and clears the retained destination. Turning pinning off during an
interaction retains its current voice thread. Every manual Start uses an explicit
pending choice first, then the pinned default, visible thread, retained destination,
or saved default. A retained target works without a saved default; a missing pinned
default cannot redirect recording to another thread.
The row's **Choose target thread** popup overrides that initial choice for the
next recording without editing the saved default. It remains available with
pinning off and survives ordinary navigation. The pending choice clears when a
new manual recording starts, on Off, or on connection change; automatic replies
retain their notification targets. A missing initial target opens the target
picker without saving a replacement default. Only **Default voice thread** in
quick or full settings edits the saved preference. Those selectors share the
popup's search and row styling in a modal/mobile sheet, with no mobile search
autofocus. Pinning does not redirect an active interaction.

While idle and using the retained fallback, **Next**
releases that destination and returns the card to its default selection.
Next is hidden when the card already follows a visible or explicitly chosen
thread. Idle notification Next and
headset Next release the same destination. They do not record, send a message,
navigate, or edit the composer. If the retained thread becomes unavailable,
Start reports the failure and keeps that target until you release it or choose
another; it never silently records into a different thread. Retention lasts only
for the current voice session and connection. Off, a connection change, or an
ended service session clears it.

By default, recognized input queues behind a running turn. **Follow composer's
selected mode** instead captures the client-wide Queue/Steer preference when
recognition finalizes. Steer names the exact current normalized target; if it
is no longer available, or other queued input must deliver first, the input
queues. Backend support remains explicit: Codex and Pi use a turn target,
Claude and OpenCode a conversation target, and Grok has no steering. Spoken
input delivery never edits or clears the composer draft. Saved dictation can be
added to the composer explicitly through its recovery controls.

The voice card under the composer appears while voice is connected and set to
Manual or Response, and whenever the selected connection has saved dictation. Wherever no composer is shown, including read-only threads
and pages without a thread, it sits on its own with a top margin and divider.
A state tile and two lines show the card's thread and its state. The first
line always names the thread: the one being spoken, the recording target, or,
when idle, the thread a recording would use. An explicit pending selection comes
first, then the pinned default, visible thread, retained voice thread, or default.
With neither, the card asks you to choose a thread. The second line is the state: **Ready** with the mode and
Auto-listen, or the readiness text while voice is not ready; **Speaking** with
the notice kind and queued count, where a narrow card drops the kind first;
**Listening**; or the recognizing or sending phase. The card shows the latest
voice error until
your next voice action, a reconnect, voice becoming ready, or the next
interaction starting. When the voice session needs to resume, for example
after Android refuses to start it, the card reads **Voice needs to resume** and
offers **Resume**, which works like **Resume voice** in Settings. A failed
connection hides the card; **Settings → Voice** then shows the error and
**Retry voice connection**.

Tap the title and status area to open the voice target thread. The small chevron beside the title
opens its target picker when changes are allowed. While listening,
choosing another recording target leaves the viewed thread unchanged. When idle,
the chevron chooses the next recording target without changing the saved default;
it does not navigate or start recording. A finishing recording keeps its destination fixed.
On mobile, the picker does not focus its search field automatically.
The compact bar keeps its title and status beside 40 px action buttons on all
screen widths. Playback shows **Next**, **Stop**, **Record**, hiding Next when
the queue is empty and Auto-listen is off; recording shows
**Keep listening**, **Cancel**, **Send**. Idle hides unavailable Next and Stop
actions so the text can use their space. Record/Send stays at the right edge,
and microphone preparation shows progress there. The outline is blue while
speaking and red while recording.
During **Listening**, the infinity button toggles **Keep listening** for the current
recording. **Keep listening by default**, available in the quick sheet and
**Settings → Voice**, starts new manual and automatic recordings with it enabled.
The preference initially defaults to off. Changing the preference affects the
next recording; the infinity button overrides only the current recording.
The idle Start button shows infinity when that default is enabled, and a
microphone otherwise, so its icon indicates how the next recording will start.
Turn it on to keep recording through pauses;
turn it off to restore ordinary silence and completion limits with fresh clocks.
All audio and text already collected remain part of the same message. With or
without Keep listening, the right-side **Send** arrow stops capture, finishes
recognition, and sends one message. The X **Cancel** discards the unsent recording. Explicit Send
is literal, including “stop”; it does not open a review step or change the composer.
Ordinary navigation never retargets an active recording; its chevron picker does,
until finishing.

**Long dictation timeout** defaults to 60 minutes and accepts 1–1,440 whole minutes.
The value is frozen for each recording. Its clock starts the first time Keep
listening is accepted, includes screen-off time, and never resets when toggled.
At the limit, capture stops and recognition finishes into **Ready to send**;
it does not send automatically. There is no on-screen timer or live transcript.

The left status icon, marked with a small caret, opens the **Voice** sheet in
every state. The sheet has **Audio mode**, **Auto-listen**, **Keep listening by
default**, **Follow composer mode**, **Pin default voice
thread**, **Only play from default voice thread**, **Default voice thread**, and
**All voice settings**, which opens
**Settings → Voice**. The default thread can be chosen from either place.
Its status line reports readiness or the latest error, and it offers **Resume
voice** when a session needs it.

- **Record** ends current speech and starts a new reply to the spoken thread,
  even with Auto-listen off. It takes priority over queued speech and uses the
  thread's current input availability. The viewed thread, default, pin, and
  pending selection cannot redirect it. Starting consumes a pending selection.
- **Next** skips current speech and its optional follow-up recording, then
  advances to the next queued item. It preserves a separately requested agent
  thread switch or listen. A tap made during speech still cancels that reply's
  unsent recording if the microphone starts before the tap arrives. While idle,
  Next releases the retained voice destination.
- **Stop** during playback cancels the current interaction and its automatic
  listen, clears queued speech including manual replays, and cancels pending
  agent-requested voice actions. New messages can still play afterward; Stop
  does not turn voice off. While the microphone is preparing, listening, or
  recognizing, **Cancel** discards the recording unsent and preserves queued
  playback.
- **Off** clears queued audio, stops voice, and hides the service notification.
  An adopted recording is saved when interrupted by Off. The voice card stays
  visible for saved dictation; otherwise it hides unless **Show voice bar when off** is on in
  **Settings → Voice**; then the card stays dimmed with its Start button disabled,
  and its status icon still opens the Voice sheet. That choice is saved only on this
  device.
  Select Manual or Response in the Voice sheet or **Settings → Voice** to
  enable voice again. Configure the speech provider and credential first.
- The navigation **Silence notifications** bell cancels automatic voice work
  and silences scripts across clients. Explicit recording remains available.
- With **Recognize stop command**, only the complete utterances “stop” and
  “stop listening” are consumed locally. “Stop the server” is ordinary input.

Tapping the service notification opens the thread of the current interaction.
While idle, it uses the same destination as Start: explicit choice, pinned
default, visible thread, retained destination, or saved default.
Its actions are **Stop** during an interaction,
**Start** when recording can begin and that target is available, a mode button labelled **Manual** or **Response**
that switches to the other mode, and **Rearm on** or **Rearm off**, which
toggles Auto-listen. While speech plays, the expanded notification shows Record,
Next, Stop, the mode button, and Rearm. During ordinary recording, the expanded
notification shows Send, Cancel, the mode button, and Rearm. With an idle retained
destination, it shows Start, Next, the mode button, and Rearm. During Keep listening, it offers **Cancel** and
**Send**. Headset pause/stop interrupts and saves an adopted recording; it never
sends it. Explicit Cancel still discards it. During speech, headset Play/Pause
starts a reply to the spoken thread when Auto-listen is on and recording is
available; otherwise it skips the speech and follow-up. Dedicated headset Next
skips both during speech, releases an idle retained destination, and leaves an
active recording unchanged.
Neither the normal headset Play/Pause tap nor dedicated Next clears queued
playback. The explicit Stop button in the app or playback notification does.
Headset controls apply only during an active voice session. Android controls
lock-screen visibility and any promoted presentation; these are not guaranteed.
Opening the app restores the saved Manual or Response mode after its Sedes
connection is authenticated, provided microphone permission and speech
configuration are already available. This restores readiness; it does not start recording.
An existing session continues when the app goes to the background. After a
force-stop or process exit, open the app again to restore voice; it does not
cold-start in the background. If Android rejects a service start, use
**Resume** on the voice card, or **Resume voice** in the Voice sheet or Voice
settings, to retry.

## Audio, queue, and recovery

The default microphone is Android's current input. Defaults are a 30-second
speech-start timeout, 60-second maximum recording after speech starts,
60-second recognition-result timeout, 1,200 ms end silence,
512 ms startup pre-roll, cues enabled, and 100% speech/cue gains. Input devices,
timing, cues, gain, and headset controls can be changed in Voice settings.
Microphones that share a product name are labelled with their input type and,
if still identical, a number. A preferred microphone is remembered by its type
and usable device address, or by its name when no stable address is available.
The picker refreshes when devices connect or disconnect and keeps an unavailable
selection visible. Reconnecting the same headset makes it available for the next
recording even if Android assigns it a new device ID. Ambiguous matches stay
unavailable; Sedes does not silently switch to a different microphone. Choose
**System default** explicitly to let Android choose the input. Losing or changing
the route during recording still stops capture and preserves adopted dictation;
reconnecting does not resume that recording automatically.

Android detects speech and trailing silence
locally while uploading audio. Ordinary listening still ends at the configured
speech-wait, completion, or silence boundary. Keep listening suspends these
endpoints. Both modes divide audio at likely pauses and bounded hard cuts, usually
at most 60 seconds, and assemble final transcripts in order. Quiet audio is kept;
long silent thinking can still consume recognition requests. Recognition accuracy
at forced boundaries depends on the selected model. The result timeout applies
to each segment. Ordinary no-speech timeout ends without sending or restarting.

During transient recognition failures, an adopted recording keeps the microphone
open and shows **Reconnecting** while accepted audio accumulates in encrypted
local storage. Recovery is bounded to five retries and a 60-second failure window;
recognizing the same audio again can repeat provider cost. Permanent errors,
exhausted retries, or storage limits stop capture and keep any captured audio or
text as a saved draft. If an error occurs after Send, successful recognition leaves
the text ready for another explicit Send instead of submitting automatically.

Startup pre-roll warms the output only after audio has been idle. Voice holds
audio focus across consecutive speech, cues, and recording, so other media
resumes about 1.4 seconds after voice audio ends. Another app taking focus,
including the keyboard's dictation microphone, quietly ends the current speech
or ordinary recording without another listening attempt. An adopted recording
with captured audio or text is retained as saved dictation. Text already recognized
still submits if only its success tone is interrupted. A Bluetooth
headset microphone is used once Android connects its voice link; recording
waits up to 5 seconds for that route and otherwise reports that the microphone
could not be routed.

**Announce recording thread** in **Settings → Voice** is off by default. When
on, a new recording started from the headset or notification while idle begins
with “Replying to {thread title}.” using the current title of the thread that
will receive it. This also applies to a separate start just after playback ends.
In-app starts, interrupting playback to reply, and automatic follow-up recordings
skip the announcement. The initiating control determines this behavior, even if
the app is visible when a headset or notification start is used.
Long titles are shortened and blank
titles are announced as “Untitled thread”. The title finishes playing before the
usual start cue and microphone preparation. The input shows **Announcing thread…**
with **Cancel**; headset Stop or Next can cancel it too. If the announcement fails,
recording does not start. Internal recognition retries, reconnects, Keep listening,
and retargeting an existing recording do not repeat it.

**Recognition cues** plays a rising start tone, a single success tone for
recognized speech, and a descending tone for failed or empty recognition,
the spoken stop command, or an explicit Stop while recognizing. **Cue gain**
controls all three independently of speech volume. Completion tones play after
microphone capture stops. Success confirms recognition, not agent delivery;
input recovery still reports any later delivery problem. Turning voice Off or
switching connections cancels pending cues without another tone.
For ordinary automatic completion, if speech was detected but the complete
recording has a blank transcript, voice plays
the failure tone and listens again. This can repeat while speech is detected
but no transcript is returned. Stop, Off, a provider change, or another app
taking audio focus cancels that pending retry. A new attempt that reaches its
no-speech timeout ends without retrying.

One logical notice completes before another begins, including all speech
chunks, audio drain, recognition, and admission. Long speech is split at safe
boundaries using the speech text limit (default 4,096 UTF-16 units). A provider
may also enforce a token limit, so reduce the text limit if a selected model
rejects long input. Context is spoken once. Blank chunks or successful responses
that produce no audio are skipped; provider errors remain visible.
Recognition starts after actual AudioTrack drain,
never between chunks.
Incoming PCM uses a bounded private cache file so fast synthesis can run ahead
of playback without retaining the whole recording in memory. Each speech
request is limited to ten minutes of audio and 256 MiB of cache data. If the
duration limit is reached, reduce the speech text limit to make smaller
requests. Completed, stopped, and failed playback removes its cache file.

The pending queue holds at most 64 items and 256 KiB of complete UTF-8 speech,
excluding the active item. Repeated attention notices with the same explicit
thread/event/subject identity may coalesce. Distinct progress and completion
items remain distinct. Overflow drops incoming progress first; other arrivals
can evict old pending progress. Dropped counts appear in Voice settings.

Interrupted adopted recordings appear in the existing toolbar as **Saved dictation**
with their target and **Retry**/**Discard** actions. Fully recognized text appears
as **Ready to send** with **Send**/**Discard**. The status icon opens the same recovery
item in a separate section with **Copy text**, **Add to composer**, **Discard**,
and **Send**. Saved dictation remains visible with voice
Off and after restarting the app. Retry recognizes only unresolved audio and
requires an enabled, configured voice session; it never opens the microphone or
sends. Sending complete text needs only the Sedes connection. **Recording
interrupted** means capture stopped without finishing normally; it does not
assert that spoken words were lost. Once the saved audio has been transcribed,
press **Send** to submit that text. There is no additional acknowledgement checkbox.

**Add to composer** opens the recording's original thread and appends its fully
recognized text to the existing draft, preserving its text and attachments.
The composer uses its normal autosave; nothing is sent. The saved dictation
remains available until you send or discard it explicitly. The action reports
**Added to composer** and cannot add the same saved revision again while this
app session and voice connection remain open. If the combined draft exceeds the composer's limit, it stays
unchanged and **Copy text** remains available. Finish transcription before adding
an item that still has unrecognized audio.

**Discard** can also cancel an active recovery Retry or Send and delete its saved
recording. It cannot withdraw input Sedes has already received. Ordinary **Stop**
preserves saved recovery data.
An older input whose admission is uncertain stays accessible while ordinary
recording continues, but must be resolved before adopting another recording.
Use **Start new recording** in the Voice sheet when that older item permits it;
the new recording uses the normal visible/default thread selection.
With **Keep listening by default** enabled, resolve the older saved dictation
first; new manual and automatic recordings cannot start, and no start cue plays.
An interruption that leaves no saved audio or text reports its cause without
keeping an empty draft or blocking the next recording. This also applies when
the first audio buffer could not be saved; there is no empty draft to restore
after restarting the app.

Recording storage is encrypted, device-local, and excluded from backups. Each
recording permits 32 MiB of unresolved PCM and 128 unresolved segments; all
recordings together fit a 64 MiB device budget. Successfully recognized audio is
reclaimed after its text is safely saved. Reaching a limit stops and preserves
the recording. Complete messages are limited to 256 KiB of UTF-8 text; overflow
remains available through Copy and Discard, without truncation. Removing a server
profile deletes its saved recordings. Corrupt or inaccessible recording storage
is preserved and reported, never replaced with an empty draft.

Once a dictation is in the thread's input queue, text above the composer's separate
64 KiB limit cannot use **Restore to composer**. Use **Copy full text** on its
queue row to recover the complete text, including failed or not-sent input.
Copy leaves the queued input and composer unchanged; save the text before
choosing **Dismiss** if you want to keep it.

Recognized input is journaled atomically in encrypted, backup-excluded native
storage before sending. It carries one immutable mutation ID and original
target. When Sedes accepts it, or a later receipt read finds it, the journal
entry is removed and delivery follows the thread's normal queue. When Sedes
definitively rejects it, for example because the thread is archived or does
not support the requested Steer, an ordinary input entry is removed and Voice
settings reports the reason. An adopted recording retains its text for Copy or
Discard; Send is disabled for a definitive rejection.

When the outcome is unknown, such as after a lost reply or a server error,
voice reads the server receipt without resending. A temporary refusal is
handled the same way: Sedes answers 503 while the thread's runtime is starting
or changing, the thread is still being created, or its queue is full. So is a
refusal because the thread has an uncertain operation to resolve first; resolve
it in the thread, then use **Resume input**. If that is still uncertain,
voice frees itself for other notices and recording, reports the uncertain input
once, and keeps it under **Pending input recovery** in Voice settings. It keeps
checking the receipt automatically, from 2 seconds doubling to 60, up to eight
times, and starts again after reconnecting to Sedes. It never resends
automatically. **Resume input** checks again and resends the same input
identity only if Sedes has no record of it. **Discard** deletes the saved input
from this device and stops checking; it cannot withdraw input Sedes already
received. For an adopted recording, these actions are merged into its saved
dictation item: **Send** checks the receipt before any retry, and **Discard**
coordinates the recording and admission records. There is no duplicate Resume
input entry for that recording.

Once a receipt shows that Sedes has the input, voice treats it as delivered,
including a first send whose new conversation is still being created. If that
creation is interrupted, recover it from the thread's first-send recovery card,
as for a composer first send; see
[First send is uncertain](../../user/troubleshooting.md#first-send-is-uncertain).

After cancellation, logout, profile departure, or Off, recovery only reads
receipts until a new explicit **Resume input** action authorizes another
same-ID admission attempt. An absent receipt alone is not proof that an earlier
request cannot still commit. Removing a server profile deletes its default-thread
selections and saved input on this device, preserving general voice preferences
and speech credentials. Saved voice records that are corrupt
are set aside and reset to defaults, with an error naming what was reset. A
temporary Android Keystore failure keeps the saved data and reports that voice
storage is unavailable.

Voice settings lists up to three recent distinct errors. **Clear errors** hides
them on this device until a newer error occurs.

## Verification without external models

The ordinary suite covers server admission, the direct-input HTTP routes and
notification policy frame, token validity, migration, policy invalidation, live
progress, and native-state synchronization. `android:verify`
checks the exact permission/service allowlist, runs JVM tests, and builds app
and instrumentation APKs.

The host transport lane runs the Android Java transport against a real local
speech server with deterministic speech workers. Set the repository path to a
checkout containing the Realtime implementation, with its locked dependencies
installed. It requires Python 3, `prlimit`, and ffmpeg, but no GPU or live keys.

```sh
env -u NODE_ENV npm run android:verify
env -u NODE_ENV \
  SEDES_SPEECH_SERVER_REPOSITORY=/absolute/path/to/openai-speech-server \
  OPENAI_SPEECH_FFMPEG=/absolute/path/to/ffmpeg npm run test:speech
```

The full-system lane also starts real Sedes and stock OpenCode with a loopback
model fixture:

```sh
env -u NODE_ENV SEDES_RUN_REAL_OPENCODE=1 \
  SEDES_SPEECH_SERVER_REPOSITORY=/absolute/path/to/openai-speech-server \
  OPENAI_SPEECH_FFMPEG=/absolute/path/to/ffmpeg \
  SEDES_VOICE_ANDROID_SERIAL=emulator-5580 npm run test:voice
```

Use an explicitly selected disposable emulator: this command clears Sedes app
data on that emulator between scenarios. `opencode2` must be available or set
`SEDES_REAL_OPENCODE_EXECUTABLE`. Omit `SEDES_VOICE_ANDROID_SERIAL` to run only
the host lane; Android cases are then reported as skipped. The harness owns
isolated server state and ports, removes its reverse rules, and writes logs
under `test-results/voice-run-*`.

The Android lane drives the actual bundled UI and AudioTrack. Deterministic
microphone PCM replaces only the audio source for repeatability; a separate
instrumentation smoke test exercises real AudioRecord start/read/stop and
AudioTrack drain. This does not establish speech quality, physical headset
routing, or device-specific background reliability. Check those on the intended
device with real ASR/TTS providers before relying on unattended voice operation.

See [Native voice testing](../../developer/native-voice-testing.md) for emulator
setup, harness boundaries, and evidence interpretation. Return to
[Android](android.md) or [Packaged clients](index.md).
