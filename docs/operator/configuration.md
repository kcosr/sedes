# Configuration

Sedes separates installation bootstrap from principal-owned execution settings.
The strict schema-11 JSON file chooses the listener, state location, and admitted
packaged-client origins. **Settings → Environments** and **Settings → Backends** manage workspace roots, provider instances, targets, model policy,
and runtime lifecycle in SQLite. These edits follow the current Sedes user
across clients and restarts.

For an existing schema-10 installation, use the explicit offline
[configuration import](#configuration-changes-and-rollback) before starting the
new binary. Ordinary startup never reloads old execution definitions from JSON
or overwrites database edits. Keep `NODE_ENV` unset for installs, tests, and
builds; `npm start` sets production mode for the application.

## On this page

- [Supported setup path](#supported-setup-path)
- [Server file structure and limits](#server-file-structure)
- [Packaged-client origin admission](#packaged-client-origin-admission)
- [Checked-in examples](#checked-in-examples)
- [Environment variables](#environment-variables)
- [Principal-owned Settings](#principal-owned-settings-and-precedence)
- [Local and SSH execution environments](#execution-environments)
- [Backends, targets, and model policy](#backends-and-targets)
- [Multiple targets](#multiple-backends-and-targets)
- [Pi](#pi), [Claude](#claude), [Grok](#grok), and [Codex](#codex)
- [Web search](#web-search-provider)
- [Application terminal policy](#application-terminal-policy)
- [Runtime lifecycle, apply, and restart](#runtime-lifecycle-apply-and-restart)
- [Change and rollback safety](#configuration-changes-and-rollback)
- [Notification scripts](#notification-scripts)

## Supported setup path

A fresh installation starts with empty execution configuration and serves the
management UI. Add an environment and a backend with its target there. Missing
or unreachable providers do not prevent repairing configuration in Settings.
The server derives tenant and principal authority; there is no principal picker
or tenant administration UI.

One strict JSON bootstrap file is the only file to write before the first
start. Everything else is created in the product's Settings UI.

1. Choose the bootstrap path. Production startup reads
   `${XDG_CONFIG_HOME:-$HOME/.config}/sedes/server.json`; a nonblank absolute
   `SEDES_CONFIG_FILE` overrides it. Sedes does not create the file, search
   other locations, or fall back to a checked-in example, and a missing file
   fails before database startup and reports the attempted path.
2. Copy [`config/server.example.json`](../../config/server.example.json) to
   that path. It is the complete minimum for a loopback installation:

   ```json
   {
     "schemaVersion": 11,
     "packagedClients": [],
     "listen": { "host": "127.0.0.1", "port": 4784 }
   }
   ```

   Only `schemaVersion` is required. A first install adds a field only when it
   needs one: `packagedClients` for an Android or Electron client, `listen`
   for a nondefault listener, `listen.trustedLanHost` with a wildcard
   listener, `allowedTailscaleHosts` for tailnet DNS names, and an absolute
   `stateDirectory` to move application state off its default location. See
   [Server file structure](#server-file-structure) for the full field
   reference and [Environment variables](#environment-variables) for the
   startup overrides.
3. Start the server and enroll the first client. Authentication is required by
   default and there is no anonymous claim of the installation, so pair each
   client with the server-account
   [pairing CLI](operations.md#pairing-clients).
4. Configure execution in Settings, not in the file. **Settings →
   Environments** adds the local or SSH environment and its workspace roots;
   **Settings → Backends** adds each provider instance, its target, model
   policy, and startup environment variables. Notifications, the web-search
   provider, and tool clients are principal-owned as well. These edits live in
   the database and apply through runtime reconciliation without restarting
   Sedes.

Restart the process after editing the bootstrap file or any startup
[environment variable](#environment-variables); those are read once at
startup. Settings saves need no server restart, although new backend startup
environment definitions reach a provider process only through that backend's
explicit restart action. See
[Runtime lifecycle, apply, and restart](#runtime-lifecycle-apply-and-restart)
for what a saved revision does and does not prove, and the
[connection model](connections.md) for how the client, provider-runtime, and
execution-environment choices stay independent.

## Server file structure

The startup file contains only schema-11 installation settings:

```json
{
  "schemaVersion": 11,
  "stateDirectory": "/absolute/sedes-state",
  "listen": { "host": "127.0.0.1", "port": 4784 },
  "packagedClients": []
}
```

Only `schemaVersion` is required. Optional `allowedTailscaleHosts` is an array
of exact admitted DNS names; optional `listen.trustedLanHost` accompanies the
explicit packaged-client trusted-LAN configuration. Unknown fields are rejected.
Execution fields such as `backends`, `targets`, or `workspaceRoots` are not valid
bootstrap keys. Start with [`config/server.example.json`](../../config/server.example.json).

### Packaged-client origin admission

`packagedClients` is an optional installation-owned list containing `android`,
`electron`, or both. Entries must be unique; unknown or duplicate values fail
startup. Omit the field when the
installation uses neither packaged client. For example, a complete
schema-version-11 bootstrap file used by both clients includes this top-level
entry:

```json
"packagedClients": ["android", "electron"]
```

The labels admit code-owned fixed origins: `android` admits
`http://localhost`, and `electron` admits `capacitor-electron://localhost`.
Operators cannot configure arbitrary origins through this list.

Origin admission affects Sedes's bounded CORS, preflight, CSRF, stream, and
application-terminal contracts. It does not start or configure a client,
change the socket listener, add transport encryption or client authentication,
or weaken exact Host validation. A wildcard listener still requires at least
one packaged-client entry and one exact trusted RFC1918 LAN Host. Read
[Packaged clients](clients/index.md) before admitting either origin.

### Checked-in examples

[`config/server.example.json`](../../config/server.example.json) is the current
bootstrap example. Files in [`config/legacy-import/`](../../config/legacy-import/README.md)
are schema-10 conversion fixtures for existing installations. They describe
provider-specific fields but are not startup configuration and must not be
copied over the schema-11 bootstrap. Fresh installations use Settings.

## Environment variables

Sedes startup variables below configure the server itself. Separately,
**Settings → Environments / Backends → Environment variables** configures
variables supplied to tools or provider processes; those are principal-owned
and are described in
[Tool and provider environment variables](#tool-and-provider-environment-variables).

### Core process

| Variable                                    | Default                                                                                                                       | Contract                                                                                                                                                                                                                                                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEDES_CONFIG_FILE`                         | Development: absolute path to `config/server.example.json`; production: `${XDG_CONFIG_HOME:-$HOME/.config}/sedes/server.json` | Optional absolute-path override for the strict server JSON file.                                                                                                                                                                                                                                                                          |
| `APP_STATE_DIR`                             | `${XDG_STATE_HOME:-~/.local/state}/sedes`                                                                                     | Absolute application-state directory. Do not share it between concurrent processes or incompatible worktrees.                                                                                                                                                                                                                             |
| `SEDES_CONVERSATION_RETENTION_MILLISECONDS` | `3600000` (1 hour)                                                                                                            | Canonical integer from `0` through `2147483647`. `0` releases eligible unobserved idle actors immediately. It never deletes provider history.                                                                                                                                                                                             |
| `SEDES_CONVERSATION_RUNTIME_BUDGET`         | `32`                                                                                                                          | Installation-owned resident conversation actor ceiling applied independently per tenant/principal execution environment, from `2` through `64`. All backends on one environment share its pool; local and distinct SSH environments do not. Admission retires the oldest eligible idle, unobserved runtime in that pool before rejecting. |

On production startup, a nonblank `SEDES_CONFIG_FILE` wins. Otherwise Sedes
uses `$XDG_CONFIG_HOME/sedes/server.json`; when `XDG_CONFIG_HOME` is unset or
empty it uses `~/.config/sedes/server.json`. A nonempty `XDG_CONFIG_HOME` must
be absolute. The file remains required and strict: Sedes does not create it,
search other locations, or fall back to a checked-in example. A missing file
fails before database startup and reports the attempted path.

`XDG_STATE_HOME`, when set, must be absolute. A bootstrap `stateDirectory`
overrides `APP_STATE_DIR`; otherwise `APP_STATE_DIR` overrides the XDG default.
Listener environment overrides (`PORT`, `SEDES_BIND_HOST`,
`SEDES_TRUSTED_LAN_HOST`, and `ALLOWED_TAILSCALE_HOSTS`) take precedence over
matching bootstrap fields. Packaged-client admission comes only from bootstrap.
The development launcher (`npm run dev`) proxies the browser client to
`http://127.0.0.1:4784` regardless of `PORT`, so change the API port only for a
production-shaped run.

Workspace grants belong to each database environment. `WORKSPACE_ROOTS` is not
an execution-configuration source; editing it does not update saved grants.
The import command requires explicit `--workspace-roots` arguments instead of
inferring them from the importing shell.

Electron Managed Local keeps its bootstrap and database under its own user-data
`managed-local` subtree. The Electron parent fixes the listener and packaged
origin boundary; execution settings belong to that Local server's database.
Direct and SSH connection profiles select another server and do not copy its
configuration or state. See [Electron](clients/electron.md).

### Network ingress

| Variable                  | Default     | Contract                                                                                                                                                                        |
| ------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                    | `4784`      | Integer from 1024 through 65535. The code-owned Electron managed-Local parent may set `0` to request an ephemeral loopback port reported through its private readiness channel. |
| `SEDES_AUTH_REQUIRED` | `true` | Exact `true` or `false`, environment-only startup setting. `false` disables paired-client admission; malformed values fail startup. |
| `SEDES_BIND_HOST`         | `127.0.0.1` | Exactly `127.0.0.1` or `0.0.0.0`. Wildcard binding requires a packaged-client opt-in and trusted LAN Host.                                                                      |
| `SEDES_TRUSTED_LAN_HOST`  | None        | One exact RFC1918 unicast IPv4 Host admitted with wildcard binding. This is Host validation, not client authentication.                                                         |
| `ALLOWED_TAILSCALE_HOSTS` | Empty       | Comma-separated list of at most 16 exact tailnet or private-proxy DNS names for Host/Origin checks. IPs, ports, wildcards, credentials, and paths are rejected.                 |

Admitted DNS names are lowercased and one trailing dot is removed. Wildcard binding
still binds every IPv4 interface even though Host validation admits only the
configured trusted LAN address. Read [Operations](operations.md#deployment-matrix)
before changing the loopback default.

The coupled packaged-client origin, wildcard listener, and trusted-LAN Host
settings also admit application terminal WebSockets. This does not add
transport encryption. With default authentication, a paired
management client can obtain a shell with the configured execution authority.
Plain HTTP exposes that credential and shell traffic to network observers.
Prefer loopback or an admitted private HTTPS origin such as Tailscale Serve.

Production authentication is required by default. `SEDES_AUTH_REQUIRED=false`
is an explicit environment-only override read at startup; changing it requires
a restart. Only exact lowercase `true` and `false` are accepted, and malformed
values fail startup. This is installation policy, not a user preference or
bootstrap-file field. Disabling it bypasses paired-client checks on HTTP APIs,
SSE, and WebSockets, while preserving Host/Origin, CORS, CSRF, host approvals,
execution grants, and dedicated agent-tool credentials. Any admitted client can
then exercise the local principal's management authority.

The override does not erase pairing records or client credentials. After a
restart with `true` or the variable unset, still-valid credentials work again;
expired, revoked, or invalid credentials remain denied. Previously paired
connectors keep their proof and credentials, while outbound hosts first
approved without credentials in that mode must be revoked and registered again
with a new authenticated connector identity; see
[Outbound hosts](outbound-hosts.md). There is no automatic first-client
enrollment or anonymous claim of the installation.

Use the server-account [pairing CLI](operations.md#pairing-clients) to enroll,
list, and revoke clients. Pairing records are separate from execution settings
and are stored in `authentication/authentication.sqlite` beneath the configured
state directory. Authentication restricts its own directory to mode `0700` and
database files to `0600`; it leaves existing state-directory permissions intact.

### Optional integrations

| Variable                   | Default                 | Contract                                                                                           |
| -------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------- |
| `SEDES_PROVIDER_PULSE_URL` | `http://127.0.0.1:4317` | Loopback `http://` origin with an explicit port for Provider Pulse. Set to `off` to disable Accounts. |
| `SEDES_EXPERIMENTAL_USAGE` | `0` (disabled) | Set to exactly `1` to enable experimental recorded usage accounting, reports, and UI. Only `0` and `1` are accepted when set. Restart the main server after changing it. |

Experimental usage is an installation-owned environment opt-in, read once at
server startup. It is not a browser preference or a `server.json` setting.
The authenticated session advertises the setting to every client. Enabled
accounting views are labeled **Experimental**; disabled installations hide
them and reject usage-report API requests before querying accounting data.

When disabled, Sedes skips accounting capture, usage-only history processing,
interrupted-capture recovery, timeline backfill, and Codex subagent monitoring
for accounting. Existing recorded and imported usage remains in the database;
normal database migrations still run. Context-window meters, transcript
counters, and Provider Pulse Accounts remain available. Providers may still
emit or store their own native usage counters.

The opt-in applies to local and remote backends in the main server. It requires
no sidecar protocol update or remote environment setting. Re-enabling resumes
accounting; backend history or cumulative counters may recover some earlier
usage, but there is no automatic comprehensive reconciliation of the disabled
period. Existing browser and packaged clients must be updated to client
protocol 122 when installing this version.

Provider Pulse is installation-owned, not tied to one environment, workspace,
or thread. Sedes contacts it server-to-server on loopback and exposes only
provider-neutral observations and admitted usage-check actions; the browser
never receives its native account or reset-credit authority. When disabled,
the client omits Accounts rather than presenting a nonfunctional control.

For Provider Pulse, `off` is the recommended explicit disabled value. Empty or
whitespace-only input and `0` are also accepted as disabled for service
environment compatibility.

### Related variables that are not server configuration

`SEDES_AGENT_TOOL_CLIENT_TOKEN` is an external `sedes` CLI credential, not
server configuration. Do not export it into the Sedes service environment or
server JSON. Tool client verifiers and restart-safe thread references use
separate derivations of the existing automatically managed installation key;
there is no additional operator secret. The Tool clients Settings page derives
its selectable environments from principal-owned database configuration. Removing
an environment or configured default makes an affected client unavailable or
**needs attention**; it never retargets authority to another environment.

Pi's `PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`, and any Pi
`sessionDir` keep their native meanings. Sedes does not copy Pi credentials,
models, extensions, skills, or conversation history into its configuration.
Diagnostic-only environment variables are intentionally documented in
[Debug diagnostics](../developer/diagnostics.md), not in this durable service
configuration table.

## Principal-owned Settings and precedence

Everything in this section is principal-owned database state rather than an
installation bootstrap field. The server derives tenant and principal
authority for each read and write, and precedence between layers is stated
with each setting.

The separate database configuration contains up to 16 environments, 32
backends, and 64 targets. Empty configuration is valid. Environment IDs are
UUIDs; backend and target IDs use bounded alphanumeric/dot/dash/underscore
identifiers. Labels are bounded display text, not identity. IDs are
case-sensitive, and IDs and execution identities remain stable once persisted
threads refer to them. A backend belongs to one environment through its
target; changing an endpoint, provider home, environment kind, or host must
not redirect existing native bindings. Create a new identity for a different
execution store.

The Settings management API validates complete, closed shapes and ownership
before mutation. It rejects duplicate IDs, invalid paths, dangling references,
unsupported topologies, and a default that is not enabled.

### Execution environments

Use **Settings → Environments → Add environment** to add a local or SSH
environment and its exact workspace roots. Open an environment to browse its
backends or select **Activity & diagnostics** for runtime controls. The global
**Backends** inventory also groups backends by environment and supports search
and environment, provider, and status filters. At most one local environment is supported. Local isolation
policy can admit Bubblewrap's `isolated` network profile, or explicitly include
`execution_host`; direct execution is separate from that Linux-only sandbox.
A missing sandbox does not turn an existing isolated thread into direct work.

An SSH environment selects one OpenSSH host alias and remote workspace roots.
OpenSSH configuration owns the account, keys/agent, host verification, ports,
ProxyJump, and route. Paths and protected credential references resolve on the
selected execution host. The browser cannot provide a different principal or
make the main host read a same-named remote path.

Remote targets use the persistent sidecar. Select only the additional operations
needed by that environment:

```json
{
  "kind": "sidecar",
  "enabledCapabilities": [
    "directory_browser", "workspace_files", "workspace_tools",
    "workspace_context", "workspace_skills", "composer_attachments",
    "agent_tools_cli", "interactive_terminal"
  ]
}
```

This is an environment operations value in database configuration, not a
bootstrap file. There is no `deployment` or `carrier` setting. Capabilities must
be unique; `workspace_tools` and `workspace_context` are selected together.
An environment with `{ "kind": "none" }` provides no optional operations and
cannot enable a remote target that requires the sidecar.

`directory_browser` admits the project picker; `workspace_files` admits Files
and Compare; `composer_attachments` admits immutable staging; `agent_tools_cli`
admits the scoped Sedes tool relay; `interactive_terminal` admits remote PTYs.
Pi SDK requires the workspace tool/context pair for a remote workspace.
`workspace_skills` independently admits bounded skill discovery from fixed
remote account and workspace roots. None grants arbitrary provider authority.

### Backends and targets

A backend instance selects one compiled provider integration and owns its
backend model policy. A target selects that backend plus one execution
environment and target defaults; it cannot broaden or narrow the backend model
policy. The enabled targets for one backend may not span multiple
execution environments in the current schema. A configured backend must have a target
that fixes its environment; a selected default target must be enabled.

Backend and target IDs are Sedes identifiers. They are not Pi session IDs or
Codex/Claude/Grok native conversation IDs.

### Backend model policy

Every enabled or disabled backend must declare exactly one top-level
`modelPolicy`. It is operator-owned authorization for new provider model work,
not a target default or browser preference:

```json
"modelPolicy": { "type": "catalog" }
```

`catalog` applies no additional Sedes restriction to the backend's live
catalog. An allowlist instead starts denied and admits a selection when any
matcher matches:

```json
"modelPolicy": {
  "type": "allowlist",
  "allowed": [
    { "providerIds": ["anthropic"] },
    {
      "providerIds": ["xai"],
      "modelIds": ["grok-4.5"],
      "reasoningEfforts": ["low", "medium"]
    },
    {
      "providerIds": ["openai"],
      "modelIds": ["example-model-a", "example-model-b"]
    }
  ]
}
```

A denylist starts with the live catalog and removes a selection when any
matcher matches:

```json
"modelPolicy": {
  "type": "denylist",
  "denied": [
    { "providerIds": ["google", "openrouter"] },
    { "modelIds": ["legacy-model-a", "legacy-model-b"] },
    {
      "providerIds": ["xai"],
      "modelIds": ["grok-4.5"],
      "reasoningEfforts": ["xhigh"]
    },
    { "reasoningEfforts": ["max"] }
  ]
}
```

Within one matcher, values in a list are ORed and the present dimensions are
ANDed. Matchers are ORed. An omitted dimension means any value, so the lists
describe a Cartesian product rather than positional pairs. All identifiers are
exact and case-sensitive; there are no labels, aliases, globs, regular
expressions, ordering, or fallback substitutions. Collections and lists must
be nonempty, each dimension list must contain unique values, exact duplicate
matchers are invalid even when their list order differs, and each matcher must
constrain at least one dimension. Redundant or overlapping nonidentical
matchers are allowed and do not establish precedence.

A policy may contain at most 64 matchers and each dimension may contain at
most 64 values. Provider and reasoning-effort identifiers are limited to 120
characters; model IDs are limited to 240. Control characters are rejected.

Pi has truthful native provider, model, and reasoning-effort dimensions and
may use all three fields. Codex, Claude, and Grok have no reviewed native provider
dimension, so their configuration rejects `providerIds`; use `modelIds`,
`reasoningEfforts`, or both. A configured value need not be in the catalog at
startup: a missing allowlist value grants nothing, while a missing denylist
value removes nothing.

A denylist intentionally admits future catalog selections that do not match a
denial. An allowlist matcher that omits a dimension also intentionally admits
future values in that dimension. Use a fully constrained allowlist when the
requirement is strictly “only these selections.” Policy filters the live
catalog and is rechecked before provider work; it never fabricates an absent
model or silently substitutes another model or effort.

An effort-specific matcher does not match a model that has no configurable
reasoning-effort axis. A catalog model remains visible only when at least one
of its advertised effort selections is admitted, or when its effortless
provider/model selection is admitted. Sedes retains an advertised default
effort only when that exact selection is admitted. If policy denies the
default, Sedes does not choose another effort automatically; an explicit
admitted stored selection is used, or the setting remains unresolved until the
operator or user repairs it.

### Multiple backends and targets

The arrays may contain multiple enabled backend instances and targets. Use
unique IDs, keep each backend on one execution environment, and select one
enabled `defaultTargetId`. A new thread stores the selected target immutably;
changing the principal default does not retarget existing threads.

The creation form keeps Project and Target visible as the routing context. A
sole eligible choice is preselected; several eligible targets require an
explicit selection.

### Tool and provider environment variables

Tools & commands defaults merge Environment → Backend → Saved Agent → Thread;
creation shows provenance and lets you override, remove, or restore inherited
values. Thread snapshots remain fixed, and forks inherit them. Ordinary
terminals use environment-level tool defaults when launched.

A value can be a literal, a reference to an execution-host environment variable,
a reference to a protected execution-host file, or an explicit removal. Use
references for secrets: Sedes stores the reference and resolves it on that
host. Protected files must be owned by the execution account, private, regular
files without symlinks; their immediate directory must be owned by that account
and not writable by group or others. Protected file references currently require
a Unix execution host; environment references also work on Windows. One final
newline is removed. An empty
literal remains present; removal deletes the variable. Provider identity paths,
Sedes-managed authority, and process loader controls are reserved. Definitions
are limited to 64 names and 32 KiB per layer and effective map. These controls
never edit the Sedes server's global environment.

### Web search provider

Sedes exposes one provider-neutral `research.web_search` agent tool. Its local
Grok CLI configuration is principal-owned database state, managed with execution
settings. A null provider selection disables it. When configured, optional
`grokHome` is an absolute provider home; native authentication remains outside
Sedes's database. This auxiliary provider does not create a Grok conversation
backend or gain another environment's authority.

Research subprocesses receive a curated environment. They never receive
unrelated provider credentials or Sedes authority. Missing executable or native
authentication makes the tool unavailable without stopping the management UI.
Provider executables and authentication are separately installed by the operator.

### Application terminal policy

The first release has no terminal-specific server JSON block or environment
variables. Its fixed code-owned limits for active terminals, retained journal,
scrollback, checkpoints, input size, geometry, one-use admission, and the
termination ladder are listed in
[Operating terminal resources](terminals.md#first-release-limits), which also
covers storage, recovery, network requirements, and the **End terminal** and
**Remove terminal** operations. Only the account's default login shell is
supported; a browser-selected shell profile is rejected.

The browser may request initial geometry but cannot choose process scope,
environment, workspace authority, initial CWD, or arbitrary process
environment. The server derives the initial CWD from the thread workspace.
That directory is not a sandbox; the shell may leave it with the operating
system account's normal authority.

### Pi

Select **Pi SDK** in **Settings → Backends**, add a target bound to
one environment, and choose its model policy. The internal backend and target
kinds remain `pi` and `pi_sdk`. Provider credentials, session storage, native
settings, and reasoning stay on main Sedes.

A remote Pi SDK target requires the sidecar's workspace tool/context pair.
Files, attachment staging, and bounded remote skills need their independent
capabilities. No remote Pi reasoning runtime or Pi CLI backend is implemented.
See [Pi SDK](backends/pi.md) and
[remote workspace tools](../internals/pi-remote-workspace-tools.md).

### Claude

A Claude backend configured in Settings runs a local digest-verified worker or
a runtime owned by the persistent sidecar in its SSH or outbound execution
environment on Linux/macOS with Node.js 24.18+. Native Windows Claude is
unsupported. The [legacy import fixture](../../config/legacy-import/server.claude.example.json)
documents its provider fields. Both path overrides are optional. Claude
resolves from the execution account's `PATH`;
`moduleConfiguration.executablePath` overrides it with a canonical absolute
POSIX path. Provider-home precedence is explicit
`moduleConfiguration.configDirectory`, then that account's `CLAUDE_CONFIG_DIR`,
then `$HOME/.claude`. An explicit configuration directory must also be a
canonical absolute POSIX path. The worker resolves and validates the selected
home on the execution host. For SSH or outbound, these environment values belong to the
remote account, never the main Sedes account. The Agent SDK is bundled with
Sedes; no SDK directory setting or separate SDK install is needed.

Claude backends use the compiled `0.3.274` Agent SDK profile and declare a
top-level model policy using model IDs and/or reasoning efforts, never
`providerIds`. The external CLI must be a stable Claude Code release at or
above 2.1.281. Sedes is tested through 2.1.283 and reports a newer admitted
release as newer than tested. The backend
`permissionPolicy.allowedModes` is a
closed nonempty allowlist drawn from `default`, `acceptEdits`, `dontAsk`,
`auto`, and `bypassPermissions`; each target selects one allowed default other
than `bypassPermissions`. That mode is deliberately powerful and should be omitted unless the
installation operator intends to make it selectable. Credentials and API keys
are not configuration fields: authenticate the exact execution account
with `claude auth login` on the selected host.

`initializationTimeoutMs` defaults to 20000 and accepts 1000–120000.
Claude has no backend-specific configurable session ceiling. Sedes applies its
shared conversation-runtime budget to resident threads, while the provider
worker retains a fixed hard guard of 32 simultaneous queries for fail-closed
resource safety.

Remote Claude targets require an SSH or approved outbound environment with
persistent sidecar operations. The sidecar owns SDK queries across carrier loss,
outbound connector restart, and main-server restart; Claude Code and its native store remain on the remote host. Files,
attachments, directory browsing, and CLI relay require their independent
environment capabilities. A missing or unavailable remote runtime never falls
back to a local worker. Read [Claude backend](backends/claude.md) for permission
interactions, lifecycle, and unsupported operations.

### Grok

Grok has one supported topology: Sedes starts and owns one local stdio process per
resident native session. The service account's first executable `grok` on
`PATH` is used by default; optional
`moduleConfiguration.connection.channel.executablePath` is a canonical
absolute override. The runtime must be stable and at or above the reviewed
`1.0.4` floor. Sedes uses its compiled `1.x` ACP compatibility profile, while
runtime admission verifies bounded native version/build evidence against that
floor and the reviewed exclusion list before opening ACP authority. Sedes is tested
through `1.0.4`; later admitted stable releases retain the pinned parser
and are reported as newer than tested rather than rejected solely for being a
newer patch or minor release.

Authentication is the closed shape `{ "type": "native" }`. Sedes preserves
the installation account's normal `HOME` and optional `GROK_HOME`, then asks
Grok to authenticate with its advertised `cached_token` method. Sedes does
not accept token paths or account IDs, inspect `auth.json`, or copy, refresh, or
persist provider credentials. A logged-out installation is presented as
authentication required. A disposable Grok home is test/probe-only.

Each Grok target chooses catalog-default or fixed model and reasoning effort.
When the model is `catalogDefault`, reasoning effort must also use
`modelDefault`; a fixed reasoning effort requires a fixed model.
The live catalog and the effective selection returned by every create/load are
checked against the backend `modelPolicy`; `providerIds` are unsupported.
Targets are local-only. See [Grok backend](backends/grok.md) for the supported
conversation lifecycle and fail-closed feature limits.

### Codex

Every enabled Codex backend declares one connection topology, an
execution-policy ceiling, and a top-level model policy using model IDs and/or
reasoning efforts, never `providerIds`. Sedes supplies its exact generated
`0.153.0` protocol profile from the compiled backend module.

The backend policy contains closed nonempty allowlists for:

- sandbox mode: `read-only`, `workspace-write`, or `danger-full-access`;
- network access: `disabled` or `enabled`;
- approval policy: `untrusted`, `on-request`, or `never`;
- approval reviewer: `user` or `auto_review`.

Each target provides a complete default tuple within that ceiling. An operator
may configure `danger-full-access` as a target default when the backend policy
allows it and the target's `networkAccess` is `enabled`. Target defaults seed
new threads; changing them does not replace existing threads' stored settings.
With a catalog or denylist model policy, the target may use
`catalogDefault`; the live default must still be admitted before execution.
With an allowlist, the target must select a fixed model admitted by the policy.
The backend's `modelPolicy` is the only configured model authorization shape.

#### Owned stdio

Select an owned process in the Codex Settings editor and its canonical
working directory. The executable is installed on the selected execution host.
The service account's first executable `codex` on `PATH` is used by default;
optional `connection.channel.executablePath` is a canonical absolute override.
`codexHome` is optional; when omitted, normal Codex home resolution is
retained. The compiled backend selects the generated 0.153.0 parser profile;
independently, Sedes admits a stable Linux x64 or macOS arm64/x64 `codex-cli`
runtime at or above 0.153.0.
Sedes is tested through 0.154.0 and reports a newer admitted runtime as newer
than tested. It owns the process group and native-store lock for the process
lifetime.

#### External local UDS

An external Unix-WebSocket connection attaches to an existing filesystem socket. The canonical parent directory must
be owned by the Sedes user with mode `0700`; the socket must be an owned
filesystem socket with mode `0600`. Sedes rechecks identity when opening a
new connection generation. It owns only the client connection, not the daemon
or native store.

#### External authenticated TCP or WSS

An external authenticated network connection uses one `ws://` or `wss://` origin with an explicit port and no path, query,
credentials, or fragment. Plaintext `ws://` is restricted to literal
`127.0.0.1` or `[::1]`. WSS uses platform certificate-chain and peer-name
verification with TLS 1.2 or newer.

Each connection generation resolves one bearer capability token from either:

- an environment variable whose name matches `SEDES_CODEX_*TOKEN*`; or
- a canonical absolute protected file owned by the Sedes user, with one hard
  link, mode `0400` or `0600`, beneath an owner-only directory.

Settings selects only credential references approved for that execution
environment; the credential value remains on that host. Literal secrets are
not a configuration shape. Secret values are excluded from
configuration fingerprints, logs, browser responses, and child/model
environments. Rotating the referenced value affects the next connection
generation.

#### External UDS over SSH

A remote Codex target is hosted through its environment's persistent sidecar.
Its provider connection may use admitted owned stdio, an external Unix socket,
or authenticated TCP/TLS under the same backend policy. Host paths, token
references, account identity, and native store ownership are evaluated on that
execution host. The SSH carrier reconnects to the existing sidecar runtime;
it does not spawn an alternative main-host provider or resubmit uncertain work.

External daemons remain operator-owned. Other clients with access to the same
app-server must be trusted and passive; competing active controllers and
unproven upgrade readiness fail closed. See [Codex](backends/codex.md).

## Runtime lifecycle, apply, and restart

Bootstrap changes require a process restart. Execution-setting saves commit a
new desired revision and apply through runtime reconciliation. A saved revision
is not proof of a successful runtime change: inspect **Applied revision**, status,
and any pending or rejected reason. Concurrent edits conflict rather than
silently replacing another client's changes. Changing a label does not retarget
a thread. A stale edit or lifecycle confirmation must be refreshed before
another attempt; an unknown operation outcome is not permission to retry it
with a new identity.

Backend startup defaults apply only to provider processes launched by Sedes.
Owned Codex, Claude and Grok accept them; external Codex UDS/TCP and in-process
Pi do not. Saving new startup values does not change a running process or
restart it. **Pending restart** marks unapplied startup definitions; use the
backend's explicit restart action and review affected threads. A new process
uses current definitions at its first launch.

Before removing a backend, its target, or an environment, stop the affected
runtime. Recover any outcomes you need before confirming Stop. Removal requires confirmed shutdown;
active, unreachable, or uncertain resources keep their definitions available.
Disabling a backend prevents new work while preserving its recovery and Stop
controls. Historical thread and workspace associations are retained after removal.

### Persistent sidecar services

The sidecar is an owner-only persistent service on the execution host. SSH
bootstraps or reconnects to it; the SSH connection does not own admitted remote
process lifetime. It retains managed provider runtimes, terminals, and bounded
operation results while main Sedes is disconnected. Pi SDK's reasoning loop
still runs on main Sedes and does not survive its shutdown.

**Disconnect** drops the main connection and persists that preference without
stopping remote work. **Stop**, **Restart**, and **Upgrade and restart** operate
on the service and require a current impact check. For a provider runtime
that reports its work, such as remote Claude, the check lists running turns,
background agents and commands, pending approvals, and conversations with
undelivered output, including conversations nobody has open, as well as
loaded threads that still have background work. Intentional Disconnect/Stop
survives main restart and is never overridden by background discovery or an
automatic upgrade. An unreachable stop reports uncertainty, not confirmed cleanup.

A compatible but outdated sidecar keeps serving after main is upgraded and is
replaced automatically once its work settles. Safe automatic upgrades require
settled work and no live terminals, active turns, pending approvals, unsettled
results, or unknown ownership. A shell at a prompt is live. Final terminal output must be handed off or preserved before
replacement. A blocker keeps the row at **Upgrade available** or **Upgrade
required** with the reason shown and **Upgrade and restart** offered; the host
is not reported unreachable. A saved revision that cannot apply while remote
work is active shows **Changes pending** with **Restart** offered. An explicit
restart confirmation authorizes interruption of active work and abandonment of
unrecovered transient outcomes. Explicit Stop attempts owned-process cleanup even
when provider state is unknown; retained outcomes do not veto it. Provider-native
history remains in its existing store. Bounded operation identity and disposition
metadata is saved under the scoped service directory’s `abandoned-work/` directory
on a best-effort basis; this is diagnostic evidence, not a replayable transcript
or proof that an uncertain mutation succeeded. An automatic replacement that
ends Claude work started after its idle check, for example a turn Claude began
itself, records the same evidence marked `startedAfterConfirmation`. Archive failures are logged and
do not block Stop. The archive retains at most 128 files and caps each evidence
payload at 1 MiB. Once full it logs `sidecar_abandonment_capacity_exceeded` and
stops recording new evidence. Back up records you need, then remove reviewed
JSON files from this environment’s `abandoned-work/` directory to free capacity;
leave `service.json`, management receipts, and other environments untouched.
External provider daemons are disconnected, not killed: closing a Codex UDS or
TCP connection does not request a server shutdown or turn interruption.
For owned stdio processes, shutdown first uses the provider's available graceful
mechanism. Codex interrupts known active turns; Claude requests SDK interruption;
Pi aborts its active session. These attempts are bounded. Owned process cleanup
then closes stdin and escalates to termination/kill if the process does not exit.
Grok uses graceful stdin EOF before that escalation.
Restart and upgrade start a replacement only after owned cleanup is confirmed.

An unknown lifecycle command stays visible in Settings until its durable
service receipt settles it, and on reconnect Sedes reconciles exact service
and resource identities before new work. See
[Operations](operations.md#persistent-remote-services) for command withdrawal,
runtime protocol mismatch, older-daemon handoff rules, authoritative Files
event refresh, and the agent tools that report unavailable while main is
absent, and [Operating terminals](terminals.md) for terminal recovery.

## Configuration changes and rollback

Normal edits follow
[Runtime lifecycle, apply, and restart](#runtime-lifecycle-apply-and-restart).
The offline import below is the one explicit conversion for an existing
schema-10 installation, and the rollback material covers recovery from it.

### Validate a startup file before restarting

Run `sedes config validate` on the server as its operating-system account with
the same `SEDES_CONFIG_FILE` and environment as the running server. Add
`--file /absolute/candidate-server.json` to check a candidate copy in place and
`--state-directory /absolute/sedes-state` to confirm the state path startup
would use; when the file itself sets a different `stateDirectory`, the command
fails and names both, because the file wins at startup. The command reads
only the bootstrap file and the startup
environment: it never opens the database, starts a provider, binds a port, or
writes anything, so it is safe while Sedes is running. It applies the same
strict schema parse and the same listener, packaged-client, trusted-LAN, port,
retention, and Provider Pulse cross-field checks as startup, and reports each
problem on its own line as a field path and message. It exits 0 when the file
is valid, 1 with the problem lines when it is not, and 2 for a usage error.
Execution configuration is database-owned, so environments, backends, targets,
admitted workspace roots, and executable paths are still validated when the
server starts; a clean result rules out a bad bootstrap edit, not a bad
Settings change.

### Offline legacy import

For a schema-10 installation, perform one explicit offline import with the new
source checkout. First settle active work, stop the old main server, and back up
the complete state directory, original server JSON, protected credential files,
and provider-native state. If remote services may still run, inventory their
resources and quiesce them for a consistent backup; main shutdown alone does
not prove they stopped. See the full [backup procedure](operations.md#state-upgrades-and-backups).

Validate the exact old file and explicit local workspace grants without opening
the database or starting providers:

```sh
env -u NODE_ENV npm run configuration:import -- \
  --file /absolute/legacy-server.json \
  --state-directory /absolute/sedes-state \
  --workspace-roots /absolute/workspaces \
  --validate-only
```

Repeat `--workspace-roots` for each previously admitted local root. The import
never derives these grants from `WORKSPACE_ROOTS` or the importing account's
home. Keep the original file intact. To apply, run the same command without
`--validate-only` while Sedes is stopped. The command takes the state lock and
backs up an existing database before its schema upgrade. Pre-schema-10 database
cutover additionally requires `--quiescent-cutover-confirmed`, after verifying
idle old Pi owners and empty in-memory queues.

Import preserves Claude definition IDs, enabled state, defaults, and existing
thread/native bindings, including admitted SSH targets. Previously imported
disabled definitions remain disabled until explicitly enabled in Settings.
Verify their remote account, provider home, workspace roots, and sidecar before
enabling them. There is no automatic local substitution or provider-store
migration.

After a successful import, replace the startup file with the schema-11
bootstrap example, preserving the installation listener, origin admission, and
state path. Start the selected build, check health, then verify environments,
backends, target defaults, old thread history, and retained terminal state in
Settings and the application. A repeat of the identical import preserves later
database edits; a different source or preexisting Settings configuration
conflicts instead of overwriting it.

### Rollback and recovery

Keep the matched old binary, configuration, and full stopped-state backup for
recovery. Never run an old binary against the upgraded database. Rollback must
also account for remote work and receipts created since the backup; do not
restore stale ownership over a still-running sidecar. No deployment is performed
by a source-code update itself.

## Notification scripts

Notification settings are principal-owned application state in SQLite, configured
through **Settings → Notifications**. They are separate from the installation
JSON file and apply without restarting Sedes. The script executable, its files,
credentials, operating-system account, and process environment remain managed
by the server operator. Browser requests derive tenant/principal authority on
the server; a request cannot select another user's settings.

Sedes launches the configured absolute executable directly with its argument
array, on the Sedes server even when a thread uses SSH. Install an executable
script with a suitable shebang, or configure an interpreter as the executable
and the script filename as an argument. No shell expansion, argument splitting,
or interpolation of thread content is performed. Arguments in the settings UI
are one per line. Use absolute paths for files the script needs.

Each invocation receives one UTF-8 JSON object on standard input followed by
EOF. Version 3 uses this shape for a completed turn:

```json
{
  "schemaVersion": 3,
  "notificationId": "92e18aa5-70f7-41ee-afbc-48437f90619c",
  "event": "turn.completed",
  "occurredAt": "2026-09-05T14:32:10.000Z",
  "title": "Agent finished",
  "message": "Implement notification hooks",
  "thread": { "id": "thread-123", "title": "Implement notification hooks" },
  "workspace": { "id": "workspace-456", "name": "Sedes" },
  "turn": { "id": "turn-789", "outcome": "completed" }
}
```

Identifiers belong to Sedes, not the provider. Title and message are convenient
plain display text; `message` remains the thread title for turn events. There is
no prompt, full transcript, or read status. Only fields applicable to the event
appear:

| Event                                               | Event-specific data                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `turn.completed`, `turn.failed`, `turn.interrupted` | `turn.id` and `turn.outcome`                                                                                 |
| `thread.woke`                                       | `wake.reason` (`deadline`) and optional `wake.reminderText`                                                  |
| `automation.started`, `automation.failed`           | `automation.id`, `name`, `runId`, `trigger` (`scheduled` or `manual`), and optional failure stage/diagnostic |
| `approval.requested`, `input.requested`             | `interaction.id` (Sedes request ID) and `interaction.kind` (normalized request kind)                         |
| `question.requested`                                | `question.id` (Sedes request ID) and `question.questionCount`                                                |
| `notification.test`                                 | Synthetic title/message; no thread is required                                                               |

**Response text**, nested inside **Turn completed**, offers compact
**Provisional**, **Unclassified**, and **Final** checkboxes. All are off by
default; no selection means metadata-only notifications. Select any combination
to include those sections of the assistant text captured at successful turn
completion. Turning off **Turn completed** retains the selection. Existing
settings keep their selected sections if response text was enabled; disabled
response text becomes an empty selection. With all selected:

```json
"assistantResult": {
  "provisional": { "text": "Checking the implementation.\n\nFound the issue." },
  "final": { "text": "Implemented the requested change. Tests passed." },
  "unclassified": null
}
```

Unselected section keys are omitted. Each selected section joins ordinary
assistant messages in that phase with blank lines.
Tool output, reasoning, and user messages are excluded. `null` means no message
was identified in that phase; `{ "text": "" }` means an identified message was
empty. Sections preserve their own message order, not interleaving between
phases. The text retains its original formatting, including Markdown.

Codex uses explicit commentary/final labels when supplied; missing labels remain
unclassified. Pi and Claude group text blocks belonging to the terminal native
assistant message using completion evidence. Grok currently has no reliable
final-message signal, so its assistant text is unclassified. Unclassified text
is never silently promoted to final. Terminal text can itself be incomplete
(for example, a provider token limit); classification does not guarantee the
answer is exhaustive.

The field is omitted when no sections are selected and on other events, including
`notification.test`. Older stored completions have no classified snapshot and
omit this field even when sections are selected. Recovery never reclassifies an
already finalized record from mutable history.

The three sections share a 16 KiB UTF-8 text budget. Final text receives space
first, then provisional, then unclassified. Sections may be shortened further
to fit the 64 KiB serialized JSON payload limit, reducing unclassified and
provisional text before final text. A shortened section carries metadata:

```json
"final": {
  "text": "Beginning of a longer response…",
  "truncation": {
    "truncated": true,
    "retainedBytes": 16384,
    "reason": "byte_limit"
  }
}
```

`retainedBytes` measures the included UTF-8 text. `originalBytes` may be supplied
but is optional. A fully omitted section's text is empty with truncation
metadata; it is not changed to `null`. If metadata leaves no room for the result
envelope, the entire field is omitted to preserve notification delivery.
Scripts should inspect truncation before assuming the text is complete.

Notification schema version 3 makes the selected sections explicit by omitting
unselected keys; update consumer scripts with the server. The repository's Assistant hook
speaks each supplied nonempty section in **Provisional → Unclassified → Final**
order, matching the checkbox row. Missing, null, empty, or whitespace-only
sections add no speech. Select Unclassified to hear Grok's response; it may
include progress commentary. With no selected text, only the normal completion
announcement is spoken. Reinstall any separately installed copy of the hook.

The setting applies across your clients and takes effect on save. Deselecting
**Turn completed** preserves the preference but stops completion notifications.
The test button uses unsaved script settings and sends sample metadata only,
without assistant response text, even when this option is enabled.

`approval.requested` covers `decision` and `confirmation` interactions;
`input.requested` covers `choice`, `text_input`, `editor`, and `questionnaire`.
Both include the owning thread/workspace context and generic display text. The
payload does not include the request title, command, question text, choices,
answers, or secrets. These events represent a newly accepted pending request,
not UI presentation, replay, or resolution. `question.requested` covers newly
committed nonblocking question batches, independently of blocking input. It
includes only the request identity, question count, and generic thread/workspace
context. Sending, dismissing, history hydration, and reconnect do not emit it.
Existing event selections remain unchanged; enable these events explicitly in
Settings.

For example, the following executable Python script consumes the contract:

```python
#!/usr/bin/env python3
import json
import sys

notification = json.load(sys.stdin)
if notification["schemaVersion"] != 3:
    raise SystemExit("Unsupported notification schema")
# Call your notification API here, using credentials from a server-owned file.
print(notification["title"] + ": " + notification["message"])
```

A test reports exit code zero as success and nonzero, timeout, or launch failure
as failure. A script may ignore stdin or stop reading it early; a closed input
pipe does not override a successful exit. No response JSON is expected. Output retained for the immediate test
result is bounded. Script execution has bounded concurrency and timeouts, and
shutdown terminates active script process groups. Notification scripts have the
Sedes account's server-side authority; the controlled environment does not
implicitly forward provider API credentials.

Normal hooks are best effort and make no delivery guarantee. They do not persist
delivery jobs, outcomes, payloads, or history and do not retry. Small internal
consumption markers prevent replayed application events from launching a script
again; these are independent of UI acknowledgment and contain no delivery result.
Disabling, silencing, or changing configuration discards pending work rather than
sending it later. There are currently no webhook destinations, routing rules,
thread-to-thread notifications, or native mobile push integration.

Return to the [operator guide](index.md) or choose a provider from the
[backend operator guide](backends/index.md).
