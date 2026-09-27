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
saved Agents, skills, manual compaction, and expressible native permissions/forms
are supported. Queue
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
96 MiB of acquisition/projection data, and 60 seconds. Limits fail explicitly.

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
If an interaction reply loses its acknowledgment and its result cannot be
proved, Sedes blocks a second response, including reset cancellation. Inspect
the native request before proceeding. Pending requests in known direct child
sessions produce a notice and require a native client to answer them.

## Tools, skills, and execution variables

**Native / Progressive** agent tools use the bundled `sedes opencode-mcp`
helper. No separate bridge installation or permanent native configuration is
required. Sedes admits a fresh private MCP registration for the exact native
runtime and workspace, then reuses it across Sedes-created root threads there.
OpenCode passes the native session ID on each call; Sedes maps it to the exact
thread and applies that thread's current tool policy. Imported sessions and
native children do not inherit another thread's Sedes tools.

The bridge credential identifies this runtime/workspace channel, not one
thread. It is passed only to the MCP child. The session ID routes an already
authenticated call; it is not the credential. Native permission rules remain
in force and may ask before a gateway call or deny it. Sedes access-boundary
approvals are a separate check. Those approvals require a currently observed
Sedes user input; a native-only or automated input cannot borrow an older
user message's approval authority. Following a lost observation stream or idle
handle eviction, send a new user message before requesting an operation requiring
that approval.
Operations already within the configured boundary remain available.

The bridge exits when Sedes closes its authenticated lifetime channel or its
heartbeat expires. It can survive ordinary idle conversation-handle eviction,
which releases the thread's event observer and runtime lease while retaining
routing for operations already within the configured access boundary.
Stock OpenCode has no conditional registration ownership check, so Sedes never
deletes or overwrites an existing entry during cleanup. Failed entries can
remain in the native MCP inventory until the native workspace/runtime restarts.
Admissions and inventory are bounded; exceeding a limit makes Sedes tools
unavailable with a notice, while conversation controls remain usable. Initial
MCP discovery can race the first prompt; Sedes does not delay all messages to
wait for native catalog readiness.

Each host runtime admits up to 1,000 thread routes and remembers up to 4,096
distinct CLI credentials, including revoked credentials. Remote routes remain
reserved after a thread closes because native background work may still call
them. Capacity is therefore a runtime-lifetime limit, not an active-tab limit.
If capacity is reached, inspect retained work before explicitly retiring and
reconnecting the backend. Owned Stop terminates its work; remote external Stop
or local external Disconnect retires Sedes's attachment and leaves the daemon running. Automatic
route eviction is unavailable because stock OpenCode cannot prove a complete
background-work inventory.

**CLI** tools are available for owned, local Sedes-created root sessions.
The generic tool settings can retain a CLI selection on other sessions. For
external or imported sessions, or an unavailable local CLI endpoint, Sedes
withholds CLI credentials and shows an unavailable-tools notice; Send, Steer
and conversation controls remain usable. Choose Native where supported or
disable Sedes tools. This does not relax the external execution-variable rule.
Thread environment definitions are supported only for owned runtimes. They
replace the complete native session shell environment before explicit work,
using the immutable owned launch baseline, the thread's frozen definitions,
and generated Sedes CLI variables last. They do not reconfigure provider
credentials, MCP children, VCS helpers, or arbitrary native/plugin processes.
Definitions must not select native identity/configuration or override Sedes
credentials. Native children do not inherit this session map; child spawning
is denied when it would lose required execution variables or CLI authority.
An external runtime rejects nonempty Sedes execution-variable definitions.
Native environment maps are volatile and are reinstalled after an owned restart.
Imported sessions with an empty Sedes definition preserve their native map.
Explicit compaction prepares the same frozen map before dispatch. When variables
or CLI authority require installation, the root must be idle with no pending
input, approval, running child or shell; compaction does not bypass that check.

A selected skill is attached to an ordinary prompt and frozen in the native
inbox with that exact input. This is an explicit manual selection, including
skills marked against automatic invocation. Native commands remain unsupported
because they can change the model or spawn work outside this submission path.

## Images and compaction

Composer files use authenticated Sedes staging. Models advertising vision can
receive validated native image bytes. Images in one OpenCode message must total
16 MiB or less. The complete encoded native prompt is also limited to 22 MiB,
including escaped text, image encoding, staging metadata and selected skill IDs.
Large text can therefore reduce the available image capacity. Inputs exceeding
either bound are rejected before sending. Ordinary staged files retain the
general composer limits. A completed native image read can show
**Viewed image** with the actual retained bytes when subsequent provider work
proves that image's inclusion. If context pruning, a checkpoint, missing bytes,
or another proof gap prevents that conclusion, the child image is unavailable;
Sedes does not reread a path and present a later file as the original input.
Operator plugins can replace native tools, so this relies on the admitted
stock runtime and trusted local configuration, rather than cryptographic tool
producer attestation. Native generated-image artifacts are unavailable.
Native reads and event frames are bounded to 32 MiB; complete history acquisition
is bounded to 96 MiB including repeated reads and projection. Native skill or
plugin expansion, generated records, external inputs, and large accumulated
histories can still return an explicit size-limit error. The adapter also avoids an
upstream Base64-validation stack overflow for large images without requiring a
patched OpenCode build.

Manual compact uses one exact private native control ID. Its HTTP reply means
admission; only its native terminal record proves completion or failure.
Staged revert, foreign pending compaction, and custom compaction instructions
are rejected. Stop attempts withdrawal of exact pending Sedes-owned controls
and preserves the ordinary Sedes Queue.

## Recorded usage

With the main-server `SEDES_EXPERIMENTAL_USAGE=1` setting, OpenCode reports native
main-session token totals and estimated USD cost, including native title and
compaction work. It does not report a bill, request counts, or child-session
usage. Turn detail comes from surviving native history and can be incomplete.
Reconnect and repeated history reads do not charge work twice; revert does not
subtract work already performed.

Sedes-created roots have a proved zero baseline. Imported sessions count only
increases after their first observed total and retain an unknown earlier-usage
notice. Native fork/child transcript allocations are withheld because they can
contain copied work. Model information comes from actual native message evidence,
not the currently selected model. Disabling recorded usage leaves ordinary
history and conversation controls available.

Forks, native commands, managed TUI, and remote execution remain unavailable.
Native configuration can load operator-installed tools independently of Sedes.

For implementation evidence and authority boundaries, see
[OpenCode internals](../../internals/backends/opencode.md). The isolated
[`test:real-opencode` suite](../../developer/development.md) uses a disposable
stock v2 daemon and loopback model fixtures, without paid model requests.
The separate opt-in `test:live-opencode` gate qualifies one explicitly selected
OpenAI-compatible provider/model with a disposable read-only canary. It requires
authorization and an explicit credential environment reference; it never runs
as part of the local suite. See the [live-provider instructions](../../developer/development.md#live-provider-suites)
for isolation, limits, and the remaining retry/billing uncertainty.
