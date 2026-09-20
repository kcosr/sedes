# Android client

Sedes includes a Capacitor 8 Android project that packages the compiled web
client from `dist/client`. It is a **buildable preview client**, not a signed
Android release. Build it from source for development or a trusted private
installation.

The WebView always loads bundled assets from the fixed `http://localhost`
application origin. It never loads the configured Sedes server as a remote page
through Capacitor `server.url` or `allowNavigation`. The server remains a
separate process. The in-app switcher remembers multiple named Direct server
connections and one selected connection.

See [Packaged clients](index.md) for the shared architecture, connection
comparison, compatibility policy, and security boundary.

## What the Android package provides

- The full responsive Sedes frontend, application terminal panes, and eligible
  Codex managed-TUI presentation.
- Multiple named HTTP or HTTPS Sedes connections, with pairing per connection.
- Android Back and keyboard behavior integrated with the mobile shell.
- The system file chooser for composer uploads, with no storage or media
  permission.
- System document-picker downloads that stream workspace files without holding
  a complete file in WebView memory.
- Bounded native copy/save actions for provider-generated PNG, JPEG, GIF, and
  WebP images.

The source manifest requests only `android.permission.INTERNET`. There is no
microphone, media, notification, foreground-service, or broad storage
permission, and the package does not contain a Sedes backend or provider
credentials.

## Saved connections and pairing

Each profile has a UUID, display name, and normalized server origin. The
selected profile and nonsecret metadata are saved in Capacitor Preferences.
Credentials are encrypted with an Android Keystore-backed AES-GCM key through
the native `ClientCredentials` bridge, keyed by profile ID and server origin.
They are never placed in Preferences, browser localStorage, or profile URLs.
If native secure storage fails, enrollment fails rather than saving plaintext.

Choose **Add & connect**, enter a name and server URL, then enter a pairing
code or the complete pairing URL on the pairing screen. Subsequent launches
reuse that connection's saved credential. **Connect** selects another profile;
**Remove** requires confirmation and clears the profile's local credential.
The old single-server preference is not imported; add existing servers again
and pair them. Android provides Direct connections only; Electron's Local and
SSH modes are not part of the Android app.

See [Pairing clients](../operations.md#pairing-clients) for code expiry,
server-side client revocation, and the distinction between removal on this
device and revocation on the server.

## Build prerequisites

- Node.js 24.18 or newer and npm 11 or newer
- JDK 21
- Android SDK Platform 36 and Build Tools 36
- Android command-line tools and platform tools
- an Android 7.0 (API 24) or newer device or emulator
- `adb` for physical-device and emulator workflows

Install the repository dependencies with `NODE_ENV` unset:

```sh
env -u NODE_ENV npm ci
```

Set `ANDROID_HOME` and `ANDROID_SDK_ROOT` if the SDK is not otherwise
discoverable. Android Studio may instead write the SDK path to the ignored
`android/local.properties` file. Do not commit that file.

The project deliberately uses the root `capacitor.config.json`. The pinned
Capacitor CLI cannot load a parallel TypeScript config with this repository's
TypeScript 7 compiler, so do not add `capacitor.config.ts`.

## First run over USB

`adb reverse` is the recommended physical-device path because Sedes can stay on
its default loopback listener.

1. In the schema-version-11 bootstrap file, admit the Android application origin:

   ```json
   "packagedClients": ["android"]
   ```

   Then build and start the server:

   ```sh
   env -u NODE_ENV npm run build
   SEDES_CONFIG_FILE=/absolute/path/to/server.json npm start
   ```

2. Connect the device, verify that `adb devices` lists it, and map the server
   port into the device:

   ```sh
   adb reverse tcp:4784 tcp:4784
   ```

3. In another terminal, build and install the debug package:

   ```sh
   env -u NODE_ENV npm run android:install:debug
   ```

   `android:run` can build, install, and launch through the Capacitor CLI.
   `android:open` synchronizes the project and opens it in Android Studio.

4. Launch Sedes and add a named connection to `http://127.0.0.1:4784`. On the
   server, run `sedes auth pair --server http://127.0.0.1:4784` with the same
   server configuration and state environment. Enter its code in the app to
   pair. Manage saved connections in **Settings → Server**.

5. When finished, remove the reverse rule explicitly:

   ```sh
   adb reverse --remove tcp:4784
   ```

Use the same port on both sides if Sedes runs on a non-default port. The app's
fixed origin remains `http://localhost`; the saved endpoint above is the API
destination, not the WebView page origin.

## Connect through a private HTTPS boundary

For a tailnet, keep Sedes on loopback and put Tailscale Serve in front of it as
described in [Operations](../operations.md#tailscale-serve). Include `android`
in the server file's `packagedClients`, admit the exact tailnet DNS Host with
`ALLOWED_TAILSCALE_HOSTS`, and save the resulting `https://...` Serve URL in
**Settings → Server**.

Use Tailscale Serve, not Funnel. Do not bind Sedes directly to its Tailscale IP,
and do not enable the wildcard LAN listener merely for tailnet access. The same
rules apply to an operator-controlled HTTPS proxy: the proxy and network must
provide the private network boundary in addition to Sedes pairing authentication.

## Direct trusted-home-LAN mode

Direct LAN HTTP is available for a deliberately trusted home network. It is
unencrypted; its pairing credentials and API data travel in cleartext.

```sh
SEDES_CONFIG_FILE=/absolute/path/to/server.json \
  SEDES_BIND_HOST=0.0.0.0 \
  SEDES_TRUSTED_LAN_HOST=192.168.50.51 \
  PORT=8787 npm start
```

The selected schema-version-11 bootstrap file must include
`"packagedClients": ["android"]` (or include both client types in canonical
order when both are used).

Save `http://192.168.50.51:8787` in the app. The two host settings have
different roles:

- `SEDES_BIND_HOST=0.0.0.0` makes the socket receive traffic on every IPv4
  interface.
- `SEDES_TRUSTED_LAN_HOST` makes application Host validation admit exactly one
  RFC1918 address in addition to loopback and configured tailnet names.

Startup rejects public, loopback, wildcard, hostname, and Tailscale values for
the trusted LAN Host. Other interface addresses are not admitted automatically.
Restrict the port to the intended private subnet with host and network
firewalls.

Pairing authentication is required by default, but HTTP exposes the pairing code,
saved bearer credential, and application data on the network. A stolen
management credential can read transcripts, control turns, and access configured
workspace roots and terminal shells. Restrict the port with host and network
firewalls. Prefer Tailscale Serve or another private HTTPS boundary for traffic
that leaves the server host.

## Build, verify, and package

| Command | Purpose | Primary output |
| --- | --- | --- |
| `npm run android:sync` | Build Sedes and copy `dist/client` into the native project | synchronized ignored assets |
| `npm run android:build:debug` | Sync and assemble a debug-signed development APK | `android/app/build/outputs/apk/debug/app-debug.apk` |
| `npm run android:install:debug` | Sync and install a debug build on a connected target | installed debug app |
| `npm run android:run` | Sync and run through Capacitor | interactive device/emulator run |
| `npm run android:open` | Sync and open Android Studio | Android Studio project |
| `npm run android:verify` | Sync, inspect, test, and assemble the debug packages | verified app and instrumentation APKs |
| `npm run android:build:release` | Assemble the current unsigned release-shaped APK | unsigned build under `android/app/build/outputs/apk/release/` |

Prefix these commands with `env -u NODE_ENV`. Synchronization rebuilds both
client and server artifacts before Capacitor copies the client. Copied web
assets, generated Capacitor runtime files, Gradle output, APK/AAB files,
`local.properties`, keystores, and signing credentials are ignored and must not
be committed.

`android:verify` performs all of the following:

- confirms synced frontend assets exist and use only local asset references;
- rejects `server.url`, `allowNavigation`, unexpected application origins, and
  Capacitor argument logging;
- checks the content-security policy needed by thumbnails and the Codex
  terminal's reviewed WebAssembly path;
- checks source and merged manifests for the exact permission and native
  provider policy;
- runs app-scoped JVM tests;
- compiles the instrumentation-test APK and debug APK; and
- inspects the APK for the bundled index, runtime config, and JavaScript assets.

This verifies build-time invariants; it does not execute the WebView or replace
device smoke testing.

## Device acceptance checks

Before handing a preview APK to another trusted tester, exercise the actual
network path and at least the following:

1. Fresh install: the app starts disconnected, server settings remain usable
   offline, and malformed origins, credentials, paths, queries, and fragments
   are rejected.
2. Connectivity: **Add & connect**, pair, switch between two named servers,
   restart the app, and confirm credentials remain bound to the right server.
   Revoke a credential on the server and verify pairing is required again.
   Ordinary API requests, SSE reconnection, and an active streamed turn work.
3. Lifecycle: process death, background/resume, device rotation, endpoint
   replacement, Android Back, and keyboard resize do not strand the shell or
   retain streams from the previous endpoint.
4. Composition: sending, queueing, steering, stashing, attachment upload,
   retry/removal, draft restoration, and normalized history work with an image
   and a generic file.
5. Files: browse an intended local or managed-SSH root; edit an allowed text
   file; download empty, text, binary, and large files; cancel in the picker and
   during transfer; and confirm stale revisions and denied paths fail closed.
   Download an APK and PDF, including a second copy with the same filename;
   confirm the document picker preserves their extensions (for example,
   `app-debug (1).apk`) and Files offers the appropriate app to open each file.
6. Context: create and edit a source excerpt with touch selection, send it, and
   confirm the immutable history card survives refresh even if the source later
   becomes unavailable.
7. Output images: long-press inline and expanded previews, copy to an
   image-aware app, save through the document picker, and cancel each flow.
8. Activity modes: reconnect and page history in detailed and summary modes;
   summary responses must omit raw reasoning, tool payloads, and tool errors.
9. Permissions: inspect the merged manifest and installed-app permission screen;
   only network access should be requested and the output-image provider must
   remain non-exported.

For an eligible Codex thread, additionally verify a complete initial terminal
repaint, input and resize, composed Unicode text, Backspace/navigation controls,
touch selection/copy, keyboard behavior, rotation, resume, and network
reconnection. Run this through both the USB path and the intended remote path
if the build will be used with both.

For an application terminal, verify that its **+** menu opens no socket for
unselected terminals and closing the last tab leaves an empty panel;
opening a terminal restores retained output without briefly exposing another
tab's renderer; confirmed observers show the active-tab lock and are read-only;
**Take control** in the panel menu on a second client immediately changes input
and resize authority without requiring release on the first; touch scroll injects
no input; the chat-style Find control searches in both directions; and Android
Back closes only the local panel.
Verify that healthy application, chat, and terminal connections show no green
status indicator, while restoring, reconnecting, and terminal lifecycle states
remain visible. After terminal output sends `CSI 3 J`, close and reopen the
terminal and confirm pre-clear scrollback does not flash or return. Close and
reopen the app and confirm that the process continued while Sedes and its
environment transport remained healthy. **End terminal** must remove its
resource and history after confirmed cleanup. Local terminals become interrupted
on main restart; persistent remote terminals must reconnect to the existing
process and retained output across main/SSH loss. A natural exit or confirmed
sidecar interruption retains truthful history until removal.

## Android-specific data and security behavior

- The saved endpoint and activity-presentation preference are local to this app
  installation. Server state and provider history do not move with them.
- Choosing a composer file uses the system picker; Sedes copies the selected
  bytes into server-owned attachment storage and receives no durable Android
  path authority.
- Workspace downloads use a metadata preflight followed by a native streaming
  GET into the selected document. Redirects, changed revision/length/media
  metadata, responses over the 1 GiB ceiling, and stalled reads fail closed.
  The save picker uses Android's extension-to-MIME mapping for the sanitized
  filename, with `application/octet-stream` for unknown extensions. This local
  document hint does not change the binary transport or its validation. Long
  suggested names retain their extension within the 128-code-point name limit.
  Android's document provider controls duplicate-name handling and the final
  saved filename.
- Output-image copy/save revalidates the closed image MIME set, byte count,
  signature, SHA-256, and 16 MiB ceiling. Clipboard data is exposed from an
  app-cache file through a non-exported, read-granting provider.
- Backgrounding suspends application, thread, and Files event streams. On
  resume, application inventory and an open thread receive retained replay when
  possible and otherwise one fresh authoritative snapshot. Session metadata is
  refreshed separately from inventory, and backgrounding does not create a
  hidden conversation lease.
- Backgrounding or closing an application terminal panel detaches its viewer
  but does not terminate its server-owned process. Merely viewing the terminal
  roster does not allocate a viewer or emulator.
- Tool client creation uses the saved server endpoint. The shown-once token is
  not stored in the endpoint, Capacitor Preferences, WebView storage, or a URL.
  Cleartext endpoints display an acknowledgement because the bearer would cross
  that path without encryption.

For the underlying attachment and file contracts, see
[Attachments](../../internals/composer-attachments.md) and
[Workspace Files](../../internals/workspace-files.md).

## Release and distribution readiness

The checked-in Android project is not ready for public store or signed APK
distribution. Currently:

- the application ID and Java namespace are `dev.sedes.local`;
- `versionCode` is `1` and `versionName` is the placeholder `1.0`;
- `android:build:release` has no private release-signing configuration;
- debug APKs use Android's development signing identity; and
- no CI release lane, artifact provenance policy, or store publishing workflow
  is defined in the repository.

Before calling an APK a release artifact:

1. define a versionCode/versionName mapping tied to the Sedes release;
2. finalize and review application artwork and store metadata;
3. configure private signing outside the repository and protect key material;
4. build from the final release commit or tag;
5. run `android:verify` and the device acceptance checks on supported API
   levels and the intended network paths;
6. inspect the final manifest, package ID, version, archive entries, and signing
   certificate; and
7. publish a SHA-256 checksum and traceable build provenance.

Until those gates exist, describe generated APKs as development or preview
builds and identify the exact source commit used.
