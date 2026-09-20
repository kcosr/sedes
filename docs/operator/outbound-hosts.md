# Outbound hosts

An outbound host runs a Sedes connector that calls your server over HTTP or
HTTPS. Accept its registration in **Settings → Environments → Review hosts**,
then configure backends and projects on the resulting environment. No inbound
SSH connection or stable client IP address is required.

The connector carries the same sidecar operations as SSH. A separate persistent
sidecar owns provider processes, terminals, and operation recovery on the host.
Keeping the connector running makes that host reachable; stopping it detaches
access without stopping the sidecar's work.

## Prerequisites

- Build and run the Sedes server with Node.js **24.18 or newer**. The ordinary
  `env -u NODE_ENV npm run build` includes both the downloadable connector and
  runtime artifacts. After a server update, rebuild before offering downloads.
- Install Node.js **22.19 or newer** on the connecting host. Provider tools and
  their authentication remain separately installed for the account running the
  connector. Its environment and filesystem authority are that account's.
- On **macOS**, install Xcode Command Line Tools before starting the connector.
  Run `xcode-select --install` if they are missing. First startup compiles a small
  process-ownership helper against the local SDK; without a working C compiler,
  startup fails with `sidecar_macos_command_line_tools_required` before a pending
  registration appears. Apple silicon and Intel are targeted.
- On **Windows**, use a native x64 or arm64 Node installation, an available
  Windows PowerShell installation, and an account permitted to use the required
  process and private-file APIs. Interactive terminals require built-in ConPTY
  on Windows 10 build 18309 or later. Windows shells are native Windows shells.
- On **Linux**, use an x64 or arm64 host with the process-ownership facilities
  required by the persistent sidecar. Native terminal support additionally
  depends on the release's matching architecture, Node ABI, and glibc floor.
- The host must reach the same supported private server origin used by Sedes
  clients. Preserve the Host allowlist and existing private ingress boundary;
  this feature does not relax server listener configuration.

HTTP uses `ws://` for both connections and HTTP for downloads. HTTPS uses
`wss://` and HTTPS, with normal certificate verification. A private reverse
proxy must forward WebSocket upgrades for `/api/outbound/control` and
`/api/outbound/runtime`, as well as the HTTP download routes. Use the server
origin, including its port when needed; URL credentials, query strings,
fragments, and path prefixes are not supported.

By default, the connector must first exchange a single-use sidecar pairing code for an
authenticated credential. Server approval and the registration code remain a
separate configuration binding and correlation check. When the server explicitly
sets `SEDES_AUTH_REQUIRED=false`, the connector may start without a pairing code;
existing saved credentials are retained. Hosts first approved without credentials
in that mode must be revoked and registered again with a new authenticated
connector identity when authentication is re-enabled. Authentication does not
encrypt HTTP. Use the already configured trusted private access boundary in
[Operations and security](operations.md); do not expose these routes publicly.

## Download and start

In **Settings → Environments → Add environment → Pair a host**, use **Download connector** and
copy the displayed command. Save `sedes-sidecar.mjs` on the connecting host. The
single downloaded JavaScript file is sufficient when invoked through Node; it
does not require an npm installation on that host.

First, run on the server as its operating-system account, using the same
configuration and state environment as the running server:

```sh
sedes auth pair --server http://192.168.1.50:4784 --sidecar
```

Use the returned code in place of `CODE` below. It expires in five minutes and
works once. Alternatively, start the connector with `connect --pairing-url
'URL_FROM_SERVER'`; the URL supplies both the server origin and code. The
connector saves the resulting credential in its protected connector state file
and reuses it on later starts without a pairing argument. Keep that file and
pairing command history private. Management pairing codes cannot enroll
sidecars, and sidecar credentials cannot access management APIs. The connector
bundle itself remains downloadable without authentication; runtime operations
and downloads require the connector's credential.

For example, with an already configured private HTTP server at
`http://192.168.1.50:4784`, run on macOS or Linux:

```sh
mkdir -p "$HOME/sedes-connector"
cd "$HOME/sedes-connector"
curl --fail --output sedes-sidecar.mjs \
  http://192.168.1.50:4784/api/outbound/connector/sedes-sidecar.mjs
node sedes-sidecar.mjs connect --server http://192.168.1.50:4784 --pairing-code CODE
```

In Windows Command Prompt:

```bat
mkdir "%USERPROFILE%\sedes-connector"
cd /d "%USERPROFILE%\sedes-connector"
curl.exe --fail --output sedes-sidecar.mjs http://192.168.1.50:4784/api/outbound/connector/sedes-sidecar.mjs
node sedes-sidecar.mjs connect --server http://192.168.1.50:4784 --pairing-code CODE
```

Substitute your actual admitted origin. For HTTPS, use the `https://` URL in
both commands. Do not bypass certificate verification to make a connection work.
A 404 with `outbound_connector_not_built` means the server operator must run the
server build first.

An operator can instead copy the output of `npm run build:connector` from
`dist/connector/`. Keep its bundle and launchers together. The POSIX wrapper is
`./sedes-sidecar`; the Windows wrapper is `sedes-sidecar.cmd`:

```bat
sedes-sidecar.cmd connect --server http://192.168.1.50:4784 --pairing-code CODE
```

Keep the process running. It prints its registration code and waits for a
server-side decision. Network failures use bounded reconnection backoff.

## Approve and configure

1. Open **Settings → Environments → Review hosts** on the server. Compare the
   registration code with the connector's output and review its reported
   hostname, operating system, architecture, and account.
2. Select **Accept**, enter an environment name and absolute workspace roots on
   that host, then select the allowed sidecar operations. Examples are
   `/Users/you/Projects` on macOS, `/home/you/projects` on Linux, and `C:\Projects`
   on Windows. Accepting creates the environment; it does not install providers.
3. Enable **Directory browsing** and **Files and comparisons** for normal
   project navigation and Files. Add **Workspace tools and context** for Pi's
   remote workspace tools, **Workspace skills** for skill discovery,
   **Attachment staging** for remote attachments, **Sedes tools for remote
   agents** for the agent CLI, and **Interactive terminals** when wanted.
4. Open the paired environment, select **Add backend**, and configure its
   supported provider endpoint or executable. Add a project
   beneath one of the saved host roots, then use its available target normally.

Roots and capability grants remain editable environment settings. Grants permit
an operation; the connected host must also advertise the corresponding support.
Shell and provider execution use the host account's authority. Workspace roots
are not an operating-system sandbox for shell processes.

| Feature | Outbound behavior |
| --- | --- |
| Files and Git comparisons | The shared sidecar implements browsing, reads/writes, transfers, watchers, links, and comparisons on the selected host. |
| Attachments | Materialized on the execution host through the same granted attachment-staging capability. |
| Workspace tools, context, and skills | Use the same remote engines and grants as SSH, including their search-tool and shell prerequisites. |
| Terminals | Persistent sidecar-owned terminals reconnect with retained output when native PTY support is available. Missing native assets omit terminal support without disabling Files or provider connections. |
| Codex | Provider connection and execution run through the persistent sidecar. Managed TUI additionally requires negotiated native PTY support. |
| Pi | The Pi SDK stays on the Sedes server; the paired host supplies remote workspace operations. Pi is not installed or executed remotely by this feature. |
| Claude | On Linux/macOS with Node.js 24.18+, the pinned Agent SDK and authenticated Claude Code installation run through the persistent sidecar. Native Windows Claude is unsupported. Files, attachments, and CLI tools require their own grants. |
| Grok | Remote execution remains intentionally unsupported; its current backend requires a local environment. |

See the [Codex](backends/codex.md), [Claude](backends/claude.md), and [Pi](backends/pi.md) guides for provider
versions, executable/endpoint setup, tool prerequisites, and remaining limits.

## Identity, availability, and decisions

The connector keeps its connector ID, registration attempt, and accepted
binding in `~/.local/state/sedes/connector/identity.json`, including on Windows
beneath the current account's home. Preserve that directory across restarts,
connector upgrades, and changes in the host's network address. Hostname and IP
address are observations; neither identifies the paired installation. A changed
server URL can reach the same server installation while preserving that binding.

Use `--state-directory <absolute-path>` to select another durable private state
directory. A new directory creates a new connector identity; do not clone an
accepted identity onto another running host. Only one connector process can own
one identity, and the server rejects simultaneous connections for that identity.
Keep the server's application state and the host's connector/sidecar state in
backups. A different server installation cannot silently adopt an old binding.

**Host online** means the connector's current control connection is alive.
Runtime status is separate: a host can be online while its runtime is stopped,
outdated, or unavailable. Backend and terminal availability also require their
current admitted connection and capabilities. Disconnection removes execution
availability; it does not delete the environment, project, history, or owned work.

The server retains at most 256 registration records per principal. When a new
request needs space, it removes the oldest denied or expired records; pending
requests, accepted registrations, pairings, and decision receipts remain. If an
old connector attempt returns after its terminal record was removed, it creates
a new pending request requiring fresh approval. Earlier approval or denial
requests cannot act on that new request. A full set of pending or accepted
registrations still blocks new requests until capacity is available.

- **Deny** rejects a pending registration. An expired or denied unpaired request
  stays terminal locally. To make a deliberate new request, restart with
  `--retry-registration`; it keeps the connector ID and creates a new attempt.
- **Revoke pairing** withdraws server access and disconnects the host. The
  environment and history remain, but its sidecar credentials are permanently
  revoked. Revocation does not terminate host-owned
  processes; stop work first when termination is intended.
- **Reapprove pairing** restores the retained binding and saved grants. After
  reapproving in Settings, create a fresh `--sidecar` pairing code on the
  server and restart that same connector with `--resume-pairing`:

```sh
node sedes-sidecar.mjs connect --server http://192.168.1.50:4784 --resume-pairing --pairing-code NEW_CODE
```

Re-enrollment of an existing authenticated connector requires both a fresh
pairing code and proof of its previous credential. The connector sends that
proof automatically from its protected state file, even after server-side
revocation. Keep the original state to resume its retained binding. A pairing
code and a copied connector ID alone cannot claim an approved host.

Connectors created before API authentication cannot inherit approval from their
old IDs. Enroll using a fresh connector state directory and complete a new
authenticated registration and approval; there is no automatic conversion of
old connector identity into authenticated authority.

`--resume-pairing` resumes a revoked pairing; a fresh pairing code also permits
resume when the connector missed the revocation notice. It cannot be combined
with `--retry-registration` and never creates another environment.
Revoke a pairing before removing its environment; existing backend references
must also be removed before the environment can be deleted.

## Runtime updates and supervision

The server stages the exact runtime release over the same HTTP(S) origin and
verifies the script and every declared native file before publishing it on the
host. The generated script includes the native manifest, so native file changes
also change the script's content address. Partial downloads do not become an
active release, and owned incomplete installations can be repaired.

Compatible reconnection attaches to existing work. An outdated idle sidecar can
be safely replaced; active work, uncertain outcomes, or unproven cleanup block
automatic replacement. Use the runtime controls in Settings to inspect, stop,
restart, or explicitly confirm a disruptive update. A runtime restart can
interrupt terminals and provider processes. Restarting only the connector does
not intentionally restart the runtime.

**Connector upgrades are manual.** Download the newly built connector, stop the
old connector process, replace its bundle, and restart it with the same state
directory. There is no published automatic connector upgrade channel. A connector
protocol mismatch may require this update before it can reconnect.

For unattended operation, configure an account-owned service using an absolute
Node executable and bundle path, a durable state directory, and the intended
provider PATH/environment. This repository does not install launchd, systemd,
or Windows services for you. Keep connector and daemon supervision separate:
for example, a systemd service's default control-group cleanup can kill detached
runtime children when stopping the connector. Process detachment alone does not
prevent a supervisor from terminating the entire process group or job.

## Native support and validation limits

The release collector includes the pinned upstream macOS x64/arm64 PTY addon and
spawn helper, and Windows x64/arm64 ConPTY addons and JavaScript helpers. Linux
x64/arm64 entries exist only when a real matching compiled addon is available;
a Linux x64 build does not invent a Linux arm64 binary. Darwin/Windows addons use
the inspected Node-API version. Linux additionally checks its recorded Node ABI
and actual ELF glibc requirement, so changing the host's Node line can leave
terminals unavailable even when the connector itself meets Node 22.19.

The implementation's Linux validation covers the bundled runtime, native PTY
startup, portable binary metadata, and failure paths. It does **not** establish
native execution validation on macOS or Windows. Test the intended native host
before relying on unattended work. This container's Linux build is not a claim
of compatibility with Rocky Linux 8. See
[Native sidecar builds](../developer/sidecar-native-build.md) for the exact
artifact contract and separately qualified Linux builds.
