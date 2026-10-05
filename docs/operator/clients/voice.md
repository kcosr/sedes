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
while Audio mode is Off. Basic settings stay local to the Android profile and
user. Enabling voice through an agent cannot grant Android permissions or supply
missing speech configuration; the result reports any local step still needed.

An end-interaction or thread switch waits until the reply finishes playing.
Switching can request one listen even with Auto-listen disabled, but it does not
turn voice on or change the default/pin. Manual actions, a closed or replaced
connection supersede pending actions. Actions have a 24-hour turn-completion
limit and a separate one-hour reply-playback limit after completion. Navigation
requires the app to remain in the foreground. Browser and Electron clients support
navigation and report voice controls as unavailable.

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
   Voice action. These are server-side settings for the current user; all Voice
   page settings are local to the Android profile and authenticated identity.

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
bound to its profile, provider, and API endpoint. Switching providers or
endpoints requires a credential for that destination. Removing the server
profile removes its speech credentials too.

Upgrading from an earlier native voice settings format resets local settings with
voice Off. Reconfigure the provider, endpoint, and models before enabling it again.
Separately stored speech credentials remain on the device.

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
is local to this device's profile and user, applies to queued and future speech,
and does not interrupt a reply already playing. Displayed conversations and
stored transcripts are unchanged. A reply containing only formatting can still
start an eligible follow-up listen without making a speech request.

## Targeting and controls

Automatic listening stays attached to the notification's source thread and
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

With pinning off, explicit recording uses the visible foreground thread, then the saved
**Default voice thread**, then a picker. It can target a running thread. While
voice is listening, the target picker on the voice card changes the target before
finishing starts. Pickers list the visible thread first as **This thread**;
when choosing a default, the saved thread comes first as **Current default
voice thread**. Ordinary navigation does not change an active target. **Only play
from default voice thread** filters automatic playback; choose a default first,
or automatic speech stays silent. It does not change the recording target.
**Ignore voice started on other devices** filters progress
and completion from another initiating client. Steering an existing turn does
not take over its origin.

**Pin default voice thread** supplies the initial target for new explicit
recordings, including the card, headset, and service-notification Start action.
The row's **Choose target thread** popup overrides that initial choice for the
next recording without editing the saved default. It remains available with
pinning off and survives ordinary navigation. The pending choice clears when a
manual interaction starts, on Off, or on connection change; automatic replies
retain their notification targets. A missing initial target opens the target
picker without saving a replacement default. Only **Default voice thread** in
quick or full settings edits the saved preference. Those selectors share the
popup's search and row styling in a modal/mobile sheet, with no mobile search
autofocus. Pinning does not redirect an active interaction.

The pin setting changes the device settings schema. Upgrading from an earlier
native voice build resets settings with Audio mode Off. Reconfigure the speech
provider and endpoint; separately saved credentials remain on the device.

By default, recognized input queues behind a running turn. **Follow composer's
selected mode** instead captures the client-wide Queue/Steer preference when
recognition finalizes. Steer names the exact current normalized target; if it
is no longer available, or other queued input must deliver first, the input
queues. Backend support remains explicit: Codex and Pi use a turn target,
Claude and OpenCode a conversation target, and Grok has no steering. Spoken
input never edits or clears the composer draft.

The voice card under the composer appears while voice is connected and set to
Manual or Response, and whenever the selected connection has saved dictation. Wherever no composer is shown, including read-only threads
and pages without a thread, it sits on its own with a top margin and divider.
A state tile and two lines show the card's thread and its state. The first
line always names the thread: the one being spoken, the recording target, or,
when idle, the thread a recording would use. Pinning uses the default thread;
otherwise this is the visible thread when it can record, then the default.
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

Tap the title and status area to open the voice target thread. The separate
chevron opens its target picker when changes are allowed. While listening,
choosing another recording target leaves the viewed thread unchanged. When idle,
the chevron can change the saved default when pinned or no thread is open;
it does not navigate or start recording. A finishing recording keeps its destination fixed.
On mobile, the picker does not focus its search field automatically.
Beside **Listening**, the infinity button toggles **Keep listening** for the current
recording. **Keep listening by default**, available in the quick sheet and
**Settings → Voice**, starts new manual and automatic recordings with it enabled.
The preference initially defaults to off. Changing the preference affects the
next recording; the infinity button overrides only the current recording.
The idle Start button shows infinity when that default is enabled, and a
microphone otherwise, so its icon indicates how the next recording will start.
Turn it on to keep recording through pauses;
turn it off to restore ordinary silence and completion limits with fresh clocks.
All audio and text already collected remain part of the same message. While
selected, the right-side **Send** arrow stops capture, finishes recognition, and
sends one message. The X **Cancel** discards the unsent recording. Explicit Send
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

- **Skip** ends current speech and retains an eligible listen afterward.
- **Stop** cancels the current interaction and its automatic listen. It leaves
  other queued notices in place. While the microphone is preparing, listening,
  or recognizing, Stop becomes **Cancel** and discards the recording unsent.
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
While idle, it uses the default thread when pinned; otherwise it uses the visible
thread, then the default. Its actions are **Stop** during an interaction,
**Start** when recording can begin and that target is available, a mode button labelled **Manual** or **Response**
that switches to the other mode, and **Rearm on** or **Rearm off**, which
toggles Auto-listen. While speech plays, the expanded notification shows Stop,
Skip, the mode button, and Rearm. During Keep listening, it offers **Cancel** and
**Send**. Headset pause/stop interrupts and saves an adopted recording; it never
sends it. Explicit Cancel still discards it.
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
if still identical, a number. Android detects speech and trailing silence
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
item with **Copy recognized text**. Saved dictation remains visible with voice
Off and after restarting the app. Retry recognizes only unresolved audio and
requires an enabled, configured voice session; it never opens the microphone or
sends. Sending complete text needs only the Sedes connection. An interrupted tail
may be incomplete; its toolbar Send opens the recovery controls so the missing-end
notice is visible before you explicitly accept that ending and send.
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
request cannot still commit. Removing a server profile deletes its voice
settings and saved input on this device. Saved voice records that are corrupt
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
