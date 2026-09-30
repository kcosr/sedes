# Changelog

## [Unreleased]

### Breaking Changes

- Browser and packaged clients must use client protocol 129, which adds
  optional, runtime-only throughput measurements to completed turns. (#20)

- Browser and packaged clients must use client protocol 128, which adds
  reviewed Task snapshots to settle/archive previews and completion requests. (#19)

- Browser and packaged clients must use client protocol 127, which adds
  confirmed live background-work counts to sidebar thread summaries. (#16)

- Codex persistent runtimes require Codex runtime protocol 2 so tool-policy
  refreshes cannot reuse an older sidecar’s cached session configuration.
  Upgrade existing sidecars before reconnecting. No database migration or
  browser protocol change is required for this fix. (#15)

- Codex viewed images use a new `viewed_image` transcript item, introduced
  in client protocol 123. This build requires client protocol 129; see the
  client protocol entries below. (#11, #13, #14)

- Claude backends require Claude Code 2.1.281 or newer and are tested through
  2.1.283. Earlier releases added a hidden "Continue" prompt when resuming
  after an interrupted tool call, and failed Agent SDK turns after an
  assistant message with plain-string content. Update Claude Code on
  every local and remote execution host before upgrading; an older release
  fails backend startup. (#12)

- Sidecars must use runtime protocol 14, which reads Claude history through the
  transcript's true tip and across automatic compactions, and reports
  transcript presence. It also runs Claude forks as one-shot launches and
  retires remote Claude queries by session. Upgrade existing sidecars
  explicitly before reconnecting with this server version. (#12)

- Browser and packaged clients must use client protocol 126, which requires
  an `origin` on every image item: generated, or viewed and either the exact
  image the provider gave the model or a later snapshot of the file. A
  **Viewed image** row pairs only with a viewed image, and can now be working,
  failed, or interrupted. (#14)

- Browser and packaged clients must use client protocol 125, which marks a
  queue entry a provider returned as not sent with a normalized
  `failureReason`. Migration 118 records that reason; entries failed before
  the upgrade have none and keep their previous label. (#13)

- Browser and packaged clients must use client protocol 124, which carries
  per-turn fork availability, restartable fork aborts, the **Discard this
  fork** action and whether a fork's provider child was returned and how it
  is identified, the affected threads in the force reset preview, and
  background work in Stop, Restart, and Upgrade previews. (#12)

- Sidecars must use runtime protocol 13, which serves `sedes mcp` and accepts
  Claude's Native agent-tool entry. Upgrade existing sidecars explicitly
  before reconnecting with this server version. (#10)

- Claude history paging requires sidecar runtime protocol 12. Upgrade existing
  sidecars explicitly before reconnecting with this server version. (#9)

- Durable usage accounting replaces accumulated token/cost values in live
  snapshots. Requires matching browser and packaged clients using protocol 122.
  Migration preserves old Claude totals separately with unknown coverage. (#8)

### Added

- Escape in Settings goes up one level, like the **‹** links: from an editor
  to its item, from an item to its list, and from a page to the Settings list
  or the workspace. An open dialog, menu, or picker closes first, a text field
  only loses focus, and unsaved edits still ask before they are discarded.

- Completed Pi turns show tokens per second at the left of the turn footer
  when every main-agent response was measured. The rate excludes tool time
  and works without experimental usage accounting. Measurements remain only
  while the Pi runtime is loaded; older history has no reconstructed rate. (#20)

- Settle, archive, and bulk stack confirmations list their affected open Tasks
  and offer **Complete all**, keeping completed Tasks attached to their threads.
  Completion requires a fresh preview if Tasks change before confirmation. (#19)

- Sidebar thread rows and previews show a slow grey spinner for live subagents
  and a grey dot for remaining background commands. Active turns and unseen
  completions take priority; acknowledging completion reveals ongoing work
  without changing Send, Steer, Queue, or Stop behavior. Claude supplies this
  live inventory today; stale or unavailable activity is not shown as live.
  Unacknowledged completion dots now also take priority over draft, snoozed,
  automation, settled, and disconnected glyphs until acknowledged. (#16)

- Show a collapsed **Viewed image** row when Claude or Pi opens an image file
  with its built-in read tool: PNG, JPEG, GIF, or WebP, and BMP on Pi. Expand
  it to see the exact image the model received, which may be resized or
  converted. Sedes keeps it with the thread, and a fork or import keeps its
  own copy. The row shows **Working…** during the read, and a failed read
  shows an error without the path. Images from MCP servers, extensions, other
  tools, or Claude subagents are not shown; Grok image reads remain tool
  cards. (#14)

- Steer a running turn several times without waiting, on Claude, Pi, and
  Codex. Each Steer gets its own **Steering** card, in the order sent, and
  clears on its own when its message appears; the composer stays available
  for more Steer or Queue input. Sedes still sends Steers to the provider one
  at a time. **Stop** returns every Steer the provider had not used as not
  sent, and never resends one. When the turn ends while Steers are still
  unconfirmed, **Send** is available and waits in the queue behind them, so it
  never runs ahead of input you sent earlier. Previously any unconfirmed
  Steer disabled Send, Steer, and Queue on the thread. (#13)

- Show a collapsed **Viewed image** row, named by file, when Codex views a
  local image; expand it to see the snapshot. Sedes reads the file once
  through the thread's execution environment (local, or an SSH or outbound
  sidecar with `workspace_files`) within its allowed roots and keeps the
  snapshot with the thread, so later file changes do not alter it. Viewed
  paths are assumed to be on the thread's configured execution host;
  Codex-native additional executor environments are unsupported. (#11)

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

- Keep the composer unfocused when opening threads on touch tablets or by
  touch/pen on hybrid devices, while preserving desktop mouse/keyboard focus.
- Balance chat header rows vertically when the worktree picker is shown.
- Add space after the chat header backend icon and enlarge the expandable
  mobile Search and worktree controls.
- Enlarge composer buttons and model/reasoning selectors.
- Reduce chat header action icons slightly while preserving their tap targets.
- Add space between sidebar thread metadata and its group label.

- Settings has a new navigation. On desktop the sidebar lists its pages in
  five groups while Settings is open, under **Back to chat** or **Back to
  workspace**, and `/settings` opens the last page viewed or **General**. On
  phones, or with the sidebar hidden, `/settings` is a grouped list with
  descriptions and each page has a **‹ Settings** link. The **Settings
  category** picker and **All settings** are gone. Every page shares one
  layout: one title size, switches for on/off settings, and a sticky save bar
  on forms.

- Environments and Backends show the list beside the selected item when the
  Settings content is at least 960px wide, and stack below that. Each
  environment, backend, editor, add step, and pending host has its own address
  under `/settings/environments/` or `/settings/backends/`, so links, browser
  Back, and Android Back reach it directly. An item has **Overview** (health
  first), **Backends** or **Connections**, and **Activity** tabs; editing
  happens beside the list; removal and pairing revocation are in a **Danger
  zone**; internal IDs appear only under **Activity**. Pending hosts are listed
  under **Awaiting approval** instead of **Review hosts**, and the backend
  defaults sit above the backend list. Projects uses the same page layout.

- Agents move to **Settings → Execution → Agents** (`/settings/agents`) with
  the same list and detail layout; **More → Agents** and **Create an Agent**
  open it there.

- Dialogs share one design: fixed sizes, a pinned title and actions with the
  primary action last, errors shown inside the dialog, and no backdrop blur.
  Confirmations are one small dialog without a close button, and only
  irreversible actions use a solid red button, so **Archive** is neutral.
  Unsaved-changes prompts share one dialog with **Keep editing**. On touch
  screens and narrow windows, medium and larger dialogs and long menus open as
  bottom sheets with 44px rows, while confirmations stay centered. Deleting an
  automation now confirms in the app instead of the browser.

- Menus and pickers share one style: rows show their current value or why
  they are disabled, and searchable pickers dim unavailable choices. The
  thread context menu, and **Thread actions** where their items overlap, use
  one order: Rename, Pin, **Move to group ›**; Settle, Snooze, Automation;
  **New with same settings** (was **New**), Fork, **Copy ID ›**; then
  **Archive** and **Force reset…**. Codex execution settings are submenus
  instead of a form inside the menu. **Archive** archives at once and opens a
  dialog only when forks, open Tasks, stashed prompts, pending questions, or an
  isolated workspace need a choice. **Move to group** is a searchable list that
  can create a Group from the search, and **New group…** asks only for a name.

- The workbench bar and panel headers grow with their text, so a title no
  longer crowds the top edge under Android text zoom. They are slightly taller
  (52px, or 54px on touch), and toolbar icons are larger (18px, or 20px in
  40px targets on touch).

- Codex archives now unsubscribe Sedes from the native conversation and refuse
  while a native turn or goal is active. Archiving or changing tools also
  requires a closed managed Codex TUI. A bound Codex conversation whose history
  is not yet materialized requires its first message before changing tools, so
  a refresh cannot discard an empty native session. (#15)

- A Claude tool call that **Stop** aborted now reads as interrupted
  (**Activity · 1 tool call · Interrupted**) instead of failed, live and after
  a reload. Only the calls Stop itself stopped change: a parallel call that
  had already failed on its own, or that you denied, still reads as failed.
  Pi and Codex report no exact per-call evidence of the abort, so their calls
  keep the provider's own outcome. (#13)

- A Steer returned by **Stop** now shows a neutral **Not sent** label instead
  of a red **Steer failed**. A failed or not-sent queue entry offers
  **Restore** and **Dismiss**; **Delete** remains only for entries not yet
  sent, and each entry, not just the first, can be dismissed. (#13)

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
  applies sidecar events without one acknowledgement round trip each. (#12)

- Sedes no longer passes an inherited `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`
  to Claude Code. A turn interrupted by a lost process is marked interrupted
  instead of re-running its tools unattended; resend it to continue. (#12)

- **Force reset** now cancels the approvals and questions it abandons at the
  provider, for every backend, instead of only removing them from Sedes, so a
  provider is not left waiting on a prompt nobody can answer. Claude and Pi
  receive a denial or dismissal. A Codex approval that offers **Cancel turn**
  receives it, which also cancels that turn; a Codex question, which has no
  cancel, fails when the runtime is replaced. The reset waits up to 10 seconds
  for these answers before it replaces the runtime. (#12)

- **Stop** on a Claude thread also withdraws steering messages Claude has
  received but not yet started, including, on a remote host, ones sent before
  Sedes restarted. They no longer run as the next turn. Each withdrawn message
  returns as a failed queue entry marked not sent, also once the remote Claude
  session has retired, which you can restore to the composer or dismiss; later
  queued messages wait for that choice, and nothing is resent automatically. A
  message Claude already started stays with the stopped turn, and Claude's own
  queued work, such as a finished background task's notification, is not
  withdrawn. Sedes' own Queue is still untouched by Stop. Remote Claude needs
  a sidecar built from this version (runtime protocol 14). (#12)

- **Stop** on a Pi thread no longer re-sends a steering message Pi received
  but had not used as the next turn. Like Claude's, it returns as a failed
  queue entry marked not sent, to restore to the composer or dismiss, and
  later queued messages wait for that choice. The same applies when Sedes
  retires or restarts the Pi runtime before Pi used it. A message Pi already
  used stays with the stopped turn. (#12)

- A sidecar's `abandoned-work/` archive records only resources whose Stop,
  Restart, or Upgrade interrupted or abandoned work; idle resources no longer
  fill it. When full it removes its oldest records instead of ignoring new
  ones, logging `sidecar_abandonment_archive_rotated` once per sidecar run.
  Files other than its records are never removed. Sidecars apply this once
  upgraded to this version. (#12)

- Claude backends use Agent SDK 0.3.283 (was 0.3.274). Claude history now
  reads task notifications Claude received while running a tool, and other
  queued input, where Claude read them, as SDK 0.3.283 does; they stay inside
  their turn, so existing threads show the same turns. The Claude Code
  runtime policy is unchanged (2.1.281 or newer, tested through 2.1.283).
  Upgrade sidecars together with the server: the sidecar build changes and
  sidecar runtime protocol 14 now also carries the queued-input marker.

### Fixed

- Keep terminal output visible after a live theme switch. The terminal now
  recolors in place instead of reattaching, keeps explicit truecolor output,
  and its frame follows the light theme instead of staying dark.

- Serve deep links such as `/settings/backends` or a thread URL when the
  server's checkout or install path contains a dot-directory, such as
  `~/.local`. They previously failed with HTTP 500. Update the server.

- Restore rounded corners and borders that undefined styles had removed:
  Settings cards, fieldsets, and status blocks, workpads, context excerpts, and
  the stack group label. Environment and backend status colors follow the
  theme instead of fixed hex colors.

- Show Settings validation errors on the fields that need fixing, described in
  words instead of raw paths, and clear them when you move to another page or
  item. Review comment errors appear inside their dialog instead of behind it,
  the operation-error dialog has a title, and archive and terminal errors are
  shown as errors instead of grey text.

- Keep row and approval option menus from covering their own trigger or card,
  and keep sidebar filter pickers as wide as their trigger instead of spilling
  over the chat.

- Load Codex histories containing newer per-item timestamps or MCP display
  metadata without reporting an invalid protocol response. The fix also covers
  live MCP events; update the server and remote sidecars. (#18)


- Allow backends to start after removing a connection, while preserving removed
  connection records for historical threads. No database migration is required. (#18)

- Show repeated runtime notices with identical text and severity only once in
  the client, including notices restored after reconnecting. (#18)

- Refresh Native agent tools and CLI presentation settings when an idle
  Codex or Claude thread already has a persistent SSH session, including
  after the server reconnects. Provider release failures leave the saved
  policy unchanged; disabled or unavailable bound targets must be enabled or
  reconnected before Native/presentation edits. CLI access edits still apply
  live. (#15)

- Claude's note after a resized image read (`[Image: original …]`) no longer
  opens a running turn that exists only live and disappears on reload. Sedes
  now drops Claude's live meta rows, as history already did, and still shows
  the compaction summary. (#14)

- **Stop** on a Codex thread no longer silently loses a steering message Codex
  accepted but had not used, while showing it as delivered. A Codex steer now
  shows **Steering** until its message appears in history. If Codex's turn
  ends without it, it returns as a failed queue entry marked not sent, to
  restore to the composer or dismiss, and it is never resent. (#12, #13)

- A Claude **Steer** now resolves as soon as Claude takes it, usually when the
  tool call it is running finishes, instead of when the turn ends. The message
  appears at that point in the running turn, where it also appears after a
  reload, instead of after Claude's final answer. Steers Claude takes together
  appear in order. A remote Claude thread keeps that placement across
  reconnects; it takes effect once the sidecar runs this build, and the sidecar
  runtime protocol is unchanged. (#12, #13)

- Claude now refuses the first prompt after a session start less often.
  Claude Code merges Sedes' startup message into that prompt under its "NON-USER
  SOURCE" label. That message now carries a short session-start marker instead
  of no text, which Claude Code showed as "(no content)". Claude can still
  refuse that prompt, so resend it if it does. A remote Claude thread gets the
  marker once its sidecar runs this build. The sidecar runtime protocol is
  unchanged. (#12)

- Create Claude forks with one locked-down Claude Code launch. It loads no
  settings, hooks, MCP servers, or tools and denies any permission request.
  It no longer uses the thread's permission mode, so it cannot act for the
  child. A launch that starts a model turn is stopped and fails. Launch
  failures are classified: a refused launch creates nothing, and a
  deterministic failure is not offered as **Start a new fork**. (#12)

- Withhold Claude forking while background agents or commands still run in the
  source, with a reason on the fork action. A fork of an earlier turn whose
  background work had not finished is allowed; its child shows that the work
  was not carried over, instead of failing verification. Each turn Claude
  cannot fork at shows why, and generic **Fork** fails with that reason when
  it is the newest completed turn instead of forking an older one. (#12)

- Claude fork children inherit the source turns' usage and terminal results,
  and copy background task results only when the copied history shows them
  finished. Migration 117 records this child evidence. (#12)

- Count a resumed or forked Claude query's usage once. Claude Code 2.1.277 and
  newer continue such a query's totals from those its transcript saved, and
  Sedes counted the earlier turns again in session tokens, cost, and the Usage
  page. Each query is now counted from the totals its startup message reported,
  and a reattached query keeps that starting point. If the start was not
  observed, earlier work is left out and the usage is marked partial. Totals
  already recorded are not corrected. (#12)

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
  appear as a separate thread, as a Codex copy can. (#12)

- Scope **Force reset** to the thread it starts from and its unfinished forks.
  Resetting a fork no longer resets its source and sibling forks or stops the
  source's running turn. The preview names each affected thread with its run
  state and background work and totals the background agents and commands it
  may stop; a change in that work makes the preview stale. (#12)

- Release remote Claude queries that are no longer useful. A failed query is
  retired once its output is delivered, so reopening the thread no longer
  needs a backend restart. A query detached for 30 minutes with nothing
  outstanding is retired, and archiving a thread retires its query, first
  applying any output Sedes had not yet applied. Hitting
  the sidecar's 32-session limit reports the limit and how to free sessions.
  (#12)

- Read Claude history through the transcript's newest row. After a resume,
  history no longer stops at an earlier parallel tool call, forks from such
  threads verify, and reconciliation no longer compares against a truncated
  history that could resend a prompt Claude had already received. (#12)

- Reopen a Claude thread that was opened but never sent to. Sedes now resumes
  the existing session instead of failing with "Session ID … is already in
  use", and first-send recovery can resolve it. (#12)

- Stop showing Claude Code's "No response requested." resume placeholder as a
  reply. Reopening a Claude thread no longer adds a phantom turn or displaces a
  turn's final answer, and forks and usage ignore the placeholder. A prompt
  left unanswered because Claude Code exited now ends as interrupted with an
  explanation instead of completed. (#12)

- Keep earlier Claude turns visible after Claude automatically compacts a long
  conversation. **Conversation compacted** marks the point and expands to
  Claude's summary, which no longer appears as a new prompt. A turn Claude
  compacted mid-way keeps its prompt, settles with its result, and can be
  stopped, instead of staying running. Threads already compacted re-identify
  the former summary turn once. Only turns after the latest compaction can be
  forked, because Claude resumes from its summary. Sidecar replay cleanup
  reads only the conversation Claude resumes, and a sidecar stop or upgrade
  no longer fails because idle threads have long compacted histories. (#12)

- End a Claude turn left running after its Claude process was lost, for
  example when the server, worker, or sidecar stopped mid-turn. The next launch
  marks it interrupted with a notice; a reattached remote query that is still
  running is unaffected. A turn that stopped after a tool call or its result
  no longer reads as finished or offers a fork. **Stop** no longer stays
  "stopping" without a result: the turn ends a second after Claude reports
  idle, or after 30 seconds. (#12)

- Show turns Claude starts itself, such as after a background task or peer
  hand-back, as running with **Stop**, and keep idle retirement, eviction and
  sidecar replacement from ending them. Sedes now launches Claude with
  `CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS=1`. (#12)

- Accept a Claude input only on Claude's exact dequeue or consumption evidence,
  so output from a turn Claude started no longer claims a queued message or
  writes its receipt. Local Claude threads now enter running and settle, so a
  second message is accepted. (#12)

- Keep a conflicting Claude result from failing the thread; the first recorded
  outcome is kept. (#12)

- Distinguish, in sidecar abandonment records, a remote Claude session whose
  work had finished (its unacknowledged result is its outcome) from work the
  stop interrupted. An automatic sidecar replacement that ends Claude work
  started after its idle check now leaves an abandonment record. (#12)

- Warn, naming each task, when a resumed Claude session reports background
  work the previous session left unfinished; its result never arrived and
  Claude may run it again. (#12)

- Show background work before it is interrupted. Backend and environment
  Stop, Restart, and Upgrade previews list running turns, background work,
  pending approvals, and undelivered output that remote Claude reports,
  including for threads nobody has open. (#12)

- Stop a Claude message whose remote session ended unconfirmed from pausing
  the queue indefinitely. **Reconcile delivery** now marks it failed with an
  unknown outcome, so you can review the conversation and dismiss it or
  restore it to send again; later queued messages wait for that choice. (#12)

- Let a remote Claude turn run twice as long while main is away before its
  retained output overflows. The sidecar counts each retained event once and
  folds streamed text that no main has seen yet into fewer events. After a
  restart or reconnection, Sedes now opens threads whose remote Claude work is
  still running or undelivered, within the conversation-runtime budget, so
  their output is applied without waiting for someone to open them. (#12)

- Show a Claude task-notification turn as its own turn while it streams, as
  reload does. Existing threads re-identify those turns once on first load.
  (#12)

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
  crashed Claude process. (#12)

- Reopen a Claude session only after its previous Claude process has exited.
  Closing or failing a query no longer releases the session while the old
  process can still write its transcript. (#12)

- Recover a stale state or native-store lock whose PID was reused by an
  unrelated process. New lock records include the owner's process start time
  and boot identity on Linux and macOS; existing PID-only records keep the
  previous PID check. (#12)

- Remove superseded sidecar and Claude worker builds that no live process
  uses after a sidecar starts or installs a new worker, keeping recent builds
  for rollback. Persistent sidecar delivery diagnostics keep captures from
  only the four most recent earlier daemon PIDs. Diagnostics remain opt-in.

### Removed

- The `/agents`, `/agents/new`, and `/agents/<id>` addresses. They now open
  the workspace without a redirect; update bookmarks to `/settings/agents`.

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
