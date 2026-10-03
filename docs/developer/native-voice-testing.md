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
reverses only its two ephemeral server ports. `SEDES_ADB_EXECUTABLE` can select
an adb executable. Run one focused scenario with Vitest's `-t` option through
the same npm command, for example `npm run test:voice -- -t 'Android response/cycle'`.

## Coverage and evidence

JVM checks verify the rising start, single success, and descending failure cue
PCM. Native runtime checks exercise final-result deduplication, cue failure and
timeout, explicit Stop, Off/disconnect cancellation, frozen Queue/Steer choice,
and adapter loss after recognition. Those orchestration checks substitute only
cue playback to control drain callbacks; a separate AudioTrack check plays all
three real cues. Additional AudioTrack checks cover 20/140 ms speech with zero
pre-roll, a short final tail after underrun, and cancellation of a stalled tail
followed by a new short stream. Cue feedback adds one bounded 15-second timeout case to the
native smoke lane.

Server/adapter checks verify capability negotiation before HTTP media calls,
actual PCM bytes and formats, multipart WAV recognition, cancellation during
ASR finalization, and new adapter identity after reconnect. Direct input
checks cover first-send binding, unchanged drafts, same-ID replay/conflict,
the content/parser limits, origin attribution, settled activity tokens, and
live notification delivery without reconnect replay.

Packaged Android scenarios cover Response and Manual cycles, background
operation, Skip, Stop, explicit recording retargeting, lost admission replies,
lost sends, and cancellation of uncertain submissions. Recovery assertions
count real model admissions and the native HTTP attempts. Separate device
tests cover encrypted journal persistence and real AudioRecord start/read/stop
plus AudioTrack drain, fast synthesis spooling beyond two MiB, duration limits,
and cache cleanup. Native runtime tests exercise Silence or policy changes
during CSRF refresh and preserve explicit/retargeted input. The deterministic
PCM source is identified in each
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
Unicode chunking, local stop grammar, protocol validation, and SSE parsing.
Provider lifecycle tests cover Codex, Pi, and Claude live-progress evidence;
the OpenCode voice harness cannot establish those other backend paths.

Report each lane independently. An emulator boot failure, skipped Android
cases, or an unavailable OS audio device is not a passed device test. Physical
microphone/headset routing, recognition quality, screen-lock/OEM behavior,
notification promotion, and live model providers need separate acceptance on
the intended deployment. The fixture suite does not claim those properties.

See [Native voice internals](../internals/native-voice.md) and
[Android voice](../operator/clients/voice.md) for the implemented contracts.
