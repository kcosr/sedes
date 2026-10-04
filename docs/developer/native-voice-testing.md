# Native voice testing

The voice harness runs real Sedes, stock OpenCode, and the pinned
`agent-voice-adapter` revision
`74b9086cdf6e9a83426432a3ac4c5398dd557130`. Only the external model, ASR,
and TTS provider endpoints are replaced with loopback fixtures. Android
instrumentation additionally provides deterministic microphone PCM and
controlled transport failures for admission recovery. It does not replace
the native queue, HTTP admission, SSE reader, adapter router, or AudioTrack.

## Prerequisites

Use Node.js 24.18 or newer and install the repository with
`env -u NODE_ENV npm ci`. Have a local clone of `agent-voice-adapter` containing
the pinned commit. The harness makes an independent temporary clone and runs
its locked dependency install; it does not modify the supplied checkout.
`opencode2` 2.0.18 must be on PATH, or set
`SEDES_REAL_OPENCODE_EXECUTABLE` to that executable.

For Android, follow the JDK 21 and SDK 36 setup in
[Android](../operator/clients/android.md), including `ANDROID_HOME`. Install
an emulator and a suitable system image using Android's SDK manager. For
example, an x86_64 Linux development host can use:

```sh
sdkmanager 'emulator' 'system-images;android-36;google_apis;x86_64'
avdmanager create avd --name sedes_voice_test \
  --package 'system-images;android-36;google_apis;x86_64'
emulator -avd sedes_voice_test -port 5580 -no-window -no-snapshot \
  -gpu swiftshader -camera-back none -camera-front none
adb -s emulator-5580 shell getprop sys.boot_completed
```

Wait for `sys.boot_completed` to return `1`. On a host without usable hardware
acceleration, `-accel off` permits a software attempt but can be very slow.
Do not use `-no-audio` when checking real audio initialization. Keep each
concurrent invocation on its own disposable emulator and explicit serial.

## Run the lanes

The server/adapter lane requires no emulator and makes no live model calls:

```sh
env -u NODE_ENV SEDES_RUN_REAL_OPENCODE=1 \
  SEDES_VOICE_ADAPTER_REPOSITORY=/absolute/path/to/agent-voice-adapter \
  npm run test:voice
```

Android cases are explicitly skipped when no serial is supplied. Build the
current app and instrumentation, then run all cases:

```sh
env -u NODE_ENV npm run android:verify
env -u NODE_ENV SEDES_RUN_REAL_OPENCODE=1 \
  SEDES_VOICE_ADAPTER_REPOSITORY=/absolute/path/to/agent-voice-adapter \
  SEDES_VOICE_ANDROID_SERIAL=emulator-5580 npm run test:voice
```

The harness requires an emulator and clears `dev.sedes.local` application data
between scenarios. It installs the APKs under `android/app/build/outputs/apk`,
creates isolated authenticated Sedes state, pairs through the bundled UI, and
reverses only its two ephemeral server ports. The pinned adapter cannot bind
an OS-assigned port, so the fixture reserves a free port, releases it, and
starts the adapter there. Readiness requires the adapter's own listening log
line for that port and a healthy response. If another process takes the port
first and the adapter reports `EADDRINUSE`, the fixture retries with a new port,
up to three attempts; any other adapter failure fails immediately.
`SEDES_ADB_EXECUTABLE` can select an adb executable. Run one focused scenario with Vitest's `-t` option through
the same npm command, for example `npm run test:voice -- -t 'Android response/cycle'`.

## Coverage and evidence

JVM checks verify the rising start, single success, and descending failure cue
PCM. Native runtime checks exercise final-result deduplication, cue failure and
timeout, explicit Stop, Off/disconnect cancellation, frozen Queue/Steer choice,
and adapter loss after recognition. They also cover definitive admission
rejection, release of an uncertain input into read-only reconciliation with
backoff, Discard of an uncertain or in-flight input, explicit Resume as the only
resend, rejected arguments that change no state, adapter reconnect backoff,
an adapter URL change that keeps an admitted input, and skipped empty, blank,
or sanitizer-emptied speech chunks. Further runtime checks keep a finalized
automatic transcript through a policy change or stream loss while still
cancelling an unfinalized recording, fail a live stream without policy once
before retrying, and reconcile an admission POST that outlives a reconnect to
the same binding read-only. Those orchestration checks substitute only
cue playback to control drain callbacks; a separate AudioTrack check plays all
three real cues. Additional AudioTrack checks cover 20/140 ms speech with zero
pre-roll, a short final tail after underrun, cancellation of a stalled tail
followed by a new short stream, PCM chunks that split a sample, the
empty-stream failure code, and one audio-focus entry held across consecutive
playback until its delayed release. The cancellation fixture holds one real
AudioTrack before its first start, verifies a full buffer and blocked priming,
then checks Stop and normal replacement playback. A DEBUG-only, one-shot hook
holds that track; a played-then-paused track can still consume frames while the
mixer completes its pause transition. Cue feedback adds one bounded 15-second
timeout case to the native smoke lane. UI setup waits for enabled controls and
the saved native audio mode before checking adapter readiness.

Local submission-event checks cover exact receipt operation identity,
one-time foreground delivery, current binding/generation, cancellation,
visibility/navigation changes before callback dispatch, late journal recovery,
and WebView replacement. Client checks cover the same Send seek path for a
late native receipt, the disabled setting, other threads and hidden panels,
and routine delivery labels remaining hidden.
The packaged Manual cycle enables Seek on Send and checks the submitted row's
position and reserved space in the real WebView. The Response cycle disables
the setting and checks that no space is reserved. Both require exactly one
canonical user row for the native receipt's operation, with no routine delivery
label and the unsent composer draft preserved.

Native startup checks restore real encrypted settings through the authenticated
bootstrap and activity visibility paths. Only Android service dispatch is
substituted, to test duplicate starts, missing prerequisites, pending-launch
cancellation, profile changes, and stale failure callbacks deterministically.
They also check that a permission result delivered before resume starts the
first enable, that an enable without visibility is rejected but persisted, that
corrupt settings are quarantined without blocking the connection, and that
connectivity failures are reported separately from pairing. Store checks cover
absent records, restoring an interrupted write from its backup, quarantine of
corrupt records, unreadable records failing without discarding saved input or
credentials, and profile removal deleting only that profile's bindings.
The Manual and Response startup scenarios also configure the actual app, stop
its process, relaunch without changing settings, and run a full conversation
cycle. They verify that readiness is restored without spontaneous recording
and that the saved settings revision and client origin survive the restart.

Server/adapter checks verify capability negotiation before HTTP media calls,
actual PCM bytes and formats, multipart WAV recognition, cancellation during
ASR finalization, and new adapter identity after reconnect. Direct input
checks cover first-send binding, unchanged drafts, same-ID replay/conflict,
the content/parser limits, origin attribution, settled activity tokens, and
live notification delivery without reconnect replay. The no-replay check
reconnects, saves the notification settings again, and waits for the resulting
policy frame as a sentinel; a replayed notification on that ordered transient
lane would have to arrive before it. Integration tests add
Steer demotion behind blocking queue work, fail-closed Steer for unbound
threads and backends without Steer, first-send readiness revalidated when the
revision moves before commit, retryable 503 answers for transitional states
and definitive 400 answers for inadmissible ones, replay resuming an
interrupted first send, retry chains with their
origin and bounded diagnostics, and completion targets that survive real
replacement snapshots. Activity-service unit tests cover replacement during
settlement, failed replacement, a bounded input-context read during a
replacement, the five-second deadline, the waiter bound, close, a newer turn,
and announce-only fallback when context capture fails.
Notification tests cover a stream without a voice lane when policy cannot be
read, progress delivery and truncation, and voice context captured only after
delivery is admitted. SSE tests cover inventory staying live without a
transient lane when its subscription or policy read fails, and transient
overflow during the handshake and behind a live drain. The default suite's HTTP coverage for the direct-input
routes and the policy frame lives in `tests/integration/normalized-http-api.test.ts`:
the direct-input body limit, CSRF, and principal-wide receipts; a 500 server
fault for a stored receipt or an input-context response that fails its output
contract; the authenticated application stream's `notification_policy` frame
without a replay ID; and the upgrade clearing script selections only from
disabled settings without a script path.

Packaged Android scenarios cover Response and Manual cycles, background
operation, Skip, Stop, explicit recording retargeting, lost admission replies,
lost sends, and cancellation of uncertain submissions. The host passes each
scenario's server and adapter origins, pairing code, thread, mode, scenario,
`initialText`, and `draftText`. The device types `draftText` into the composer
before voice runs. Stop waits until the stopped item is released rather than
sleeping for a fixed time. In each recovery
scenario, the first failed reconciliation releases the active slot and leaves
one uncertain input with recording available. A lost reply is then found by
automatic reconciliation without Resume. A lost send is read automatically but
resent only through **Resume input**. A cancelled input stays read-only after
leaving and re-entering its binding, completes a read-only reconciliation
there without a second POST, and is resolved with Discard. Recovery assertions
count real model admissions and the native HTTP attempts.

Each scenario reports a `voiceResult` of observed values; the host makes the
assertions. `audioSink` is `AudioTrack` only if a playing runtime-owned track's
playback head advanced, sampled every 10 ms, and otherwise `none`.
`speechPlayback` records such playback during the speaking phase. `audioSource`
is `deterministic-pcm` when capture chunks were supplied, otherwise `none`.
`composerDraftPreserved` checks the composer text, `serverDraftPreserved` polls
Sedes for the autosaved draft, and `draftPreserved` requires both. The host
requires `audioSink: "AudioTrack"`, the deterministic source, and all three draft
results for every scenario. It requires `speechPlayback` for Response scenarios
except Stop, and confirms the server draft itself.

The device smoke lane runs `NativeVoiceStoreTest`, `ClientCredentialStoreTest`,
`NativeVoiceQueueDeviceTest`, `NativeVoiceRuntimeTest`,
`NativeVoiceStartupTest`, and `NativeVoiceAudioTest`. These cover encrypted
journal persistence, credential backup restore after an interrupted write,
payload size measured with the platform's own org.json escaping up to the exact
limit, and real AudioRecord start/read/stop plus AudioTrack drain, fast
synthesis spooling beyond two MiB, duration limits, and cache cleanup. Native
runtime tests check that Silence or a policy change during a CSRF refresh keeps
a submitted automatic admission, that Stop before or during the refresh
resolves the unadmitted input without retrying, and that explicit or retargeted
input is preserved. The deterministic PCM source is identified in each
scenario's result; it is not evidence of real microphone speech quality.

Every invocation writes `test-results/voice-run-*`, including adapter/Sedes
logs, Android instrumentation results, native screenshots, and logcat captures.
Each Android scenario also saves `android-<mode>-<scenario>-voice-diagnostics.json`
with policy, content-free notification target summaries, and input-context
observations. Failures include native state captured before cleanup and current
server input contexts, so missing recognition authority is visible directly.
Inspect both active and settled screenshots. Cleanup stops owned servers,
removes the temporary adapter clone and owned adb reverse rules, and force
stops the test app. The emulator remains caller-owned.

Also run the normal typecheck, unit/integration suite, build, browser E2E,
Android verification, and Electron verification required by `AGENTS.md`.
JVM tests separately exercise queue bounds, progress eviction/coalescing,
Unicode chunking, local stop grammar, protocol validation, and SSE parsing,
including CR-only line endings, line caps, and the `application-live`
handshake marker arriving after queued policy. They also cover payload size
measured as the server's `JSON.stringify` output, the settings record version,
adapter peer Close, HTTP status reporting and message size bound, ECMAScript
blank-text matching, definitive-rejection classification, backoff, connection
failure classification, error messages, and storage failure classification,
in which a failed authentication tag is the only decryption failure treated as
corruption. Provider lifecycle tests cover Codex, Pi, and Claude live-progress
evidence, including Pi tool-call messages that end aborted or errored and
Claude superseded tool-use groups, and confirm that Grok and OpenCode never
qualify progress. The conversation actor tests
report a replacement snapshot as pending authority and its failure as loss.
The OpenCode voice harness cannot establish those other backend paths.

Client tests cover the voice bar appearing only for a connected, enabled
session, bridge-safe thread titles, retarget labels, error persistence, the
Voice settings connecting and retry states, Discard and Resume, Resume using
refreshed native settings, recent error listing and clearing, and microphone
labels. App tests check that the application renders before voice connects,
keeps one API client while the origin changes, sends no WebView-generated
origin on Android, saves a server switch before disconnecting voice, and
removes a credential at logout even when the voice bridge fails.

Report each lane independently. An emulator boot failure, skipped Android
cases, or an unavailable OS audio device is not a passed device test. Physical
microphone/headset routing, recognition quality, screen-lock/OEM behavior,
notification promotion, and live model providers need separate acceptance on
the intended deployment. The fixture suite does not claim those properties.

See [Native voice internals](../internals/native-voice.md) and
[Android voice](../operator/clients/voice.md) for the implemented contracts.
