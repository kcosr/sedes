# Remote Pi workspace-tools subsystem contract

Sedes can keep the Pi SDK and model loop on the main host while executing
Pi's seven workspace-effecting built-ins on the selected SSH environment:
`read`, `write`, `edit`, `ls`, `find`, `grep`, and `bash`.

These seven names derive from the release-pinned Pi built-in disposition, not
from whatever tools the installed SDK happens to register. Pi 0.86.0's
`powershell` built-in is intentionally unsupported and excluded before session
construction. Every admitted override must have the exact trusted
`<sdk:name>` identity. A residual host built-in, malformed override, or newly
discovered SDK built-in fails session construction or reload without local
fallback.

This is not a remote Pi runtime. Provider credentials, model requests,
approvals, conversation history, native Pi sessions, SQLite, tasks, and all
other application state stay on the Sedes host. The persistent sidecar owns
remote processes and bounded operation receipts across SSH attachment loss.
Those receipts remain in the sidecar's memory; they do not survive sidecar
death. It receives no provider credential and makes no model decision.

For operator setup, see the [Pi backend guide](../operator/backends/pi.md) and
[Configuration](../operator/configuration.md). The shared carrier and Files
boundaries are documented in [Workspace Files](workspace-files.md). Agent tools
are a separate application-management surface described in
[Agent tools](agent-tools.md). Backend changes must follow the
[backend integration contract](backend-integration-contract-rules.md).

## Contents

- [Configuration](#configuration)
- [Authority and behavior](#authority-and-behavior)
- [Lifecycle and failures](#lifecycle-and-failures)
- [Backend dispositions](#compiled-backend-dispositions)
- [Verification](#verification-surfaces)

## Configuration

An SSH Pi target is eligible only when its environment enables the complete
pair in its principal-owned database definition:

```json
{
  "kind": "sidecar",
  "enabledCapabilities": [
    "workspace_tools",
    "workspace_context",
    "workspace_skills"
  ]
}
```

The tools/context pair is atomic even when no Pi target currently references the environment:
configurations containing only one member are rejected. `workspace_files`,
`directory_browser`, `composer_attachments`, and `agent_tools_cli` remain
independently enabled policy surfaces and can share the same sidecar process.
`workspace_skills` is independently optional; enabling it is the explicit
environment grant for the fixed remote account-global and workspace skill roots.
`operations: { "kind": "none" }` installs, probes, and starts nothing.

The [`config/legacy-import/server.pi-ssh-sidecar.example.json`](../../config/legacy-import/server.pi-ssh-sidecar.example.json)
example is a schema-10 offline-import fixture, not a startup configuration.
Fresh installations configure the environment and Pi SDK backend in Settings.
A Pi backend instance spans one execution environment, so remote Pi uses its
own backend instance and main-host native
session namespace rather than repointing a local instance.

## Authority and behavior

File and search tools are confined to the selected primary workspace. Files
supplemental and hidden link-only roots do not grant agent authority. No remote
path is probed on the main host's filesystem, and a missing required
capability rejects submission before the model call. Search executables are a
lazy per-tool prerequisite: their absence does not disable remote Pi or any
other tool. Without `workspace_skills`, passive catalog and history reads never
start the sidecar.

The main-side executor converts semantic POSIX paths into the sidecar's
workspace-relative wire paths. Directory/search requests for `.` or the exact
workspace root omit the wire path; absolute paths inside the workspace become
relative paths. The sidecar retains canonical-root and symlink checks. Wire
paths are literal: a filename beginning with `@` or `~` must not undergo a
second round of prompt-oriented path interpretation.

Remote Bash runs `/bin/bash -c` without a login shell or PTY and receives a
bounded allowlist derived from the remote account environment. It is not a
sandbox: commands have the filesystem, process, credential-helper, and network
authority of the SSH account. Process-group cleanup is bounded best effort and
does not promise containment against a command that deliberately daemonizes.
Remote Bash does not receive Sedes CLI injection and returns no main-host
output-spill path.

Remote `grep` first resolves `rg` from the remote `PATH` and remote `find`
first resolves `fd`; if no trusted system executable is available, each falls
back to Pi's standard account-owned managed-bin location at
`~/.pi/agent/bin/rg` or `~/.pi/agent/bin/fd`. A system candidate must resolve
through root-owned directories that are not group- or other-writable to a
root-owned regular executable with the same write restrictions. The managed
fallback retains its owner-only path checks.
Sedes does not accept `fdfind` as an alias, download a substitute, or pin
either tool to one product-global version. At each invocation it reads a
bounded semantic version and revalidates the admitted path, file identity, and
version immediately before direct spawning. If one executable is absent or
invalid, only the corresponding tool returns
`workspace_tools_search_prerequisite_unavailable`; Files, context, Bash, and
the other Pi tools remain available. These executables are code owned by the
remote system or SSH account, so the trusted-host/account requirement applies
to them just as it does to remote Bash and workspace content.

`workspace_context@1` loads the bounded remote instruction hierarchy as prompt
data. In each directory, `AGENTS.override.md` replaces that directory's
`AGENTS.md`/`CLAUDE.md` candidate while preserving instructions selected from
ancestor directories. Remote mode does not execute project extensions or
load remote project settings, packages, prompts, themes, `SYSTEM.md`,
or `APPEND_SYSTEM.md`, and does not discover main-host ancestor resources.
Sedes prepends at most one bounded instruction file from the configured
main-host Pi agent directory, labeled `host-global`, before the labeled remote
hierarchy. The same `AGENTS.override.md` precedence applies in that directory;
this explicit global file is the only main-host context admitted.

The SDK's generated `Current working directory` line uses the remote semantic
workspace path. Pi 0.86.0 separately inserts documentation and example paths
from its main-host package installation; these are not evidence of the tool
execution directory and may not exist remotely. The ordinary SDK integration
test checks the actual outbound system prompt before and after a tool result,
including when SDK service and session-metadata paths differ from that remote
workspace.

`workspace_skills@1` scans only `~/.pi/agent/skills`, `~/.agents/skills`, and
the selected workspace's `.pi/skills` and `.agents/skills`. The remote account
home roots are intentionally outside workspace authority and are admitted only
by this explicit installation-owned capability. Discovery is bounded, does not
follow symlinks or load settings, and returns metadata, digests, opaque IDs,
diagnostics, and one catalog fingerprint. Selection re-scans and resolves the
exact `SKILL.md` only while that fingerprint still matches; drift fails closed.
Remote selector IDs include the content digest, so repaired metadata cannot
turn a stale selection into consent for changed content. A drift failure
refreshes the cached metadata for immediate re-selection without requiring an
unrelated turn.

Pi's host-local resource loader uses the metadata for the existing normalized
skill selector. On explicit selection, the Pi adapter strips frontmatter,
constructs Pi 0.86.0's exact private `<skill>` envelope with the remote file
and base directory, and disables SDK skill expansion. The body and native
paths remain server-private and existing history projection redacts the
envelope. Relative assets in account-global skills are not automatically
granted through the workspace-confined `read` tool; remote Bash retains the
SSH account's ordinary authority.

## Lifecycle and failures

One persistent environment-scoped sidecar multiplexes enabled Files, tools,
context, skills, attachment, and CLI capability families. The installation,
tenant, principal, environment, controller epoch, and service incarnation fence
ownership; configuration and operations revisions fence every lease.
A Pi-only SSH environment internally remains
`ssh_environment_not_validated` until its first sidecar-backed operation
completes the versioned hello handshake, but that initial state is admitted and
is not presented as a failure. An enabled skill catalog can start this
validation; otherwise passive catalog and history reads do not. The handshake contributes positive environment availability
evidence. Transport-level startup or unexpected session loss contributes
negative evidence, while ordinary idle retirement, shutdown, caller
cancellation, and sidecar-local artifact or capability failures do not.
Passive skill-catalog scan failures preserve the last complete catalog (or the
initial empty catalog) with a warning and do not fail required context refresh
or tear down the Pi session. Explicit selected-body resolution remains
fail-closed.
Active shells belong to the persistent service and survive loss of their SSH
carrier. Releasing an upstream operation lease does not stop the remote shell.

Carrier loss never falls back locally. Sidecar and Codex health remain
independent even though both are availability evidence sources; a current
positive source keeps the environment available. Read-only work may retry only
before an effect boundary and under fresh authority. A possibly delivered
write, edit, or shell launch is never replayed automatically. Recovery inspects
the exact retained operation; missing or insufficient evidence remains outcome
unknown.

While the local Pi turn remains alive, SSH shell recovery reacquires an
authorized carrier and polls the same shell identity every 250 ms until it
completes. A still-running inspection keeps the tool pending instead of ending
the turn with an uncertain result. Recovery has a finite budget derived from the
original command deadline plus five seconds for cleanup/recovery; reconnect
does not restart the command timeout. Carrier acquisition may use the remaining
overall budget, rather than restarting a slow healthy connection every five
seconds. Inspection and control calls remain individually bounded. A carrier
that closes between inspection polls is reacquired under the same authority.
Cancellation targets that same shell
through the recovered carrier, shortens the remaining wait to at most five
seconds, and still requires terminal evidence. A lost launch acknowledgement
also enters inspection recovery without repeating the launch.
Recovery revalidates current authority throughout the wait. Revoked
configuration or an explicit environment **Disconnect** stops automatic
recovery; a retained carrier lease cannot bypass that decision.

Inspection returns bounded retained stdout and stderr prefixes. The executor
tracks bytes already delivered on each channel and forwards only the unseen
suffix of each retained prefix. This preserves each channel's byte order but
cannot reconstruct stdout/stderr interleaving during the gap. Output-consumer
work completes before the tool settles. Recovered single-channel output stays
complete when every byte is available. If recovery reconstructs both stdout and
stderr, it conservatively marks output incomplete because their interleaving
is lost, even when all bytes are retained. Missing bytes or a truncated terminal
result also mark it incomplete. Pi leaves incomplete command receipts available
for environment recovery; after consuming
a complete result it acknowledges the receipt. A lost acknowledgement never
changes the command's result. The completing recovery lease remains available
for acknowledgement for at most five seconds, avoiding another SSH attachment
for the usual immediate acknowledgement. If the caller leaves the receipt
unacknowledged, the lease is released without discarding that receipt.

This recovery does not resume a Pi turn after the main Sedes daemon restarts.
The SDK/model loop and its waiting tool invocation are main-process state.
Sidecar death, lost operation identity, unavailable recovery authority, or an
exhausted recovery budget cannot prove command completion and remain explicit
uncertainty boundaries. There are no new settings or browser protocol fields.

Direct-local Pi keeps its existing native shell, resource, and CLI policies.
Local isolated Pi shares the shell adapter, but its ephemeral Bubblewrap worker
can inspect only the original session; it never starts a replacement worker to
recover a command and never falls back to a host shell.

## Compiled backend dispositions

| Backend          | Disposition                                                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi SDK           | Implements SSH tools/context and shell recovery, plus remote skills when `workspace_skills` is enabled. Direct-local execution and isolated-worker authority remain unchanged. |
| Codex app-server | Uses native provider execution and remote `skills/list`; it does not consume the Pi workspace shell executor or `workspace_skills`. Its persistent runtime recovery is unchanged. |
| Claude Agent SDK | Local worker or persistent SSH/outbound runtime. Native Claude tools and SDK skill discovery execute with that runtime; it does not consume the Pi workspace shell executor or `workspace_skills`. |
| Grok ACP         | Local-only. Remote Grok admission, workspace-tools projection, and remote skill discovery remain unsupported; local execution is unchanged. |

The in-memory conformance backend does not create a production remote-Pi
contract.

## Verification surfaces

Changes must test strict capability-pair configuration, environment and
workspace authority, fixed account-global authorization, context and skill
discovery bounds, stale catalog rejection, search-executable admission,
every built-in's success and failure projection, cancellation, lease and
generation fencing, availability evidence, sidecar startup/idle retirement,
carrier loss, read-only pre-effect retry, and outcome-unknown behavior for
possibly delivered writes or processes. Shell recovery coverage must include a
still-running command, completion before reconnect, lost launch response,
repeated carrier loss, exact-once output delivery, retained-output overflow,
lost stdout/stderr interleaving, cancellation after reconnect, authority
revocation during recovery, bounded recovery expiry, and an unknown shell.
Prove that reconnect never repeats the launch and that isolated-worker loss
never creates a replacement or a host fallback. Tests must prove that unsupported
backends and missing capabilities fail before model submission and never fall
back to the Sedes host filesystem. Live Pi verification is separately gated
and requires explicit authorization.

## Related contracts

[Back to Internals](index.md) · [Workspace Files](workspace-files.md) ·
[Agent tools](agent-tools.md) ·
[Backend integration](backend-integration-contract-rules.md)
