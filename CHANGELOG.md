# Changelog

## [Unreleased]

### Breaking Changes

- Claude backends require Claude Code 2.1.281 or newer and are tested through
  2.1.283. Earlier releases sent Sedes' startup message to the model with the
  first prompt, which Claude sometimes refused, or added a hidden "Continue"
  prompt when resuming after an interrupted tool call. Update Claude Code on
  every local and remote execution host before upgrading; an older release
  fails backend startup.

- Sidecars must use runtime protocol 14, which reads Claude history through the
  transcript's true tip and across automatic compactions, and reports
  transcript presence. It also runs Claude forks as one-shot launches and
  retires remote Claude queries by session. Upgrade existing sidecars
  explicitly before reconnecting with this server version.

- Browser and packaged clients must use client protocol 123, which carries
  per-turn fork availability, restartable fork aborts, the **Discard this
  fork** action and whether a fork's provider child was returned and how it
  is identified, the affected threads in the force reset preview, and
  background work in Stop, Restart, and Upgrade previews.

- Sidecars must use runtime protocol 13, which serves `sedes mcp` and accepts
  Claude's Native agent-tool entry. Upgrade existing sidecars explicitly
  before reconnecting with this server version. (#10)

- Claude history paging requires sidecar runtime protocol 12. Upgrade existing
  sidecars explicitly before reconnecting with this server version. (#9)

- Durable usage accounting replaces accumulated token/cost values in live
  snapshots. Requires matching browser and packaged clients using protocol 122.
  Migration preserves old Claude totals separately with unknown coverage. (#8)

### Added

- Show a **Viewed file snapshot** after Codex's "viewed a local image" notice.
  Sedes reads the file once through the thread's execution environment
  (local, or an SSH or outbound sidecar with `workspace_files`) within its
  allowed roots and keeps the snapshot with the thread, so later file changes
  do not alter it. Viewed paths are assumed to be on the thread's configured
  execution host; Codex-native additional executor environments are
  unsupported. (#11)

- Let Codex and Claude threads use Native Sedes agent tools. Choose
  **Native tools** in **Agent tools…**; Sedes adds a per-thread `sedes` MCP
  server (`sedes mcp`) that presents Progressive gateways or one tool per
  granted operation, with structured results and hints from each tool's
  declared effects. Sedes never edits Codex or Claude configuration, and the
  provider's own permission controls still apply. New Codex and Claude
  threads and Saved Agents without a tool policy default to Native tools in
  Individual mode; migration 115 changes only the default for new threads.
  Thread references are now bound to the CLI or MCP presentation; issued CLI
  references keep working. (#10)

- Add a **Usage** page (sidebar **More** → **Usage**) with tokens and
  estimated cost over time for every thread, filterable and groupable by
  model, provider, reasoning effort, backend, environment, project, thread,
  agent, and activity. It includes period comparison, an explorer with CSV
  export and two-dimension splits, a thread ranking, weekday-by-hour patterns,
  token mix, and a coverage view. Charts place usage only where its time is
  known. Migration 113 adds a derived usage timeline and rebuilds existing
  accounting once on first read. Pi, Codex, and Claude record the
  provider-confirmed model and reasoning effort for new usage. (#8)

- Capture Codex subagent usage independently of parent turns, including nested
  and background agents. Session stats separates main-agent, combined-subagent,
  and overall token totals. Migration 112 preserves existing accounting and
  adds durable child ownership; lightweight recovery avoids transcript scans. (#8)

- Record Pi, Codex, and Claude usage in the main database, with per-turn
  usage/cost details below replies and offline session totals in Session stats.
  Counts retain model/provider attribution, estimates, and incomplete-coverage
  labels; Grok reports accounting as unsupported.
  Turn usage actions appear only after a turn ends with recorded data, in a
  compact overlay sized for mobile screens, with closely spaced 44×44 touch
  controls and cached input grouped beneath its inclusive input total.
  Session stats stays in the thread menu rather than flashing during loading. (#8)

### Changed

- Make recorded usage accounting experimental and disabled by default. Set
  `SEDES_EXPERIMENTAL_USAGE=1` on the main server and restart to enable capture,
  recovery, report APIs, and UI. Existing records are preserved; context meters
  and Accounts remain available. Electron Managed Local passes through the
  setting when Electron launches with it. No sidecar protocol update is required. (#8)

- Rename the sidebar Provider Pulse quota entry from **Usage** to **Accounts**. (#8)

- New thread creation selects Custom by default, while explicit saved-Agent and
  template choices remain available. (#6)

- Claude sends show running as soon as Claude dequeues the input instead of
  after its first output. The composer activity bar starts at Send for every
  backend. Claude skips settings calls the live session already confirmed and
  applies sidecar events without one acknowledgement round trip each.

- Sedes no longer passes an inherited `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`
  to Claude Code. A turn interrupted by a lost process is marked interrupted
  instead of re-running its tools unattended; resend it to continue.

- **Force reset** now cancels the approvals and questions it abandons at the
  provider, for every backend, instead of only removing them from Sedes, so a
  provider is not left waiting on a prompt nobody can answer. Claude and Pi
  receive a denial or dismissal. A Codex approval that offers **Cancel turn**
  receives it, which also cancels that turn; a Codex question, which has no
  cancel, fails when the runtime is replaced. The reset waits up to 10 seconds
  for these answers before it replaces the runtime.

### Fixed

- Create Claude forks with one locked-down Claude Code launch. It loads no
  settings, hooks, MCP servers, or tools and denies any permission request.
  It no longer uses the thread's permission mode, so it cannot act for the
  child. A launch that starts a model turn is stopped and fails. Launch
  failures are classified: a refused launch creates nothing, and a
  deterministic failure is not offered as **Start a new fork**.

- Withhold Claude forking while background agents or commands still run in the
  source, with a reason on the fork action. A fork of an earlier turn whose
  background work had not finished is allowed; its child shows that the work
  was not carried over, instead of failing verification. Each turn Claude
  cannot fork at shows why, and generic **Fork** fails with that reason when
  it is the newest completed turn instead of forking an older one.

- Claude fork children inherit the source turns' usage and terminal results,
  and copy background task results only when the copied history shows them
  finished. Migration 117 records this child evidence.

- Log every fork failure with its backend code and cause. A retry that fails
  transiently keeps the fork recoverable instead of discarding a child an
  earlier attempt may have created. Startup fork recovery runs after the
  server listens. It finishes forks whose provider child was already returned
  without contacting the provider, retries only forks a crash interrupted
  before a response, and never discards one. Aborted and discarded Pi and
  Claude forks keep their reserved provider identity, so discovery never
  imports an orphaned fork child under the source's title (migration 116).
  Add **Discard this fork** to abandon an unfinished fork whose provider copy
  was not returned; its confirmation says whether an orphaned copy can still
  appear as a separate thread, as a Codex copy can.

- Scope **Force reset** to the thread it starts from and its unfinished forks.
  Resetting a fork no longer resets its source and sibling forks or stops the
  source's running turn. The preview names each affected thread with its run
  state and background work and totals the background agents and commands it
  may stop; a change in that work makes the preview stale.

- Release remote Claude queries that are no longer useful. A failed query is
  retired once its output is delivered, so reopening the thread no longer
  needs a backend restart. A query detached for 30 minutes with nothing
  outstanding is retired, and archiving a thread retires its query. Hitting
  the sidecar's 32-session limit reports the limit and how to free sessions.

- Read Claude history through the transcript's newest row. After a resume,
  history no longer stops at an earlier parallel tool call, forks from such
  threads verify, and reconciliation no longer compares against a truncated
  history that could resend a prompt Claude had already received.

- Reopen a Claude thread that was opened but never sent to. Sedes now resumes
  the existing session instead of failing with "Session ID … is already in
  use", and first-send recovery can resolve it.

- Stop showing Claude Code's "No response requested." resume placeholder as a
  reply. Reopening a Claude thread no longer adds a phantom turn or displaces a
  turn's final answer, and forks and usage ignore the placeholder. A prompt
  left unanswered because Claude Code exited now ends as interrupted with an
  explanation instead of completed.

- Keep earlier Claude turns visible after Claude automatically compacts a long
  conversation. **Conversation compacted** marks the point and expands to
  Claude's summary, which no longer appears as a new prompt. A turn Claude
  compacted mid-way keeps its prompt, settles with its result, and can be
  stopped, instead of staying running. Threads already compacted re-identify
  the former summary turn once. Only turns after the latest compaction can be
  forked, because Claude resumes from its summary.

- End a Claude turn left running after its Claude process was lost, for
  example when the server, worker, or sidecar stopped mid-turn. The next launch
  marks it interrupted with a notice; a reattached remote query that is still
  running is unaffected. **Stop** no longer stays "stopping" without a result:
  the turn ends a second after Claude reports idle, or after 30 seconds.

- Show turns Claude starts itself, such as after a background task or peer
  hand-back, as running with **Stop**, and keep idle retirement, eviction and
  sidecar replacement from ending them. Sedes now launches Claude with
  `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`.

- Accept a Claude input only on Claude's exact dequeue or consumption evidence,
  so output from a turn Claude started no longer claims a queued message or
  writes its receipt. Local Claude threads now enter running and settle, so a
  second message is accepted.

- Keep a conflicting Claude result from failing the thread; the first recorded
  outcome is kept.

- Distinguish, in sidecar abandonment records, a remote Claude session whose
  work had finished (its unacknowledged result is its outcome) from work the
  stop interrupted. An automatic sidecar replacement that ends Claude work
  started after its idle check now leaves an abandonment record.

- Warn, naming each task, when a resumed Claude session reports background
  work the previous session left unfinished; its result never arrived and
  Claude may run it again.

- Show background work before it is interrupted. Backend and environment
  Stop, Restart, and Upgrade previews list running turns, background work,
  pending approvals, and undelivered output that remote Claude reports,
  including for threads nobody has open.

- Stop a Claude message whose remote session ended unconfirmed from pausing
  the queue indefinitely. **Reconcile delivery** now marks it failed with an
  unknown outcome, so you can review the conversation and dismiss it or
  restore it to send again; later queued messages wait for that choice.

- Let a remote Claude turn run twice as long while main is away before its
  retained output overflows. The sidecar counts each retained event once and
  folds streamed text that no main has seen yet into fewer events. After a
  restart or reconnection, Sedes now opens threads whose remote Claude work is
  still running or undelivered, within the conversation-runtime budget, so
  their output is applied without waiting for someone to open them.

- Show a Claude task-notification turn as its own turn while it streams, as
  reload does. Existing threads re-identify those turns once on first load.

- Preserve underlying Claude read errors in gated thread-load diagnostics and
  identify failed persistent-runtime commands without logging conversation content.

- Reclaim acknowledged remote Claude output during long unfinished turns once
  native history covers it, preserving unfinished output and pending delivery.
  Restart recovery reads large histories in bounded, consistency-checked pages. (#9)

- Speed up Usage timeline queries by scanning the time index per bucket instead
  of repeatedly scanning a principal's history; totals, filters, and interval
  placement remain unchanged. (#8)

- Accept owned final symlinks to private Codex Unix sockets, including daemon
  socket aliases on remote hosts, while preserving owner/mode checks and
  detecting alias or target replacement without changing accounting identity. (#8)

- Keep historical Codex subagent accounting out of reconnect monitoring and
  release only acquired attachments, preventing imported history from flooding
  remote sidecars with cleanup requests and disconnecting sessions. Migration
  114 adds recovery indexes while preserving recorded usage. (#8)

- Capture Codex multi-agent v2 spawn events as well as legacy collaboration
  events, so both modes contribute to the session's subagent totals. (#8)

- Report fully captured Codex turns as complete at main-agent scope; unknown
  model attribution no longer makes token counts partial. Existing session-wide capture gaps, including
  restart recovery, can still mark earlier turns partial. (#8)

- Recover first-turn usage from Codex's restored idle checkpoint when provided,
  without extra history reads. (#8)

- Preserve the deployed usage-accounting migration checksum and add session-gap
  scope in a separate migration so existing installations can upgrade. (#8)

- Avoid spurious active-thread archive errors when opening the thread menu
  starts a status read or cold runtime attachment. Briefly drain existing
  runtime borrowers under the archive fence, then recheck activity before
  committing. (#7)

- Show Pi, Codex, and Claude turn failure details with the current failed state,
  and retain quiet details on historical turns. Clear the current explanation
  when newer work starts; Pi retries do not leave a stale failure. Requires
  matching browser and packaged clients using client protocol 117. (#6)

- Stop Claude Bash tool processes with their Claude process. The Claude worker
  now tracks descendants that run in their own sessions and reports cleanup as
  proven only after they are gone; previously they could outlive a stopped or
  crashed Claude process.

- Reopen a Claude session only after its previous Claude process has exited.
  Closing or failing a query no longer releases the session while the old
  process can still write its transcript.

- Recover a stale state or native-store lock whose PID was reused by an
  unrelated process. New lock records include the owner's process start time
  and boot identity on Linux and macOS; existing PID-only records keep the
  previous PID check.

- Remove superseded sidecar and Claude worker builds that no live process
  uses after a sidecar starts or installs a new worker, keeping recent builds
  for rollback. Persistent sidecar delivery diagnostics keep captures from
  only the four most recent earlier daemon PIDs. Diagnostics remain opt-in.

### Removed

## [0.1.1] - 2026-09-21

### Breaking Changes

- `install:server` now requires a verified, extracted server package built with
  `package:server`, instead of a built root checkout. Previously installed
  releases must be rebuilt as dedicated packages before activation or rollback.
  Packages use an independent dependency lock, external Node 24.18.0+,
  source-built SQLite/PTY addons, offline activation, and extraction checks.
  Systemd unit creation and updates now require explicit `--systemd` on each
  install or activation; the former `--no-systemd` option is removed. Linux
  and macOS default to installation without service integration.
  ([#4](https://github.com/kcosr/sedes/pull/4))

### Changed

- Add explicit Electron `client` and `full` distribution profiles. Client keeps
  Direct/SSH connections without a bundled backend; full retains Managed Local
  with shared locked server dependencies and target-pruned native payloads.
  Both use separately installed Codex, Claude Code, and Grok executables.
  ([#4](https://github.com/kcosr/sedes/pull/4))

- Redesign Files Changes with a persistent changed-file navigator, automatic
  diff loading, local reading-position restoration, and separate current/history
  review controls. A compact toolbar opens comparison, View, and Review settings
  without shifting the diff; file counts and navigation sit with the files.
  Revision pickers show commit messages and dates, searchable branch groups,
  scoped history, and branch-comparison presets. Requires matching
  clients and managed sidecars with `workspace_files@8`.
  ([#1](https://github.com/kcosr/sedes/pull/1))

- Clarify Linux, macOS, and limited Windows standalone server support, add a
  Windows entry point, and identify Linux as the developer's primary server host.

- Refresh README examples with desktop conversations, bookmarks, inline diffs,
  and mobile thread and terminal screenshots.

- Make test-host discovery portable: Claude native fixtures use PATH or their
  explicit executable override, and sandbox checks use the current home and a
  temporary canary instead of personal configuration files.

- Point repository links and release tooling at `kcosr/sedes`; remove the local
  validation diary and personal test account name. The live Claude conversation
  test now discovers `claude` on PATH unless an explicit executable is supplied.

- Clarify connection diagrams with transport labels, separate client and
  execution SSH hops, and an outbound-host example showing process ownership.
  The README now identifies the developer's primary setup and most-used backends.

- Upgrade the embedded Pi SDK and integration profile to `0.86.0`, including
  the Electron local server. Pi now defaults to cost-aware cache warming
  during active runs and supports per-model compaction budgets in native
  settings. Custom provider extensions must support transcript-based prompts.
  ([#51](https://github.com/kcosr/sedes/pull/51))

### Fixed

- Keep pending messages queued and retry unavailable backends during startup,
  instead of preventing the server from starting.
  ([#4](https://github.com/kcosr/sedes/pull/4))

- Preserve the browser Host header in the development API proxy so same-origin
  mutations pass origin validation.
  ([Issue #2](https://github.com/kcosr/sedes/issues/2), [PR #3](https://github.com/kcosr/sedes/pull/3))

- Bound changed-file filters so long pasted input cannot interrupt saved Files
  navigation.
  ([#1](https://github.com/kcosr/sedes/pull/1))

- Keep historical review comments and reviewed flags off replacement comparisons;
  editing a historical comment no longer creates an unrelated current review.
  ([#1](https://github.com/kcosr/sedes/pull/1))

- Preserve interrupted status when Pi provider setup returns an error after
  cancellation, in both live output and restored history.
  ([#51](https://github.com/kcosr/sedes/pull/51))
- Preserve the global Pi cache-warming setting for remote and isolated
  sessions, including explicit opt-out. Refresh displayed usage for cache
  warming while idle and include known warming requests without creating
  assistant messages. ([#51](https://github.com/kcosr/sedes/pull/51))
- Electron local-server packages retain only the matching Pi native platform
  and architecture and reject foreign native payloads during verification.
  ([#51](https://github.com/kcosr/sedes/pull/51))

Initial release
