# Antigravity

Sedes runs the official Google Antigravity CLI through ACP on the selected
execution host. Local, SSH, and outbound Linux/macOS environments use the same
provider runtime. The remote runtime remains owned by the persistent sidecar
when the browser, main Sedes process, or SSH carrier disconnects.

## Install and authenticate

Install `agy` on each execution host using Google's
[CLI installation instructions](https://antigravity.google/docs/getting-started?tab=cli).
This integration admits stable Antigravity **1.5.14 or newer within major 1**,
ACP version 1, and the required native session capabilities. Windows is not
currently qualified for this backend.

```sh
agy --version
agy acp --help
agy acp --login
```

Complete sign-in as the account running the Sedes execution service. Google's
[ACP guide](https://antigravity.google/docs/cli/acp) describes interactive
authentication, including hosts reached over SSH. Sedes reuses native
authentication; it does not copy credentials from main to a remote host.

## Configure

In **Settings > Execution**, add an Antigravity backend and choose its execution
environment. `executablePath` optionally selects the absolute host path to
`agy`; otherwise Sedes resolves it on that host. `geminiDirectory` optionally
selects an absolute native configuration directory. Its default is the host
account's `.gemini` directory. `initializationTimeoutMs` defaults to 30000.

Each execution environment supports one enabled Antigravity backend, with
multiple connection targets for different defaults. This conservative ownership
reservation also applies when separate profile paths are configured: default,
explicit, and symlinked paths may refer to the same native store, and preparing
configuration never probes a remote filesystem to guess their identity.

On a connected SSH or paired host, saving the first backend or an additional
target applies it as soon as the sidecar confirms the settings. Running turns
and terminals continue. Changes to provider startup settings apply to the next
native runtime. If you need them immediately, stop the existing backend after
its work settles.

The backend kind is `antigravity`, connection kind `antigravity_acp`, and
configured protocol release `1.5.18`. Connection configuration accepts:

```json
{
  "defaults": {
    "modelId": "gemini-3.8-flash",
    "thinkingLevel": "low",
    "modeId": "default"
  }
}
```

Values must match the installed provider's live catalog. The example is not
an entitlement promise. Model policies filter native model and reasoning
identifiers; model availability and reasoning choices are rechecked before
delivery. A disposable native session discovers each model's actual reasoning
options without changing the user's session.

Native modes are exact provider identifiers. Sedes does not equate `plan` with
read-only execution or `auto` with unrestricted execution. Native permissions
and workspace trust remain Antigravity's responsibility.

In a thread's **Thread actions > Antigravity mode** menu, choose Default,
Accept edits, Auto, or Plan when the installed provider advertises that choice.
The preference is saved for that thread and applied before its next prompt.
**Keep native mode** clears the preference and preserves the provider's current
choice; it does not restore the target's initial default. The menu describes a
next-turn preference, not confirmation of a currently active permission mode.

Saved Agents inherit the target's mode default and can override it with a
qualified mode the target currently advertises. If the target stops advertising
the selected mode, the editor marks it unavailable and the Saved Agent cannot
start a thread with that selection.

Startup and per-thread environment definitions are resolved on the execution
host. Secret-file paths refer to that host. Provider identity and Sedes authority
variables are controlled by the runtime. Sedes disables automatic CLI updates
for processes it owns; upgrade the installed executable deliberately.

## Sessions and lifecycle

Native conversation databases remain in
`<geminiDirectory>/antigravity-cli/conversations/`. Sedes stores scoped thread
bindings, desired settings, and application receipts, not a duplicate transcript.
History viewing reads SQLite in a read-only transaction and does not start or
resume Antigravity. Archiving in Sedes does not delete native conversations.

Foreground readiness and background activity are separate. Commands, scheduled
work, and subagents can outlive a prompt and produce new messages or permission
requests. While the CLI still holds a prompt open for background work, Send
remains unavailable even after the foreground reply finishes. A standalone
quota notice after a proven executor failure leaves the turn failed, with the
quota message visible when you reopen the thread. If a subagent fails on quota
without sending a completion message, Sedes stops counting it as active once
the parent execution that launched it has a terminal failure or cancellation
receipt. Stop can then finish and the thread can accept another message when
all other work has settled. Pending work and undelivered
outcomes block ordinary runtime retirement. A disconnected runtime is not evidence that work stopped.

Remote instances require an execution sidecar advertising
`antigravity_runtime` capability 6. Upgrade main and the sidecar together before
enabling this backend. There is no local fallback when a remote host is offline.
Reconnect restores exact retained session authority; it does not replay an
uncertain submission or silently create another session.
If the sidecar itself is replaced, for example after the host container
restarts, Sedes rebuilds the backend once the replacement is ready and open
settled threads reattach. Threads with a pending permission, unresolved
operation, or background work that was running before the restart stay
disconnected until you review them and restart the Antigravity backend.

Attached idle threads continue checking for native changes so background work
remains observable. Unchanged history reuses its validated snapshot and avoids
repeated transcript projection, usage accounting, and full-history SSH transfer.
SQLite reading and decoding run in a dedicated worker on the execution host.
Streaming refreshes are coalesced; permission and operation events are still
processed promptly. This optimization does not mark background work complete
or turn an uncertain submission into an accepted one.

Receipts have explicit bounds: a runtime retains at most 256 unacknowledged
creations and 4096 total creation identities; a resident session retains 4096
operation identities, with 128 additional slots reserved for cancellation and
permission cleanup. Acknowledging a receipt preserves its identity and result
until its owner retires. Capacity refuses new effects before delivery rather
than forgetting an identity that could be replayed. After settling pending work
and outcomes, retire the session or restart the idle backend runtime to rotate
these bounds. Unidentified creation attempts with uncertain outcomes remain
blocked until an explicit forced runtime Stop proves owned process cleanup;
Sedes never adopts an unrelated native conversation to resolve them.

Unproven process cleanup fences new work across that backend runtime. Recovery
observations and cleanup controls remain available. A failed close does not
authorize a competing runtime or prove that native background work stopped.

Antigravity 1.5.14 can leave a token-generating native subagent running after
ACP cancellation. Sedes reports an uncertain Stop and fences further input
until cancellation is positively proved; it does not report the child stopped.
Retry Stop after native work settles, or explicitly force Stop on the backend
runtime when owned process shutdown is intended.

A later fresh native snapshot can prove that an uncertain Stop drained its
original inputs and background work. Sedes then settles that exact receipt and
clears the input fence without replaying cancellation. Unknown native receipts
continue to require explicit retirement when no such proof exists. An uncertain
setting change needs a subsequent exact native setting observation; transcript
text and cached settings do not prove a configuration or permission decision.

Child completion needs its exact native message receipt as well as terminal
child history. Some native system messages omit the event kind and child
identity; these do not prove a particular child notification was consumed.
Sedes retains the pending obligation rather than inferring completion from
message text or timing.

## Capability boundaries

Thread renames are local to Sedes, for drafts and bound threads while idle or running.
The saved title takes precedence over subsequent native discovery titles on both
local and remote execution hosts. It does not rename the conversation in `agy`.
Renaming a draft also preserves that title after its first send binds the native
session. Before an explicit rename, native discovery can refresh the displayed title.

The first integration supports native session discovery, creation, streaming,
passive paged history, conversation-scoped Steer, model/reasoning selection, permission decisions and native
choice questions, staged files and image input, Saved Agents, automation policy,
native token usage, and Sedes tools through Native MCP or CLI. Both tool surfaces support Progressive and Individual presentation with the current thread policy checked on every call. Capabilities are evaluated for the installed runtime.

Exact conversation forks, managed provider terminals, native generated-image
artifacts, and account quota reporting
are not currently advertised. Native Antigravity tools and its own configured
MCP servers remain provider-owned. See the
[capability matrix](index.md#capability-differences) for the current shared controls.

## Troubleshooting

Verify the executable and native sign-in on the execution host, then inspect the
backend's runtime status in Settings. Authentication failure does not authorize
Sedes to copy another host's credentials. A native schema mismatch fails closed
instead of replacing missing history with a new session.

If runtime retirement reports outstanding work, inspect the thread and resolve
pending interactions or use the scoped Stop control. Do not remove native
databases or kill unrelated `agy` processes to clear the status.

Developer contracts and qualification details are in
[Antigravity internals](../../internals/backends/antigravity.md).
