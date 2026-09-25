# Agent tools subsystem contract

Sedes exposes a bounded set of application operations through two explicit
caller classes:

- a thread agent uses that thread's default-off, exact-ID policy, with live
  access edits in CLI presentation and idle-only native/presentation edits; and
- a named principal-owned **Tool client** uses a durable, revocable credential
  with its own exact tools, environment allowlist, and optional defaults.

It is an application-management surface—not provider tools, general MCP
server management, workspace shell access, or a general asynchronous job
system. Sedes serves only its own tools over MCP, to Codex and Claude threads
that use the Native surface.

For user workflows, see [Provider features](../user/provider-features.md). For
operator trust-boundary requirements, see
[Operations](../operator/operations.md). Related internal contracts are
[Blocking interactions](blocking-interactions.md),
[Workspace Files](workspace-files.md), and
[remote Pi workspace tools](pi-remote-workspace-tools.md). New adapters and
backends must also follow the
[backend integration contract](backend-integration-contract-rules.md).

## Contents

- [Policy and caller ownership](#policy-ownership-and-persistence)
- [Environment authority](#access-boundary)
- [Catalog and backend presentations](#catalog-and-effects)
- [Native MCP presentation](#native-mcp-presentation-codex-and-claude)
- [CLI transport and invocation lifecycle](#cli-transports-and-admission)
- [Trust boundary and verification](#http-adapter-and-trust-boundary)
- [Limits](#limits)

## Policy ownership and persistence

Agent-tool policy is principal-owned application state attached to a thread,
not provider session state. Ordinary Custom threads start disabled with no
selected IDs. A Saved Agent may
provide the complete initial tool policy, and the thread menu's **New** action
copies the source thread's complete policy. Both paths create independent thread
state, so later edits to the Agent or source thread do not alter the new thread.

UI groups and select-all controls are conveniences. Durable policy stores the
master flag, exact enabled IDs, one thread-wide environment-access rule,
revision, and presentation surface/mode. Concurrent edits conflict instead of
overwriting one another. With an unchanged CLI presentation, the master flag,
exact enabled IDs, and environment-access rule can change during a turn or
beside queued input without retiring the runtime. Discovery and invocation
read the current policy. Disabling a tool prevents a stale discovery result
from invoking it later; already admitted work is not cancelled. Any policy
revision change invalidates a pending access approval at revalidation.
The agent learns about added tools on its next discovery request, not through
an automatic message.

Native-tool policy and all surface/mode changes require an idle thread and
runtime retirement. Native presentation keeps its tool list for the Pi turn or
the Codex or Claude provider session; every invocation still rechecks policy.

## Principal Tool clients

An external `sedes` CLI process can use a named principal-owned Tool client.
Creation requires a name, at least one current eligible
tool, one default execution environment, and an explicit nonempty allowed-
environment set containing that default. A default workspace and thread are
optional conveniences; they never expand the allowlist. The client starts
enabled.

The create response returns the `hatc1_…` credential exactly once. Sedes
persists only a keyed verifier, never the plaintext token, so a lost value
cannot be recovered. Rotation issues a replacement and invalidates the previous
generation; disable is reversible; revocation is permanent. Revoked metadata
is retained for truthful operation provenance and cannot be restored.

Policy changes, disable, rotation, and revocation are revision checked and
govern requests that cross the next admission boundary. They do not rewrite
historical provenance or cancel domain work that was already admitted. A
removed catalog tool or unavailable configured default remains visible as
**needs attention** but is filtered from discovery and execution until the
client is edited.

Principal clients have no source thread or active-turn lease. They never see
the source-only `agent.context` operation and cannot create or expand other
Tool clients. Every other advertised operation uses the same canonical schema,
effects, revisions, receipts, recovery, and provenance as its thread-agent
counterpart. In particular, they may invoke `thread.send@2` only in its
fire-and-forget form: `callback: true` requires a trusted calling thread and is
rejected when the caller is a principal Tool client.

## Access boundary

Thread-owned policy uses `accessBoundary`: `thread`, `environment` (default),
or `unrestricted`. It controls whether an enabled Sedes tool needs an
application decision; it never bypasses ownership, tool exposure, or provider
permissions.

- **Ask outside this thread** admits only exact source-thread resources without
  prompting. Thread-scoped Tasks and Workpads belong to that audience. Other
  threads (including descendants), project scopes, global scopes, and the
  environment directory require approval. Moving a resource checks both its
  current and destination scopes. Source context and public web research do
  not cross the boundary.
- **Ask outside this environment** preserves the previous default. Global
  Tasks, Workpads, and Saved Agent metadata remain environment-neutral.
- **Allow without asking** performs the same resource checks without prompting.

Approval is **Allow once** or **Deny**, bound to the exact invocation. Sedes
revalidates the source thread, approval runtime, policy revision, input,
resource identity and revision, tool contract, and effects after approval.
Task and Workpad authority includes thread identity, preventing a resource
moved between scopes while approval is pending from inheriting stale access.
Policy changes and runtime resets invalidate pending approvals.

These scopes do not otherwise isolate projects. A thread in environment mode
may explicitly query another project or thread in its environment. Lists use
the requested scope and do not silently filter denied targets into a different
query. Cross-environment checks remain in addition to principal ownership.

Tool clients retain their configured environment allowlists and have no
interactive approval path. They do not inherit a thread policy. Automations
cannot answer browser decisions; any invocation that needs approval fails
closed. Delegated agent work uses the destination thread's own policy.
Application decisions are provider-neutral for Pi, Codex, Claude, and Grok;
unavailable interaction bindings fail closed instead of bypassing approval.


## Catalog and effects

The canonical catalog groups operations under:

- **Context** — bounded source-thread/application context;
- **Files** — source-thread linked-worktree discovery and thread worktree
  preference selection;
- **Threads** — inventory, status, messages, creation, send, fork,
  archive/restore, and related controls;
- **Agents** — saved Agent discovery and revision-checked management;
- **Tasks** — bounded reads and revision-checked mutation; and
- **Automations** — definition/history reads and guarded scheduling controls;
- **Research** — current public information through an installation-owned
  provider process.

`research.web_search` is provider-neutral. Its initial Grok CLI provider may
use general web search, page fetch, and public X search, while Sedes removes
local file, shell, write, image, subagent, memory, and MCP capabilities. It is
a Sedes read with model execution and no durable external side effect. If
the executable fails its startup check, configuration screens show the exact
tool disabled and runtime catalogs omit it.

Search continuation is deliberately narrow. Set `continue` only for a direct
follow-up that depends on the most recent successful search by the same
trusted Sedes thread or Tool client. Sedes resumes only the exact returned
provider session ID—never Grok's “latest” session. The mapping is process-local;
after restart, or when that exact session is missing, the request safely starts
fresh and reports `continuationFallback: true`. New or unrelated questions
should omit `continue`.

Effects remain part of every public tool descriptor. For example, direct send
or automation run-now can start model work, while a task file path is only
metadata and grants no Files access. List operations are bounded; mutating
operations retain their normal application revisions, receipts, and recovery
rules.

Do not maintain a second static schema catalog in documentation. The
authoritative IDs, versions, effects, labels, and eligibility rules are in
[`canonical-agent-tool-manifest.ts`](../../src/server/agent-tools/registry/canonical-agent-tool-manifest.ts),
with generated public contracts under
[`schema/artifacts`](../../src/server/agent-tools/schema/artifacts/). Agents should
discover the live catalog because enabled IDs and versions are thread-specific.

## Compiled backend presentation dispositions

Presentation has two independent dimensions:

- **Surface** selects the provider-facing mechanism: `native` tools or the
  generated `cli` in an admitted shell environment. Native tools are Pi SDK
  tools in the Sedes process for Pi, and the stdio `sedes mcp` server for
  Codex and Claude.
- **Mode** selects disclosure: `progressive` exposes compact discovery and
  generic invocation, while `individual` exposes every granted operation as a
  named tool or command with typed parameters.

The normalized policy stores the exact pair as
`presentation: { surface, mode }`. Capability metadata groups supported modes
under each surface so the UI can show separate selectors, hide a selector with
only one choice, and never synthesize an unsupported pair. The first listed
surface and its first mode are the default: new Pi policies default to
Native/Progressive, new Codex and Claude policies to Native/Individual through
`sedes mcp`, and new Grok policies to CLI/Progressive. Saved Agents without an
explicit policy use the same default, and the thread-creation trigger
(migration 115) stores it for new threads. Existing thread policies keep
their stored presentation.

| Backend/environment      | Native modes                                             | CLI modes                                                       |
| ------------------------ | -------------------------------------------------------- | --------------------------------------------------------------- |
| Local Pi                 | Progressive, Individual                                  | Progressive, Individual when Bash and CLI admission permit them |
| Pi on SSH workspace      | Progressive, Individual                                  | None                                                            |
| Local Codex              | Progressive, Individual through MCP on eligible threads  | Progressive, Individual on eligible Sedes-created threads       |
| Codex over SSH UDS       | Progressive, Individual through MCP with sidecar support | Progressive, Individual with sidecar capability and admission   |
| Local Claude             | Progressive, Individual through MCP on eligible queries  | Progressive, Individual on eligible queries                     |
| Claude over SSH/outbound | Progressive, Individual through MCP with sidecar support | Progressive, Individual with sidecar capability and admission   |
| Local Grok               | None                                                     | Progressive, Individual on eligible Sedes-created sessions      |
| In-memory conformance    | None                                                     | Intentionally unavailable outside contract tests                |

Codex and Claude Native presentation uses exactly the eligibility and runtime
admission of their CLI presentation, and is unavailable on Windows execution
hosts. Grok has no Native surface. Grok SSH targets and Pi remote CLI
presentation are intentionally unsupported.
The shared CLI implements both CLI modes for every supported row: local Pi,
Codex, Claude, and Grok, plus the admitted Codex and Claude remote relays. It does not
add a CLI path to the intentionally unsupported Pi-SSH or Grok-SSH topologies.
The incompatible catalog-summary cutover advances both the owner-only local
CLI frame and the managed relay capability to `agent_tools_cli@3`; stale peers
fail closed.
The in-memory conformance backend exercises normalized catalog,
admission, and invocation behavior without creating a production presentation
contract. Missing presentation eligibility must omit or disable the surface;
it must never fall back to another adapter.

### Progressive Pi native

Progressive presentation gives Pi at most three stable gateways:
`sedes_catalog`, `sedes_read`, and `sedes_act`. The catalog gateway lists
compact summaries and describes one to sixteen selected tool IDs atomically.
Read and action gateways validate the selected tool's current public contract
before invocation. This keeps a large catalog out of the initial prompt while
preserving the exact same policy and implementations.

### Individual Pi native

Individual presentation installs every selected eligible definition directly
on the Pi SDK session. The list is fixed for the complete turn, including model
continuations. Installation failure stops the turn instead of retaining stale
definitions. Pi `read_only`, `ask`, and `full` policy continue to govern native
tool use; `ask` routes protected operations through Sedes approval.

### Native MCP presentation (Codex and Claude)

Codex and Claude load Native Sedes tools from a stdio MCP server that the
provider starts for the thread:

```text
sedes mcp --mode progressive|individual
```

It runs from the same `sedes` executable as the CLI: the built provider bin
locally, or the sidecar binary on SSH and outbound hosts. It reads
`SEDES_AGENT_TOOL_ENDPOINT` and a thread reference issued for MCP, reaches
Sedes over the same loopback HTTP routes or sidecar relay as the CLI, and exits
when its stdin closes. Principal Tool client tokens are rejected.

The server implements only the tools subset of MCP: `initialize` with version
negotiation (2025-11-25, 2025-06-18, 2025-03-26, and 2024-11-05, omitting
fields that an older negotiated version does not define), `ping`,
`tools/list`, `tools/call`, and `notifications/cancelled`. It advertises no
list-change notifications, pagination, resources, prompts, logging, progress,
or client features. Stdout carries only JSON-RPC; diagnostics are fixed stderr
messages that never echo credentials. The protocol is implemented directly
rather than through the MCP SDK so the hash-pinned sidecar bundle needs no new
dependencies; the SDK client drives its conformance tests.

- **Individual** lists one tool per granted operation with the same name as
  its Pi native tool: `sedes_` plus the tool ID with dots as underscores.
  Clients add their own namespace, so Claude and Codex show
  `mcp__sedes__sedes_thread_status`. The registry rejects an MCP name that
  does not follow this rule. Each tool carries its canonical input and output
  schemas without the explicit `$schema` dialect, a `title`, `_meta` entries
  `sedes/toolId` and `sedes/schemaVersion`, and hints derived only from its
  declared effects: side-effect-free reads are `readOnlyHint`; destructive
  application effects set `destructiveHint`; model execution or durable
  external effects set `openWorldHint`. Successful results return
  `structuredContent` plus the same JSON as text.
- **Progressive** lists the `sedes_catalog`, `sedes_read`, and `sedes_act`
  gateways with the same contract as Pi's, except that the catalog gateway's
  input schema is an object with an `action` field because MCP requires
  object input schemas. A lane appears only when the current catalog has an
  operation for it, and an empty catalog lists no tools. Summaries omit the
  CLI command path.

Every list and call reads the live server catalog, and the server derives
the calling adapter from the reference, so admission checks the thread's
current Native policy on every request. The tool list is otherwise fixed for
the provider session because Native policy changes are idle-only and retire
the runtime. Input that fails its canonical schema, policy denials, failed
invocations, and transport failures return `isError` tool results carrying
`{ "error": { "code", "message", "retryable" } }`, so the model can correct
itself; an unknown tool name or malformed request is a JSON-RPC error.
`notifications/cancelled` aborts the exact invocation, including a pending
access approval, and suppresses its response.

The provider's own permission controls govern each MCP call before Sedes
applies the thread's access boundary. Codex's default approval mode runs
read-only tools without asking and asks before destructive or open-world ones;
Claude's permission mode applies to `mcp__sedes__*` tools like any other MCP
tool.

Injection is per thread and never changes operator configuration:

- **Codex** receives `config["mcp_servers.sedes"]` on `thread/start`,
  `thread/resume`, and `thread/fork`, with the command, `--mode`, an
  environment containing only the endpoint and reference, a 30-second startup
  timeout, and a 24-hour call timeout so Codex's 60-second default cannot
  cancel a pending access approval. The shell policy still strips every Sedes
  variable. The server lives while Codex keeps the thread loaded; a resume
  that carries config rebuilds an idle, unsubscribed loaded thread with the
  current entry. Runtime request fingerprints record only the entry's
  variable names.
- **Claude** receives `mcpServers.sedes` on the query beside the servers its
  setting sources load. The Agent SDK passes MCP servers to the CLI as a
  `--mcp-config` argument that other local users can read, so the entry names
  the reference as `${SEDES_AGENT_TOOL_SOURCE_CAPABILITY}` and the query
  environment carries the value, as it does for CLI presentation. The worker
  protocol carries the entry as a closed `agentToolMcp` field that is
  exclusive with the CLI query environment. On SSH and outbound hosts the
  sidecar admits it only for its own `sedes` binary and live ingress, and a
  reattach must present the same entry.

On SSH and outbound hosts the server is the sidecar's own `sedes` binary,
which sidecar runtime protocol 13 guarantees can serve it. Windows execution
hosts fail closed because their process launchers cannot run the generated
script directly. A missing runtime or admission leaves the
thread without Sedes tools; it never falls back to the CLI.

### Progressive CLI

A production build emits `dist/cli/provider-bin/sedes`. Every enabled CLI
tool is available through the lossless generic discovery and invocation
commands:

```text
sedes tool list --json
sedes tool describe TOOL_ID [TOOL_ID ...] --json
sedes tool invoke TOOL_ID (--input-json <json> | --input-file <path|->) --json
```

This JSON-only interface is the CLI equivalent of progressive native
presentation. The model first lists compact caller-filtered summaries,
describes only the operations it needs, and invokes the selected exact ID with
canonical JSON. It is preferred when a large granted catalog should not be
expanded into command help up front.

### Individual CLI

The compact live catalog publishes one named command path for every exposed
CLI tool. Dots form command levels and underscores normalize to hyphens;
registration fails closed on invalid, reserved, or colliding paths. Examples:

```text
sedes thread status --thread-id <thread-id> [--json]
sedes thread messages --thread-id <thread-id> [--json]
sedes task create --title <title> --scope-kind workspace [--json]
sedes research web-search --query "What changed in Node.js today?" [--json]
sedes thread worktree-list [--json]
sedes thread worktree-set --expected-revision 3 --root-id <root-id> [--json]
```

Named dispatch resolves only the caller-filtered live catalog, describes that
exact operation, and compiles its current bounded canonical input schema into
options. Properties become kebab case, nested objects flatten by property
path, primitive arrays repeat their option, numbers parse strictly, and
Booleans require explicit `true` or `false`. Whole objects, arrays, and complex
unions accept a `-json` option; primitive unions also provide that exact JSON
form when the caller must select a member that text coercion would not choose.
Registration rejects reserved or ambiguous generated option names. The final
canonical validator and serialized input limit remain authoritative. `sedes
GROUP COMMAND --help` renders current required, conditional, enum, collection,
and minimum-property constraints plus effects without invoking the tool.

`sedes --help` renders the currently granted command groups, `sedes GROUP
--help` renders that group's currently granted commands, and command help
renders the live typed contract. This is the CLI equivalent of individual
native presentation: discovery and invocation read like an ordinary human CLI
without first printing the complete JSON catalog.

Every string option also has a `-file` form; `-` reads the exact value from
stdin. Use it for multiline Markdown and text containing backticks, `$()`,
quotes, or other shell syntax. `--input-file` reads a complete canonical JSON
object and cannot be mixed with named options. File/stdin reads use only the
CLI process's existing filesystem authority and do not grant Sedes Files
access. In progressive mode, generic `tool invoke` is the canonical route for
complex inputs. In individual mode, `--input-file` is the lossless escape hatch
for a named command whose complete canonical input is clearer as JSON. Neither
route is an alternate authorization path.

`describe` accepts one through sixteen unique IDs as one atomic request. List,
select a currently present ID, describe its schema, then invoke it. Successful
invocations write exactly the operation payload advertised by `outputSchema`;
the HTTP invocation envelope is not part of CLI stdout, including with
`--json`. Validation and transport failures are diagnostic stderr. A named
form exists only while its exact tool is advertised in the live catalog;
command metadata is presentation, never authorization.

The selected CLI mode is injected as `SEDES_AGENT_TOOL_CLI_MODE` for a managed
thread-agent process. It is a deterministic presentation hint, not a security
boundary: a process can modify its own environment, while every discovery and
invocation request still resolves the current server-owned thread policy and
grants. Help, list, and describe therefore reflect tools added or removed in
the UI on their next request, and invocation rechecks the selected operation
again. Changing grants never leaves a formerly advertised command authorized.
The CLI does not cross from one configured mode or surface to another when a
command is unavailable.

The one-time durable migration maps the former flat `cli` presentation to
`{ surface: "cli", mode: "progressive" }`, preserving the historical generic
discovery contract. It maps `native_progressive` and `native_individual` to
their corresponding native pairs. Runtime protocols accept only the new
orthogonal shape; there is no legacy parser or alias.

The three `thread.worktree_*` operations are available only to a thread agent.
They take no thread, workspace, environment, or path authority from model
input: Sedes derives the exact source thread and asks its owning local or SSH
Files provider for registered linked worktrees. `thread.worktree_list@1`
returns Primary plus the admitted linked worktrees and the current nullable
preference with its independent revision. Set accepts only one returned linked
root ID; clear restores Primary. Both mutations require the list's current
revision so a user and agent cannot silently overwrite each other's newer
selection. This first-class thread preference changes Files, Compare, and
relative chat-file link resolution only; it never changes the provider, agent,
or terminal working directory. A disappeared preferred worktree is cleared
during successful topology reconciliation.

The list operation has the ergonomic `sedes files worktree-list` form. Set
and clear include an integer revision and therefore use the generic typed
`sedes tool invoke` form; the current ergonomic resolver supports string
positionals only.

`thread.messages@4` keeps settled-turn pagination unchanged. A request without
a cursor also returns `activeTurn` from the same conversation snapshot: null
when there is no active turn, or a bounded chronological tail of ordinary user
and assistant messages whose normalized items are completed even though the
turn remains in progress. Those messages have stable normalized item IDs and
do not consume `pageSize`. User-role inter-agent input retains its optional
authenticated `agent_message` or `agent_result` origin in both settled and
active projections.
Streaming partials and non-message activity are not returned, and text-final
completion does not imply turn success or idleness. Continuation pages omit
`activeTurn` and remain fixed to their settled-history snapshot.

`thread.send@2` adds an optional Boolean `callback`. Omit it or set it to
`false` for fire-and-forget delivery. A thread agent may set it to `true` when
it needs the target operation's eventual result without polling. The send
returns immediately with the admitted operation and callback IDs; it does not
wait for the target turn. The callback follows the authenticated calling
thread, not the turn that registered it.

After the exact target operation reaches an authoritative terminal outcome,
Sedes delivers its bounded normalized assistant result back to the calling
thread. If that thread currently has an active turn and its backend truthfully
supports exact-target Steer, Sedes Steers the result into that current turn. A
stale target demotes to durable Queue. When Steer is unavailable, or no turn is
active, the result is durably queued and starts a new turn as soon as the
thread is idle. The model sees ordinary user-role content, while authenticated
inter-agent provenance lets the transcript render collapsed Activity-style
disclosures with `Agent message · <source thread>` for the original send and
`Agent result · <source thread>` for its callback. Each disclosure retains a
one-line content preview and expands to the complete input. Callback result
text remains untrusted agent output.

The named `sedes thread send` form exposes `--callback true|false` when the
current schema advertises it. Principal Tool clients must not request callbacks
because they have no trusted calling thread.

The checked-in mode-specific skills explain the live workflow without copying
the catalog:

- [Progressive CLI tools](../../skills/sedes-cli-progressive-tools/SKILL.md)
- [Individual CLI tools](../../skills/sedes-cli-individual-tools/SKILL.md)
- [Progressive native tools](../../skills/sedes-native-progressive-tools/SKILL.md)
- [Individual native tools](../../skills/sedes-native-individual-tools/SKILL.md)

The native skills also cover Codex and Claude Native presentation, where the
MCP client prefixes the same tool names with its server namespace.

`npm run dev` does not build the provider CLI. Run
`env -u NODE_ENV npm run build` in a fresh source checkout before expecting CLI
presentation.

### Durable callback lifecycle

A `callback: true` send registers a principal-scoped callback obligation for
the exact target operation in the same database transaction that durably admits
the send, so an admitted send never leaves an unregistered obligation and an
aborted first send cancels its registration. The obligation follows the
authenticated calling thread rather than the turn that registered it.

Authoritative completion is recorded on the shared
`submission_completion_observations` rail, enriched with the normalized
application turn, outcome, and an immutable bounded assistant-result snapshot.
Materialization joins registered callbacks to that exact completion and
atomically creates a callback-origin queued-input row while marking the
callback materialized in `thread_completion_callbacks`, whose rows are
`registered`, `materialized`, or `cancelled`. Materialization is deterministic
and idempotent, so a replayed completion cannot deliver a result twice. The
existing queued-input dispatcher then owns Steer, stale-turn demotion, retry,
delivery uncertainty, idle submission, and restart recovery. Callback queue
rows carry immutable `agent_result` provenance distinct from composer or
ordinary agent-control input: the `callbackId`, the source thread, and its
display label captured at materialization.

Startup recovers the ordinary durable queue first and only then materializes
registered callbacks whose completion snapshot already exists, so a recovered
result is delivered through the queue that already owns it. Registered
callbacks block archival at either endpoint, a force reset cancels the affected
registrations, and archived or snoozed calling threads are never silently
revived.

## CLI transports and admission

The CLI requires `SEDES_AGENT_TOOL_ENDPOINT` plus exactly one caller
credential:

```text
SEDES_AGENT_TOOL_SOURCE_CAPABILITY   # injected thread-agent reference
SEDES_AGENT_TOOL_CLIENT_TOKEN        # copied principal Tool client token
```

Managed thread processes also receive `SEDES_AGENT_TOOL_CLI_MODE` as
`progressive` or `individual`. This non-secret hint selects the matching CLI
presentation; it is not caller identity or authorization.

Eligible CLI runtimes receive their environment even when the master flag is
off or no tool IDs are selected. This applies to local Pi, local and Sidecar
remote Codex/Claude, and local Claude/Grok. Unsupported topologies still fail closed.
Enabling access during a turn therefore needs no new credential or environment
injection; the next request uses live server policy. A Native Codex or Claude
thread likewise starts `sedes mcp` while access is off; it lists no tools.

A thread reference accepts an HTTP(S) management origin or one canonical
`unix:///...` sidecar address. A principal-client token accepts HTTP(S) only;
the CLI rejects it with a Unix endpoint before opening a transport. There is no
fallback and no CLI option for tenant, principal, source thread, client, or
credential-generation override. Sedes deterministically encrypts a thread
association with a domain-separated key derived from the installation key and
authenticates the server-derived tenant, principal, ingress transport, and
presentation. It stores no token alias. Reissuing a reference for the same
thread, ingress, and presentation returns the same bytes, including after a
restart. A management-HTTP reference is invalid on the sidecar relay and a
sidecar reference is invalid on management HTTP.

The presentation binding separates the CLI from `sedes mcp`: the two
references for one thread and ingress differ, and the server derives the
calling adapter (`cli` for discovery and `http` for invocation over HTTP,
`cli` over the relay, or `mcp`) from the reference rather than from the
request. Both presentations therefore share the same routes and
`agent_tools_cli@3` frames without a wire discriminator, and admission rejects
a reference whose presentation does not match the thread's current surface.
CLI references keep the bytes issued before MCP presentation existed.

The reference survives Sedes process and provider-runtime replacement. Each
request still resolves the thread's current workspace, environment, backend,
inventory, and policy from application state. Provider-native turn identity is
not an authorization input: discovery and invocation are governed by the
resolved thread and its current policy. Request cancellation aborts the exact
invocation. A cross-environment **Ask** decision additionally borrows the
application runtime that presents that prompt, and runtime replacement cancels
only that pending decision. Deleting or archiving the thread or changing the
installation key makes the reference unusable.

A Tool client token is a separate HTTP bearer credential. Authentication
resolves its tenant/principal, current generation, enabled state, exact policy,
allowlist, and defaults from the retained client record. It never substitutes
for a thread reference and is never accepted by the sidecar. CLI environment
builders strip ambient client tokens and presentation-mode hints before
installing the server-resolved thread values so caller classes cannot collide
and ambient process state cannot select the managed mode.

Eligible local Codex, Claude, and Grok processes use the local management listener.
Local Pi CLI presentation uses Pi's existing shell tool and never enables shell
access by itself. Claude inherits its complete per-query environment before
Sedes adds CLI variables, so injection cannot discard its normal `HOME`,
`PATH`, or external login.

Codex over SSH can use CLI presentation only when the environment explicitly
enables `agent_tools_cli` and the sidecar advertises `agent_tools_cli@3`.
Sedes deploys one owner-only Unix socket beside the managed sidecar, and the
sidecar relays the strict v3 agent-tool protocol over its current persistent-service
connection. Codex and sidecar health remain independent. Missing
capability, unavailable sidecar, imported thread, disabled network policy, or
unverifiable environment isolation fails closed. Network access is currently
still required for this admission even though the agent endpoint itself is a
Unix socket.

Claude over SSH or an outbound connection uses the same independently admitted `agent_tools_cli@3` relay
with its exact thread/query context. The sidecar retains the provider query
when main disconnects, but tool invocation still needs current main-server
authority and fails closed while that connection is absent. Remote Grok
execution and agent-tool relay remain unsupported.

A Pi SSH target never receives the CLI in remote Bash. The Pi model loop and
native session stay on the Sedes host while only its seven built-in workspace
tools execute remotely. See [Remote Pi workspace tools](pi-remote-workspace-tools.md).

`thread.create@5` and `saved_agent.list/get/options/create/update@5` expose
`accessBoundary: thread | environment | unrestricted` in their policy contracts.
Their previous v4 schemas are no longer admitted; callers must describe the
current tool before invocation. `saved_agent.delete` retains its version because
its wire shape is unchanged.

## Invocation and retry semantics

Every invocation is independent. `requestId` is correlation metadata, not a
deduplication key. A write that returns `timed_out` has an indeterminate outcome
and may already have applied; repeating it is a new invocation and can create a
second resource/run or fail a domain revision check. Adapters do not retry
writes automatically.

A cross-environment decision has no approval deadline; it waits until the user
chooses **Allow once** or **Deny**, just like a normal blocking tool permission.
The pending decision is cancelled when its exact invoking request/process is
aborted, its application approval runtime is replaced, or Sedes shuts that
runtime down. Cancelling a background Bash command therefore propagates through
the command's existing cancellation path when it aborts the CLI invocation.
Sedes does not poll browser connectivity, and closing or disconnecting a
browser alone does not cancel a prompt. Tool execution deadlines begin only
after admission; CLI `list` and `describe` remain bounded discovery operations,
while `invoke` follows caller cancellation rather than imposing a transport
approval timeout.

Optional workspace or thread inputs may default from trusted source-thread
context. Explicit IDs are still resolved under the server-derived principal.
A missing, disabled, wrong-version, wrong-scope, malformed, or stale request
fails closed.

## HTTP adapter and trust boundary

The local CLI uses these normalized routes:

```text
GET  /api/agent-tool-csrf
GET  /api/agent-tools
POST /api/agent-tool-descriptions
POST /api/agent-tool-invocations
```

The server requires exactly one thread-reference or principal-client header;
duplicates, comma-combined values, both, and neither fail closed. For a thread
caller it derives tenant/principal, decrypts the opaque reference, revalidates
the source thread, and loads current policy. For a Tool
client it verifies the current stored generation and atomically snapshots its
policy/default/environment authority before invoking the same canonical
implementation. The CSRF route returns the existing
per-process token so a short-lived CLI need not load the browser bootstrap.

The principal token authenticates only these agent-tool routes; it does not add
login or account authentication to Sedes's broader management API. Likewise,
the thread reference is a bearer capability inside the trusted provider
process, not a boundary against a compromised agent runtime. A holder can
exercise only its current caller policy and still passes scope, environment,
resource, and caller-specific admission checks. Host validation, CORS, CSRF,
private addresses, and Unix-socket ownership remain defense in depth. Use both
caller classes only within the trusted boundary in
[Operations](../operator/operations.md).

The deterministic restart-safe format is `htr2_`. It intentionally rejects
older random `htr1_` references instead of carrying a dual decoder. A provider
process that retained an `htr1_` value must be restarted or reattached once.
Rolling back to a pre-`htr2_` binary likewise requires another provider restart
or reattach.

Tool client persistence and principal-client provenance are one-way database
changes. Back up the complete application state and installation key before
upgrading. Rolling back across those migrations requires restoring the matching
pre-upgrade state; an older binary must never open the migrated database.

## Verification surfaces

Changes must cover generated schema parity, exact-ID catalog filtering,
thread-policy and Tool-client revision conflicts, token rotation/disable/
revocation, wrong-principal and wrong-environment denial, default resolution,
cross-environment approval revalidation, application-decision cancellation,
and automation fail-closed behavior. Adapter tests must exercise both modes on
native Pi, both CLI modes for local Codex, Claude, and Grok, both Native MCP
modes for Codex and Claude, the `sedes mcp` protocol subset against the MCP
SDK client, presentation-bound references, remote
Codex/Claude sidecar ingress, transport credential separation, cancellation,
timeout and outcome-unknown semantics,
and every unsupported presentation. Mutating operations must retain their
domain revisions, receipts, recovery rules, and prohibition on automatic
retry. Live provider and skill gates remain separately opt-in.

## Limits

- No Sedes-hosted HTTP MCP endpoint, MCP for principal Tool clients, MCP
  resources, prompts, or list-change notifications, per-tool executables,
  automatic write retry, or generic asynchronous invocation lifecycle.
- Tool clients do not authenticate the management UI/API, use Unix/sidecar
  ingress, impersonate a thread, receive interactive access approvals, or
  manage other credentials through agent tools.
- No Native Grok presentation, no Native MCP on Windows execution hosts, no
  Grok SSH target, no Pi remote CLI, and no surface or transport fallback.
- Missing CLI or sidecar admission disables agent tools for that presentation;
  it does not disable ordinary provider conversation capabilities.
- Native policy and surface/mode changes wait for idle. For a bound thread, Sedes proves the complete
  provider runtime retired before committing the new policy, so the next
  attach reconstructs Pi, Codex, Claude, or Grok presentation state and CLI
  environment from one current policy instead of retaining a stale mode.

Contract generation and opt-in live skill gates are documented in
[Development](../developer/development.md).

## Related contracts

[Back to Internals](index.md) · [Blocking interactions](blocking-interactions.md)
· [Workspace Files](workspace-files.md) ·
[Remote Pi workspace tools](pi-remote-workspace-tools.md)
