# Electron desktop client

Sedes includes an Electron desktop project that packages the same compiled
frontend as the browser and Android clients. It is a **buildable preview
client**, not a signed or notarized desktop release.

The application loads bundled frontend assets from the fixed
`capacitor-electron://localhost` origin. On first launch, it opens a connection
chooser with saved Direct HTTP(S) and managed SSH connections to separately
operated servers. The full distribution also includes one built-in **Local**
connection. Every choice must pass
the normalized server session handshake before entering the application; the
application inventory then arrives through its SSE snapshot and replay stream.

See [Packaged clients](index.md) for the shared architecture, connection
comparison, compatibility policy, and security boundary.

## Distribution profiles

| Profile | Contents | Connections |
| --- | --- | --- |
| `client` | Electron, bundled frontend, credential/connection/download plugins | Direct HTTP(S) and managed SSH |
| `full` | Client profile plus the slim server runtime and Electron-compatible native addons | Local, Direct HTTP(S), managed SSH |

The native main process reads an immutable packaged profile manifest. A client
build hides Local and rejects native Local startup. A Local preference left by
a previous full installation does not start a server in client mode; its saved
preference and state are preserved for a later full installation. Changing
renderer preferences cannot enable the omitted backend.

Build each profile explicitly:

```sh
env -u NODE_ENV npm run electron:package -- --profile client
env -u NODE_ENV npm run electron:package -- --profile full
```

Add `--dir` for an unpacked package. Outputs are separated under
`electron/dist/client/` and `electron/dist/full/`, and artifact names include
`sedes-client` or `sedes-full`, the version, OS, and architecture. Existing
`electron:build`, `electron:run`, and `electron:smoke` commands use full by
default. For profile-specific preparation and verification:

```sh
env -u NODE_ENV npm run electron:sync -- --profile client
env -u NODE_ENV npm run electron:verify -- --profile client
env -u NODE_ENV npm run electron:verify -- --profile full
```

Each package build starts a fresh profile output directory. Prior output is
preserved under `electron/dist/previous-<profile>-<unique>/<profile>/`, keeping
its original metadata. `BUILD-INFO.json` records the source commit, branch,
commit timestamp, lock hashes, host, Electron ABI, and validation results;
`SHA256SUMS` covers the current output. Full package verification runs SQLite,
migrations, a real PTY, provider imports, and server HTTP/startup/shutdown checks
with the packaged Electron executable. Remote worker probes use external Node.
The graphical smoke gate additionally needs a secure OS keyring; a failure
there is recorded separately from the native runtime checks.

Client builds skip local-server staging and addon compilation. Full builds
consume the same `packages/server-runtime` manifest and independent lockfile
as standalone server distributions, with an Electron-specific native build.
They remove preferred upstream SQLite/PTY prebuilds before source compilation,
retain only runtime build outputs, and prune foreign optional packages at every
nesting level, including Pi's esbuild executables. Remote sidecar native assets
retain their separate external-Node requirements; Electron addons are never
substituted for them. Full retains the backend's served browser assets to
preserve its HTTP behavior.

Neither profile ships Codex CLI or Claude Code executables. Codex's build-time
package is retained in the development tree for protocol generation; desktop
staging copies only its small protocol release metadata. Claude's SDK JavaScript
and Pi provider libraries are included only in full. Executable paths and
provider authentication remain operator responsibilities.

## What the Electron package provides

- The full Sedes frontend in a dedicated desktop window.
- In full, a packaged, current-platform Sedes server runtime for Local.
- Multiple named, device-local direct or managed SSH connection profiles.
- HTTP(S) API, SSE, and WebSocket connectivity to the selected server.
- A narrow native connection runtime that owns the full profile's Local server and uses
  the system OpenSSH client for managed SSH loopback forwarding.
- A narrow native workspace-file download plugin that streams validated server
  bytes to a user-selected destination.
- Application terminal panes and the Codex managed-TUI presentation for
  eligible threads when the desktop account has a compatible Codex CLI
  installed or the backend configures its canonical `tuiExecutablePath`.

The full package contains the compiled Sedes server, its statically compiled backend
dependencies, workers, and native modules built for the current operating
system, architecture, and Electron ABI. It does not contain a standalone Node
distribution, user configuration, application state, provider credentials,
provider executables, provider-native conversation stores, or repository source
and tests. The Claude Agent SDK and Pi runtime are application libraries rather
than installed provider commands; Claude Code, Codex, Grok, authentication, and
native stores remain separately installed for the desktop account. Direct and
SSH connections continue to use the separately operated server's runtime and
state.

## Build prerequisites

- Node.js 24.18 or newer and npm 11 or newer
- the root repository installed with `env -u NODE_ENV npm ci`
- native build prerequisites expected by Electron/electron-builder for the
  current host platform
- a graphical desktop for interactive runs
- `xvfb-run` for the automated runtime smoke test on headless Linux

Install the root dependencies first:

```sh
env -u NODE_ENV npm ci
```

The Electron shell has its own lockfile and build dependencies. The profile
orchestrator installs that subproject with `npm --prefix electron ci`; a normal
root install does not download Electron. The full backend uses the shared
server-runtime lock, with addons built for Electron.

The committed project pins Electron, electron-builder, and the pre-1.0
`@capawesome/capacitor-electron` adapter. Treat adapter upgrades as native
platform changes and rerun the full sync, runtime smoke, and package
verification.

Build each release artifact on a host or CI runner whose operating system and
CPU architecture match the artifact. The Local staging step uses that host's
platform, architecture, Electron ABI, and native provider packages; it is not
a cross-compilation step. Run `npm run electron:verify -- --profile PROFILE`
for each selected profile on every Linux, macOS, or Windows target. Windows
build and validation are delegated to the Windows deployment agent; Linux
checks do not establish Windows or macOS compatibility. macOS
distribution additionally requires Apple signing and notarization on macOS;
Windows distribution requires its own code-signing setup. An unsigned build
from this preview workflow is suitable only for deliberate local testing.

## Use managed Local

Managed Local is included in full. It runs on Linux, macOS, and Windows. Pi isolated-workspace execution
requires Linux and an executable Bubblewrap installation at `/usr/bin/bwrap`.
When that runtime is unavailable, Local still starts normally and Pi runs
directly in the selected project; the isolated-workspace selector is not shown.

Native Windows Local uses the built-in Windows PowerShell and .NET Framework
for owned-process Job Objects and private attachment ACLs. Those components
must remain available to the desktop account. If their launch or access-control
checks fail, the operation fails instead of using weaker cleanup or permission
checks. Normalized Windows drive and UNC paths are supported for workspace
files; device namespaces and alternate data streams are not workspace paths.
Windows file operations revalidate canonical paths against open-file identity,
with the same external-writer race limitation documented for macOS in
[Workspace files](../../internals/workspace-files.md#known-limitations).

After installing dependencies on a Windows checkout, run
`npm run test:windows-runtime` for deterministic native process-tree, file
identity, and attachment ACL tests. This command requires Windows and does not
use a live model provider. Run `npm run electron:verify` separately for the
packaged client. Linux model tests do not replace these native Windows checks.

The verified Job Object cleanup applies to owned stdio processes. Windows PTY
sessions still use node-pty/ConPTY cleanup and do not yet provide the same
independent confirmation that every descendant has exited.

Choose **Local** when work should run on the desktop account and does not need
to continue after Electron exits. Electron launches its packaged server on an
ephemeral `127.0.0.1` port, admits only the fixed Electron application origin,
and keeps execution configuration in its private database. Use Settings for
workspace grants and provider targets. The renderer cannot choose the server
executable, listener, bootstrap path, or state path.

Choose the narrowest practical local workspace roots in Settings. Saved grants
belong to this Local server and do not follow a switch to another connection.

On first use, Electron creates a private `managed-local` subtree beneath its
platform user-data directory. That subtree owns `server.json` and the complete
Local application state. Common user-data parents are the operating system's
per-user application-data location for Sedes, such as
`~/.config/Sedes` on Linux, `~/Library/Application Support/Sedes` on macOS, or
`%APPDATA%\Sedes` on Windows; platform packaging can vary the parent name. Stop
Electron and inspect the installed application's actual user-data directory
before backup or manual configuration changes.

Electron owns the installation bootstrap; backend and model policy are edited
in the Local server's Settings, not in its connection chooser or startup JSON.
An old execution-configuration file requires explicit import before cutover.
Stop Electron and back up the complete `managed-local` subtree before migration.
Invalid bootstrap fails visibly on the Local card. Never point another Sedes
process or worktree at the same state directory.

The packaged Pi SDK still uses the desktop account's provider/model setup.
Codex, Claude, Grok, and other provider-owned executables, accounts,
authentication, and native conversation stores remain external prerequisites
when enabled in Settings. Packaging a backend dependency does not install
or authenticate those provider runtimes.

Electron hydrates Local's `PATH` from the desktop account's login shell on
macOS and Linux before starting the server, then preserves inherited entries.
This lets a Finder-launched application discover operator-installed `codex`,
`claude`, and `grok` commands using the same backend rules as a directly run
server. Each backend also accepts an optional canonical absolute executable
override when normal `PATH` lookup is not appropriate.

Local is an application-session process, not a background service. Electron
stops it on application exit without an extra prompt. **Switch connection**
opens the chooser without stopping it. Choosing Direct or SSH asks for
confirmation because active Local agents and terminals will end. After
confirmation, Local remains alive only while the candidate is validated; a
failure or cancellation restores Local, while a successful candidate is not
shown until Electron has stopped the exact Local instance. No successful
switch leaves a hidden Local server running.

## Connect to a separately operated server on the same host

Use a Direct profile instead of managed Local when another process or service
already operates Sedes on the same machine.

1. In the schema-version-11 bootstrap file, admit the Electron application origin:

   ```json
   "packagedClients": ["electron"]
   ```

   Then build and start Sedes:

   ```sh
   env -u NODE_ENV npm run build
   SEDES_CONFIG_FILE=/absolute/path/to/server.json npm start
   ```

2. In another terminal, build, synchronize, and launch the desktop client:

   ```sh
   env -u NODE_ENV npm run electron:run
   ```

3. On the connection screen, create a named **Direct** connection with
   `http://127.0.0.1:4784`, then choose **Save & connect**. Later, use
   **Settings → Connection → Switch connection** to return to the same
   chooser, add or edit profiles, or select another server.

HTTP is appropriate for same-machine loopback. It is not private when traffic
crosses a network. `electron:run` always rebuilds and synchronizes
`dist/client` before launching; the endpoint is used for API connections and
never as a remotely loaded renderer page.

After Local or a saved profile successfully completes native setup and the
server session handshake, it becomes the last-selected connection. The
chooser's **Connect automatically at startup** setting is enabled by default, so the desktop app
attempts that profile once on the next launch. Turn it off to require an
explicit connection choice on every launch; the last-selected profile remains
saved. A failed attempt returns to the chooser with an actionable error; it
does not repeatedly retry SSH authentication or silently select another server.

## Connect through managed SSH

Managed SSH is the preferred built-in path to a Sedes daemon installed on a
remote SSH machine. The remote daemon must already be running on its own
loopback interface, and its schema-version-11 bootstrap file must include
`"packagedClients": ["electron"]`. For example, run this on the remote host:

```sh
SEDES_CONFIG_FILE=/absolute/path/to/server.json npm start
```

On the Electron host:

1. Configure a normal system OpenSSH host alias. The alias may define
   `HostName`, `User`, `Port`, `IdentityFile`, `ProxyJump`, and the other
   routing or identity details needed by that installation.
2. Verify that the alias connects and completes host-key and authentication
   handling outside Sedes:

   ```sh
   ssh my-sedes-host
   ```

3. In the Electron chooser, add an **SSH** connection. Enter a name, the exact
   host alias, and the remote Sedes port (default `4784`), then choose
   **Save & connect**.

Electron invokes the system `ssh` executable noninteractively, binds a saved
local port only on `127.0.0.1`, and forwards it to
`127.0.0.1:<remote-port>` as observed by the remote SSH host. The UI accepts an
alias, not a hostname plus a second set of SSH options. User names, keys,
agents, ports, proxy jumps, and `known_hosts` policy remain in the operating
system account's OpenSSH configuration.

The forwarding port is persisted privately for the profile ID, SSH target, and
remote port, preserving the exact local origin to which its credential is
bound. Changing the target selects a distinct origin and requires pairing for
that destination. If the saved port is occupied, connection fails with an
actionable error; stop the occupying process and reconnect. Sedes does not
silently choose a random replacement port or reuse a credential at another
origin.

Sedes cannot prompt for an SSH password, key passphrase, host-key acceptance,
or multifactor challenge. Arrange agent/key access and accept or update the
host key before connecting. If the alias does not work noninteractively for the
same desktop account, fix it outside Sedes. Do not place private keys,
passphrases, or SSH options in a connection name or alias.

Only one managed SSH tunnel is active per Electron application instance.
Switching connections, cancelling setup, closing the application, or losing
the SSH process closes the owned forward. An unexpected loss returns the user
to the chooser rather than falling back to a direct profile. The forward
provides private transport and reachability; the client must separately pair
with Sedes to access its configured local principal.

## Connect through Tailscale Serve

Keep Sedes bound to loopback, put Tailscale Serve in front of it, and admit both
the exact tailnet DNS Host and the Electron application origin:

```sh
SEDES_TAILNET_HOST="$(
  tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")'
)"
tailscale serve --bg http://127.0.0.1:4784
tailscale serve status
SEDES_CONFIG_FILE=/absolute/path/to/server.json \
  ALLOWED_TAILSCALE_HOSTS="$SEDES_TAILNET_HOST" npm start
```

The selected schema-version-11 bootstrap file must include `electron` in
`packagedClients`.

Save `https://$SEDES_TAILNET_HOST` as a named Direct connection in the desktop
client. Both computers must be on the same tailnet. Use Serve, not Funnel; do
not bind Sedes directly to its Tailscale IP. See
[Operations](../operations.md#tailscale-serve) for the full server-side
procedure and trust boundary.

## Connection credentials

By default, Direct and SSH connections pair with the server using the code or URL from
`sedes auth pair --server URL`, run as that server's operating-system account.
The one-time code is exchanged for a persistent, revocable management
credential. See [Pairing clients](../operations.md#pairing-clients) for expiry
and server-side client listing and revocation.

The native `ClientCredentials` bridge encrypts credentials using Electron
`safeStorage` and binds each stored entry to the profile ID and server origin.
Credentials are separate from connection preferences. Secure storage fails
closed when OS encryption is unavailable, including the Linux `basic_text`
backend; configure an OS keyring rather than accepting plaintext storage.
The renderer needs the credential in memory for authenticated requests, so
native encryption protects persistence, not a compromised active renderer.
Managed Local enrolls automatically using a one-time token delivered over its
private parent/child channel and saves the resulting credential securely.
Local and SSH connections retain their existing lifecycle and forwarding
behavior; the SSH transport itself does not replace Sedes API authentication.

For an explicitly trusted deployment, `SEDES_AUTH_REQUIRED=false` on the server
allows connections without pairing and preserves saved credentials. Launching
Electron with that environment setting also configures its managed Local server
to disable authentication. Local verifies the child's reported policy and shows
**Authentication disabled** under Settings → Connection. It can then start without
an OS keyring; no Local credential is issued or replaced in this mode. Unset the
variable or set it to `true` and restart to restore the default policy.

## Direct trusted-home-LAN mode

For a deliberately trusted home LAN, Electron can use the bounded wildcard
listener:

```sh
SEDES_CONFIG_FILE=/absolute/path/to/server.json \
  SEDES_BIND_HOST=0.0.0.0 \
  SEDES_TRUSTED_LAN_HOST=192.168.50.51 \
  PORT=8787 npm start
```

The selected schema-version-11 bootstrap file must include
`"packagedClients": ["electron"]` (or include both client types in canonical
order when both are used).

Save `http://192.168.50.51:8787` as a named Direct connection. The socket
receives traffic on all IPv4 interfaces, but application Host validation admits
only loopback, configured tailnet DNS names, and the one exact private IPv4
Host. It does not admit every interface address.

Pairing authentication is required by default, but HTTP exposes the pairing code,
saved bearer credential, and application data on the network. A stolen
management credential can read transcripts, control turns, and access configured
workspace roots and terminal shells. Restrict the port with host and network
firewalls. Prefer Tailscale Serve or another private HTTPS boundary for traffic
that leaves the server host.

## Build, verify, and package

| Command                   | Purpose                                                                                                  | Primary output                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `npm run electron:sync`   | Build Sedes, install Electron dependencies, and synchronize `dist/client` and manifests                  | ignored Electron app/generated content       |
| `npm run electron:run`    | Sync and launch the desktop client                                                                       | interactive application                      |
| `npm run electron:open`   | Sync and open the platform project                                                                       | platform development workflow                |
| `npm run electron:smoke`  | Sync and exercise the source-project Electron renderer and connection fixtures for fast iteration        | runtime smoke result                         |
| `npm run electron:verify` | Sync, package an unpacked app, inspect its contents, and run the unpacked package outside the repository | verified unpacked app under `electron/dist/` |
| `npm run electron:build`  | Sync and ask electron-builder for current-host artifacts                                                 | artifacts under `electron/dist/`             |

Prefix these commands with `env -u NODE_ENV`.

`electron:verify` checks both the synchronized source and the assembled package:

- synchronized files exactly match `dist/client` by listing and SHA-256;
- the content-security policy retains the expected network and framing rules;
- the renderer origin remains exactly `capacitor-electron://localhost`;
- permission checks and permission requests remain denied except for sanitized
  clipboard writes from the packaged main renderer;
- the generated plugin manifest contains only the reviewed workspace-download
  and consolidated connection-runtime plugins;
- the actual Electron renderer connects to disposable HTTP API, SSE, and
  WebSocket endpoints with the expected Origin;
- managed SSH uses the system client with the reviewed noninteractive,
  loopback-only forwarding contract and cleans up its owned process;
- the native download plugin streams a response with exact metadata;
- the packaged payload contains the frontend, Electron adapter, compiled Local
  server and workers, and only the intended current-platform native/runtime
  dependencies while excluding source, tests, credentials, configuration, and
  application or provider state; and
- the actual unpacked application starts Local outside the source tree, loads
  its Electron-ABI native modules, passes health, the normalized session
  handshake, and the initial application SSE snapshot;
  exercises switching and rollback, and leaves no managed child after exit.

Generated `electron/app`, `electron/build`, `electron/generated`,
`electron/vendor`, and `electron/dist` content is ignored and must not be
committed. Build distributable artifacts on their target operating system; do
not assume an artifact built on one OS represents verified support on another.

## Desktop acceptance checks

Before handing an installer or unpacked preview to another trusted tester, run
`electron:verify` on the target platform and exercise at least:

1. Fresh profile: the application opens the chooser with non-editable Local,
   can start it and save multiple named Direct and SSH profiles, and remains
   usable when any candidate is unavailable.
2. Connection validation: invalid direct schemes, credentials, paths, queries,
   and fragments are rejected. Invalid SSH aliases and ports are rejected;
   **Save & connect**, cancellation, errors, edit, and delete work as shown.
3. Core transport: API calls, SSE replay/reconnect, an active streamed turn,
   and an eligible Codex terminal WebSocket work on the intended network path.
4. Lifecycle: reload, window close/reopen, network interruption, and endpoint
   replacement dispose old streams and recover without combining servers.
   Verify last-successful auto-connect and **Settings → Connection →
   Switch connection** for Local, Direct, and SSH. Opening the chooser from
   Local must retain it; cancelling the stop confirmation or a failed/cancelled
   candidate must restore the same Local process. A successful replacement
   must stop Local before appearing, and application exit must stop it without
   installing a background service. Closing or switching away from SSH must
   terminate its owned forward.
   For application terminals, closing the window or panel must detach the view
   without terminating the process. Reopen it from the roster and verify an
   isolated renderer, checkpoint restore without pre-clear output flashing,
   chat-style terminal Find, and quiet healthy connection indicators. Exercise
   the active-tab observer lock and panel-menu **Take control** with a second
   client without first releasing the original controller. Verify that **End
   terminal** removes confirmed process history while natural exit or
   interruption remains inspectable.
5. Files: browse/edit an allowed root and download empty, text, binary, and
   large files; cancel a destination selection and an active transfer; reject a
   changed revision, redirect, invalid metadata, and over-limit response.
6. Application safety: inline code-copy writes to the clipboard while
   clipboard reads, external navigation, popups, other permission requests,
   cross-origin frames, and attempts to use Node APIs in the renderer remain
   blocked.
7. Packaging: product name, application ID, version, icons, artifact names,
   install/uninstall behavior, and profile location are correct for the target
   OS.

The smoke script is strong automated coverage of the packaged origin and
transport contract, but it does not replace installer, OS integration, or
interactive feature checks on each supported platform.

## Security boundary

- The renderer uses context isolation and Chromium sandboxing with Node
  integration disabled.
- Permission checks and requests are denied by default. The only exception is
  sanitized clipboard write from the packaged application's exact main-frame
  origin; clipboard reads remain denied.
- The Sedes window is not a general browser; preserve the platform's navigation
  and new-window guards.
- CSP admits runtime-configured HTTP(S) API/SSE and WS/WSS endpoints, while
  blocking cross-origin frames, objects, and arbitrary form destinations.
- Workspace downloads cross the native boundary only through the dedicated
  streaming plugin after exact metadata validation.
- Managed Local and SSH cross the native boundary only through the consolidated
  connection runtime. Local uses code-owned executable/config/state paths and
  a loopback listener; SSH accepts a restricted host alias and remote port,
  invokes system OpenSSH without a shell, binds only loopback, and never stores
  SSH credentials.
- The server echoes CORS only for the explicitly enabled, code-owned Electron
  origin and does not enable credentialed CORS.
- A saved profile or SSH forward grants no authority by itself and cannot
  bypass server Host, Origin, Fetch Metadata, CORS, or CSRF enforcement.

These controls reduce renderer and cross-origin risk independently of the
paired-client authentication required by the server. A saved profile or network
connection alone does not grant API access.

For the server-side file contract, see
[Workspace Files](../../internals/workspace-files.md).

## Release and distribution readiness

The checked-in Electron project is not ready for public installer distribution.
Currently:

- `electron/package.json` is private, version `0.1.0`, and MIT-licensed;
- electron-builder uses the provider-neutral application ID
  `dev.sedes.local`;
- its homepage names the current `harness` repository; the release owner must
  decide whether that repository name remains the public home for Sedes;
- the build has no macOS signing/notarization, Windows code-signing, Linux
  package-signing, or update/publication configuration;
- only a general PNG artwork source is present, without reviewed platform icon
  assets for every target; and
- no CI matrix proves packaged behavior across target operating systems and
  architectures.

Because Local includes Electron-ABI native modules, every artifact is specific
to its build operating system and architecture. A successful build or smoke on
one target is not evidence for another. The feature does not create a
standalone daemon archive, system service, background-after-exit mode, remote
installer, or automatic update channel.

Before calling a desktop artifact a release installer:

1. align package version, license, homepage/repository, author, product ID, and
   artifact naming with the release;
2. finalize platform artwork and installer metadata;
3. define supported OS versions and architectures;
4. configure platform signing and macOS notarization with credentials stored
   outside the repository;
5. build from the final release commit or tag on each target platform;
6. run `electron:verify` and the desktop acceptance checks on each supported
   target;
7. inspect the installed package, ASAR contents, version, signature, and
   uninstall behavior; and
8. publish checksums and traceable build provenance.

Until those gates exist, describe Electron outputs as local development or
preview builds and identify their exact source commit and build platform.
