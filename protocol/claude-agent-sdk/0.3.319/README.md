# Claude Agent SDK 0.3.319

Sedes pins `@anthropic-ai/claude-agent-sdk` 0.3.319 and records native
Claude Code 2.1.319 as its tested-through release. The independently installed
runtime floor remains 2.1.287. Newer stable runtimes are accepted with an
advisory. Sedes uses the configured native executable rather than the SDK's
bundled executable. Exact artifact identities and verification results are
recorded in [`native-qualification.json`](native-qualification.json).

## Upstream changes and adaptation

The official [SDK changelog](https://github.com/anthropics/claude-agent-sdk-typescript/blob/v0.3.319/CHANGELOG.md)
and the installed SDK declarations were compared with 0.3.296. The consumed
query, permission, streaming, and native-history contracts retain their
required fields. The added hook failure option is not requested by Sedes.
These changes require no worker or persistent-runtime capability cutover.

Three new startup failure reasons, `sandbox_required_unavailable`,
`initialize_not_first`, and `config_file_invalid`, receive bounded Sedes
failure messages. Raw startup stderr remains private. Terminal-state tests
cover their persistence after Claude's trailing idle signal.

Upstream MCP background tasks use `task_type: "mcp_task"`. The existing complete
inventory projection already counts these as other background work, and
agent-specific settlement tracking continues to require `local_agent`.
Sedes does not enable the new automatic MCP background-task option.

The new `session_writes_lost` informational message is documented as safe to
ignore and does not change a received result or the native exit status.
It follows the existing handling for unprojected informational messages.
No native diagnostic details or new provider fields become browser contracts.

The SDK package now requires Node 18.14.0, below Sedes' Node 24.18.0 floor.
Its optional native executables are still pruned from Sedes bundles. Existing
usage normalization, native session ownership, permission settings, and
startup markers retain their behavior. Prior qualification directories remain
historical evidence for their recorded SDK and executable versions.

Claude Code 2.1.319 distinguishes a tool stopped while running from a refused
permission prompt with an exact correction suffix. Sedes recognizes that native
result, with or without the provider memory note, only when the batch carries
its explicit interruption marker. Other failures and denials keep their outcome.
The native failed-compaction fixture permits up to three summary attempts to
cover the current CLI while retaining its failure and no-boundary assertions.

The 0.3.302 default for Agent `subagent_type: "fork"` uses the existing child
message identities (`agent_id` / `parent_tool_use_id`), which remain private to
Claude and cannot settle a parent turn. Existing child-scoping unit coverage
applies; this specific default fork-subagent variant was not exercised natively.
This differs from the user-requested conversation fork covered by the live suite.

The 0.3.318 interrupt change for input held behind a model change does not
change Sedes withdrawal authority: the query owner calls `cancel_async_message`
for each unstarted Sedes input before a plain interrupt. Only its exact cancelled
lifecycle before a start proves withdrawal; neither `still_queued` nor a missing
input does. `claude-steer-native.test.ts` covers Stop with three pending inputs;
the model-change-held input variant was not exercised as a distinct native case.

The 0.3.311 ModelUsage cache-creation split adds duration-specific fields while
retaining `cacheCreationInputTokens` as the total. `claude-usage-accounting.ts`
continues to count that total once and ignores the breakdown; the usage-accounting
unit suite and native usage-continuation cases cover the existing total path.

## Verification

The focused release-policy, SDK session/probe, conversation-handle, background
inventory, and release-reconciliation checks passed 336 tests across nine
files. Typecheck, server-runtime dependency validation, and the regenerated
third-party license inventory check passed.

Final native qualification passed all 42 cases across 15 files with isolated
Claude Code 2.1.319: 33 loopback native cases and nine authenticated cases using
first-party subscription Sonnet 5.5 at low effort, including manual compaction.
The retained 2.1.287 minimum passed all 33 loopback native cases with the new SDK.
The initial latest run found the running-stop correction and compaction retry
changes described above; the complete latest rerun passed after both fixes.

The full browser suite passed 173 tests across 64 specs in four lanes. The
streaming-tools and restored-Stop Claude screenshots were inspected. After the
final stopped-running adaptation and rebuild, the Claude browser journey passed
both cases again. Final build and typecheck passed. The final general suite passed
19,268 tests with 91 skipped, including real sandbox tests excluded by the
container guidance.
The 168 focused history tests passed after the adaptation. Iterative Keel review
with `claude-default` completed two follow-ups with no findings remaining.

Native qualification is Linux x64 only and does not establish macOS, Windows,
SSH, or deployed-host behavior. The persistent-runtime suite uses local framed
sockets rather than an SSH host. Loopback fixtures do not establish authenticated
model behavior. Existing startup-marker refusals remain outside this SDK refresh.
The default fork-subagent and model-change-held input variants described above
were source-audited but were not individually exercised natively.
