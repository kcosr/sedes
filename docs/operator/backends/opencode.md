# OpenCode v2

Sedes supports stock OpenCode **2.0.18** on local Linux under the same operating
system account. Select the absolute path to the v2 binary, normally
`opencode2`. The older `opencode` v1 executable is not an alternative. Provider
authentication, native project configuration, plugins, permissions, and model
definitions remain in the selected native OpenCode environment.

## Connections

Choose one ownership mode in **Settings → Environments → Backends**:

| Mode | Configuration | Behavior |
| --- | --- | --- |
| Sedes-owned | Absolute executable, working directory, and native database path; optional native configuration directory | Starts `serve --stdio --hostname 127.0.0.1 --port 0` as needed and retains the daemon between threads. Stdin controls lifetime; conversation traffic uses HTTP/SSE. Backend Stop and Restart clean up owned work. |
| External | Explicit loopback HTTP IP/port, native database path, and Basic password reference | Connects to the existing daemon. Backend Disconnect leaves that daemon and its background work running. Conversation Stop still interrupts the selected session. |

The external URL must be an IP literal such as `http://127.0.0.1:4096`, without
a path, query, URL credentials, or redirects. Remote HTTP, DNS endpoints,
WebSocket, UDS, ACP, and SSH/outbound sidecars are not supported. Owned stdio is
a process-lifetime channel, not a JSON-RPC conversation transport.

Authenticate OpenCode's providers separately before sending a Sedes message.
For an existing daemon, enable native password authentication and configure
the matching password reference in Sedes: an approved `SEDES_OPENCODE_…PASSWORD…`
environment variable or an owner-protected file. The username is `opencode`.
Owned mode generates its own server password. Neither mode writes provider
credentials into Sedes thread settings.

Use a dedicated database path for each native owner. Sedes verifies the native
process and store and holds a private adjacent lease. Do not launch another
owner over a leased store. Unproved cleanup or a crash can leave a retained
lease; inspect the prior process and descendants before manually removing it.
Sedes never removes native history to resolve a lease conflict.

## Conversations and settings

Create a thread or discover a native session in the exact authorized workspace.
Imported sessions initially have no desired Sedes model; explicitly select a
catalog model before sending work or copying the session into a saved Agent.
Provider-qualified model identities distinguish identically named models.
Catalog defaults come from OpenCode's actual default selection.

Sedes keeps desired settings separate from the observed native selection.
An ordinary Send reapplies a reviewed desired selection after another client
changes the native model. Steer requires the current native selection to match.
Unknown/custom variants remain readable and stoppable but require an explicit
supported selection before new work. Only reviewed reasoning-effort variants
appear in Sedes; arbitrary native variants are not treated as effort settings.

Send, conversation-scoped Steer, Sedes Queue, Stop, rename, model/effort changes,
saved Agents, and expressible native permissions/forms are supported. Queue
stays in Sedes until the preceding work settles. Stop preserves that queue and
attempts to withdraw each still-pending Sedes input from the native inbox.
An input already consumed by OpenCode is not returned as unsent.

Permission prompts offer **Allow once** and **Deny and stop**. Native rejection
rejects all pending permissions in that session. Dismissing a permission
without rejecting it is unavailable. Unsupported session-owned form shapes are
cancelled once with a visible notice; unowned global forms are never answered
or cancelled by Sedes.

## Recovery and limits

OpenCode owns the transcript. Sedes reconstructs native history after a stream
disconnect, including final full-text repairs for incomplete streaming deltas.
Initial history acquisition can be expensive: it is bounded to 100,000 records,
64 MiB of acquisition/projection data, and 60 seconds. Limits fail explicitly.

An HTTP prompt acknowledgment proves inbox admission, not consumption. Sedes
tracks each submitted input independently. Lost replies never trigger a second
prompt. If the original continuous input stream is lost and native history and
inbox cannot establish the outcome, Sedes shows a failed unknown delivery.
Review the native conversation before restoring that text to the composer.
Restoring does not send it. Stock OpenCode does not persist event payloads by
default, and native revert can erase both pending and consumed inputs.

Other native clients may edit sessions or answer approvals. Sedes reconciles
observed changes but cannot attribute those external actions to a Sedes user
operation. Managed TUI handoff is unavailable. Observed child sessions and
session-attributed shells contribute background counts; this is not a complete
inventory of every native Job.

Attachments, image input/viewing, generated-image artifacts, Sedes agent-tool
MCP/CLI, per-thread execution environment injection, manual compaction, forks,
and usage accounting are currently unavailable. Native configuration may still
load operator-installed tools independently of Sedes.

For implementation evidence and authority boundaries, see
[OpenCode internals](../../internals/backends/opencode.md). The isolated
[`test:real-opencode` suite](../../developer/development.md) uses a disposable
stock v2 daemon and loopback model fixtures, without paid model requests.
