# Native voice testing

Voice verification has separate host transport, Sedes pipeline, Android device,
and optional live OpenAI lanes. Report each lane independently. A successful
JVM run or instrumentation compilation does not establish microphone, playback,
Keystore, service, or packaged UI behavior on Android.

The host transport lane runs the same pure Java `NativeSpeechTransport` used by
Android against a real local OpenAI-compatible speech server over HTTP and
WebSocket. The speech server supervises deterministic Python workers in place
of model inference. There is no adapter service, mock Java transport, emulator,
or live provider call in this lane.

## Prerequisites

Use Node.js 24.18 or newer, JDK 21, and Android SDK 36 as documented in
[Android](../operator/clients/android.md). Install Sedes with
`env -u NODE_ENV npm ci`. The Gradle JVM lane needs the normal native project
dependencies and generated Capacitor configuration; on a fresh checkout run
`env -u NODE_ENV npm run android:sync` first.

Use a local checkout of `openai-speech-server` containing its Realtime
transcription implementation and `scripts/test-fixture.ts`. Install its locked
dependencies with `env -u NODE_ENV npm ci`. Set
`SEDES_SPEECH_SERVER_REPOSITORY` to that checkout's absolute path. The fixture
uses the selected checkout directly and records no deployment configuration;
it neither installs dependencies nor changes the checkout. Record both source
revisions when reporting a cross-repository run.

The deterministic speech workers require Python 3, `prlimit`, and ffmpeg with
audio decoding/resampling support. Set `OPENAI_SPEECH_FFMPEG` to the absolute
ffmpeg executable when it is not `/usr/bin/ffmpeg`. A missing ffmpeg is a failed
prerequisite, not a reason to skip audio assertions. No GPU or speech model
installation is required for the fixture workers.

## Host transport lane

```sh
env -u NODE_ENV \
  SEDES_SPEECH_SERVER_REPOSITORY=/absolute/path/to/openai-speech-server \
  OPENAI_SPEECH_FFMPEG=/absolute/path/to/ffmpeg \
  npm run test:speech
```

The runner starts two speech servers on OS-assigned loopback ports with
independent fixture credentials and worker state. It invokes only
`NativeVoiceSpeechIntegrationTest` through Gradle's JVM test task. Ordinary
JVM runs skip this class unless the runner's explicit gate is set.

This lane verifies:

- Real HTTP speech streaming with byte-exact 24 kHz mono PCM16LE output and
  multiple delivery callbacks.
- A real Realtime transcription session and acknowledged configuration before
  audio append; explicit commit is required to start inference. The server
  normalizes the prerecorded 24 kHz PCM into 16 kHz worker input.
- One final result per committed recording, separate recordings, and no
  transcript replay into a new session.
- Cancellation after commit, suppression of a late result, cancellation of the
  worker, and a successful subsequent request.
- HTTP stream cancellation and failure after partial audio, without a false
  success or automatic request replay.
- Authentication failure on both HTTP and WebSocket before any worker request.
- Disposal of outstanding work when replacing the speech endpoint, with the
  replacement using an independent real server and credential.

`NativeSpeechTransportTest` supplies additional real loopback socket peers for
adversarial wire cases: session/item correlation, ignored optional events,
malformed messages and PCM, content types, arbitrary HTTP chunk boundaries,
timeouts, redirects, limits, and cancellation before response headers. These
are ordinary JVM checks. They complement the real-server lane.

The runner writes `test-results/speech-run-*` with `jvm.log`, a metadata-only
`result.json`, and local server logs. It closes owned servers and workers on
completion or failure. No transcript or credential is included in the live
smoke summary. The runner does not discover or use ambient provider keys.

## Optional live OpenAI smoke

Run this lane only when live-provider usage is explicitly authorized and a
dedicated test credential is available. Supply `SEDES_SPEECH_TEST_API_KEY`
securely in the process environment, without putting its value in command
arguments, shell history, reports, or repository files. An ambient
`OPENAI_API_KEY` is deliberately insufficient.

```sh
env -u NODE_ENV SEDES_RUN_LIVE_OPENAI_SPEECH=1 npm run test:speech -- --live
```

This uses the same Java transport with `https://api.openai.com/v1`. It makes at
most one HTTP speech request for a fixed, non-sensitive phrase, then one
Realtime transcription session using those recorded PCM bytes. It checks the
recognized phrase without printing the transcript. Audio is capped at ten
seconds, each operation has a deadline, and neither request is retried. The
live test has a 90-second overall timeout; Gradle startup has a separate bounded
runner timeout.

The defaults are `gpt-live-transcribe`, `gpt-4o-mini-tts`, and `coral`. Explicit
test-only model or voice selection is available through
`SEDES_SPEECH_TEST_STT_MODEL`, `SEDES_SPEECH_TEST_TTS_MODEL`, and
`SEDES_SPEECH_TEST_VOICE`. These values do not change saved application settings.
This smoke establishes a bounded provider contract check; it does not establish
microphone recognition quality or Android device behavior.

## Sedes pipeline and packaged Android lanes

The pipeline fixture retains real Sedes and stock OpenCode 2.0.18 with a
loopback model endpoint. Set `SEDES_REAL_OPENCODE_EXECUTABLE` if `opencode2` is
not on PATH. Its speech fixture is the same real speech server used above.

```sh
env -u NODE_ENV SEDES_RUN_REAL_OPENCODE=1 \
  SEDES_SPEECH_SERVER_REPOSITORY=/absolute/path/to/openai-speech-server \
  OPENAI_SPEECH_FFMPEG=/absolute/path/to/ffmpeg \
  npm run test:voice
```

With no explicit Android serial, device cases are skipped. The host cases
verify streamed speech bytes, Realtime session/commit/result ordering,
normalization, and Sedes direct-input admission with unchanged drafts,
same-identity receipts, live completion delivery, and no notification replay.
The application HTTP suite also covers CSRF, scope, body limits, parser bounds,
first-send readiness, queue/steer decisions, and read-only receipt recovery.

On a separate host with a disposable Android emulator, build and run:

```sh
env -u NODE_ENV npm run android:verify
env -u NODE_ENV SEDES_RUN_REAL_OPENCODE=1 \
  SEDES_SPEECH_SERVER_REPOSITORY=/absolute/path/to/openai-speech-server \
  OPENAI_SPEECH_FFMPEG=/absolute/path/to/ffmpeg \
  SEDES_VOICE_ANDROID_SERIAL=emulator-5580 npm run test:voice
```

An explicit serial is required. The harness verifies that it is an emulator,
clears `dev.sedes.local` application data between scenarios, installs the
current APKs, pairs through the bundled UI, and reverses only its owned Sedes
and speech-server ports. `SEDES_ADB_EXECUTABLE` selects adb when needed. Each
concurrent invocation must own its own disposable emulator. Do not disable
audio when checking AudioRecord or AudioTrack initialization.

The packaged setup chooses **Own speech server**, saves the endpoint, models,
and voice through Settings, then enters the fixture bearer token through the
native credential dialog. Capture receives deterministic 24 kHz PCM; speech
uses real AudioTrack. The fixture token is never entered into a WebView form.
Focus a scenario through the same coordinator, for example
`npm run test:voice -- -t 'Android response/cycle'`.

Packaged cases cover Response and Manual cycles, background operation,
restoration after process restart, Skip, Stop, recording retargeting, lost
admission replies, lost sends, and cancellation of uncertain submissions.
They preserve the unsent composer and saved server draft, count real model
admissions, and require one canonical user row for each admitted receipt.
Automatic recovery is read-only; only **Resume input** resends. Startup
restores saved settings without spontaneously recording.

Device smoke cases exercise encrypted settings and credential persistence,
backup recovery, queue limits, native runtime scheduling and cancellation,
notification/SSE lifecycle, recognition feedback cues, real AudioRecord, and
AudioTrack streaming, focus, drain, underrun, and cancellation. JVM checks
cannot execute these Android framework and Keystore paths.

Each packaged scenario reports observed `voiceResult` values to the host.
`audioSink: "AudioTrack"` requires the runtime-owned playing track's playback
head to advance. `speechPlayback` records advancement while speaking;
`audioSource: "deterministic-pcm"` identifies injected capture. The host checks
these values and both composer/server draft preservation. Injected PCM does
not establish real microphone speech quality.

Pipeline runs write `test-results/voice-run-*` with Sedes and speech-server
logs, instrumentation output, native screenshots, logcat, and content-free
voice authority diagnostics. Inspect active and settled screenshots. Cleanup
stops owned processes, removes owned adb reverse rules, and force-stops the
test app; the caller owns the emulator lifecycle.

## Verification handoff

Run the normal typecheck, unit/integration suite, build, browser E2E, Android
verification, and Electron verification required by `AGENTS.md`. State exactly
which checks ran. Instrumentation APK compilation is not a device test.
Report skipped device or live-provider lanes explicitly.

The separate Android acceptance host must verify the packaged credential
dialog, Keystore isolation and removal, provider/endpoint switching, microphone
and headset routing, audible streaming, recognition, Stop/Off, focus loss,
screen-lock behavior, foreground notification controls, process restoration,
and OEM lifecycle behavior. A live key must be entered only in the native
credential dialog. Never copy one into an instrumentation argument or fixture.

See [Native voice internals](../internals/native-voice.md) and
[Android voice](../operator/clients/voice.md) for the implemented contracts.
