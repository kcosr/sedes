# Operations and security

Sedes currently exposes one trusted local principal; it is not a public
service. The operator owns its process, server configuration, network
boundary, application state, provider state, and every filesystem root made
available to it.

## On this page

- [Routine operation](#routine-operation)
- [Deployment shapes and network exposure](#deployment-shapes-and-network-exposure)
- [Pairing and credentials](#pairing-and-credentials)
- [Production lifecycle](#production-lifecycle) and its [systemd example](#example-systemd-user-service)
- [State, upgrades, and backups](#state-upgrades-and-backups)
- [Restart and recovery](#restart-and-recovery)
- [Security boundary and incident response](#security-boundary-and-incident-response)
- [Live smoke and measurement](#live-smoke-and-measurement-commands)
- [Troubleshooting](#troubleshooting)

## Routine operation

This is the short supported path for one installation. Each item is a summary;
the linked section below owns the complete rules and remains authoritative
before you change a deployment shape, upgrade, or restore.

- **Supported shape.** Run one server process listening on `127.0.0.1` on a
  standalone host (Linux x64 or macOS on Apple silicon or Intel; Windows has
  limited support based on limited use by the developer),
  and put [Tailscale Serve](#tailscale-serve) in front of that loopback
  listener when a device off the host must reach it. Every admitted and
  unsupported shape is in the [deployment matrix](#deployment-matrix).
- **Start.** Place the reviewed schema-11 bootstrap at
  `${XDG_CONFIG_HOME:-$HOME/.config}/sedes/server.json`, build the source tree
  that will actually run, then start it against an absolute state directory:

  ```sh
  env -u NODE_ENV npm run build
  APP_STATE_DIR=/absolute/path/to/state npm start
  ```

  The default endpoint is `http://127.0.0.1:4784`, and `/api/health` returns
  `{"status":"ok"}` for a paired management credential. See
  [Production lifecycle](#production-lifecycle) for service-manager
  requirements, the optional Linux
  [installed user service](#installed-user-service-on-linux), and the
  [systemd user unit](#example-systemd-user-service).
- **Stop.** Send `SIGTERM` and permit the bounded 30-second teardown. Stopping
  main Sedes does not stop remote turns, shells, or retained results on a
  sidecar host; see [Restart and recovery](#restart-and-recovery).
- **Pair a browser or device.** Run
  `sedes auth pair --server https://sedes.example` on the server as its
  operating-system account, then open the printed URL in the browser or enter
  its `XXXX-YYYY` code in a packaged client's pairing screen. The code lasts
  five minutes and is single-use. [Pairing clients](#pairing-clients) covers
  listing, revocation, connector codes, and the submission limits.
- **Where state lives.** The overlay database and its blob directories live
  under `APP_STATE_DIR` (by default `${XDG_STATE_HOME:-~/.local/state}/sedes`),
  and the startup file lives at the selected `server.json` path. Provider
  authentication and native conversation stores stay provider-owned. See
  [State, upgrades, and backups](#state-upgrades-and-backups).
- **Minimum backup.** Stop Sedes, verify the process is no longer running, copy
  the complete state directory while it is quiescent, and keep the server JSON,
  protected credential files, and provider-native backups beside it. A
  database-only copy is incomplete. Archive, checksum, and restore commands are
  in [State, upgrades, and backups](#state-upgrades-and-backups) and
  [Restore and rollback](#restore-and-rollback).
- **Upgrade.** Settle active work, inventory remote sidecar work, stop and back
  up, build the exact commit or tag that will run, then start it and require a
  successful health check. An older binary rejects a newer database, so keep the
  matched pre-upgrade set for rollback. The ordered procedure is in
  [State, upgrades, and backups](#state-upgrades-and-backups); a schema-10
  installation first needs the one-time [schema-10 cutover](#schema-10-cutover).

## Deployment shapes and network exposure

These are the admitted ways a client reaches Sedes and what each one exposes.
Choose the shape first; [Connection model](connections.md) explains how this
client layer differs from provider-runtime and execution-environment choices.

### Deployment matrix

| Shape                      | Listener                                       | Transport                                        | Trust boundary                                                                                      |
| -------------------------- | ---------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| Same host                  | `127.0.0.1`                                    | HTTP loopback                                    | Local operating-system account and local browser clients.                                           |
| Tailscale Serve            | `127.0.0.1`                                    | HTTPS to tailnet; loopback upstream              | Tailnet users/devices permitted by Tailscale ACLs or grants to reach Serve, plus the local account. |
| Private HTTPS proxy        | `127.0.0.1`                                    | HTTPS to a same-host proxy; loopback upstream    | Clients admitted by the proxy's private access policy, plus the local account.                      |
| Android with `adb reverse` | `127.0.0.1`                                    | USB/emulator tunnel                              | Local account and connected device.                                                                 |
| Electron on the server host | `127.0.0.1`                                   | HTTP loopback                                    | Local operating-system account and packaged desktop client.                                         |
| Packaged client on trusted LAN | `0.0.0.0` plus one exact admitted RFC1918 Host | Plain HTTP unless another private proxy is added | Every program or device able to reach the firewall-admitted host/port.                            |

Unsupported shapes include Tailscale Funnel, public listeners, public reverse
proxies, guest networks, and any network with untrusted clients. Production
management APIs require paired-client authentication by default. Tool-client credentials
authorize only their agent-tool routes. CORS, CSRF, Fetch Metadata, Host checks,
and security headers remain independent browser and deployment protections.

### Tailscale Serve

Sedes does not embed or manage Tailscale. Keep the application on loopback
and let the existing Tailscale daemon terminate HTTPS. The command below also
requires `jq` to read the daemon's JSON status.

First obtain the exact DNS name and configure Serve:

```sh
SEDES_TAILNET_HOST="$(
  tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")'
)"
tailscale serve --bg http://127.0.0.1:4784
tailscale serve status
```

Then start Sedes with that exact name in its allowlist:

```sh
SEDES_CONFIG_FILE="$PWD/config/server.example.json" \
ALLOWED_TAILSCALE_HOSTS="$SEDES_TAILNET_HOST" npm start
```

Open `https://$SEDES_TAILNET_HOST` from a device on the same tailnet. If the
browser reports a Host, Origin, or forwarded-origin rejection, compare the
name with `tailscale serve status`, then restart Sedes with the exact value.
Changing Serve does not update the running application's allowlist.

Use Serve, not Funnel. Do not bind Sedes to its Tailscale IP, and do not
enable wildcard trusted-LAN mode just for tailnet access.

### Private HTTPS reverse proxy

An operator-controlled HTTPS proxy can provide another private access boundary
when it runs on the same host as Sedes. Keep Sedes on `127.0.0.1`; the
application accepts forwarded origin headers only from a loopback peer.

Add the proxy's exact external DNS name to `ALLOWED_TAILSCALE_HOSTS` despite
the variable's historical name:

```sh
SEDES_CONFIG_FILE="$PWD/config/server.example.json" \
ALLOWED_TAILSCALE_HOSTS=sedes.private.example npm start
```

Configure the proxy to:

- terminate HTTPS and enforce the private network, device, or user access
  policy before forwarding;
- connect upstream to `http://127.0.0.1:4784`, never to a wildcard or public
  Sedes listener;
- send an allowed `Host` value and overwrite, rather than trust,
  `X-Forwarded-Host` with the exact admitted external DNS authority;
- overwrite `X-Forwarded-Proto` with `https`; both forwarded headers must be
  present together;
- preserve streaming responses and WebSocket upgrades; and
- reject public or otherwise untrusted ingress.

A browser uses `https://sedes.private.example` (including the external port
when nondefault), and its Origin must match the forwarded Host, port, and HTTPS
protocol. A packaged client saves that same API endpoint but retains its fixed
application Origin, which requires its matching entry in the server file's
`packagedClients` array.
Sedes rejects forwarded headers from non-loopback peers, unlisted DNS names,
partial header pairs, and mismatched browser origins. The proxy supplies
transport and private access control; Sedes also requires client pairing. See the
[packaged-client security boundary](clients/index.md#shared-security-boundary)
before connecting Android or Electron.

### Android ingress

The bundled Android client uses the exact application origin
`http://localhost`. Add `"packagedClients": ["android"]` to the
schema-version-11 bootstrap file, then start it without changing the loopback
listener:

```sh
SEDES_CONFIG_FILE=/absolute/path/to/server.json npm start
adb reverse tcp:4784 tcp:4784
```

Save `http://127.0.0.1:4784` in the app. This is the preferred cleartext
development path.

Direct LAN access instead requires the coupled packaged-client, wildcard-bind,
and exact trusted-LAN-Host settings. Authenticated credentials and data travel
without encryption;
the [Android guide](clients/android.md#direct-trusted-home-lan-mode) owns the
complete device, firewall, and endpoint workflow.

The same coupled settings also admit application terminal WebSockets, so on
plain HTTP a paired management credential can expose the configured shell
authority to network observers; see
[Network ingress](configuration.md#network-ingress). Prefer loopback, Tailscale
Serve, or a private HTTPS proxy when that LAN-wide trust is too broad.

### Electron ingress

The bundled desktop client uses the exact application origin
`capacitor-electron://localhost`. Its built-in Local connection starts the
packaged production server on an ephemeral loopback port for the Electron
application session. Electron owns its exact executable, configuration, state,
workspace root, and shutdown lifecycle; the renderer cannot redirect them.
Local stops on application exit and is not installed as a system service.

Managed Local state and `server.json` live together beneath the Electron
user-data directory's private `managed-local` subtree, not in the traditional
XDG service locations. Back up that complete subtree only while Electron is
stopped. Do not share it with a source checkout, user service, another Electron
installation, or a concurrently running process. Provider authentication,
native conversation stores, and separately installed provider executables are
not included in that backup.

Switching away from Local is transactional. Electron warns that active Local
agents and terminals will end, retains Local while the selected Direct or SSH
candidate is validated, restores Local if that attempt fails or is cancelled,
and stops the exact Local process before publishing a successful replacement.
No server state or provider conversation is migrated between connections.

For a separately operated server on the same computer, keep the listener on
loopback and add `"packagedClients": ["electron"]` to its
schema-version-11 bootstrap file:

```sh
SEDES_CONFIG_FILE=/absolute/path/to/server.json npm start
```

Save `http://127.0.0.1:4784` as a Direct profile in the desktop client. A
tailnet URL additionally requires its exact DNS name in
`ALLOWED_TAILSCALE_HOSTS`.

Electron can also manage a connection to a remote Sedes daemon through the
desktop account's existing system OpenSSH host alias. Keep that remote daemon
on its own `127.0.0.1` listener, include `electron` in that daemon's
`packagedClients`, and enter the alias and remote Sedes port in an SSH profile.
Electron owns only a temporary loopback forward; it does not install, launch,
update, or configure the remote daemon, manage SSH credentials, or turn the
tunnel into Sedes authentication. Read [Electron](clients/electron.md) for
managed Local and SSH, provider prerequisites, private HTTPS, trusted-LAN,
build, packaging, and
runtime-verification workflows.

## Pairing and credentials

How browsers, packaged clients, connectors, and operator scripts authenticate to
the one local principal, and how that authority is withdrawn.

### Pairing clients

By default, production Sedes authenticates access to its backend APIs, event streams,
WebSockets, and protected downloads. The frontend HTML/JavaScript and the
connector bundle remain public so a new client can reach enrollment. Public
assets grant no application authority. All management clients use the one
server-derived local principal; pairing does not create users or tenants.

An operator can explicitly disable paired-client checks using
`SEDES_AUTH_REQUIRED=false` and restart the server. Existing Host/Origin, CORS,
CSRF, host approval, and Tool-client checks remain; management access then relies
on the admitted private network boundary.
[Network ingress](configuration.md#network-ingress) owns the exact contract:
disabling deletes no credentials, re-enabling accepts only credentials still
valid at that time, and an outbound host first approved without a credential
while authentication was disabled must be revoked and registered again with a
new authenticated connector identity before it can reconnect.

Run the CLI on the server as its operating-system account, with the same
`SEDES_CONFIG_FILE`, `APP_STATE_DIR`, and environment as the running process:

```sh
sedes auth pair --server https://sedes.example
sedes auth list
sedes auth revoke CLIENT_ID
```

The same binary validates an edited startup file without opening the
database, starting a provider, or binding a port, so it is safe while Sedes is
running:

```sh
sedes config validate [--file /absolute/server.json] [--state-directory /absolute/sedes-state]
```

It exits 0 when the file is valid, 1 with one line per problem when it is not,
and 2 for a usage error. See
[Configuration changes and rollback](configuration.md#configuration-changes-and-rollback).

From a built source checkout without a linked `sedes` command, use
`node dist/cli/sedes-cli-main.js auth ...` or `... config validate` for these
commands.

`auth pair` prints JSON containing a URL, a code, and the expiry. The code lasts
five minutes and is single-use. Codes contain eight letters, displayed as
`XXXX-YYYY` (for example, `WDJB-MJHT`). Entry is case-insensitive; the middle
hyphen and surrounding whitespace are optional. Open the URL in the browser, or enter the code
in a packaged client's pairing screen after selecting its server. The URL
carries the code in its fragment, not an API query parameter. Keep both private.
Each active manual code permits at most five well-formed code submissions
across the installation, including guesses for other codes. After that budget
is exhausted, generate a fresh code. Pairing requests are also limited to 60
per minute across the installation. These limits persist across server restarts.
The server exchanges the code for a revocable credential lasting 90 days;
expired or revoked clients must pair again. Changing the enrollment-code format
does not replace existing paired clients or their saved credentials. `auth list` lists active clients
and `auth revoke` permanently removes the selected credential's authority.

The ordinary browser uses its same-origin server and an HttpOnly, SameSite
Strict cookie scoped to `/api`; HTTPS sets the Secure attribute. There is no
browser multi-server profile list. Android and Electron keep credentials per
connection in native encrypted storage, separately from saved profile metadata.
Removing a saved connection clears its local credential; use server-side
revocation to withdraw an issued credential's authority.

For an outbound connector, generate a separate code:

```sh
sedes auth pair --server https://sedes.example --sidecar
```

Sidecar credentials are restricted to outbound operations and bound to the
connector identity. They do not grant management access. Server-side host
approval and workspace/operation grants remain required after authentication.
See [Outbound hosts](outbound-hosts.md) for the connector command and revocation
recovery.

### Credentials for operator scripts

The automation CLI and `npm run measure:thread` read a paired device credential
from `SEDES_AUTH_TOKEN`. To obtain one, generate a management pairing code with
`sedes auth pair --server URL`, then privately POST JSON to that server's
`/api/auth/pair` containing `token` (the code), `kind: "device"`, and a descriptive
`clientName`. Save the returned `credential` in a protected secret file or
secret manager; do not print it in shared terminals, logs, or command arguments.
Use an HTTP client that reads the request body from protected input, and HTTPS
for remote enrollment. Supply the saved credential through `SEDES_AUTH_TOKEN`
in the script's environment. Never place it in the server URL. Revoke the client
with `sedes auth revoke CLIENT_ID` when the script no longer needs access.
This is a management credential with the local principal's authority; use a
policy-limited Tool client when a caller needs narrower permissions.

Authentication records and hashed secrets live in
`authentication/authentication.sqlite` beneath the state directory, the only
part of that directory whose permissions authentication restricts; see
[Network ingress](configuration.md#network-ingress) for the exact modes. Back up
the complete state directory consistently and protect it as server-account
authority. The server does not store recoverable
pairing codes or client credential plaintext in this database.

Prefer HTTPS through the documented private ingress. The explicitly admitted
trusted-LAN HTTP mode still sends pairing codes, bearer credentials, cookies,
and application data without transport encryption. Authentication does not make
that mode safe for an untrusted network or authorize public internet exposure.

## Production lifecycle

Place the reviewed schema-11 installation bootstrap at
`${XDG_CONFIG_HOME:-$HOME/.config}/sedes/server.json`, build the selected
source tree, then start it:

```sh
env -u NODE_ENV npm run build
APP_STATE_DIR=/absolute/path/to/state \
npm start
```

Use `SEDES_CONFIG_FILE=/absolute/path/to/server.json` when the installation
deliberately stores it elsewhere. Sedes requires the selected file and fails
closed rather than generating configuration or using a repository example.

A fresh database serves Settings with empty execution configuration. Add its
environments, workspace roots, backends, and targets there. Existing installations
require [explicit offline import](configuration.md#configuration-changes-and-rollback)
before normal startup.

The default endpoint is `http://127.0.0.1:4784`. A health check returns
`{"status":"ok"}`. It requires a paired management credential in
`SEDES_AUTH_TOKEN`, as described in [Credentials for operator scripts](#credentials-for-operator-scripts):

```sh
printf 'Authorization: Bearer %s\n' "$SEDES_AUTH_TOKEN" |
  curl --fail --header @- http://127.0.0.1:4784/api/health
```

Use a service manager that:

- starts only after the selected configuration, state directory, provider
  prerequisites, and any external endpoint are available;
- sends `SIGTERM` for normal shutdown;
- permits the server's bounded 30-second teardown; and
- kills no separately operated external Codex daemon as part of Sedes
  cleanup.

Sedes drains admitted HTTP operations, long-lived streams, background
publication, main-owned provider interactions, queues, runtimes, processes, and
locks in an ordered shutdown. If the outer deadline expires, the process exits
nonzero and leaves fail-closed ownership evidence rather than stealing or
deleting a lock.

Do not start two Sedes processes against the same `APP_STATE_DIR`. An owned
Pi or Codex native store also has a single-writer boundary; do not open the same
Pi conversation from an independent Pi process while Sedes owns it. Claude's
external store has no Sedes writer lock, but the selected Claude config
directory remains part of native conversation and credential backup authority.

### Installed user service on Linux

The installer installs a verified slim server package into versioned per-user
releases on Linux and macOS. Systemd integration is opt-in: add `--systemd`
on Linux to create or update a user service unit. Build and extract a
package as described in [Server distribution](server-distribution.md), then:

```sh
npm run install:server -- --package /absolute/extracted-release --systemd
```

Installation is offline and requires Node.js 24.18.0 or newer with the package's
Node ABI. It never reinstalls the root production dependency graph or compiles
addons. Integrity, browser/server startup, SQLite migrations, real PTY, and
module checks must pass before activation. Native compilation happens on the
target build host during packaging. A failure leaves the active release unchanged.

The installer creates this layout and never touches state or configuration
beyond seeding a missing `server.json` from `config/server.example.json`:

```text
${XDG_DATA_HOME:-~/.local/share}/sedes/
  releases/<version>/   dist/, production node_modules/, bin/ wrappers, RELEASE.json
  current -> releases/<version>
~/.local/bin/sedes -> .../current/bin/sedes
~/.local/bin/sedes-automation -> .../current/bin/sedes-automation
~/.config/sedes/server.json        seeded only if absent
~/.config/systemd/user/sedes.service   with --systemd, only if absent or still installer-managed
```

`current` is the only place that records the active version. The bin links and
the unit file point through it, so an upgrade is one atomic symlink swap and a
service restart, and rollback is the same swap in the other direction. The
installer never runs `systemctl`; it prints the commands to run next. On first
install:

```sh
systemctl --user daemon-reload
systemctl --user enable --now sedes.service
```

To upgrade, follow the backup steps in
[State, upgrades, and backups](#state-upgrades-and-backups), then build the new
version and run the installer again; it stages the new release beside the old
one and activates it. Restart the service to pick it up:

```sh
npm run install:server -- --package /absolute/extracted-release --systemd
systemctl --user restart sedes.service
```

To roll back, activate the previous release and restart, remembering that an
older release refuses a database a newer release has migrated:

```sh
npm run install:server -- --list
npm run install:server -- --activate 0.1.0 --systemd
systemctl --user restart sedes.service
```

The wrappers and the unit run `node` from the service's `PATH`. When Node.js
comes from a version manager that only configures interactive shells, add an
absolute `Environment=PATH=...` line to the unit and remove its
`# Managed by sedes install:server` marker to keep those edits on later runs.

`--prefix` and `--bin-dir` change the install locations, `--systemd` opts into
unit creation or updates, `--no-activate` stages a release without switching to it, and
`--uninstall` removes the releases, links, and installer-managed unit while
leaving state and configuration in place. The installer refuses to replace the
active release. macOS installations use the default command without `--systemd`; Windows remains
outside this package installer.

A release staged with `--no-activate` carries its sample configuration.
A later `--activate VERSION` completes first-install setup
even if the original checkout is gone: it seeds missing configuration, creates
the launchers, then switches `current`. Add `--systemd` to that activation
command to create or update the owned service unit. Service preferences are
not stored with releases; each install or activation requires explicit opt-in.
Without the flag, existing units remain unchanged and are not disabled or
removed. Run `current/bin/sedes-server` directly or through your own supervisor
when not using systemd.

Existing launcher files and links belonging to another installation are
refused rather than replaced. Generated service units record their owning
installation prefix; installation refuses another prefix's managed unit, and
uninstallation leaves it untouched. Resolve a reported ownership conflict
before retrying.

Install, activate, and uninstall hold exclusive directory locks for the release
prefix and, when used, the shared launcher/configuration locations. A concurrent
operation fails with an installer-busy message. Locks are removed on success or
failure; after a process crash, inspect the reported lock's `owner.json` and
verify that installer process has stopped before removing that lock directory
and retrying. Locks are never reclaimed based only on elapsed time.

### Example systemd user service

The following is a starting point for a hand-managed service, or for reference
when the installed unit needs editing. Replace
every absolute path, build and verify the selected source separately, and keep
the environment file readable only by the service account:

```ini
# ~/.config/systemd/user/sedes.service
[Unit]
Description=Sedes coding-agent workspace
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/absolute/path/to/sedes
EnvironmentFile=/absolute/path/to/sedes.env
ExecStart=/absolute/path/to/npm start
Restart=on-failure
RestartSec=5s
TimeoutStopSec=35s
KillMode=control-group

[Install]
WantedBy=default.target
```

The environment file uses concrete values; systemd does not perform shell
expansion such as `$PWD` in them:

```text
APP_STATE_DIR=/absolute/path/to/state
PORT=4784
```

This user service reads `~/.config/sedes/server.json` by default. Add an
absolute `SEDES_CONFIG_FILE` entry only when the service account uses another
location. If `XDG_CONFIG_HOME` is set for the unit, it must be absolute and the
default moves to `$XDG_CONFIG_HOME/sedes/server.json`.

Load and start a user unit with:

```sh
systemctl --user daemon-reload
systemctl --user enable --now sedes.service
systemctl --user status sedes.service --no-pager
printf 'Authorization: Bearer %s\n' "$SEDES_AUTH_TOKEN" |
  curl --fail --header @- http://127.0.0.1:4784/api/health
```

Use the exact Node/npm installation selected during verification. A user unit
that must run while the account is logged out also depends on the host's user
manager/lingering policy. Do not add filesystem-hardening directives blindly:
the service must retain deliberate access to configured workspaces, native
provider stores, SSH material, state, and any owned executables.

## State, upgrades, and backups

Sedes stores its overlay database at:

```text
$APP_STATE_DIR/overlay.sqlite
```

The state directory also contains `.tool-provenance-key`, the installation
signing/authentication secret for lineage cursors, attachment/CLI namespaces,
restart-safe agent-tool thread source references, provider-private operation,
context, Task, attachment and history provenance, and principal Tool client
verifiers. Losing or replacing it breaks continuity of that evidence and
invalidates outstanding source references and Tool client credentials.
Treat the entire directory as one backup unit. `.state.lock` is separate transient
process-ownership metadata and is removed after a clean shutdown.

The overlay stores Sedes-owned state: projects, inventory, drafts, stashes,
principal execution configuration, runtime preferences and receipts, the
saved-prompt library, pending input, tasks, automations, saved
Agents, thread templates, immutable thread Agent origin, operation and creation
recovery, bindings, settings, lineage, and related metadata. Durable blobs live
under `composer-attachments/` for normalized user input and
`output-artifacts/blobs/` for supported immutable provider output; derived
local staging is under `execution-attachments/`. Terminal restore checkpoints
and their ordered output-journal suffixes are stored under `terminals/`. SQLite
and all of these files are one quiescent backup unit, so a database-only copy
is incomplete. Terminal output is sensitive application state; each retained
resource keeps a bounded checkpoint plus the raw suffix after its checkpoint.
Pi session/auth
state, Codex native state/authentication, Claude config/session/authentication,
and Grok native state/authentication remain provider-owned.
Keep the bootstrap, original pre-import JSON, and protected credential files
with the installation backup. Remote sidecar state and provider-native stores
are separate backup units on their hosts; main state alone cannot restore a
remote terminal's newest offline output or reconcile its active runtime.

Durable usage observations and session/turn summaries are also stored in
`overlay.sqlite`, scoped to the authenticated owner. Backing up main state retains
captured accounting; it cannot recover unobserved provider work. No usage sidecar
spool or separate usage service is required. Existing provider replay/history may
recover some gaps. A complete successful Pi history reconciliation clears its
interrupted-capture and storage-failure gaps; unproven coverage and conflicting
evidence remain visible. SDK numeric cost estimates are rounded to at most 18
fractional decimal places before storage, then summed with decimal arithmetic.

The durable-accounting migration preserves old Claude ledger totals as a
separate legacy summary with unknown coverage and its recorded time, and removes
their old authority.
Legacy totals are never added to newly selected accounting facts. Opening older
history registers visible turn identities without performing a global backfill.
Use the ordinary pre-migration backup and rollback procedure below.

Before an upgrade:

1. Settle active work and resolve or explicitly review uncertain creation,
   queue, mutation, provider-feature, interaction, and automation state.
2. Inventory remote sidecar work. Stop/quiesce managed services explicitly if
   the upgrade or backup needs a globally stopped snapshot; stopping main Sedes
   does not stop remote turns, shells, or retained results. Do not infer remote
   cleanup from an unreachable host.
3. Stop Sedes and verify the process is no longer running.
4. Copy the complete `APP_STATE_DIR` while it is quiescent.
5. Back up the server JSON and provider-native stores using the provider's
   own procedure.
6. Build the final source commit or tag that will actually run. With the
   [installed user service](#installed-user-service-on-linux), run the
   installer to stage and activate the new release.
7. Run the explicit configuration import if required, replace the old startup
   file with bootstrap11, then start it against the selected state and require a successful health check.

For example, after stopping and verifying the process, archive the state
directory by its parent so hidden files and all blob subdirectories are
included:

```sh
tar --create --gzip \
  --file /absolute/backup/path/sedes-state-YYYYMMDD_HHMM.tar.gz \
  --directory /absolute/path/to state-directory-name
tar --list \
  --file /absolute/backup/path/sedes-state-YYYYMMDD_HHMM.tar.gz
sha256sum /absolute/backup/path/sedes-state-YYYYMMDD_HHMM.tar.gz \
  > /absolute/backup/path/sedes-state-YYYYMMDD_HHMM.sha256
```

Record the source commit/tag, schema-era configuration file, provider-native
backup identifiers, packaged-client build, archive checksum, and stop time
beside the backup. Preserve modes and ownership when restoring. Test restores
against an isolated state path, port, and provider environment; never use a
production provider store as a downgrade experiment.

### Schema-10 cutover

Converting a schema-10 installation is a one-time offline step, not a runtime
configuration fallback: the server never reads a legacy JSON file at startup.
Run the import once while Sedes is stopped, against the installation's actual
state directory, and pass every previously admitted local workspace root
explicitly. The command, its options, and its validation-only form are in
[configuration changes and rollback](configuration.md#configuration-changes-and-rollback).

Before importing, inventory and preserve any remote provider history you still
need. Import preserves definition IDs, enabled state, defaults, and existing
thread and native bindings, leaves previously disabled definitions disabled
until you enable them in Settings, and names what to verify on an imported
remote backend before enabling it; those rules live with the command in
[configuration changes and rollback](configuration.md#configuration-changes-and-rollback).
Select a new default target if the previous default is unavailable.

After a successful import, replace the startup file with the schema-11
bootstrap example, keeping the installation listener, origin admission, and
state path. Start the selected build, require a successful health check, then
verify desired against applied state in Settings for environments, backends,
targets, and terminal policy before resuming work. Live process continuity does
not extend across a sidecar or provider crash or a host reboot, so confirm
remote runtimes explicitly instead of assuming they survived the cutover. When
packaging Linux assets on a newer distribution than the target hosts, follow
[Sidecar native builds](../developer/sidecar-native-build.md) before the
cutover.

### Restore and rollback

A restore is a complete, stopped-state replacement, not a merge into the
current directory:

1. Reconcile or stop remote sidecar work before replacing main state. A restored
   snapshot must never claim ownership over unaccounted live remote resources.
   Stop the candidate/current Sedes process and verify no process owns either
   the source backup state or the new restore path.
2. Verify the archive checksum against the recorded value. List the archive and
   confirm it contains the expected single state root, `overlay.sqlite`,
   `.tool-provenance-key`, and the expected blob directories; reject unexpected
   absolute paths or traversal entries.
3. Create a **fresh**, empty, owner-only restore parent and extract there. Do
   not extract over, copy into, or partially replace a live or previously used
   `APP_STATE_DIR`.
4. Restore test copies of the exact source commit/build, server configuration,
   provider-native stores, protected token material, and packaged client
   recorded with that snapshot. An application-state archive alone is not a
   complete rollback.
5. Point a test service at the validation copy using a nonconflicting loopback
   port and disposable provider authority. Do not let restored schedules replay
   against production accounts. Require startup, health, target availability,
   and representative read-only history/file checks. Treat this validation
   state as consumed because startup migrations and schedulers can mutate it.
6. Stop the test process. Extract the archive again into a second fresh,
   owner-only cutover path. Keep the old live state intact, update the production
   service to the clean restored path and matching release/configuration/provider
   state, then start and health-check once.
7. Retain the pre-cutover state until the restored installation is accepted.
   If rollback is necessary, stop first and switch the entire matched set; do
   not run an old binary against state already migrated by a newer release.

Example archive inspection and extraction commands are:

```sh
sha256sum --check /absolute/backup/path/sedes-state-YYYYMMDD_HHMM.sha256
tar --list --file /absolute/backup/path/sedes-state-YYYYMMDD_HHMM.tar.gz
mkdir --mode=0700 /absolute/new-restore-parent
tar --extract --gzip \
  --file /absolute/backup/path/sedes-state-YYYYMMDD_HHMM.tar.gz \
  --directory /absolute/new-restore-parent
```

Inspect the listing before extraction. The destination must be a newly chosen
path owned by the service account, not the active state directory.

Migrations can reject nonterminal or malformed legacy state rather than guess
how to rewrite it. Follow the exact startup repair error, restore the backup if
needed, repair with the matching old application, and retry; stopping alone
does not make every state migratable.

Keep the quiescent overlay database, installation key, blobs, configuration,
and compatible browser/packaged client together. A stale packaged client fails
at the explicit browser protocol fence. Tool clients or other state created
after a restored snapshot do not survive that restore.

For an existing older database, startup creates and integrity-checks a
pre-migration SQLite backup under `$APP_STATE_DIR/backups/` before applying the
one-way migrations. Automatic retention keeps at least the newest five, every
recognized backup no older than 30 days, and the newest backup for each schema;
other recognized backups may be pruned after migration. Do not rely on that
directory as the only operator backup, and do not edit a deployed migration to
make older code accept newer state.

An older binary rejects a newer database. Rollback therefore means stopping
the new binary and restoring the matching pre-upgrade application state,
configuration, and compatible provider state—not pointing the old binary at
the migrated overlay. Use distinct `APP_STATE_DIR` values for worktrees or
branches with potentially incompatible schemas.

If startup explicitly requests `SEDES_QUIESCENT_CUTOVER_CONFIRMED=1` for a
legacy database, follow that error's cutover procedure with all Pi owners idle,
queues empty, and uncertain work resolved. It is not a routine or general
upgrade flag.

## Restart and recovery

What survives a main-server restart, a carrier loss, or a target restart, and
what must be proven before a resource is replaced.

### Main restart and local resources

Local terminal processes are owned by main Sedes; shutdown cleans them up and
preserves verified retained history. Persistent remote terminal/provider
processes are owned by the sidecar and continue across main shutdown or SSH
loss. Use explicit environment lifecycle controls when remote work must stop;
an unreachable host does not prove cleanup. See
[Operating terminal resources](terminals.md#restart-and-transport-recovery).

### Persistent remote services

Each admitted SSH environment uses an owner-only persistent sidecar for remote
provider runtimes and separately granted Files, tools, attachment, skill, and
terminal operations. OpenSSH supplies bootstrap and transport identity; it does
not define the lifetime of admitted work. A main-server restart or carrier loss
reattaches to the same service and resources after identity/version checks.
It does not submit a prompt again, recreate a terminal, or turn an unknown file
mutation into a new write.

**Settings → Environments** reports desired/applied revisions, connection
state, service version, upgrade state, and active-resource observations.
**Disconnect** preserves remote work and intentional disconnection across main
restarts. **Stop** requests service shutdown and persists stop preference even
if the host is unreachable; only confirmed cleanup is displayed as stopped.
**Connect** or **Start** explicitly resumes an intentionally suppressed runtime.

A stop, restart, or upgrade whose acknowledgement was lost stays **unknown**
until its durable service receipt settles it or a later explicit Stop safely
supersedes it. A prior command still executing locally or on the same remote
service must finish first. A verified retired service cannot keep executing its
old command, but its final outcome may remain unconfirmed. The service admits a control by
writing an `accepted` receipt for its mutation id before any effect, so a
missing receipt on an unchanged service means the command has not been
admitted yet, not that it never will be: request bytes can still be delivered
after the carrier failed. After about a minute of such observations, main
withdraws the mutation id on the service, which atomically records a terminal
`withdrawn` receipt unless an admission already exists. Only then is the
outcome reported as "never reached the sidecar; nothing changed": a late
arrival of the same command finds the withdrawn receipt and is refused
(`sidecar_management_mutation_withdrawn`) without stopping anything. If the
withdrawal instead returns an existing receipt, the command was admitted after
all and recovery keeps following that receipt. The service also refuses to
begin a control whose requester connection has already ended by the time its
admission completes; that command settles as failed with
`sidecar_management_requester_gone` and nothing changed.

After a Sedes upgrade, main attaches to a running sidecar whose runtime
protocol is still compatible even though its build is older, reports it as
**Upgrade available**, and keeps serving its existing work. Automatic artifact
replacement then happens as soon as the service is observed idle, on the next
connection or maintenance pass, without a prompt. Active provider turns,
pending approval decisions, commands, transfers, unsettled receipts, live
terminals, unacknowledged final terminal history, or unknown ownership
block automatic replacement until they settle. **Upgrade and restart** obtains
a fresh interruption impact before acting. Confirmation authorizes interruption
of owned work and abandonment of unrecovered transient outcomes; retained
delivery state does not block this explicit shutdown. Provider-native history
stays in its existing store, and bounded abandonment metadata is archived on a
best-effort basis as described in [Configuration](configuration.md). Replacement
still requires proof that owned processes stopped. Artifact staging and
verification finish before conversation interruption; staging failure leaves
the existing service and connections in place. A failed replacement remains
visibly failed rather than claiming healthy rollback.

Recovery can read and acknowledge an older artifact's retained results when its
runtime wire version and required capability versions remain compatible. An
incompatible runtime protocol prevents normal attachment and automatic recovery,
but explicit **Stop** and **Upgrade and restart** use the stable management
protocol. Main does not require runtime history handoff before submitting that
confirmed shutdown. The running daemon enforces its own cleanup rules; an older
daemon may still require its retained work to settle before it can be replaced.

A service that answered but refused or deferred attachment (an upgrade blocked
by active resources, an incompatible runtime, a pending saved revision,
unproven cleanup, or retained results awaiting handoff) is reported with that
reason and remains observable; only a host that could not be reached at all is
reported as unreachable. Intentionally stopped or disconnected environments are
still observed passively so their status stays current after a main restart.
A restart or upgrade whose old service has already stopped replaces the
environment runtime with the saved revision before the new service attaches.

Unproven cleanup does not stop the service forever: an explicit **Stop** retries
the owned-resource shutdown and, once every resource proves it ended, records
the service as stopped. Until then replacement stays blocked. The daemon
handles `SIGTERM` by attempting the same forced stop; if cleanup is unproven it
exits with its ownership record still marked running, so a later start requires
recovery, and a second signal always forces an exit. A daemon that has recorded
`stopped` exits on its own; a replacement bootstrap prompts a lingering one
with `SIGTERM` after three seconds and `SIGKILL` after ten. If every resource
proved it ended but the daemon then failed to close its remaining hosts or to
record `stopped`, the **Stop** or **Upgrade and restart** request reports that
failure, its receipt records the same code, and the daemon still exits; its
ownership record may still read `running`, so the next start requires the same
recovery.

When the management endpoint is missing, the runtime status distinguishes:

- `sidecar_service_owner_unreachable`: the exact recorded daemon process is
  still alive. Inspect that environment's daemon on the host and request its
  graceful shutdown (`SIGTERM` on Linux/macOS), then retry. Check the recorded
  process start identity as well as its PID before signaling; a reused PID is
  not the same process. Leave other environments and external provider servers
  alone.
- `sidecar_service_orphan_cleanup_unproven`: the recorded daemon has exited,
  but there is no durable proof that its owned workers, terminals, and commands
  stopped. This is an ownership problem, not a retained-result reconciliation
  request. Restarting main or killing another daemon cannot establish cleanup.
- `sidecar_service_target_identity_unavailable`: the host's native process
  identity facility could not be read. Restore that access before retrying;
  unreadable identities do not authorize deleting ownership records.
- `sidecar_service_recovery_required`: the saved ownership record or process
  identity cannot be validated. Inspect the exact service's files and host
  identity before repairing anything.

An explicit Stop can abandon retained results while still proving physical
cleanup through the live daemon. A daemon that was already killed cannot
perform that cleanup. The current implementation has no durable per-child
ownership ledger, so even a daemon that appears idle cannot be automatically
replaced on the same host lifetime solely because its PID disappeared. Verify
cleanup of that exact service and all its children before repairing its
ownership descriptor; an absent socket or missing supervisor PID alone is not
cleanup evidence. Proven spawn failures and early child exits before daemon
ownership are recorded as stopped automatically.

### SSH target restart recovery

Every SSH execution environment uses the same ownership checks, whether its
target is a host or a container. Sedes does not detect containers or require
extra host mounts. The existing account home stores the ownership record;
process lifetime is read from the target's own platform identity facility (`/proc` on Linux, the native ownership helper on macOS or Windows).

An environment identifies one target at a time. Its management commands,
bootstrap, and sidecar must run in the same target PID namespace; replacing the
target retires its previous instance. This is the ordinary single-target SSH
model, not a shared service identity across several live targets.

New descriptors and startup locks record the target's boot and process lifetime,
including the clock offset needed to compare process start times. These checks
identify a new target lifetime even when Linux reuses a PID-namespace ID,
allowing stale ownership to be retired automatically.
Thus a container restart recovers even when its home directory and the host's
boot ID remain unchanged. The artifact-independent management carrier and
startup use the same check, so **Start** and **Upgrade and restart** can proceed.

If the target lifetime is unchanged, a missing supervisor alone does not prove
its Codex processes, terminals, or commands stopped. Recovery remains blocked
until their cleanup is confirmed. An unreadable or ambiguous target identity
also remains blocked and reports ownership recovery, rather than host
unreachability. `sidecar_service_target_identity_unavailable` means Sedes could
not validate the target's own process view.

Older descriptors and startup locks lack this target lifetime identity. A
clean **Upgrade and restart** from the previous format needs no manual step:
the old service records `stopped` only after proving its resource cleanup, and
the new bootstrap waits for that exact daemon process to exit before replacing
it. An older record still marked `starting` or `running` (the old daemon
crashed or was killed) requires one-time recovery. After confirming the old
service and all its children have exited, move the exact service's
`service.json` and any abandoned `startup.lock` to timestamped backups, then
retry **Start** or **Upgrade and restart**. Startup handles the abandoned
socket. Keep receipt, transcript, and terminal state intact. New records then
support automatic recovery after later target restarts.

The sidecar retains bounded results and terminal output while main is absent.
On reconnect, explicit Files events subscriptions refresh from authoritative
state. Browse and Compare use explicit refresh actions without filesystem
subscriptions. Tools requiring
main's current task, thread, or policy authority report unavailable; there is
no disconnected task/message queue or implicit retry. Already admitted remote
work cannot immediately observe a new main-side policy revocation while cut
off. Revalidate before admitting new work after reconnect.

A sidecar crash or explicit service restart is a separate interruption boundary.
Unknown child cleanup fences conflicting replacement work. Provider history
remains provider-owned; there is no second chat transcript journal in Sedes.
External Codex daemons remain operator-managed and are not killed by sidecar
Stop/Restart/Upgrade. Explicit Stop retires the sidecar connection and marks
unavailable outcomes as interrupted; it does not claim the external server
stopped. Automatic replacement still waits for trustworthy idle evidence.

For a host backup, use the reported service identity/state location and preserve
its owner-only modes alongside provider-native stores. Never remove artifact,
state, receipt, or terminal directories while a service may own them. Restoring
main state requires reconciling the remote identities and results from that
same recovery point, not treating an old main snapshot as current authority.

## Security boundary and incident response

Least-authority boundaries inside the trusted installation, and what to do when
that boundary may have failed.

### Agent-tool caller boundary

An eligible provider process receives an opaque `htr2_` bearer reference for
its exact Sedes source thread and HTTP or sidecar ingress. Callers cannot
select that association by supplying a thread ID. The encrypted reference
survives provider/Sedes runtime replacement under the same installation key;
it is deliberately stable and is not an active-turn lease. Sedes re-resolves
the current thread, policy, environment, and backend on every request. A valid
reference can discover and invoke exactly what that thread's current policy
permits, whether or not a provider turn is active. Request cancellation aborts
the corresponding invocation; provider-native turn identity is not an
authorization input.

A principal-owned Tool client instead presents a `hatc1_` credential over the
management HTTP(S) agent-tool routes. Its retained row supplies scope, current
generation, enabled/revoked state, exact tools, explicit environment allowlist,
and defaults. It has no source thread or interactive cross-environment
approval. Disable is reversible; rotation invalidates the old generation for
later admissions; revocation is terminal. Plaintext is returned only once on
create/rotate and is never recoverable from Sedes state.

Both provide attribution and least-authority inside the trusted installation
and do not replace paired management-client authentication or the deployment
matrix. A provider process that can read a thread reference can exercise the
thread's current policy whether or not a provider turn is active. A holder of a Tool client
token can exercise that client's current policy; it cannot use that token to
authenticate unrelated management APIs. Do not expose provider/client environments, shell history, process
dumps, diagnostics, or logs containing either bearer value. Keep every
listener, external CLI process, and managed SSH account inside the same trusted
boundary described above.

### Incident response

If a Sedes listener may have been reachable by an untrusted client, follow the
[operational response](../../SECURITY.md#operational-response) steps in the
security policy: restore the boundary, preserve and review the relevant logs,
revoke exposed paired-client credentials with the
[pairing CLI](#pairing-clients), rotate provider and principal Tool-client
credentials, and treat workspace contents, application state, attachments, and
provider conversation data as potentially disclosed. When state integrity is in
doubt, restore only from a quiescent, verified backup as described in
[Restore and rollback](#restore-and-rollback).

## Live smoke and measurement commands

These commands target an already running production-shaped server and are not
part of the deterministic test suite.

Set `SEDES_AUTH_TOKEN` from the protected device credential described under
[Credentials for operator scripts](#credentials-for-operator-scripts).

`measure:thread` is read-only. It reports the application session handshake and
repeated initial-stream measurements and aborts after the authoritative
snapshot:

```sh
npm run measure:thread -- THREAD_ID --repeats=3 \
  --url=http://127.0.0.1:4784
```

Restart the server immediately beforehand only when the first sample must be a
guaranteed cold attach.

The live streaming smoke test is mutating: it creates and sends one real
thread through the explicitly selected environment, target, and project, then
records visible state changes. It does not archive or delete the created
Sedes/provider conversation. Verify that all three selections are intended
before running. If the provider asks for permission to run the smoke's exact
command, the script grants that request once.

The smoke opens a fresh browser and checks the server’s public authentication
status. When authentication is required, it pairs through the UI before creating
the thread. Run `sedes auth pair --server http://127.0.0.1:4784` on the server and
copy the returned `code` value. Supply a fresh management code for every run;
it expires after five minutes and is consumed once. This Bash invocation reads
it without echoing it or putting its value into shell history:

```sh
read -rsp 'Fresh management pairing code: ' SEDES_SMOKE_PAIRING_CODE
printf '\n'
SEDES_SMOKE_PAIRING_CODE="$SEDES_SMOKE_PAIRING_CODE" \
SEDES_SMOKE_URL=http://127.0.0.1:4784 \
SEDES_SMOKE_ENVIRONMENT=Local \
SEDES_SMOKE_TARGET=Pi \
SEDES_SMOKE_PROJECT=my-project \
  npm run test:smoke-live-streaming
unset SEDES_SMOKE_PAIRING_CODE
```

If the server explicitly reports authentication disabled, omit the pairing-code
read, assignment, and unset lines; the smoke skips pairing. It does not infer
disabled authentication from a failed or malformed status response.

When pairing is required, the paired client is named **Live streaming smoke**; revoke its entry in
Settings after the run. The script closes its browser without saving the
browser session.

Screenshots default to `test-results/live-streaming-smoke/` and are local
artifacts. The script consumes real provider capacity when the selected target
does.

## Troubleshooting

### Server will not start

- **Port in use:** stop the existing process or choose another validated
  `PORT`.
- **State/provider lock owned:** stop the actual owner. Do not delete a live
  lock file or bypass the native-store gate.
- **Configuration rejected:** validate the schema-11 bootstrap. If it contains
  old execution fields, use explicit offline import. Repair database environment,
  provider policy, paths, references, and unavailable runtime status in Settings.
- **Newer database rejected:** run the matching newer source or restore a
  compatible backup; do not downgrade the database in place.
- **Permission denied:** verify the service account can traverse the source,
  configuration, state, workspace, executable, provider-store, socket/token,
  and SSH paths it was deliberately given. Do not make credentials or state
  group/world-readable as a shortcut.
- **Owned provider preflight failed:** run the configured executable and its
  authentication check as the exact service account with the same `HOME`,
  `PATH`, optional provider home, and service-manager environment.

### No project or model is available

- Ensure the project path exists beneath the saved environment workspace roots for local access or
  beneath the configured SSH environment roots for remote access.
- Verify the provider runtime, native authentication, endpoint, live catalog,
  and model policy as the service account. Use the matching
  [backend troubleshooting guide](backends/index.md#common-troubleshooting)
  for provider-specific commands and release admission.

### SSH or remote operations are unavailable

- Verify the OpenSSH alias non-interactively in the installation account.
- Confirm that the remote project path is canonical and beneath a configured
  remote root.
- Check the saved/applied environment revisions, intentional connection
  preference, service version, and last error in Settings. **Disconnect** and
  **Stop** intentionally suppress background reconnect even after main restart.
- Provider runtime and optional operations have independent admission. A healthy
  sidecar does not grant every Files, attachment, agent-tool, or terminal action.
- Verify the selected host's supported runtime/artifact and owner-only service
  state, plus Git for repository operations and shell/search tools for Pi SDK.
  Do not replace a live service or delete its state to clear an unknown status.
- An environment with `operations.kind: "none"` has no optional remote
  operations. Enabled remote targets require a sidecar; Pi SDK also requires
  the complete workspace tool/context pair.
- Remote terminals require admitted `interactive_terminal` support. Main or SSH
  loss leaves them on the sidecar; reconnect reconciles exact process identity
  and retained output. Service crash/restart is a separate interruption boundary.
- Upgrade pending can reflect a live shell at its prompt, unsettled results,
  pending interactions, unacknowledged terminal output, or unknown ownership.
  Review impact and preservation requirements before explicit replacement.

### A browser or packaged client cannot connect

- Check `/api/health` from the server host with a paired management credential before debugging the client.
- Name the build in every report. `/api/health` returns
  `{"status":"ok","version":"X.Y.Z"}` for a paired management credential, and
  `sedes --version` or `sedes-automation --version` prints `sedes X.Y.Z` for an
  installed CLI. In a browser or packaged client, **Settings → Diagnostics**
  names the client build and, when the two differ, the connected server's
  build; quote both with the copied diagnostics buffer.
- For a local browser, use the exact loopback origin and confirm the configured
  port. A production server does not serve on Vite's development port 5173.
- For Tailscale Serve, compare the exact DNS name in
  `ALLOWED_TAILSCALE_HOSTS` with `tailscale serve status`. Restart Sedes after
  changing its environment; configuring Serve alone cannot hot-reload Host and
  Origin policy.
- For Android or Electron, enable the matching packaged-client origin. That
  server-file entry does not change the socket listener. With `adb reverse`,
  keep Sedes on loopback; with direct LAN access, require the explicit
  wildcard-bind and trusted-LAN-Host pair.
- A `host_not_allowed`, `origin_not_allowed`, or
  `forwarded_origin_not_allowed` response means the request crossed a boundary
  the running process did not admit. Correct the exact deployment shape rather
  than adding wildcards or disabling the check.
- Check host and network firewalls for LAN access. Remember that a reachable
  cleartext LAN listener exposes pairing codes, credentials, and application
  traffic to network observers even though API authentication is required.

### Accounts quota observations are unavailable

- Confirm `SEDES_PROVIDER_PULSE_URL` is not `off`, `0`, or empty and points to
  one loopback `http://` origin with an explicit port and no path.
- Query Provider Pulse on the server host and inspect its service logs. Sedes
  does not start or authenticate that separately operated process.
- Restart Sedes after changing the integration URL. The browser never contacts
  Pulse directly, so changing browser CORS settings cannot repair the proxy.
- An unavailable Pulse integration should not affect conversations, Files,
  tasks, or provider execution; diagnose it as an optional installation
  service.

### An operation is uncertain

When the composer shows **Queue paused: an earlier delivery needs reconciliation**,
use **Reconcile delivery** to check that earlier message. Additional queued
messages cannot dispatch until it is resolved. Your draft and queued messages
remain intact; an unresolved check keeps the notice visible.

Follow the exact recovery callout. A reconnect or restart may reveal provider
evidence that proves accepted or not applied. Do not repeat a write merely
because the old HTTP connection disappeared. Use **Force reset…** only after
reviewing the preview and accepting that it abandons Sedes blockers without
stopping or rewriting provider state.

### Deeper latency diagnosis

Use only the implemented opt-in flags described in
[Debug diagnostics](../developer/diagnostics.md). Diagnostics can include thread IDs,
lifecycle reasons, and raw error messages; review and redact logs before
sharing them.

Return to the [operator guide](index.md) or continue with
[Configuration](configuration.md).
