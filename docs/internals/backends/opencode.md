# OpenCode v2 runtime foundation

The OpenCode module and its native runtime are implemented under
`src/server/backends/opencode`. They are currently exercised through the
qualification suites and a test catalog. The production module catalog still
contains Pi, Codex, Claude and Grok; OpenCode conversation methods explicitly
return unavailable until their history and delivery integration is complete.
The normalized backend identity is `opencode`, its connection kind is
`opencode_http`, and the browser brand is `opencode`. Client protocol 128
includes these closed-enum additions and terminal Stop diagnostics.

## Native ownership

The exact admitted release is OpenCode **2.0.18**, with the generated
`@opencode/client` package pinned to that same release. Qualification uses
upstream source revision `cd9a14a6b688d4021bee381dfd39d2cef9c0f862`. An owned
backend requires an explicit absolute executable path. On the reference host
that executable is `opencode2`; Sedes never searches for the older `opencode`
executable as an alternative.

| Mode | Connection | Lifetime |
| --- | --- | --- |
| Owned | `serve --stdio --hostname 127.0.0.1 --port 0`; stdout announces the HTTP endpoint, and stdin controls process lifetime. Application traffic uses authenticated HTTP and SSE. | Conversation references can reach zero while the daemon and its background work remain alive. Explicit backend Stop, Restart and main shutdown retire the owned process. |
| External | Authenticated HTTP to an explicit loopback IP literal and port. DNS, remote endpoints, URL credentials, redirects, query strings and endpoint paths are rejected. | Disconnect closes Sedes subscriptions and releases its lease. It sends no native interruption and leaves the external daemon and background work running. |

Both modes require a local Linux execution environment and the same OS account
as Sedes. Admission records PID, process start time, executable identity and
canonical database identity. Subsequent identity changes revoke the connection;
an endpoint alone never proves continuity. The configured database path is an
operator declaration where the native API cannot prove which store it opened.
Symlink and hardlink store aliases are rejected. Other operating systems and
remote execution environments have no qualified identity/cleanup path here.

The adjacent, private store lease excludes another Sedes runtime using the same
store. It does not lock out independent native OpenCode processes. The operator
must select external mode for an existing owner. Unconfirmed cleanup retains the
lease; Sedes does not steal it or launch a replacement over it.
An abrupt Sedes crash can leave a stale lease that requires operator inspection
and removal after confirming the prior owner and its work have stopped.

Owned shutdown first tries bounded native session interrupts, then closes stdin,
then escalates through TERM/KILL and verifies descendants. Process identity and
an inherited ownership marker identify detached children. Processes deliberately
stripping that marker before escaping cannot be inventoried without OS
containment; this is a same-account trust boundary, not a sandbox. Cleanup never
deletes native history or credentials. A clean restart keeps the store and
acquires a new runtime generation. Incomplete native interruption and unproved
process cleanup are distinct outcomes.

## Configuration and authority

Backend configuration requires `nativeStorePath` and one closed `connection`
shape. Owned connections contain `process_stdio`, `executablePath` and
`workingDirectory`; external connections contain `http`, `url` and a Basic
authentication secret reference with the fixed username `opencode`. Connection
defaults contain separate model and variant selections. Variants are not
implicitly reasoning-effort values.

External credentials resolve in the execution environment from an approved
`SEDES_OPENCODE_…PASSWORD…` variable or an approved protected file. Password
validation has its own purpose; Codex capability-token namespaces and validation
remain separate. Protected-file resolution preserves canonical-path, owner,
mode, inode and replacement checks. Password values remain private to the native
client and never enter browser configuration, fingerprints or diagnostics.

Owned startup generates a password and preserves the account's HOME, native
authentication and configuration. An explicit configuration directory overrides
the default `${XDG_CONFIG_HOME:-$HOME/.config}/opencode`. It derives
`OPENCODE_DB` from the admitted store and rejects a conflicting override, forces
`OPENCODE_DISABLE_AUTOUPDATE=1`, and removes inherited process-mode/password
controls. The selected configuration directory replaces inherited
`OPENCODE_CONFIG_DIR`. Both ownership modes reject simulation and incompatible
config/client/model-URL profiles during admission.

Native project configuration, plugins, hooks, MCP registrations, provider
credentials, custom models and saved permission grants remain operator authority.
Sedes does not rewrite them. Tools already allowed by native policy may run
without a Sedes interaction. The pinned source inventory found only retained
configuration/migration fields for `share`, `autoshare` and `share_url`, with no
active core/CLI/server sharing producer; no active telemetry producer was found
in that scope. These observations are release-specific, not promises about
plugins or future releases.

Native binding and operation evidence are private scoped tables. A binding
includes principal, backend, connection, environment, canonical workspace,
native namespace and session. Operation identity and request fingerprint are
immutable before dispatch; accepted or proven-not-applied outcomes cannot be
reopened. Create/fork destinations are deliberately unbound until their result
is validated. Later mutations must match the exact persisted session binding.
Changing the configured database changes reserved native identity; changing an
endpoint updates the runtime configuration revision and requires fresh admission.

## Shared control and verification

Conversation Stop borrows already-published control before history hydration. A
per-owner fence serializes native Send/Steer calls with Stop, including first
Send, while history and queue acquisition stay outside that fence. A failed
initial projection retains control within the normal retention period, permits
exact force reset and remains reclaimable under runtime-budget pressure. Missing
history never proves native idle state. See the
[backend contract](../backend-integration-contract-rules.md) for deadline,
reconciliation, queue and automatic-detachment rules.

Deterministic tests cover schema/authentication boundaries, release mismatch,
HTTP response limits, runtime identity replacement, native store leases and
scoped operation evidence. Opt-in isolated native tests use stock `opencode2`
2.0.18 with fixture-owned state. They verify owned startup, malformed/expired
readiness, background-shell survival after reference release, external
Disconnect, detached-descendant cleanup, retained database identity and restart.
These tests do not require authenticated model requests or use an operator's
running OpenCode server.
