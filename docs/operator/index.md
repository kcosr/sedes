# Operator guide

This section is for the person who installs, configures, upgrades, backs up,
and exposes a Sedes server. Sedes currently exposes one server-derived local
principal: the operator is responsible for the operating-system account,
provider credentials, filesystem access, network boundary, and state backups.
Use the server-account [pairing CLI](operations.md#pairing-clients) to enroll
browsers, packaged clients, and outbound connectors before API access.

If you only want to use an existing installation, start with
[Getting started](../user/getting-started.md). Contributors should use the
[developer documentation](../developer/index.md).

## Start here

| Goal | Guide |
| --- | --- |
| Install and run from source | [Run from source](#run-from-source) |
| Build, verify, and install a slim server package | [Server distribution](server-distribution.md) |
| Select providers, targets, models, roots, and integrations | [Configuration](configuration.md) |
| See how clients, provider runtimes, and execution environments fit together | [Connection model](connections.md) |
| Choose a safe deployment shape | [Operations and security](operations.md#deployment-matrix) |
| Connect a host that calls the server over HTTP or HTTPS | [Outbound hosts](outbound-hosts.md) |
| Configure and recover interactive terminal resources | [Operating terminal resources](terminals.md) |
| Operate a production process | [Production lifecycle](operations.md#production-lifecycle) |
| Back up, upgrade, or roll back | [State, upgrades, and backups](operations.md#state-upgrades-and-backups) |
| Reach Sedes through a tailnet | [Tailscale Serve](operations.md#tailscale-serve) |
| Put a private HTTPS proxy in front | [Private HTTPS reverse proxy](operations.md#private-https-reverse-proxy) |
| Connect a packaged client | [Android and Electron](clients/index.md) |
| Manage automations from scripts | [Automation CLI](automation-cli.md) |
| Diagnose startup, availability, or remote-operation failures | [Troubleshooting](operations.md#troubleshooting) |

Provider and packaged-client details are separate references:

- [Pi](backends/pi.md), [Codex](backends/codex.md),
  [Claude](backends/claude.md), and [Grok](backends/grok.md)
- [Android](clients/android.md) and [Electron](clients/electron.md)

## Before installing

Sedes currently supports Linux x64 and macOS on Apple silicon or Intel, and
requires Node.js 24.18 or newer. Install and run it as a dedicated or otherwise
trusted operating-system account that has access only to the projects, provider
credentials, SSH identities, and local services the installation should
control.

Decide these boundaries before startup:

1. **Filesystem scope.** Environment workspace roots in Settings control where
   projects may be opened. Grant only the intended directories.
2. **Provider authority.** Select the required backends in Settings and authenticate
   each provider as the service account. Provider credentials remain in their
   native stores.
3. **Model policy.** Every backend has an principal-configured catalog,
   allowlist, or denylist policy. Use an allowlist when future catalog entries
   must not become available automatically.
4. **Network boundary.** Loopback is the safe default. Sedes has no general
   client login, so do not treat Host, Origin, CORS, or CSRF checks as remote
   authentication.
5. **State and backup locations.** Select a persistent `APP_STATE_DIR`, keep
   the server JSON outside disposable source/build directories, and plan a
   quiescent backup of both Sedes and provider-native state.

## Run from source

Use [Getting started](../user/getting-started.md) for prerequisites, checkout,
locked dependency installation, Pi authentication, the development launcher,
and the first completed thread. Do that local loopback smoke test before
creating a durable service.

For the production-shaped process, keep `NODE_ENV` unset during the build and
install the schema-11 bootstrap file at the XDG default:

```sh
install -d -m 700 "${XDG_CONFIG_HOME:-$HOME/.config}/sedes"
install -m 600 config/server.example.json \
  "${XDG_CONFIG_HOME:-$HOME/.config}/sedes/server.json"
env -u NODE_ENV npm run build
npm start
```

An absolute `SEDES_CONFIG_FILE` remains available when an installation keeps
the strict JSON elsewhere. Production never creates or guesses configuration.

Open `http://127.0.0.1:4784` and verify the health endpoint separately with a
paired management credential in `SEDES_AUTH_TOKEN` (see
[Credentials for operator scripts](operations.md#credentials-for-operator-scripts)):

```sh
printf 'Authorization: Bearer %s\n' "$SEDES_AUTH_TOKEN" |
  curl --fail --header @- http://127.0.0.1:4784/api/health
```

A healthy process returns `{"status":"ok"}`. This endpoint proves that the
HTTP application completed startup; individual targets can still be
unavailable because of provider authentication, executable, endpoint, model,
or execution-environment failures.

The source tree is not an installation state directory. Do not commit or
package `dist/`, `node_modules/`, application state, credentials, provider
sessions, or test results.

## Production readiness checklist

Before relying on an installation:

- pin the exact source commit or release and build from that source;
- keep the strict server JSON, state directory, and provider stores on
  persistent storage with permissions appropriate for the service account;
- replace executable, socket, token-file, working-directory, SSH, and
  workspace-root placeholders in the chosen configuration example;
- verify each provider as the same account and environment used by the service;
- select explicit backend model policies and remove disabled examples that are
  not intentionally retained;
- keep the listener on `127.0.0.1`, or document and test the exact supported
  private ingress boundary;
- use a service manager that sends `SIGTERM` and allows the 30-second bounded
  shutdown to complete;
- health-check the running process and inspect the UI for target and execution
  environment availability;
- take a stopped, complete backup and practice restoring it before the data is
  irreplaceable; and
- keep the application build, server configuration, overlay state, provider
  state, and packaged-client protocol version aligned during upgrades and
  rollbacks.

## Configuration and state ownership

Knowing who owns a setting prevents unsafe fallbacks and incomplete backups.

| Scope | Examples | Where it lives |
| --- | --- | --- |
| Installation | listener, workspace roots, environments, backend instances, targets, model policy, optional integrations | environment variables and server JSON |
| Local principal | saved prompts, Agents, templates, tasks, Tool clients, bookmarks | Sedes application state |
| Workspace and thread | projects, inventory, drafts, queues, automations, lineage, attachments, settings | Sedes application state plus blob directories |
| Provider | authentication, native conversations, provider-native session metadata | provider-owned stores |
| Execution environment | SSH identity/routing and managed-sidecar policy | OpenSSH configuration and server JSON |

The browser never supplies tenant or principal authority. The production
identity provider exposes exactly one server-derived local principal; that is
a product boundary, not permission to share one state directory across
installations or accounts.

## Optional integrations

Optional components should fail closed and remain inside the same trusted
installation boundary:

- **Provider Pulse** supplies sidebar usage observations through a loopback
  server-to-server proxy. Configure `SEDES_PROVIDER_PULSE_URL`, or set it to
  `off`. The browser does not contact Pulse directly.
- **Web search** exposes the provider-neutral `research.web_search` agent tool
  through a local Grok CLI. Configure the server JSON `webSearch` block and
  authenticate its normal or dedicated `GROK_HOME` as the service account.
- **Outbound hosts** pair an account-local connector to this server over HTTP or
  HTTPS. They share sidecar execution, Files, tools, and runtime recovery with SSH;
  see [Outbound hosts](outbound-hosts.md) for setup and platform prerequisites.
- **Managed SSH operations** can provide directory browsing, Files, composer
  attachments, Pi workspace tools/context, and agent-tool CLI relay. Enable
  only the named sidecar capabilities the remote account should expose.
- **External Codex connections** can use a protected local Unix socket,
  authenticated loopback WebSocket, WSS, or a Unix socket reached through
  OpenSSH. Each topology has different ownership and credential requirements;
  use the checked-in example and the [Codex guide](backends/codex.md).
- **Packaged clients** are separately built Android and Electron applications.
  Enabling their exact origins does not enable authentication or change the
  listener by itself.

## Security model in one minute

Anyone who can reach the management listener can act as the local principal:
they can read prompts and transcripts, control conversations and automations,
and use available file roots. Sedes therefore supports trusted private access,
not public hosting.

The supported remote shape is normally Tailscale Serve terminating HTTPS in
front of a loopback Sedes listener. An operator-controlled private HTTPS proxy
is also supported when its upstream connection is same-host loopback and its
exact external DNS Host/protocol are forwarded and admitted. A direct
trusted-home-LAN listener is an explicit, unencrypted exception for packaged
clients and admits one exact RFC1918 Host while still binding the socket to
every IPv4 interface. Firewall reachability remains decisive. Tailscale
Funnel, public listeners, guest networks, and untrusted reverse proxies are
unsupported.

Agent-tool references and Tool client tokens narrow authority for agent-tool
routes; they do not authenticate the rest of the management API. See
[Agent-tool caller boundary](operations.md#agent-tool-caller-boundary) before
running a CLI or provider process outside the server host.

## Routine operating rhythm

- **After configuration changes:** restart Sedes, require a healthy process,
  and verify affected targets and environments in the UI. Configuration is
  startup-owned and is not hot-reloaded.
- **Before upgrades:** settle or review uncertain work, stop the process, back
  up all state, retain the matching old binary/configuration, then start the
  new build.
- **After upgrades:** check health, backend availability, migration diagnostics,
  packaged-client compatibility, and one non-destructive provider attach before
  resuming scheduled work.
- **When writes become uncertain:** do not repeat them solely because a client
  disconnected. Follow Sedes recovery evidence and restore or force-reset only
  after reviewing the consequences.
- **When sharing diagnostics:** redact tokens, thread references, prompts,
  paths, provider data, and raw errors. Use only the documented opt-in
  diagnostics.

Continue with [Configuration](configuration.md) to define the installation or
[Operations and security](operations.md) to build its lifecycle and deployment
runbook.
