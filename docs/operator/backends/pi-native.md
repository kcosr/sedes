# Pi native backend

Select **Pi** in Settings to run the installed **Pi 1.4.0** CLI in RPC mode on
the thread's execution host. Sedes owns the process and uses Pi's native
authentication, model catalog, configuration, and JSONL conversation store.
Local, persistent SSH, and outbound environments are supported on Linux and
macOS. Native Windows execution is unsupported.

**Pi SDK** remains a separate backend using the embedded 0.86.0 SDK. Its
provider runtime stays on main Sedes and it offers the existing local workspace
isolation modes. Adding Pi does not convert SDK backends or existing threads.
See the [SDK guide](pi.md) and [backend comparison](index.md).

## Prerequisites and authentication

Install Pi 1.4.0 and authenticate the operating-system account that will run
it. For SSH or outbound environments, this is the remote sidecar account.
Verify `pi --version` reports `1.4.0` and that the intended native model catalog
is available under that account. Sedes rejects other versions, including newer
versions; this integration has an exact reviewed runtime boundary.

Credentials stay in Pi's native configuration. They are not Sedes backend
configuration fields. An explicit **Agent directory** selects a different
native Pi configuration directory. Otherwise the process uses
`PI_CODING_AGENT_DIR`, or Pi's normal `~/.pi/agent` default.
The environment value comes from the execution host's process environment;
Sedes's per-thread and startup variable editors do not override it. A leading
`~/` resolves against that account's home. Other relative values are rejected
so discovery and the running process always use the same native store.

For a remote runtime, enable persistent sidecar operations and deploy a sidecar
that advertises the native Pi runtime capability. Install and authenticate Pi
on that host. Files, attachment staging, terminals, and Sedes CLI tools still
require their own environment grants; starting Pi grants none of them. Native
Pi workspace tools run on the execution host and do not use the SDK's remote
workspace-tool adapter.

## Configuration

In **Settings → Backends**, add **Pi** to one execution environment and create
its target. Its backend kind is `pi_native`; target kind is `pi_rpc`.
Configuration is principal-owned database state, like the other backends.

| Setting | Meaning and default |
| --- | --- |
| Executable path | Optional canonical absolute path on the execution host. Otherwise resolve `pi` from that account's `PATH`. |
| Agent directory | Optional canonical absolute native Pi configuration directory on that host. |
| Session directory | Optional canonical absolute directory containing native JSONL sessions. Otherwise use Pi's native per-workspace session directory. |
| Trust Pi project resources | Defaults to false. Controls Pi's native project trust choice, including whether project MCP configuration is loaded. |
| Initialization timeout | `initializationTimeoutMs`, 1000–120000 milliseconds; defaults to 30000. |
| Default provider and model | Set both or neither. Without an explicit pair, use the admitted native selection. |
| Default thinking level | Optional: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`; the selected model must support it. |
| Model policy | Catalog, allowlist, or denylist policy over provider/model/effort selections. The current native catalog and policy must both admit a selection. |

Paths and startup environment overrides resolve on the execution host. A
backend belongs to one execution environment; configure another instance for
another host. An unavailable historical model remains visible but cannot
receive new work until an admitted selection is chosen.

## Tools, native configuration, and MCP

Sedes launches Pi with a managed companion and disables automatic loading of
other extensions. The companion enables Pi's native code-mode and MCP
factories. Native skills and prompt templates remain available; arbitrary
extension commands are unsupported in this managed session.
Code-mode scripts can call admitted tools. The optional `models` global is
disabled, so scripts cannot make additional model calls outside Sedes's model
policy.

Configure third-party MCP servers in Pi's native files on the execution host:
the agent directory's `mcp.json`, and the workspace's `.pi/mcp.json` when
project trust is enabled. There is no separate per-thread MCP server editor in
Sedes. Native configuration may resolve environment references or run configured
commands with the host account's authority, so review it before enabling it.
Complete MCP OAuth login outside Sedes using the native Pi CLI; the managed
conversation does not expose the extension's `/mcp` login commands.

Use **Thread actions → Agent tools…** for Sedes application tools. Sedes supplies
the selected tools automatically to that thread through the companion; no
native MCP file entry is needed. Native Progressive and Individual modes are
supported. CLI modes additionally require an available Sedes CLI endpoint on
the execution host and its remote grant when applicable. Tool grants and
project/environment scope are rechecked for every application operation.
For an eligible CLI presentation, enabling tools or changing the selected IDs
takes effect on the next invocation, including during a running turn. Changing
the Native tool presentation still requires an idle thread.

Opening or retrying the skill picker requests a fresh native catalog. Ordinary
presentation uses a five-second freshness window and keeps the last successful
catalog while refresh is pending or fails. A failed picker refresh remains
visible and can be retried.

Pi tool access and Sedes resource scope are independent:

| Pi tool access | Effect |
| --- | --- |
| Read-only | Allows reviewed read-only built-ins and Sedes tools with no write, external, or model-usage effects. Third-party MCP calls are denied. |
| Ask | Requests approval for mutating built-ins, effectful Sedes operations, and every third-party MCP call. |
| Full | Permits the admitted native tool catalog; Sedes application tools still require their own grants and resource scope. |

The same checks apply to tool calls nested inside code mode. MCP read-only
annotations are unverified and do not bypass the policy. Tool access is an
application policy, not an operating-system sandbox. Native Pi does not offer
the SDK backend's Bubblewrap workspace isolation.

## Conversation controls and history

Pi supports Send, turn-scoped Steer, Queue, Stop, rename, manual compact, model
and thinking changes, and tool-access changes. Steer targets the exact active
turn. Queue is the shared Sedes queue and sends only after authoritative turn
settlement. Stop reconciles accepted and cleared native inputs; an unknown
outcome stays in recovery rather than being retried automatically.

Native history is read from the execution host's JSONL store. Opening detached
history does not start a model turn or attach a writable Pi session. Discovery
is restricted to the canonical workspace directory. Native history reads and
discovery are bounded; oversized or malformed stores fail visibly rather than
returning an incomplete transcript as complete.

Forks copy through the selected or latest **completed** turn, including its
native tool results and compaction entries. A completed boundary can be forked
while a later source turn runs. Forks do not include the active provider
snapshot. The child inherits the captured model, thinking level, and tool access;
the captured model and thinking level override older selections in copied
history. It reloads the host's current instructions, so historical instruction
text is not preserved. Retrying an already-created fork verifies its original
receipt without requiring the source history or current model policy again.

Composer files use staged host paths. Native image input is available only
when the selected model advertises it. Native in-band images in assistant and
tool results can be displayed as Sedes image artifacts, including authenticated
nested code-mode results. Image publication validates the actual raster bytes;
paths in provider output do not authorize a host-file read. Managed provider
terminals, background-work status, and nonblocking structured questions are
unsupported. Supported blocking interactions are choices,
confirmations, text input, editors, and tool decisions.

Usage is recorded from native entry evidence with available provider/model
dimensions, token counters, and native cost values. Verified inherited fork
entries are excluded from new spend. Unproven ancestry is reported as
incomplete coverage instead of silently counted again. Attached sessions show
Pi's current context occupancy and model window separately from cumulative
usage. After compaction, occupancy stays unknown until Pi receives a new model
response; detached history exposes message and tool counters only. Completed, continuously
observed turns can show throughput from matching native request-duration and
output-token evidence. Missing, failed, or interrupted observations suppress
the rate.

## Ownership, reconnect, and recovery

Sedes owns one writer for a native session. The SDK and native backends share
the session-writer lock when pointed at the same native store. They also share
conversation ownership: discovery does not import a second Sedes thread for a
session already bound or reserved by either backend, including an aborted
fork's reserved child. Other sessions in the store remain discoverable.
Read-only history remains available. Standalone Pi does not honor this Sedes lock:
do not open the same conversation for writing concurrently outside Sedes.
The two Pi versions share the native v3 file format, but not every context
feature. Sessions with native context edits or unknown active record/message
kinds require **Pi** for writing;
the older **Pi SDK** backend rejects those sessions rather than changing their
meaning. Passive discovery and history remain available.
The SDK also includes older retained compaction summaries that Pi 1.4 omits;
shared storage does not promise identical model context. Continue these
native sessions with **Pi** to preserve their context reconstruction.

For remote environments, the persistent sidecar owns Pi processes. Main-server
restart, SSH carrier loss, or outbound connector loss does not end accepted
work. Reconnection must reach the same runtime and session generation;
Sedes does not replay a mutation merely because its response was lost.
For local environments, stopping main Sedes also stops its owned runtime.

Runtime inspection reports active work, pending interactions, unacknowledged
operations, and cleanup uncertainty. Ordinary stop or restart refuses these
blockers. A forced runtime operation explicitly abandons retained work and
attempts process cleanup. If cleanup cannot be proven, the writer remains
locked and status stays `cleanup_unproven`.
Streaming progress and observation-only reads do not invalidate a Stop
confirmation; newly owned work or interactions do. Recovering a retained
session uses a separate read-only attachment, so other threads can continue
normal work while it drains.

After an abrupt host-process failure, establish that the old Pi child and its
descendants have exited before recovering that session's
`<session-file>.sedes-native-writer` marker on the execution host. The recovery
diagnostic identifies this condition. Sedes does not infer descendant cleanup
from an absent or reused host/child PID. Do not delete lock files or the marker
while a surviving process may still write. Each session can retain 32 MiB of
events and unfinished stream state; unconsumed output is bounded even during
a detached run. Exhausting that event budget reports continuity loss and blocks
ordinary mutations for that session without consuming another session's
allowance. Operation-capacity limits also refuse new work. Neither case
silently drops evidence and continues.
Concurrent status and history reads share a bounded read allowance that leaves
separate capacity for Send and Stop. Large retained results can still exhaust
their allowance; a mutation whose result cannot be retained remains explicitly
uncertain and must be reconciled before retrying.
An observation gap can recover for that session once its process has exited or
native state proves it idle, without stopping other threads. Sedes closes an idle
process, proves writer cleanup, reloads native history, applies retained output,
and reports that some transient output was unavailable. Active work, queued input,
pending interactions, or uncertain cleanup keep recovery blocked. Retained
operation outcomes remain subject to their existing recovery checks; acknowledging
an output gap does not make an uncertain operation safe to repeat.
A busy session with an output gap remains available in control-only mode so you
can choose **Stop** for that thread. Reattaching does not stop it automatically.
An explicit Stop cancels pending approvals, dialogs, and Sedes tool calls before
the session can recover; it does not stop other threads on the backend.
Recovery also starts automatically when the run finishes naturally or its
process exits. If the session remains in recovery after the run finishes, review
its pending operations. A retained wait can require stopping that session's exact
Pi process on the execution host; identify it by its session file, and leave
other sessions running. Cleanup must still be proven before reconnecting.
An operation with an unknown outcome remains unsafe to repeat after process
exit. Sedes preserves its receipt and does not retry it as part of gap recovery.
If a recorded kernel boot identity proves that the host rebooted, Sedes can
recover the stale marker automatically. Same or unknown boot identity requires
the operator checks above.

Back up native Pi configuration and session directories alongside Sedes state.
Remote runtimes also require the sidecar's private state, including its native
Pi authentication key, to verify retained operation evidence. Session files
alone do not carry that private authority.

## Troubleshooting and verification

| Symptom | Check |
| --- | --- |
| Runtime unavailable | Exact Pi 1.4.0, executable permissions, selected account, Linux/macOS, and the configured native directories. |
| No remote Pi capability | Upgrade the persistent sidecar and verify its platform and operations connection. No local fallback is attempted. |
| Missing models or credentials | Agent directory, `PI_CODING_AGENT_DIR`, execution-host environment, native login, then model policy. |
| Missing MCP tools | Native `mcp.json`, project trust, MCP startup/authentication, and tool-access mode. Read-only deliberately denies third-party calls. |
| Session locked | Another cooperating SDK/native writer or an unproven surviving Pi child; inspect ownership before cleanup. |
| Input outcome unknown | Preserve the thread and let exact operation evidence reconcile. Do not resend based on matching prompt text. |

Deterministic tests cover configuration, the RPC companion, process ownership,
durable operations, native history, and sidecar reconnect behavior. Those
checks do not establish live model-provider compatibility. The separate
`test:real-pi-native` suite runs an explicitly selected stock Pi 1.4.0 executable
against isolated loopback model and MCP fixtures. Set
`SEDES_REAL_PI_NATIVE_EXECUTABLE` to its absolute path; the suite does not use
normal account credentials or live providers. The existing `test:real-pi` and
`test:real-pi-cli` gates exercise the SDK backend.

The separate `test:live-pi-native` gate requires explicit authorization,
`SEDES_RUN_LIVE_PI_NATIVE=1`, and an absolute `SEDES_LIVE_PI_NATIVE_EXECUTABLE`
selecting stock Pi 1.4.0. It uses disposable native sessions and verifies the
exact `aw-qwen-3-8-27b/aw-qwen-3-8-27b` model, low reasoning, and read-only tools
before prompting. On 2026-10-26, its one Linux x64 live test passed, including
nested code-mode reads, signed provenance, and detach/resume; all ten offline
native qualification tests also passed, including context occupancy through
compaction and secret-free process bootstrap. This evidence is limited to that model
and host platform; it does not qualify other providers or macOS execution.

Provider-private evidence, bounds, and lifecycle invariants are documented in
the [native Pi maintainer contract](../../internals/backends/pi-native.md).
