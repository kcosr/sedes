# Claude backend

Sedes integrates Claude through the exact-pinned
`@anthropic-ai/claude-agent-sdk` 0.3.274 package in a managed local
worker or persistent SSH/outbound sidecar and an operator-selected Claude Code
executable. Claude Code owns authentication and native conversation history; Sedes provides its normalized thread workflow, durable controls, and
recovery records.

Choose Claude when you want to use a Claude Code subscription on the local, SSH, or outbound execution host, permission modes and prompts, native skills, recorded token usage, and image
input in Sedes. Compare it with the other integrations in the
[backend support matrix](index.md). Backend maintainers should also read the
[Claude integration contract](../../internals/backends/claude.md).

## On this page

- [Prerequisites and authentication](#prerequisites-and-authentication)
- [Quick configuration](#quick-configuration)
- [Version compatibility](#version-compatibility)
- [Topology and ownership](#topology-and-ownership)
- [Permissions and security](#permissions-and-security)
- [Capabilities](#capabilities)
- [Current limits](#current-limits)
- [Safe verification](#safe-verification)
- [Troubleshooting](#troubleshooting)
- [Opt-in live verification](#opt-in-live-verification)

## Prerequisites and authentication

- Run Sedes on Linux x64 or macOS arm64/x64.
- Ensure the execution account resolves Node.js 24.18 or newer as `node`.
- For SSH, configure an OpenSSH host alias and a supported Linux or macOS sidecar host.
  The SSH account must have access to the workspace, provider installation,
  and provider home; authentication must already work unattended.
- For outbound, accept a Linux or macOS host as described in [Outbound hosts](../outbound-hosts.md).
  Its Claude runtime also requires Node.js 24.18 or newer, even though the connector
  and Files runtime can run on Node.js 22.19. Native Windows Claude is unsupported
  because its worker supervisor requires POSIX process groups.
- Install Claude Code in the target execution environment. By default the
  worker resolves the first executable `claude` on the service account's
  `PATH`. Set the optional `executablePath` only
  when you need to override that lookup; an override must be its canonical
  absolute POSIX path.
- Leave `configDirectory` blank for the execution account's normal Claude
  configuration. Sedes uses that account's `CLAUDE_CONFIG_DIR` when set, otherwise
  `$HOME/.claude`. An explicit `configDirectory` overrides both and must be a
  canonical absolute POSIX path. The worker validates the selected provider
  home and executable before opening SDK authority. When neither override is
  configured, Sedes leaves `CLAUDE_CONFIG_DIR` unset for Claude and its SDK
  helpers, preserving Claude's native default behavior.
- Authenticate that exact installation under the execution account: the local
  Sedes process account or the selected remote account.
- Use a first-party `claude.ai` subscription login. Sedes rejects API-key-only
  and API-key-overridden authentication and has no pay-per-token fallback.
- Defaults resolve in the selected execution environment: the local Sedes
  service account or the remote account. A remote target never uses the
  main server's `HOME` or `CLAUDE_CONFIG_DIR`.

The Agent SDK is bundled with Sedes. You do not need to install it separately
or configure an SDK directory; the optional configuration directory selects
Claude's login/settings/session home.

For multiple enabled Claude backends in one execution environment, set an
explicit directory for each. This lets Sedes distinguish their native stores;
a backend using the default cannot share that environment with another Claude
backend. Stop any retained conflicting runtime before starting a replacement.

Sedes's npm post-install step removes the SDK's unused optional platform
executable packages. It retains the SDK library and uses your separately
installed Claude Code executable. This reclaims installed disk space; npm may
still download and cache those packages. Installs using `--ignore-scripts` skip
this cleanup; run `node scripts/prune-claude-executables.mjs` afterward if needed.

Check the selected executable as the service account before starting Sedes:

```sh
claude auth status
```

The admitted status must report a first-party subscription login with no active
API-key credential source. Claude's user, project, local, and command-line
settings remain external operator policy; Sedes does not rewrite them or copy
Claude credentials into its database.

## Quick configuration

Add a local or **Sidecar SSH** environment, or accept an outbound Linux/macOS
host, in **Settings → Environments**, then
add **Claude** for that environment in **Settings → Backends**. Make these
choices explicitly. The [legacy fixture](../../../config/legacy-import/server.claude.example.json)
is only for offline conversion:

1. Leave the executable and configuration directory fields blank for the
   target account's normal installation. Sedes finds `claude` on its `PATH` and
   selects `CLAUDE_CONFIG_DIR`, otherwise `$HOME/.claude`, for provider state.
   Set `executablePath` or `configDirectory` only when overriding those defaults.
2. Define the required top-level `modelPolicy`.
3. Set `allowedModes` as the backend permission-mode ceiling.
4. Select a conservative target default; `bypassPermissions` can never be the
   default.

Claude policy matchers can constrain native model IDs and reasoning efforts.
They reject `providerIds`, because Claude's normalized provider value is a
Sedes connection namespace rather than a reviewed native provider identity.
All enabled targets on one Claude backend share one execution environment
and Claude configuration namespace. See [Configuration](../configuration.md)
for the complete schema and model-policy behavior.

For remote execution, grant optional `directory_browser`, `workspace_files`,
`composer_attachments`, or `agent_tools_cli` only when needed. These are
independent of Claude runtime admission. All provider paths resolve on the
remote host. Previously disabled remote definitions stay disabled until you
explicitly enable them; their IDs and native session bindings are retained.

## Version compatibility

Sedes pins one SDK profile: `@anthropic-ai/claude-agent-sdk` 0.3.274. It admits
stable Claude Code releases at or above 2.1.274, except for explicitly excluded
known-bad releases.

The reviewed runtime baseline is Claude Code 2.1.274. A newer admitted stable
release produces a structured advisory while continuing to use the pinned
SDK profile and behavioral checks. This warning is not an authentication
failure. Prereleases and releases older than 2.1.274 fail closed. The minimum
runtime does not move merely because a future SDK package bundles a newer CLI,
and protocol or behavioral incompatibility still fails closed.

For the most predictable deployment, pin the reviewed baseline. Before adopting
a newer admitted runtime, deliberately run the opt-in live gate described
below.

## Topology and ownership

For a local environment, Sedes launches a digest-verified Claude worker as a
child process. For SSH or an approved outbound host, the persistent sidecar
hosts the Claude runtime on the execution host. SSH stdio or the outbound
connection carries the same runtime protocol. The sidecar owns its SDK queries
and Claude processes independently of that attachment. Both paths load the
pinned SDK and perform discovery, history, rename, fork, version, and
authentication operations in the selected filesystem and account namespace.
Claude's login and ambient permission rules remain external operator authority.

Outbound Linux and macOS hosts use the same provider runtime. Native Windows
Claude is unsupported; this does not disable Windows Files, Pi workspace
operations, or Codex. See [Outbound hosts](../outbound-hosts.md) for native prerequisites
and platform validation limits. Native macOS execution must be validated on a Mac; Linux verification does not
establish that evidence.

Idle conversations use Sedes's existing retention period (one hour by default).
Evicting a conversation closes its SDK query and Claude Code subprocess. When
its last query is evicted, the shared worker and supervisor also exit once
history, discovery, and other operations finish. Later use starts a fresh worker;
provider history and backend configuration remain intact. Carrier loss or a main
server restart preserves sidecar-hosted queries and running work. Remote eviction
requires sidecar runtime protocol 8.

One principal/backend runtime owns the SDK queries admitted by Sedes's shared
conversation-runtime budget for that execution environment. A live Sedes
thread has at most one warm query, and closing a handle does not delete the
Claude session. The provider worker also retains a fixed hard guard of 32
simultaneous queries as a fail-closed resource boundary; it is not an
operator-tunable Claude session policy. Claude Code and its SDK remain
authoritative for native conversation history. Sedes stores only its
application overlay, recovery records, and provider-private binding metadata.

Remote queries can remain alive across SSH or outbound connection loss,
connector restart, or main-server restart.
Reconnect reattaches the existing session and recovers retained runtime events
and provider history without resubmitting accepted input. A sidecar service
restart or remote-host loss is a different boundary: native history remains
provider-owned, but an in-flight query may be interrupted and its outcome may
need recovery. Retained recovery output is bounded; exhaustion produces an
explicit query failure instead of dropping output silently.

**Disconnect** detaches main Sedes and preserves remote work. **Stop**,
**Restart**, and **Upgrade and restart** act on the owning runtime/service and
require the current impact check. Active turns, pending permission decisions,
and unsettled results block automatic replacement. Sedes tools that require
main-server authority cannot execute while main is absent. See
[Persistent remote services](../operations.md#persistent-remote-services).

Files, attachment staging, directory browsing, and agent-tool CLI modes require
their own admission in each topology. Managed provider terminals remain unsupported. Claude has no
Native agent-tool surface, and missing CLI admission does not fall back to
another presentation.

## Permissions and security

Claude permissions appear in Sedes as the private versioned
`claude.permissions@1` feature. They are not Pi tool access and are not a
filesystem sandbox. The backend configuration defines a closed
backend ceiling over these modes:

| Mode                | Operator-visible behavior                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `default`           | Ask when Claude requires permission.                                                           |
| `acceptEdits`       | Automatically accept supported edit operations.                                                |
| `dontAsk`           | Deny operations not already allowed.                                                           |
| `auto`              | Use Claude's automatic permission classification.                                              |
| `bypassPermissions` | Bypass Claude permission checks; must be explicitly allowed and can never be a target default. |

The selected model, effort, and permission mode apply together at a turn
boundary. Sedes blocks new work when an observed state cannot safely satisfy
the desired selection instead of guessing or silently substituting values.
Permission prompts become normalized Sedes interactions, including bounded
ephemeral session grants where the SDK permits them.

Claude permission decisions and Sedes execution-environment decisions are
separate. A Claude **Allow once** or session grant authorizes only the SDK
operation it describes. It does not authorize a Sedes application tool to
cross execution environments. Conversely, a Sedes environment approval does
not broaden Claude's permission mode or ambient Claude Code policy.

Plan mode is intentionally unavailable because its reset-producing lifecycle
does not have a durable normalized rebind contract. For the exact permission
and interaction invariants, see the
[internal integration contract](../../internals/backends/claude.md#permissions-and-blocking-interactions).

## Capabilities

The Claude backend can:

- create, discover or import, resume, submit, Steer, Queue, Stop, rename, and
  recover threads;
- choose an admitted native model, reasoning effort, and Claude permission
  mode;
- normalize confirmation, decision, and questionnaire interactions;
- use positively classified nonterminal skills;
- deliver ordinary text, immutable context excerpts, structured Task
  references, staged files, and native PNG, JPEG, GIF, and WebP image input;
- use Tasks, Saved Agents, and eligible automations;
- expose eligible Sedes agent tools in Progressive or Individual mode through
  the generated local CLI or admitted SSH/outbound sidecar CLI relay;
- retain direct main-loop turn usage and separate cumulative pipeline totals; and
- fork an idle thread at its latest successfully completed ordinary turn or an
  exact successfully completed ordinary turn.

Ordinary staged files are provided to Claude as authenticated paths, not
inlined contents; ask Claude to read the staged path. Recognized images use a
separate validated SDK image-block path and remain available as staged read-only
files. Native image input does not imply provider-output image artifacts.

Steer sends input at Claude’s next native opportunity, including during active
work, using conversation-scoped delivery. It may join the current turn
or start the next if the current turn has finished. Pending input remains
visible until Claude confirms incorporation. Steer does not interrupt work.
Claude Code 2.1.274 is the minimum because its consumption acknowledgments allow Sedes to track delivery reliably.
If a server restart interrupts confirmation, Sedes exposes the delivery as
unconfirmed for recovery and retains its original identity. Missing transcript
entries or an empty native queue never authorize an automatic resend. A late
consumption acknowledgment can still resolve that same delivery.
If the original delivery can no longer be tracked, the input becomes a failed
queue item explicitly marked with an unknown outcome. Claude may already have
received it. You can acknowledge the failure or restore the text to review
before deciding whether to send again; Sedes never resends it automatically.

Queue is Sedes-owned next-turn work. It is not SDK stream injection and is not
relabeled as Steer. An unconfirmed delivery pauses subsequent dispatch and shows
“Queue paused: an earlier delivery needs reconciliation” above the composer.
Use **Reconcile delivery** to check the original submission; your draft and
later queued messages remain intact while confirmation is pending.

On the reviewed 2.1.274 runtime, native background inventories keep subagents
and commands visible after the main response finishes. Ordinary Send remains
available. Live or uncertain background work blocks automatic idle eviction;
remote runtime impact checks include known background work. Transport loss
invalidates the displayed inventory until authoritative state returns.
Subagent terminal notifications produce separate transcript rows retained in
scoped Sedes receipts because SDK history does not retain those notifications.
This feature does not expose child transcripts or individual task stop controls.

## Current limits

Claude does not support:

- manual compaction;
- plan mode, reset-producing commands, terminal-only commands, or unclassified
  slash commands;
- active-source forks or latest-provider-snapshot forks;
- forks from attachment-ended structured-output turns;
- guaranteed file-history or attachment fidelity across a native fork;
- provider-output image artifacts;
- the shared Pi `set_tool_access` action;
- native agent-tool presentation; or
- managed terminals.

Unavailable operations are omitted from capabilities and fail closed at the
backend boundary. Claude's generic **Fork** action resolves the newest completed
turn only while the source is idle and records an inclusive completed-turn
boundary. Transcript and agent-tool forks select an exact completed turn.

Claude Steer targets the conversation; it does not provide Codex’s exact-turn
guarantee. A separate interrupt-and-send action is not exposed. Public history can
erase the boundary needed to recover manual compaction as one normalized
operation. Automatic provider folding remains provider-owned history behavior.
The [internal integration contract](../../internals/backends/claude.md) records
the complete reasoning and recovery rules.

## Safe verification

After startup:

1. Confirm that the backend is healthy and exposes the expected models and
   efforts.
2. Create a disposable thread with `default` or `dontAsk` permission mode.
3. Send one small text turn and wait for its terminal result.
4. Reload the thread and confirm that the user turn, response, usage, and
   terminal state remain stable.
5. Send another disposable turn and test **Stop**.
6. Exercise a permission prompt separately before enabling a broader default.
7. If staged files are needed, verify an ordinary file-read request and a
   supported image input independently.

For SSH persistence, additionally use a disposable remote thread to verify
that a turn survives a lost SSH connection and a main-server restart, then
reattaches to the same native session without duplicate input. Test permission
recovery and Stop separately. Do not infer these properties from a local gate.

These checks consume provider capacity. Keep prompts small, use a disposable
workspace, and do not use sensitive files merely to validate connectivity.

## Troubleshooting

| Symptom                                                      | Checks and resolution                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend is unavailable at startup                            | Confirm the target account's `PATH` resolves `claude`, or verify the optional canonical `executablePath` override; also check the selected provider home (`configDirectory`, then the execution account's `CLAUDE_CONFIG_DIR`, then `$HOME/.claude`), worker artifact admission, executable permissions, and runtime compatibility. Inspect the bounded diagnostic code for worker, version, authentication, or initialization failure. |
| Authentication is rejected despite a working interactive CLI | Run the configured executable's `auth status` as the selected local or remote execution account. Confirm first-party `claude.ai` subscription login, remove active API-key overrides, and verify the selected provider home and the environment visible to that account.                                                                                                              |
| SSH runtime does not reconnect                              | Check the environment connection preference, exact SSH alias and account, remote Node installation, sidecar compatibility, and ownership/recovery status. Use **Connect** after intentional Disconnect; do not substitute local provider paths. |
| Runtime version is rejected                                  | Use a stable Claude Code release at or above 2.1.274. Prereleases and explicitly excluded releases fail closed.                                                                                                                                                                                                                    |
| Runtime is newer than tested                                 | This is advisory for an otherwise admitted stable release. Pin 2.1.274 for the reviewed baseline or deliberately run the opt-in real-Claude gate before adopting the newer CLI.                                                                                                                                                    |
| No models or efforts are selectable                          | Confirm native initialization and catalog success, then inspect `modelPolicy`. Claude matchers use model IDs and efforts; `providerIds` are invalid.                                                                                                                                                                               |
| Initialization times out on a healthy installation           | Investigate slow CLI startup first. If appropriate, increase `initializationTimeoutMs` within its supported one-to-120-second range; do not hide authentication or version failures with a longer timeout.                                                                                                                         |
| The worker reports query capacity exceeded                   | The fixed 32-query worker guard indicates that too many Claude queries remain resident in one execution environment. Close or archive idle threads and inspect runtime retirement if capacity does not recover. Attaching the same native session twice is denied independently.                                                   |
| A permission mode is missing                                 | Compare it with the backend `allowedModes`. `bypassPermissions` must be explicitly allowed and can never be the target default.                                                                                                                                                                                         |
| Plan-mode tools appear or a reset command is selected        | Use a reviewed CLI/profile and keep those commands disabled. Sedes rejects `EnterPlanMode`, `ExitPlanMode`, and other reset-producing forms.                                                                                                                                                                                       |
| An ordinary file is visible but its contents were not used   | Sedes sends the authenticated staged path, not the file body. Ask Claude to read it explicitly; native images use a separate SDK image-block path.                                                                                                                                                                                 |
| Fork is missing                                              | The source must be idle and the boundary must be an exact successfully completed ordinary turn. Attachment-ended structured-output boundaries and active sources are unforkable.                                                                                                                                                   |

Use [Debug diagnostics](../../developer/diagnostics.md) for safe inspection.
Do not attach Claude credentials, complete provider payloads, or native
transcripts to an issue.

## Opt-in live verification

The real-Claude suite consumes the authenticated subscription and provider
capacity. It is not part of routine verification. Run it only when deliberately
approved:

```sh
env -u NODE_ENV npm run test:real-claude
```

The gate uses its reviewed model, effort, and no-tools profile to verify basic
streaming, persistence, usage, and reopen behavior. Its persistent-runtime case
uses real worker stdio and local framed sockets to verify active-turn completion
after main-client disposal and reattachment without resubmission. It does not
verify a remote SSH or outbound host, or its login. Passing the suite also does not claim live
verification of every tool projection, image, subagent, skill, or permission
path.

For implementation ownership, history projection, terminal receipts, input
correlation, agent-tool injection, forks, and recovery, continue with the
[Claude integration contract](../../internals/backends/claude.md).

## Recorded usage

Claude records direct main-loop turn usage separately from cumulative usage and
estimated cost across the actual SDK query lifetime. The reply popover labels
**Main-loop usage only**; broader query-pipeline/subagent totals and cost stay at
session scope. Message evidence is replaced by covering result evidence, not
added twice. Model information is preserved where the source reports it.

Reattaching the same retained query preserves accounting identity. A new query
lifetime is a separate epoch, and a recorded conversation reset ends its segment.
A decrease without proven reset stays a conflict. Existing retained replay and
ordinary history can reconcile available evidence; unrecoverable gaps remain
labelled. Legacy Claude ledger totals have unknown coverage and appear separately
from newly recorded totals. Request counts remain unavailable when native fields
count model rounds or messages instead of requests.

Captured values live in the main Sedes database and remain readable without
opening a provider session. See [recorded usage](../../user/conversations.md#view-recorded-usage)
for the UI and [backups](../operations.md#state-upgrades-and-backups) for retention.
