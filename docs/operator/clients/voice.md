# Android voice

Android's native voice service speaks Sedes notifications and sends recognized
text directly to a thread. It owns its network connections, audio playback,
microphone capture, and input recovery while the WebView displays settings and
controls. Browser and Electron clients do not show the Voice page.

## Configure a session

1. Pair the Android app with Sedes as described in [Android](android.md).
2. Run an `agent-voice-adapter` instance on a network the device can reach. Its
   ASR and TTS providers are configured on that server. Sedes does not store
   those provider keys. Use a trusted private endpoint; the adapter is separate
   from Sedes and its address is not inferred from the Sedes connection.
3. Open **Settings → Voice**, save the adapter's HTTP or HTTPS base URL, select
   **Response**, and grant microphone access. Enable notifications for visible
   service controls. **Enable voice** selects Response; the initial mode is Off.
4. In **Settings → Notifications**, enable notifications and choose each event's
   Voice action. These are server-side settings for the current user; all Voice
   page settings are local to the Android profile and authenticated identity.

For USB development, reverse the adapter's port as well as Sedes's port with
`adb reverse tcp:PORT tcp:PORT`. No example private endpoint is built into Sedes.
The adapter URL may include a reverse-proxy path, such as
`https://voice.example/agent-voice-adapter`. HTTP media requests and the
WebSocket connection stay under that path. Query strings, fragments, and
embedded credentials are not accepted.

HTTPS adapters may use a private certificate authority installed in Android's
user certificate store. That trust is app-wide: the app also accepts such a CA
for its Sedes connections, which carry the paired credential. See
[Android HTTPS connections](android.md#connect-through-a-private-https-boundary).

The app opens without waiting for voice. While voice connects, **Settings →
Voice** shows "Connecting voice to this server…". If voice cannot connect, the
page shows the error and **Retry voice connection**. The app also retries on
its own, from 2 seconds doubling to 60 while visible, and immediately when it
resumes, becomes visible, or comes back online. Messages sent from the composer
before voice connects carry no client-origin metadata.

The status line in the Voice settings **Voice session** section reports the
first unmet requirement: the Sedes connection, voice Off, microphone
permission, an adapter URL, a service start that needs **Resume voice**, the
adapter connection, then the notification stream. **Connecting to Sedes
notifications…** appears until the server sends notification policy. **Sedes
notifications are unavailable. Explicit recording still works.** appears after
a failed stream attempt; voice keeps retrying. **Voice is ready.** requires all
of them.

| Mode | Completion | Other selected events | Explicit microphone |
| --- | --- | --- | --- |
| Off | Disabled | Disabled | Enable voice first |
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

Explicit recording uses the visible foreground thread, then the pinned
**Voice thread**, then a picker. It can target a running thread. The active
recording chip allows an explicit target change before recognition finishes.
Ordinary navigation does not change an active target. **Only play from Voice
thread** filters automatic playback; it does not change the recording target.
**Ignore voice started on other devices** filters progress and completion from
another initiating client. Steering an existing turn does not take over its
origin.

By default, recognized input queues behind a running turn. **Follow composer's
selected mode** instead captures the client-wide Queue/Steer preference when
recognition finalizes. Steer names the exact current normalized target; if it
is no longer available, or other queued input must deliver first, the input
queues. Backend support remains explicit: Codex and Pi use a turn target,
Claude and OpenCode a conversation target, and Grok has no steering. Spoken
input never edits or clears the composer draft.

The bottom voice bar appears only while voice is connected and set to Manual or
Response. It shows the recording target, phase, and the latest voice error
until your next voice action, a reconnect, voice becoming ready, or the next
interaction starting.

- **Skip** ends current speech and retains an eligible listen afterward.
- **Stop** cancels the current interaction and its automatic listen. It leaves
  other queued notices in place.
- **Off** clears queued audio, stops voice, and hides the bottom voice bar and
  service notification. Open **Settings → Voice** and select Manual or Response
  to enable voice again.
- The navigation **Silence notifications** bell cancels automatic voice work
  and silences scripts across clients. Explicit recording remains available.
- With **Recognize stop command**, only the complete utterances “stop” and
  “stop listening” are consumed locally. “Stop the server” is ordinary input.

Tapping the service notification opens the thread of the current interaction,
otherwise the visible thread or the Voice thread. Its actions are **Stop**
during an interaction, **Start** when recording can begin and a visible thread
or Voice thread is available, a mode button labelled **Manual** or **Response**
that switches to the other mode, and **Rearm on** or **Rearm off**, which
toggles Auto-listen. While speech plays, the expanded notification shows Stop,
Skip, the mode button, and Rearm.
Headset controls apply only during an active voice session. Android controls
lock-screen visibility and any promoted presentation; these are not guaranteed.
Opening the app restores the saved Manual or Response mode after its Sedes
connection is authenticated, provided microphone permission and an adapter URL
are already available. This restores readiness; it does not start recording.
An existing session continues when the app goes to the background. After a
force-stop or process exit, open the app again to restore voice; it does not
cold-start in the background. If Android rejects a service start, use
**Resume voice** in Voice settings to retry.

## Audio, queue, and recovery

The default microphone is Android's current input. Defaults are a 30-second
speech-start timeout, 60-second completion timeout, 1,200 ms end silence,
512 ms startup pre-roll, cues enabled, and 100% speech/cue gains. Input devices,
timing, cues, gain, and headset controls can be changed in Voice settings.
Microphones that share a product name are labelled with their input type and,
if still identical, a number.

Startup pre-roll warms the output only after audio has been idle. Voice holds
audio focus across consecutive speech, cues, and recording, so other media
resumes about 1.4 seconds after voice audio ends. Another app taking focus,
including the keyboard's dictation microphone, quietly ends the current speech
or recording without a red error or another listening attempt. Text already
recognized still submits if only its success tone is interrupted. A Bluetooth
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
If captured audio returns no transcript, voice plays the failure tone and
listens again. Stop, Off, an adapter change, or another app taking audio focus
cancels that pending retry.

One logical notice completes before another begins, including all speech
chunks, audio drain, recognition, and admission. Long speech is split at safe
boundaries using **Adapter text limit** (default 5,000 UTF-16 units); configure
that value no higher than the adapter's sanitizer limit. Context is spoken once.
A chunk that the adapter's sanitizer leaves empty, or that produces no audio, is
skipped and speech continues. Recognition starts after actual AudioTrack drain,
never between chunks.
Incoming PCM uses a bounded private cache file so fast synthesis can run ahead
of playback without retaining the whole recording in memory. Each adapter
request is limited to ten minutes of audio and 256 MiB of cache data. If the
duration limit is reached, reduce the adapter text limit to make smaller
requests. Completed, stopped, and failed playback removes its cache file.

The pending queue holds at most 64 items and 256 KiB of complete UTF-8 speech,
excluding the active item. Repeated attention notices with the same explicit
thread/event/subject identity may coalesce. Distinct progress and completion
items remain distinct. Overflow drops incoming progress first; other arrivals
can evict old pending progress. Dropped counts appear in Voice settings.

Recognized input is journaled atomically in encrypted, backup-excluded native
storage before sending. It carries one immutable mutation ID and original
target. When Sedes accepts it, or a later receipt read finds it, the journal
entry is removed and delivery follows the thread's normal queue. When Sedes
definitively rejects it, for example because the thread is archived or does
not support the requested Steer, the entry is removed and Voice settings
reports that it was not delivered, with Sedes's reason.

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
received.

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

The optional full-system lane clones the pinned reference adapter into a
temporary directory, installs its locked dependencies, and runs its real
provider clients against loopback ASR/TTS fixtures. It also starts real Sedes
and stock OpenCode with a loopback model fixture. It uses no live model keys.

```sh
env -u NODE_ENV npm run android:verify
env -u NODE_ENV SEDES_RUN_REAL_OPENCODE=1 \
  SEDES_VOICE_ADAPTER_REPOSITORY=/absolute/path/to/agent-voice-adapter \
  SEDES_VOICE_ANDROID_SERIAL=emulator-5580 npm run test:voice
```

Use an explicitly selected disposable emulator: this command clears Sedes app
data on that emulator between scenarios. `opencode2` must be available or set
`SEDES_REAL_OPENCODE_EXECUTABLE`. Omit `SEDES_VOICE_ANDROID_SERIAL` to run only
the server/adapter lane; Android cases are then reported as skipped. The harness
owns isolated server state and ports, removes its reverse rules and adapter
checkout, and writes logs under `test-results/voice-run-*`.

The Android lane drives the actual bundled UI and AudioTrack. Deterministic
microphone PCM replaces only the audio source for repeatability; a separate
instrumentation smoke test exercises real AudioRecord start/read/stop and
AudioTrack drain. This does not establish speech quality, physical headset
routing, or device-specific background reliability. Check those on the intended
device with real ASR/TTS providers before relying on unattended voice operation.

See [Native voice testing](../../developer/native-voice-testing.md) for emulator
setup, harness boundaries, and evidence interpretation. Return to
[Android](android.md) or [Packaged clients](index.md).
