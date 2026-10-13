# Claude Agent SDK 0.3.296

Sedes pins `@anthropic-ai/claude-agent-sdk` 0.3.296 and records Claude Code
2.1.296 as its tested-through release. The independently installed native
runtime floor remains 2.1.287; the SDK's bundled executable is not used by
Sedes. Compatible newer stable runtimes remain available with an advisory.
Exact artifacts and verification limits are recorded in
[`native-qualification.json`](native-qualification.json).

## Upstream changes and adaptation

The official [0.3.296 changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.296/CHANGELOG.md)
and installed declaration diff from 0.3.287 were reviewed. Relevant changes
across these releases include:

- 0.3.290 fixes queued-input replay and interrupted partial-message closure,
  and extends reply correlation on resumed permission/tool continuations.
- 0.3.292 adds `agent_id` to subagent messages, task-run and parent-task
  identifiers, and connector permission restrictions. Sedes recognizes an
  explicit `agent_id` as child ownership before parent acceptance, replay,
  or compaction bookkeeping. Existing permission handling already omits
  session-wide approval when `suppressAlwaysAllowRule` is set.
- 0.3.295 passes named CLI options as `--flag=value`, preserves streamed
  citations, adds rate-limit metadata, and strengthens permission and large
  MCP-result limits.
- 0.3.296 adds optional `claude_code_version` to the initialization control
  response, per-subagent compaction windows, and sandbox-settings merging.
  Sedes continues verifying its configured executable independently, does
  not request per-subagent compaction windows, and supplies no SDK `sandbox`
  option to merge.

Two added native startup failures, `org_config_required_unavailable` and
`org_config_refused`, receive bounded Sedes failure messages. Native details
remain private. Task inventory continues using the provider's complete
`background_tasks_changed` snapshot rather than relying on bookend ordering.
The existing task-run model is unchanged; optional upstream metadata does not
become a browser contract.

The startup marker is unchanged by this SDK refresh. A synthetic non-query
message still reaches subsequent model context. The newly exposed native
version field is useful for investigating control-only startup, but upgrading
the SDK alone does not fix startup-label refusals. Native forks, usage
normalization, and retained-query identity keep their existing behavior.

## Ownership and other backends

All adaptations are Claude-private. Native account credentials, executable
identity, and conversation history remain provider-owned. The upgrade does
not change persisted usage normalization or introduce a data migration.
Pi, Codex, Grok, and OpenCode retain their existing SDKs, protocols,
capabilities, and launch paths; no shared browser or sidecar wire shape changes.

## Verification

The focused release-policy, conversation-handle, and manual-compaction suites
passed all 264 tests. They cover the new startup failure dispositions and
agent-ID-only child messages that must not accept a parent input or supply a
parent compaction summary.

SDK 0.3.296 with native Claude Code 2.1.287 passed all 33 loopback cases across
10 files. This retains the established native floor with evidence for SDK
option serialization, startup and skill discovery, permissions, interrupted
streams, Steer, background work, manual compaction, persistent-runtime replay,
and resumed/forked usage accounting.

Native Claude Code 2.1.296 also passed all 33 loopback cases. Its combined
15-file real-Claude run passed 39 of 41 cases in 201.42 seconds, including
manual compaction. Two authenticated production-driver and persistent-runtime
cases stopped at the model-catalog preflight because the older exact Sonnet 5
model was absent. After selecting the available exact Sonnet 5.5 model with low
effort, both passed in a separate 67.64-second rerun; safety gates remained
enforced. All eight authenticated cases passed across these runs, but there
was no single clean full-suite run.

Typecheck and the production build passed. The full default suite passed
16,044 tests, failed two, and skipped 53 across 1,014 files in 651.56 seconds.
The two failures were unchanged supplemental-file-root and Codex SSH lifecycle
timeout cases; both passed isolated reruns without code changes. The
supplemental-root timeout also left an `ENOTEMPTY` cleanup error. These reruns
do not make the initial full run a clean pass. Real Bubblewrap launches were
skipped under the documented container exception. Loopback tests use disposable
native stores, a fixture key, and a localhost Messages API; they do not prove
model behavior or authenticated-account behavior.

The blocking-interaction browser file exposed an existing fixture race: its
2.6-second Codex turn finished while the test persisted a retained draft,
before the test could open the approval. Holding completion through approval
creation with the fixture's existing gate preserves all application behavior
and assertions. All seven cases passed on rerun in 77.308 seconds. This
exceeds the 55-second job guidance on a shared host with concurrent suites;
it is not a quiet-host performance comparison. The unchanged supplemental
file-root HTTP case also passed its isolated rerun after a five-second timeout
in the initial full run. Typecheck passed again after the fixture repair,
and the regenerated third-party license inventory passed its check. The
unchanged Codex SSH lifecycle case also passed its isolated rerun after a
full-suite timeout. The blocking-interaction menu and pending-response desktop
screenshots were inspected after the passing rerun.

The full four-lane browser run covered 48 files and 141 cases in 687.640 seconds:
132 passed, three failed, and six dependent blocking-interaction cases did not
run. Besides the repaired fixture race, Workpads and sidebar project management
hit 60-second timeouts. They passed unchanged coordinator reruns, covering one
Workpads case and three sidebar cases in 59.173 seconds combined. All 141
unique cases passed across the initial run and targeted reruns; no single full
run was clean. Concurrent suites and other shared-host work make the exceeded
200-second prebuilt guidance unsuitable for a quiet-host comparison. The
unchanged Workpads rerun took 57.371 seconds as a file; it also exceeded the
55-second job guidance under that load.

Both Claude browser cases passed in a 50.149-second file run. Their streaming
tools, skill-alias search, and restored-compaction-statistics screenshots were
inspected. These browser tests exercise fixture-backed UI behavior, not a live
Claude model.

Native qualification is Linux x64 only. It supplies no native macOS or Windows
evidence and no actual SSH or outbound-host deployment evidence. Existing
startup-marker refusals remain an unresolved limitation; passing synthetic
model fixtures cannot establish that they are fixed.
