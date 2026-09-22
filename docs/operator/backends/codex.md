# Codex backend

The Codex backend connects Sedes to Codex app-server while keeping Codex's
native protocol and identifiers behind Sedes's normalized conversation
contract. Choose it when you need explicit sandbox, network, approval, and
reviewer settings; structured questions; Goal or Fast mode; native generated
images; or an operator-owned app-server reached locally or through SSH.

For provider-protocol, history, recovery, and feature implementation details,
see the [Codex backend internals](../../internals/backends/codex.md). For a
cross-backend comparison, see the [backend support matrix](index.md).

## On this page

- [Prerequisites and authentication](#prerequisites-and-authentication)
- [Configure Codex](#configure-codex)
- [Version compatibility](#version-compatibility)
- [Supported topologies](#supported-topologies)
- [Capabilities and limitations](#capabilities-and-limitations)
- [Safe verification](#safe-verification)
- [Troubleshooting](#troubleshooting)
- [Opt-in live verification](#opt-in-live-verification)

## Prerequisites and authentication

Every topology requires an already authenticated Codex installation. Sedes
does not perform Codex login, store provider credentials, or copy the native
Codex store into application state.

For a Sedes-owned stdio backend:

- run the standalone Sedes server on Linux x64 or macOS arm64/x64, or use
  Electron Managed Local on Windows arm64/x64, under the operating-system
  account that owns the intended Codex authentication and native store;
- configure the canonical absolute default working directory; Sedes resolves
  `codex` from the service account's `PATH` unless the optional canonical
  `connection.channel.executablePath` override is present;
- ensure the executable is a regular executable file whose version command
  reports one stable `codex-cli` version; and
- keep `HOME` and an optional `CODEX_HOME` consistent with the account used to
  authenticate Codex.

For an external endpoint, you own the daemon, account authentication, native
store, upgrades, and restart policy. Sedes verifies the runtime version during
initialization but never launches or restarts that daemon. TCP WebSockets also
require a per-connection-generation capability bearer loaded from an
appropriately named `SEDES_CODEX_*TOKEN*` environment variable or an
owner-protected absolute file. That bearer protects the app-server endpoint;
it is separate from Codex account authentication.

A remote target requires a working OpenSSH host alias, an admitted persistent
sidecar, and a workspace beneath a saved remote root. Its provider endpoint and
credentials resolve on that execution host. Files, attachments, and Sedes CLI
tools require their explicit capabilities; the provider transport grants none.

## Configure Codex

Add **Codex** in **Settings → Backends**. Choose its environment, provider
connection ownership and transport, model policy, execution-policy ceiling,
and target defaults. Credentials stay in approved host-scoped environment or
protected-file references; Settings never returns their values.

Local connections support owned stdio, external Unix sockets, and authenticated
TCP/TLS. Remote connections use a persistent sidecar on the selected host, with
separately admitted provider runtime and workspace-operation authority. Keep all
targets for a backend in one environment and create a new backend identity for
a different provider store or endpoint.

The [schema-10 examples](../../../config/legacy-import/README.md) document explicit
legacy import. They are not current startup files. Use
[Configuration](../configuration.md) for Settings ownership and conversion.

### Model and execution policy

The top-level `modelPolicy` controls model and reasoning admission. The
provider-private `moduleConfiguration.policy` controls the execution-policy
ceiling. Codex policy matchers may constrain native model IDs and reasoning
efforts but reject `providerIds`: the normalized provider value is a Sedes
connection namespace, not a reviewed native provider identity. The obsolete
`moduleConfiguration.policy.models` field is rejected.

`catalog` adds no Sedes model restriction. An allowlist admits only matching
model/effort selections. A denylist removes matches but deliberately admits
future unmatched catalog values; use a constrained allowlist for a closed set.
Sedes filters the live catalog, does not fabricate configured entries or
substitute defaults, and rechecks the effective tuple before provider work.
Existing disallowed selections remain readable and visible as unavailable
until repaired. See
[backend model policy](../configuration.md#backend-model-policy).

The target provides defaults. Each thread stores the desired model, reasoning,
service tier, sandbox, network, approval policy, and approval reviewer for its
next create or turn. A fork also needs a complete allowed tuple that the child
can apply. The detailed authority rules are in
[Codex execution settings](../../internals/codex-thread-execution-settings.md).

## Version compatibility

Sedes supplies the exact generated `0.153.0` app-server protocol profile from
its compiled Codex backend. Operators do not select that profile in Settings. Sedes independently probes and admits stable Codex app-server
executables at or above 0.153.0. Build metadata is allowed and does not affect
version precedence. Prereleases, malformed versions, versions below the floor,
and explicitly excluded known-bad releases are rejected.

Releases newer than the 0.154.0 tested-through threshold are admitted with an
installation advisory. They do not gain capabilities merely because of their
version. Managed TUI uses `moduleConfiguration.tuiExecutablePath` when present;
otherwise it resolves the first `codex` on the execution environment account's `PATH`. This is
identical for a directly run server and Electron Local. The command is version
checked on every Start but its user-owned bytes are not hashed or pinned.

Paginated history uses the stable `thread/turns/list` and `thread/items/list`
routes. The remaining experimental surface is bounded to reviewed
provider-private directions and does not change the normalized browser
contract or any other backend.

The compiled profile is persisted for diagnostics and runtime-generation
integrity; it is not a request to install or launch that Codex release. See
[protocol and release admission](../../internals/backends/codex.md#protocol-and-release-admission)
for the parser and generation contract.

## Supported topologies

| Topology                    | Ownership                                                                    | Environment | Route assurance                                                                             | Managed TUI | Files                        |
| --------------------------- | ---------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------- | ----------- | ---------------------------- |
| Process stdio               | Sedes owns executable, process group, and native-store lock                  | Local       | Canonical executable/workdir plus version probe                                             | No          | Local                        |
| Unix WebSocket              | Operator owns daemon/store; Sedes owns client                                | Local       | Owned `0700` parent and owned `0600` filesystem socket, rechecked per generation            | Yes         | Local                        |
| Authenticated WS/WSS        | Operator owns daemon/store; Sedes owns client                                | Local       | Loopback-only plaintext or platform-verified TLS plus per-generation bearer                 | Yes         | Local                        |
| Persistent sidecar runtime | Sidecar owns its runtime/client; an external daemon remains operator-owned | SSH or outbound | Exact environment/service identity and provider transport admission on the execution host | Yes, for an external daemon when the sidecar negotiated managed-TUI operations | Separately granted operations |

Sedes does not start, stop, restart, archive, or configure an external Codex
daemon. It establishes availability through the normal connection and
initialization handshake. Disconnecting a client does not prove that a
provider turn was cancelled. External connections do not claim a Codex
native-store lock.

### Sedes-owned stdio

Sedes canonicalizes and prepares the executable and working directory, probes
`--version`, starts app-server over stdio, and requires the initialized
app-server user agent to report the same semantic-version precedence; build
metadata may differ. Sedes owns the complete process group and native-store
lock. It forwards a closed environment set plus normal `HOME`; an explicit
`codexHome` adds `CODEX_HOME`, while omission preserves Codex's normal default.

All configured profiles share one concurrent app-server client generation in
the principal/backend runtime. Logical Sedes threads do not create a daemon
each. Shutdown kills the owned process group before releasing the store lock.

After the last retained conversation is evicted (one hour by default), Sedes
releases the shared runtime once outstanding operations finish. Owned stdio
exits; an external UDS/TCP server keeps running and only Sedes's connection
closes. Backend configuration stays enabled, and later use starts or reconnects
the runtime on demand. Creating or attaching another conversation prevents idle
teardown. Sidecar-hosted work survives main-server and carrier disconnects;
unacknowledged outcomes and retained remote threads prevent idle retirement.
Remote eviction requires sidecar runtime protocol 8.

### Local Unix WebSocket

The socket modes are a capability boundary. Sedes requires a canonical,
owner-only parent (`0700`) and owned socket (`0600`), captures the socket
identity, connects, and fences a replacement generation. The external
app-server remains alive when Sedes stops or reconnects.

### Local TCP and WSS

Plain `ws://` requires literal `127.0.0.1` or `[::1]`. `wss://` uses platform
certificate-chain, validity, and peer-name checks with TLS 1.2 or newer.
Non-loopback WSS is not published as a local workspace target because a local
execution environment cannot provide truthful remote path semantics.

Sedes resolves one capability token for each connection generation. It sends
the bearer only in the WebSocket Upgrade `Authorization` header, never in
logs, errors, snapshots, configuration fingerprints, browser storage, or
child/model environments. Other clients holding the same token must be
trusted and should remain passive: Sedes cannot stop them from answering
provider server requests first.

### SSH UDS

For a remote target, the sidecar establishes the admitted provider connection
on the execution host. It retains the runtime across main-server restart or SSH
loss, including bounded creation/submission receipts and pending interaction
state. Reattach identifies the existing provider session and reconstructs from
provider-native history before allowing conflicting new work. It never repeats
an uncertain submit merely because the caller lost its response.

The persistent runtime can use admitted owned stdio, external Unix-WebSocket,
or authenticated TCP/TLS transport. Paths, native store locks, executable checks,
and credentials resolve on that host. Remote app-server clients must be trusted
and passive. Safe upgrade cannot be inferred from an empty sidecar inventory
when an external client may still be active.

Files, terminal, attachment, and agent-tool operations require independent
capability grants even when the provider runtime is healthy. Tools requiring
main's application authority are unavailable while main is disconnected; there
is no offline task or message queue. See
[persistent remote services](../operations.md#persistent-remote-services).

## Capabilities and limitations

The current Codex driver supports:

- discovery, import, resume/reattach, and bounded history pagination;
- submit, steer, interrupt, rename, and compact;
- provider-assigned creation and restart reconciliation;
- model, reasoning, service tier, and four-axis execution policy;
- workspace skills;
- provider approvals and structured questionnaires;
- context and token usage;
- selected-turn and latest-provider-snapshot native forks; and
- nonblocking follow-up questions in the Questions panel; and
- provider features `codex.execution@1`,
  `codex.fast_mode@1`, `codex.goal@1`, and `codex.tui@1` where eligible.

When Codex temporarily recovers model-provider authentication during a turn,
Sedes shows a warning notice followed by a success notice for that thread.
Those notices do not mean the app-server transport restarted and are not used
as account identity or authorization evidence.

Async follow-up questions raise a notice above the conversation and a
**Questions** tab beside **Prompts**. Both appear only while questions are open
and open the same panel above the composer. The panel opens automatically on new
questions and on loading a session with pending questions. Closing it is respected
until another question arrives or you reload. Amber question icons in the composer
and sidebar indicate pending questions; the sidebar icon opens the session's
panel. Archiving asks for confirmation and preserves unanswered questions.
Navigate requests oldest first with
the previous/next controls. Clicking a suggested answer sends it immediately;
**Other…** reveals a text box for a custom answer. Questions without suggestions
have a **Write an answer…** control. Answers to other questions in the same
batch remain pending until answered or dismissed.

Clicking an answer immediately shows a **Sending** row and preserves your
composer draft. The reply steers a running turn when supported, starts a new
turn when idle, or queues when immediate delivery is unavailable or earlier
inputs must go first. Its status follows the confirmed delivery state until
the reply appears in the transcript.
**Dismiss** sends nothing and discards the current request's remaining questions.
Once a request is finished, the panel advances to the next. Once none remain,
the panel closes and its notice and tab disappear. Open questions survive later
messages and reloads, and the panel never blocks the running agent. Sent replies
have a compact **Question answered** transcript entry that retains its styling
after reload through Sedes's stored delivery metadata.

Enable **Nonblocking questions** in notification settings to receive an event
when a new batch opens. Imported history does not create a backlog of pending
questions. If structured questions exceed Sedes's bounds, ordinary bounded
assistant text remains visible.

Fast mode is the closed service-tier feature. Codex 0.153 may also advertise
its separate native Ultrafast tier; Sedes recognizes that catalog metadata but
does not offer or map Ultrafast to Fast. Goal stores one bounded objective and
projects provider-observed lifecycle status; its create, pause, resume, and
clear actions are capability- and revision-checked. Neither is inferred from
model names or free-form provider text.

### Agent tools

Eligible Sedes-created local or managed-SSH threads can receive the generated
Sedes CLI in Progressive or Individual mode according to their per-thread
agent-tool policy and shell environment policy. Progressive uses bounded JSON
catalog/describe/invoke commands; Individual uses the live help hierarchy and
named typed commands. Imported
threads, network-disabled settings, a missing built CLI, an unavailable
sidecar/capability, or contexts whose isolation cannot be proven receive no
CLI. For SSH, `agent_tools_cli` must be enabled on the managed sidecar.
Codex has no Native Sedes-tool surface and never falls back to one.

### Managed TUI

Managed TUI is available only for eligible external UDS/TCP Codex connections
with the required executable, endpoint, PTY, and execution-policy
capabilities. A local target qualifies when the local execution environment can
prepare the command, the process-visible endpoint, and an owned PTY. An SSH or
outbound target qualifies when the persistent sidecar hosts the Codex runtime
and its runtime channel negotiated the `codex_managed_tui` control and execute
operations; the sidecar advertises that capability only when its native PTY
support loaded. The terminal process then runs inside the sidecar, not on the
Sedes host. Managed TUI also requires `modelPolicy.type: "catalog"`; allowlist
and denylist policies disable it because the interactive client can select a
model without a pre-turn authorization hook. It remains unavailable for
Sedes-owned stdio connections on every topology. See
[Managed Codex TUI](../../internals/codex-managed-tui.md).

Sedes does not edit the service account's Codex configuration. Each managed
TUI process receives a closed set of command-line config overrides: automatic
recap is off, Enter submits, Vim mode does not start active, alternate-screen
support remains enabled for full-screen overlays, raw-output mode is off, and
Codex's paste-burst detector remains enabled. Codex still renders its main
surface in an inline viewport. These launch invariants override conflicting
account config; other Codex TUI preferences remain account-owned.

The following boundaries are intentionally unsupported:

- container execution environments;
- managed TUI on Sedes-owned stdio connections, on every topology including a
  persistent sidecar;
- automatic transport fallback or alternate routes;
- moving an existing thread between backends or environments;
- Sedes-owned Codex MCP configuration;
- provider `openaiForm` MCP elicitation requests;
- output artifacts other than completed, in-band PNG `imageGeneration`
  results;
- path-only generated-output reads, including through the managed-SSH
  sidecar;
- durable promotion of ordinary tool-result images;
- image-generation controls and a dedicated image download action; and
- inference of native children or mutation outcomes from approximate matches.

## Safe verification

After startup:

1. Confirm the expected model catalog and installation advisory.
2. Create a disposable thread and send one small turn.
3. Reload the thread and confirm its history.
4. Test Stop on disposable work.
5. For external transports, perform an operator-controlled daemon restart and
   confirm that Sedes reconnects before relying on the topology.

This smoke check exercises the configured route without invoking the broader
live-provider suite. Preserve any application recovery state if a sent
mutation times out or the transport drops; reconnecting does not make a
mutation safe to repeat.

## Troubleshooting

| Symptom                                                      | Checks and resolution                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Owned stdio is rejected before startup                       | Confirm Linux x64, macOS arm64/x64, or Windows arm64/x64 through Electron Managed Local; verify that `PATH` resolves `codex` or the optional canonical override is valid, the canonical workspace path is admitted, executable access is available, and one compatible stable `codex-cli` version line is reported.                                                      |
| A console window briefly flashes when a Windows turn starts  | Current Codex Windows releases may create a visible PowerShell command-safety helper even when Sedes starts `codex.exe` without a console window. This is provider-runtime behavior; upgrade Codex when its Windows child-process fix is available.                                                                                                                    |
| Codex reports that login is required                         | Authenticate the same service account using its intended `HOME`/`CODEX_HOME`. Sedes does not translate API credentials or perform login.                                                                                                                                                                 |
| Native store is already locked                               | Another owned Codex/Sedes process is using the same store. Stop the other owner; do not remove the lock blindly or operate one native store concurrently.                                                                                                                                                |
| Local UDS fails route assurance                              | Start the external daemon first, then verify that the socket parent is owned and mode `0700`, the filesystem socket is owned and mode `0600`, and the configured path is exact.                                                                                                                          |
| TCP connection receives `401` or `403`                       | Confirm the capability bearer is available to the Sedes service and matches the daemon. It is required in addition to provider authentication.                                                                                                                                                           |
| WebSocket URL is rejected                                    | Plain `ws://` accepts only literal loopback. `wss://` requires platform-trusted TLS, hostname verification, and TLS 1.2 or newer. Use a persistent-sidecar target for a remote execution environment.                                                                                                                        |
| External daemon is unavailable or reports a version mismatch | Inspect the daemon independently, compare it with the admitted stable range, correct the operator-owned service, and restart it yourself. Sedes does not manage external lifecycle.                                                                                                                      |
| Models appear but a thread cannot run or fork                | Check model/effort, service tier, sandbox, network, approval policy, and reviewer against the live catalog and configured ceiling. Sedes does not invent or substitute an unconfirmed value.                                                                                                             |
| Managed TUI is missing                                       | It requires an external UDS/TCP Codex connection—local, or hosted by a persistent sidecar whose runtime channel negotiated the managed-TUI operations—plus one completed first submission, healthy endpoint and PTY support on the hosting environment, a compatible operator-installed CLI there, fully representable settings, and catalog model policy. Set canonical `moduleConfiguration.tuiExecutablePath` to override normal `PATH` resolution. |
| Sedes CLI tools are missing                                  | Check thread provenance, network policy, built CLI availability, proven isolation, and—on SSH—the `agent_tools_cli` sidecar capability.                                                                                                                                                                  |
| A sent mutation times out or the transport drops             | Preserve the application recovery state. Sedes retries only reviewed safe reads and never infers an outcome from title, workspace, timing, or similar content.                                                                                                                                           |
| A reloaded thread contains an older abandoned turn           | Sedes reads paginated history without changing Codex's native store and shows abandoned native `inProgress` turns as interrupted. A stale historical shell does not require Force reset or direct SQL/rollout repair.                                                                                    |

`429` and `503` from an external endpoint are treated as transient overload.
Wait for the operator-owned daemon to recover instead of changing transport
identity. Use [Debug diagnostics](../../developer/diagnostics.md) for bounded
delivery and fork diagnostics. Never include tokens, rollout files, or
provider payloads in reports.

## Opt-in live verification

Codex live suites launch or connect to authenticated provider processes and
can consume provider capacity. They are separate from normal unit and
integration verification. Run the broad local live gate only when that use is
explicitly authorized:

```sh
env -u NODE_ENV npm run test:real-codex
```

The generated-image canary is a further opt-in. It requires the approved
shared UDS endpoint and exact Luna model, consumes image-generation capacity,
and leaves its non-ephemeral native Codex thread retained:

```sh
SEDES_REAL_CODEX_GENERATED_IMAGE=1 \
SEDES_REAL_CODEX_UDS_SOCKET=/canonical/absolute/path/to/codex.sock \
SEDES_REAL_CODEX_UDS_MODEL=gpt-5.6-luna \
  env -u NODE_ENV npm run test:real-codex -- \
  -t "publishes one real generated image"
```

Authorization for this gate must cover both capacity use and retained provider
state. It unsubscribes from the native thread but does not archive or delete
it.

Focused gates exist for agent tools, SSH UDS, and managed TUI. Each has strict
environment and endpoint prerequisites; review the matching gate before
invocation. One topology's success does not live-verify another topology,
transport, generated-image path, or TUI.

For contributor-facing protocol and lifecycle contracts, continue with
[Codex backend internals](../../internals/backends/codex.md).

## Recorded usage

Codex records cumulative `thread/tokenUsage/updated` observations on main.
Repeated totals replace checkpoints rather than add another charge. Per-turn
values are conservative differences between continuous, attributable checkpoints.
The first interval of a new turn is included when Sedes observed the previous
turn's checkpoint, its completion, and the new turn's start in that order within
one uninterrupted runtime generation. A start alone, a reconnect, or a late
checkpoint cannot establish that boundary. These remain recorded intervals,
not a claim that all turn or child-agent usage is available.
The latest-call counter is retained as lower-scope evidence, not the whole turn.

Native history provides no per-turn usage backfill. Codex 0.153.0 restores its
cumulative accumulator from the saved rollout on cold resume, including
paginated resume. The pinned implementation is
[`record_initial_history` at revision 41e22fee](https://github.com/openai/codex/blob/41e22fee981a63b3698df7ed36bad393cda24715/codex-rs/core/src/session/mod.rs#L1450),
with [upstream resume fixtures](https://github.com/openai/codex/blob/41e22fee981a63b3698df7ed36bad393cda24715/codex-rs/app-server/tests/suite/v2/thread_resume.rs#L3502).
A restored checkpoint can recover session totals without recovering older turns.
Reconnect and process generation changes therefore preserve the same counter
series. If resumed totals are lower, Sedes retains the last valid value and shows
reconciliation incomplete; it does not invent a reset or charge a new series.
Copied fork baselines are not newly charged. Usage notifications provide no model
or provider attribution, so those dimensions remain unknown. Native child-thread
usage is not captured separately and its inclusion in parent totals is unproven.
No billing cost is fabricated from token counts.

Captured values live in the main Sedes database and remain readable without
opening a provider session. See [recorded usage](../../user/conversations.md#view-recorded-usage)
for the UI and [backups](../operations.md#state-upgrades-and-backups) for retention.
