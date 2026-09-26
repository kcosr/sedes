# Pi SDK backend

The Pi backend embeds `@earendil-works/pi-coding-agent` 0.86.0 directly in the
Sedes server. Sedes does not launch the Pi CLI or use Pi RPC mode.

Pi is the most direct integration for its native provider/model catalog,
skills, workspace tools, tool-access controls, and usage/cost reporting. The
provider runtime always stays on the Sedes host. An optional managed sidecar
can run Pi's built-in workspace operations against an SSH workspace without
moving authentication or conversation history to that host.

For implementation ownership, projection, isolation, persistence, recovery,
and contributor invariants, see the [Pi internal contract](../../internals/backends/pi.md).
For a comparison with other providers, see the [backend support matrix](index.md).

## On this page

- [Prerequisites and authentication](#prerequisites-and-authentication)
- [Configuration](#configuration)
- [Version policy](#version-policy)
- [Topologies and capabilities](#topologies-and-capabilities)
- [Operational boundaries](#operational-boundaries)
- [Verification](#verification)
- [Troubleshooting](#troubleshooting)
- [Opt-in live verification](#opt-in-live-verification)

## Prerequisites and authentication

- Run Sedes on Linux x64 or macOS arm64/x64. Direct local execution is
  supported on both; optional Bubblewrap isolation is Linux-only.
- Run Sedes with the same operating-system account and effective `HOME` that
  owns the intended Pi provider configuration and credentials, or deliberately
  set Pi's documented native directory variables for the service.
- Configure at least one authenticated provider/model in Pi's native
  environment. The pinned SDK is already a Sedes dependency; no separate Pi
  executable or RPC service is required.
- For local isolated workspaces, install Bubblewrap at `/usr/bin/bwrap` on
  Linux and allow its namespace preflight to succeed.
- For an SSH workspace, configure a working OpenSSH host alias. The managed
  sidecar requires remote Linux `/proc`, Node.js 22.19 or newer, `/bin/bash`,
  and the complete `workspace_tools` and `workspace_context` capability pair.
  Add `workspace_skills` when remote account-global or workspace skills should
  appear in the Pi skill selector.

Pi owns credential discovery and refresh. Credentials do not belong in the
Sedes server JSON, database, browser, or logs. `PI_CODING_AGENT_DIR`,
`PI_CODING_AGENT_SESSION_DIR`, and Pi's native `sessionDir` affect which
configuration and conversation store the service account sees. Keep those
values consistent between authentication/setup and production startup.

## Configuration

Select **Pi SDK** in **Settings → Backends**, choose the execution environment,
and save the backend with its target and model policy. Add workspace roots and
sidecar capabilities in **Settings → Environments**. The internal identifiers
remain `pi` and `pi_sdk`; the visible name does not rename stored bindings.

The [local](../../../config/legacy-import/server.example.json) and
[remote workspace](../../../config/legacy-import/server.pi-ssh-sidecar.example.json)
schema-10 examples are explicit legacy-import fixtures. They are not startup
files. Fresh startup uses the schema-11 bootstrap and empty database settings.
See [Configuration](../configuration.md).

All enabled targets on one Pi backend must resolve to the same execution
environment. A backend also has one required top-level `modelPolicy`; use
separate backend instances when targets need different environments or policy
ceilings.

Pi's native catalog remains authoritative. Sedes intersects that live catalog
with `modelPolicy` and never fabricates a configured-but-missing model or
substitutes another provider, model, or reasoning effort. Use an allowlist when
you require a closed set: a denylist intentionally admits future unmatched
catalog values. See the shared
[backend model-policy contract](../configuration.md#backend-model-policy).

### Local isolation policy

A local target can offer direct execution or a durable Bubblewrap workspace
when a thread is created. The local execution environment's principal-owned
`workspaceIsolation` policy controls the available network profiles. Its safe
default admits only `isolated`; configure `execution_host` explicitly before
the UI offers or the server accepts it.

A missing or failed Bubblewrap preflight hides isolation choices for new
threads. A persisted isolated selection fails closed if its runtime or current
network profile is unavailable; Sedes never silently changes it to direct
execution. See
[execution-environment configuration](../configuration.md#execution-environments).

### Managed SSH workspace

An SSH target is accepted only when its sidecar provides the complete
`workspace_tools` and `workspace_context` pair. `workspace_skills` is optional
and independent. When enabled, it scans the remote account's fixed
`~/.pi/agent/skills` and `~/.agents/skills` roots plus `.pi/skills` and
`.agents/skills` under the selected workspace. Loading a Pi session's skill
catalog can therefore perform the first remote handshake; without that
capability, passive Pi catalog and history reads remain sidecar-free. There is
no local fallback if an enabled remote path is unavailable.

If SSH drops during a Bash command while the Sedes daemon remains running,
the tool waits for the same remote command after reconnecting. It does not run
the command again. Recovery remains bounded by the original command deadline
plus five seconds for cleanup/recovery. **Stop** forwards cancellation to that
command when a carrier is available and limits the remaining wait to five
seconds. An unavailable carrier can leave cancellation unconfirmed.
An explicit environment **Disconnect** or revoked configuration stops automatic
recovery, including an already pending wait.

Sedes recovers bounded retained output without repeating bytes already shown;
stdout/stderr interleaving during the gap cannot be reconstructed.
If recovery reconstructs both channels, or output exceeds what the sidecar
retained during the gap, the tool reports incomplete output and keeps the
command result available in environment
recovery. If completion cannot be established, it reports an uncertain outcome.
Restarting the main Sedes daemon does not resume an active Pi turn, even when
the remote command survives; restarting the sidecar loses its in-memory
command receipts. The model loop, credentials, and conversation store remain
on the Sedes host.

## Version policy

Pi is an exact in-process dependency, not an executable compatibility range.
The package dependency, lockfile, and compiled integration profile all use
`0.86.0`. Settings does not select that compiled release.
Sedes persists the compiled profile for diagnostics and runtime-generation
integrity. A Pi upgrade is a deliberate source dependency and test update.

### Cache warming and compaction budgets

Pi 0.86.0 defaults to `"cacheWarming": "streaming"`: it may make paid
refresh requests to retain an expensive prompt cache during long tool runs
when its cost estimate favors refreshing. `"off"` disables refreshes;
`"idle"` also permits them while waiting for another message. Configure this
in the service account's **global Pi settings**, not project settings. Sedes
preserves that global choice for direct, SSH, and isolated sessions and does
not enable idle warming itself. Remote settings are read on the Sedes host.

Refresh tokens and estimated costs contribute to recorded session usage, including
updates while idle. Request counts appear only where native usage establishes
request cardinality; transcript message counters remain a separate live view.
Cache-warming records do not appear as assistant messages. In idle mode,
ending a turn does not disable the operator's idle-warming policy; disposing
the Pi session cancels warming.

Pi also supports per-model compaction budgets in its native settings:

```json
{
  "cacheWarming": "off",
  "compaction": {
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "modelOverrides": {
      "provider/model-id": {
        "reserveTokens": 32768,
        "keepRecentTokens": 12000
      }
    }
  }
}
```

Replace the example key with an exact native `provider/modelId`. Omitted
per-model fields use the ordinary compaction values. Sedes passes global
compaction settings through to SSH and isolated sessions; direct sessions
also use Pi's trusted-project settings rules. No Sedes browser setting is
needed. Provider extensions using custom streaming callbacks must support
Pi 0.86's transcript-based prompt and tool declarations.

## Topologies and capabilities

| Topology       | Provider runtime and native store | Workspace operations                                         | Important boundary                                                                                                          |
| -------------- | --------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Direct local   | Sedes host                        | Authorized local project                                     | Pi and tools execute with the Sedes service account's local authority.                                                      |
| Local isolated | Sedes host                        | Durable Bubblewrap allocation                                | The sandbox contains workspace operations, not provider calls, credentials, or Pi persistence.                              |
| Managed SSH    | Sedes host                        | Seven built-ins and optional skill reads through the sidecar | Remote Bash has the SSH account's authority; remote Pi, extensions, settings, credentials, and custom tools are not loaded. |

The current driver supports:

- submit, Steer, interrupt, rename, and compact;
- bounded normalized history with older-history pagination;
- model, thinking-level, and tool-access changes;
- native workspace commands and skills;
- choice, confirmation, text-input, editor, and Sedes-managed decision
  interactions;
- context, token, cost, and counter usage;
- shared staged file attachments and model-conditional native image input; and
- provider-native forks at the latest completed turn or a selected completed
  turn, except for isolated workspaces.

**Stop** clears Pi's generation-volatile Steer and follow-up queue before it
aborts the active run. It does not remove Sedes's durable next-turn queue, and
there is no control for retracting one already submitted Steer independently.
A Steer that Stop cleared before Pi used it was not accepted, so Sedes keeps it
as ordinary queued work, which runs after the stopped turn.
If automatic compaction occurs between a tool result and resumed assistant
output, Sedes keeps streaming that run and refreshes the projection after it
settles. A failed automatic compaction appears as a bounded warning without
replacing the conversation history.

Pi tool access is `read_only`, `ask`, or `full`. In `ask`, Sedes presents the
same eligible catalog as `full` but intercepts built-in mutators and
non-read-only Sedes agent tools for a decision. Pi tool access and Sedes
execution-environment access are independent: approval at either layer never
broadens the other layer.

The supported Pi built-ins are `read`, `grep`, `find`, `ls`, `bash`, `write`,
and `edit`. Pi 0.86.0 also provides an optional `powershell` tool, but Sedes
intentionally excludes it on its supported Linux and macOS server platforms,
even when a `pwsh` executable is installed. Direct-local project extensions
remain available under their own identity in eligible `ask`/`full` catalogs.
Managed SSH and local isolation expose only the seven reviewed,
executor-backed workspace operations plus explicitly enabled Sedes agent
tools; they never fall back to a host shell tool.

Pi intentionally does not advertise structured questionnaires, a managed
provider terminal/TUI, provider-output native image artifacts, or
`latest_provider_snapshot`. Generic extension prompts retain their primitive
interaction kind instead of being inferred as approvals or questionnaires.

## Operational boundaries

- The Pi provider runtime remains host-local. SSH support covers the managed
  workspace-tool/context topology and, when explicitly enabled, bounded skill
  discovery and exact selected-body reads. Sedes constructs Pi's native skill
  envelope locally; it never asks the SDK to read a remote path.
- A selected remote skill body is self-contained prompt data. Relative assets
  in account-global skills remain outside the workspace-confined `read` tool;
  remote Bash retains the SSH account's broader authority.
- A writable isolated workspace is a private Git clone. A read-only isolated
  workspace is a live read-only mount of the authorized source; it is not a
  snapshot. Both have a durable private writable home.
- Isolated workspaces cannot currently be forked. Direct local and managed SSH
  threads can fork completed turns, including while later source work is
  active.
- Independent concurrent access to the same native session is unsafe. Stop the
  other Pi or Sedes process instead of bypassing its writer lock.
- Provider credentials and native stores are outside Sedes backups.
- Local Pi offers Progressive and Individual modes on both Native and CLI
  surfaces when eligible. CLI presentation still requires ordinary Bash
  eligibility; Sedes never enables Bash on its behalf. SSH and isolated
  targets offer only the two Native modes and do not receive the Sedes CLI.
  Missing CLI admission never falls back to Native presentation.
- A local reset can abandon Sedes blockers but does not edit or stop the Pi
  session. Preserve uncertain-operation receipts so authenticated native
  markers can reconcile them.

For the exact sandbox filesystem, lifecycle, and handoff rules, read
[Pi workspace sandbox](../../internals/pi-workspace-sandbox.md). For the SSH
protocol and authority boundary, read
[Remote Pi workspace tools](../../internals/pi-remote-workspace-tools.md).

## Verification

After startup:

1. Confirm the expected provider/model tuples appear and that policy-excluded
   tuples do not.
2. Create a disposable thread and complete one small turn.
3. Reload the thread and confirm its transcript and usage recover.
4. Exercise the configured execution topology: read a local project file, use
   an isolated workspace operation, or trigger a Files/workspace-tool request
   over SSH.
5. If fork behavior matters, fork a completed turn on a direct local or SSH
   thread and verify that the child opens independently.

The SSH sidecar is intentionally validated on its first real operation, so a
successful server startup alone does not verify the remote path.

## Troubleshooting

| Symptom                                 | Checks and resolution                                                                                                                                                                                         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pi starts but has no selectable models  | Run Sedes under the account that owns the intended Pi native configuration; check `HOME` and `PI_CODING_AGENT_DIR`; confirm provider authentication and native catalog discovery; then inspect `modelPolicy`. |
| Pi integration profile mismatch         | Install and run one internally consistent Sedes build; the bundled Pi dependency and compiled profile must both be `0.86.0`.                                                                                  |
| An existing session is locked           | Stop the other Pi/Sedes process that owns the native session. Do not delete or bypass the writer lock.                                                                                                        |
| Isolation choices are missing           | Confirm `/usr/bin/bwrap` exists and review the preflight diagnostic. Persisted isolation fails closed rather than falling back to direct execution.                                                           |
| `execution_host` is not offered         | Add it explicitly to the local environment's `workspaceIsolation` network policy.                                                                                                                             |
| SSH browsing or tools fail on first use | Verify the OpenSSH alias and remote prerequisites, then confirm both sidecar capabilities are enabled. There is no local fallback.                                                                            |
| A remote Bash tool stays pending after SSH loss | Restore SSH access and let the active turn recover the same command. The wait is bounded; use **Stop** to request cancellation. A main-daemon restart cannot resume that turn. |
| Remote command output is incomplete     | Inspect the retained command result in environment recovery. Missing bytes or lost stdout/stderr interleaving cannot be reconstructed; do not rerun a mutation merely to recover its output. |
| Remote Pi skills are missing            | Enable `workspace_skills`, verify the skill is beneath one of the four fixed roots with valid Agent Skills frontmatter, and reopen or reload the Pi thread.                                                   |
| Fork is unavailable                     | Isolated Pi sessions cannot fork. For a direct or SSH thread, select or wait for a completed turn and recheck the advertised capability.                                                                      |
| A mutation has an uncertain outcome     | Preserve the recovery receipt and let Sedes reconcile authenticated native markers. Do not retry based on prompt text, timestamps, or a later turn.                                                           |

Use [Debug diagnostics](../../developer/diagnostics.md) for bounded diagnostic
surfaces. Do not copy Pi credentials, native JSONL, or provider payloads into
logs or issue reports.

## Opt-in live verification

The real-Pi suites consume authenticated provider capacity and are not routine
verification. The main gate requires exactly one authenticated `xai/grok-4.5`
model at low reasoning and verifies read-only tool state before prompting:

```sh
env -u NODE_ENV npm run test:real-pi
```

The separate built-CLI gate is disabled unless its explicit environment gate
is present:

```sh
SEDES_RUN_REAL_PI_CLI=1 env -u NODE_ENV npm run test:real-pi-cli
```

Run either only after deliberate approval and only when its provider/model and
tool-policy preflight are expected to pass. Contributor verification and
backend audit requirements are in the [Pi internal contract](../../internals/backends/pi.md#verification-and-change-contract).

## Recorded usage

Pi records distinct usage-bearing native entries, including available auxiliary
and cache-warming work, and reuses their identities when ordinary history is
loaded. Available model/provider dimensions come from each source entry. Token
buckets are SDK-normalized; SDK pricing is an estimate. A proven copied fork
entry retains its origin rather than becoming new spend. Unproven ancestry stays
outside selected totals with an incomplete-coverage explanation. Native entry
counts are not automatically billed request counts.

Captured values live in the main Sedes database and remain readable without
opening a provider session. See [recorded usage](../../user/conversations.md#view-recorded-usage)
for the UI and [backups](../operations.md#state-upgrades-and-backups) for retention.
