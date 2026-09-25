# Backend operator guide

Sedes ships four compiled conversation backends. Choose a backend for its
provider, execution topology, and controls—not only for the model names it
currently lists. The live catalog and the backend `modelPolicy`
remain authoritative after startup.

This section covers provider installation, authentication, supported
topologies, capability differences, release admission, and backend-specific
troubleshooting. Use [Configuration](../configuration.md) for the complete
schema and [Operations](../operations.md) for server lifecycle, networking,
state, and backups.

## On this page

- [Support matrix](#support-matrix)
- [Capability differences](#capability-differences)
- [Version policy](#version-policy)
- [Integration status](#integration-status)
- [Choosing a backend](#choosing-a-backend)
- [Common setup sequence](#common-setup-sequence)
- [Common troubleshooting](#common-troubleshooting)
- [Maintainer references](#maintainer-references)

## Support matrix

| Backend             | Provider runtime                                            | Execution environments                                                                          | Core controls                               | Notable supported features                                                                                                             |
| ------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [Pi SDK](pi.md)         | SDK embedded in the Sedes process                           | Local; SSH workspace operations and optional remote skill discovery through the managed sidecar | Submit, Steer, Queue, Stop, rename, compact | Tool-access modes, skills, usage and cost, selected-turn forks, optional local Bubblewrap workspaces                                   |
| [Codex](codex.md)   | Owned local app-server or an external app-server connection | Linux/macOS local; persistent-sidecar runtime over SSH or outbound                                                                    | Submit, Steer, Queue, Stop, rename, compact | Execution settings, approvals, questionnaires, Fast mode, Goal, selected-turn and latest-provider-snapshot forks, eligible managed TUI |
| [Claude](claude.md) | Managed Claude Agent SDK worker plus Claude Code            | Linux/macOS local; persistent-sidecar runtime over SSH or outbound                                        | Submit, Steer, Queue, Stop, rename                 | Permission modes, prompts, native questions, skills, usage, background-work status, selected-completed-turn forks, native image input                                         |
| [Grok](grok.md)     | Sedes-owned Grok ACP process                                | Local Linux x64 or macOS arm64/x64                                                              | Submit, Queue, Stop, rename                 | Plans, tool and collaboration rendering, file/image input, completed `ImageGen` and `ImageEdit` artifacts                              |

`Queue` is a provider-neutral Sedes feature: while a turn is active, Sedes
retains the next input and submits it only after authoritative settlement. It
does not imply that the provider has a native queue.

## Capability differences

This matrix is the authoritative capability reference for Sedes. The user
guide and the maintainer contracts restate it in their own terms and must not
contradict it.

| Capability                        | Pi SDK                                         | Codex                                               | Claude                                              | Grok                                        |
| --------------------------------- | ---------------------------------------------- | --------------------------------------------------- | --------------------------------------------------- | ------------------------------------------- |
| Mid-turn Steer                    | Turn-scoped                                    | Turn-scoped                                         | Conversation-scoped                                 | No; Queue only                              |
| Manual compact                    | Yes                                            | Yes                                                 | No                                                  | No                                          |
| Exact completed-turn fork         | Yes                                            | Yes                                                 | Yes; source must be idle                            | No                                          |
| Latest provider snapshot fork     | No                                             | Yes                                                 | No                                                  | No                                          |
| Structured questions              | No                                             | Questionnaires and MCP forms                        | Native multiple-choice questions                    | No                                          |
| Provider permission interaction   | Primitive prompts                              | Approvals                                           | Permission prompts                                  | Not exposed                                 |
| Skills                            | Yes                                            | Yes                                                 | Eligible native skills                              | No                                          |
| Sedes agent-tool surfaces         | Native SDK tools; CLI on eligible local        | CLI or Native through a per-thread MCP server       | CLI or Native through a per-query MCP server        | CLI on local threads                        |
| Background-work status            | No                                             | No                                                  | Subagents and commands                              | No                                          |
| Managed provider terminal         | No                                             | Eligible external connections                       | No                                                  | No                                          |
| Local image input                 | Model dependent                                | Model dependent                                     | PNG, JPEG, GIF, WebP                                | Model dependent                             |
| Native generated-image artifact   | No                                             | Completed in-band PNG                               | No                                                  | Completed local `ImageGen`/`ImageEdit` JPEG |
| SSH or outbound workspace target  | Managed tools/context; optional sidecar skills | Persistent runtime; independently granted Files/CLI | Persistent runtime; independently granted Files/CLI | No                                          |

Notes on individual rows:

- **Steer.** Turn-scoped Steer targets the exact active turn. Claude's Steer is
  conversation-scoped: it is delivered at Claude's next native opportunity and
  may join the current turn or start the next one, and it never interrupts
  work. Grok advertises no Steer, so active-turn input stays in Sedes Queue.
- **Local image input.** Sedes accepts PNG, JPEG, GIF, and WebP composer
  images. Claude always admits them; Pi, Codex, and Grok advertise native image
  input only when the selected model declares image input, and Grok also
  requires a runtime that supports the image path.
- **Managed provider terminal.** Codex additionally requires an external
  connection, a catalog model policy, and either a local endpoint with PTY
  support or a persistent sidecar whose runtime channel negotiated the
  `codex_managed_tui` operations. Owned stdio connections never offer it.

Remote Grok runtimes are unsupported; Cursor is deferred.
Pi SDK keeps its model loop on main Sedes and uses the sidecar only for remote
workspace operations.

Capabilities are evaluated per thread and can be narrower than this matrix.
Runtime version, target topology, model metadata, execution policy, sidecar
availability, and thread state all affect what the UI advertises. Sedes omits
an unsupported action and the backend rejects it again if called directly.

## Version policy

| Backend | Compiled profile                | Runtime admission                                                        | Tested through        |
| ------- | ------------------------------- | ------------------------------------------------------------------------ | --------------------- |
| Pi SDK  | `0.86.0` SDK                    | Exact pinned SDK package in the Sedes process                            | `0.86.0`              |
| Codex   | `0.153.0` app-server protocol   | Stable `>=0.153.0`, excluding reviewed incompatible releases             | `0.154.0`             |
| Claude  | `0.3.274` Agent SDK             | Stable Claude Code `>=2.1.274`, excluding reviewed incompatible releases | Claude Code `2.1.274` |
| Grok    | `1.x` ACP compatibility profile | Stable `>=1.0.4`, excluding reviewed incompatible releases               | `1.0.4`               |

Codex, Claude, and Grok may admit a stable runtime newer than the release most
recently exercised by this repository. Sedes shows an installation advisory
and continues to use the pinned reviewed protocol profile; a newer executable
does not unlock new Sedes capabilities. Prereleases, exact excluded releases,
and incompatible protocol behavior fail closed.

These profiles are supplied by the compiled backend modules and persisted for
diagnostics and runtime-generation integrity. They are not configurable Settings fields. Actual external executable releases are probed against
the compiled runtime-admission policies shown above.

## Integration status

Compatibility above answers "will this version connect?" and the capability
matrix answers "does this workflow exist?". This section answers "how settled
is the integration?" with evidence rather than a rating. Newer admitted
runtimes are not equivalent to exercised runtimes.

| Backend | In Sedes since | Most recent runtime qualification | Live suites in the repository | Execution topologies |
| --- | --- | --- | --- | --- |
| Pi SDK | July 2026 | Pinned SDK `0.86.0` runs inside the Sedes process; no external runtime to qualify | `test:real-pi`, `test:real-pi-cli` | Local runtime; SSH or outbound sidecar for workspace tools and context |
| Codex | July 2026 | App-server `0.154.0` reviewed against the compiled `0.153.0` profile | `test:real-codex-agent-tools` | Local process, external UDS/TCP, persistent SSH or outbound sidecar |
| Claude | August 2026 | Claude Code `2.1.274` with Agent SDK `0.3.274` | `test:real-claude` (six files) | Local worker; persistent SSH or outbound sidecar on Linux/macOS |
| Grok | August 2026 | Grok Build `1.0.4` against the compiled `1.x` ACP profile | `test:real-grok` (three files) | Local Linux x64 or macOS only |

Version-pinned qualification evidence for each external runtime is kept under
`protocol/` beside its compiled profile. Live suites are opt-in and consume
provider capacity; the deterministic suite exercises every backend through
recorded fixtures on each change.

Maintainer positioning, stated as judgment rather than measurement: Pi SDK and
Codex are the primary integrations and carry the broadest feature set and the
longest history in Sedes. Claude and Grok are supported with the explicit
limits in the capability matrix; Claude gained conversation-scoped Steer and
the sidecar-hosted runtime in September 2026 and is the more actively
extended of the two, while Grok remains a local-only runtime with no Steer,
compact, or fork support. Expect rougher edges in the two newer integrations
and report reproducible problems with the backend, runtime version, and
topology named.

## Choosing a backend

- Choose **Pi SDK** for the richest native tool-access controls, local workspace
  isolation, or a host-local provider runtime operating on an SSH workspace.
- Choose **Codex** for explicit sandbox/network/approval settings, structured
  questions, Goal or Fast mode, or an externally operated local/SSH app-server.
- Choose **Claude** for Claude Code's authenticated local, SSH, or outbound environment,
  permission modes, native skills, and image-capable prompts.
- Choose **Grok** for a local Grok Build installation and the reviewed
  unrestricted ACP profile, including native generated or edited image output.

You may configure multiple backend instances and targets. Each instance has
its own model policy; a thread remains bound to its original backend,
execution environment, and provider conversation.

## Common setup sequence

1. Install and authenticate the provider on its selected execution host.
2. Start Sedes with the schema-11 installation bootstrap. For existing state,
   first perform the [offline import](../configuration.md#configuration-changes-and-rollback).
3. Add the environment and narrow workspace roots in Settings, then its backend
   and target. Choose model and execution/permission policy deliberately.
4. Check desired/applied revisions and runtime status. Resolve unsupported,
   unavailable, or pending application before sending work.
5. Deliberately verify a disposable thread, Stop, reload, and history recovery.
   Provider turns consume provider capacity; they are separate from startup.

Do not run the opt-in real-provider test suites as routine checks. They consume
authenticated provider capacity and can exercise tools. Each backend guide
documents its relevant live gate for deliberate integration verification.

## Common troubleshooting

| Symptom                                     | What to check                                                                                                                                        |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend is absent at startup                | `enabled`, target references, absolute paths, provider runtime compatibility, and the startup diagnostic code                                        |
| No models are selectable                    | Provider authentication, native catalog availability, then `modelPolicy`; existing denied selections remain visible but unavailable                  |
| Thread opens but new work is blocked        | Repair a missing/denied model or execution setting; Sedes will not silently substitute another value                                                 |
| Provider history is missing                 | Confirm the provider-native store/home and service account; Sedes state backups do not include provider history or credentials                       |
| Files or attachments are unavailable on SSH | Confirm that the execution environment enables the exact managed-sidecar capabilities required by that topology                                      |
| Action is missing from the UI               | Treat the thread capability document as authoritative; compare the backend-specific unsupported list before debugging the browser                    |
| Runtime is reported newer than tested       | Pin to the tested-through release for the most conservative deployment, or review the advisory and run the opt-in live suite                         |
| Authentication fails only under the service | Compare the service account's `HOME`, provider-specific home variables, `PATH`, and executable permissions with the interactive shell used to log in |

For diagnostic logging and safe inspection, follow
[Debug diagnostics](../../developer/diagnostics.md). Never paste credential
files, bearer tokens, provider payloads, or complete transcripts into an issue.

## Maintainer references

Provider-private protocol, lifecycle, history, persistence, recovery, and test
invariants live separately from these operator runbooks:

| Backend | Operator runbook                          | Maintainer contract                                    |
| ------- | ----------------------------------------- | ------------------------------------------------------ |
| Pi SDK  | [Configure and operate Pi](pi.md)         | [Pi internals](../../internals/backends/pi.md)         |
| Codex   | [Configure and operate Codex](codex.md)   | [Codex internals](../../internals/backends/codex.md)   |
| Claude  | [Configure and operate Claude](claude.md) | [Claude internals](../../internals/backends/claude.md) |
| Grok    | [Configure and operate Grok](grok.md)     | [Grok internals](../../internals/backends/grok.md)     |

Contributors must start at the
[backend maintainer index](../../internals/backends/index.md) and follow the
normative
[backend integration contract](../../internals/backend-integration-contract-rules.md).
Provider SDK types, wire shapes, native IDs, event parsing, and history
interpretation stay inside their backend module; the browser receives only the
normalized protocol.
