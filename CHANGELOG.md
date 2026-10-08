# Changelog

## [Unreleased]

### Breaking Changes

- Browser and packaged clients require client protocol 145, which adds
  automation schedule details and run turn outcomes to thread summaries and
  runs, drops the Remind now inventory action, and adds turn reply replay.
  Upgrade clients together with the server.
  ([#58](https://github.com/kcosr/sedes/pull/58), [#59](https://github.com/kcosr/sedes/pull/59), [#61](https://github.com/kcosr/sedes/pull/61), [#62](https://github.com/kcosr/sedes/pull/62))

- `PATCH /api/threads/:threadId/inventory` no longer accepts the `remind`
  action. ([#61](https://github.com/kcosr/sedes/pull/61))

- `POST /api/threads/:threadId/automation/runs/:runId/resolve` returns
  `{ run, automation }` instead of the run alone. Update scripts that read it.
  ([#58](https://github.com/kcosr/sedes/pull/58))

- Browser and packaged clients require client protocol 141, including thread
  workpad counts. Direct inputs accept up to 256 KiB of text and 2 MiB per JSON
  request; input origins use server registration shared by Android native voice
  and its WebView. Upgrade clients together with the server.
  ([#50](https://github.com/kcosr/sedes/pull/50), [#53](https://github.com/kcosr/sedes/pull/53), [#56](https://github.com/kcosr/sedes/pull/56))

- Android voice uses snapshot version 9, settings version 7, and dictation
  manifest version 2. Reconfigure voice and re-enter speech credentials after
  upgrading: previous per-connection preferences are not imported and their
  speech keys are removed. Finish or copy saved dictation first; older recordings
  remain on disk until discarded but cannot be resumed.
  ([#49](https://github.com/kcosr/sedes/pull/49), [#51](https://github.com/kcosr/sedes/pull/51), [#53](https://github.com/kcosr/sedes/pull/53), [#55](https://github.com/kcosr/sedes/pull/55))

- Self-hosted speech servers must advertise per-model `realtime` capabilities.
  Hosted recognition accepts only the supported base model IDs, excluding dated
  and custom IDs.
  ([#53](https://github.com/kcosr/sedes/pull/53))

- Database migrations 133–134 raise direct-input storage limits while preserving
  existing inputs and receipts. Back up the database before this one-way upgrade.
  ([#53](https://github.com/kcosr/sedes/pull/53))

- Notification scripts require payload version 4. Upgrade separately copied
  hooks with the server and review the migrated per-event Script/Voice settings.
  ([#45](https://github.com/kcosr/sedes/pull/45))

- Codex Speed is provider feature `codex.fast_mode@2`, which replaces the
  Fast mode enable/disable actions with `set_standard`, `set_fast`, and
  `set_ultrafast`. Clients that only know `codex.fast_mode@1` hide the control
  until they are upgraded.
  ([#44](https://github.com/kcosr/sedes/pull/44))

- The managed Codex TUI uses sidecar capability `codex_managed_tui@2`, which
  accepts the Ultrafast tier. Rebuild and upgrade execution sidecars with the
  server; an older sidecar is rejected at connection.
  ([#44](https://github.com/kcosr/sedes/pull/44))

- Browser and packaged clients require client protocol 136, which gives every
  Task a `backlog` field. Upgrade clients together with the server.
  ([#39](https://github.com/kcosr/sedes/pull/39))

- Agent tools `task.list@5`, `task.get@3`, `task.create@3`, and
  `task.update@3` replace their previous versions. Every returned Task carries
  `backlog` next to `pinned`; `task.list` accepts a `backlog` filter and
  includes backlog Tasks when it is omitted; `task.create` and `task.update`
  accept `backlog`. Callers must describe these tools again; the previous
  versions and earlier `task.list` cursors are rejected.
  ([#39](https://github.com/kcosr/sedes/pull/39))

- Completing a Task now unpins it and takes it out of the backlog, and a
  completed Task can't be pinned or put in the backlog: such a request is
  rejected as a bad request. The upgrade unpins Tasks that are already
  completed.
  ([#39](https://github.com/kcosr/sedes/pull/39))

- Codex persistent runtimes require protocol 3 to preserve settings updates
  that race a resume. Rebuild and upgrade execution sidecars with the server;
  older retained runtimes must be replaced before reattachment.
  ([#38](https://github.com/kcosr/sedes/pull/38))

- Browser and packaged clients require client protocol 135. Project summaries
  now include Task and Workpad counts. Upgrade clients together with the server.
  ([#34](https://github.com/kcosr/sedes/pull/34))

- Browser and packaged clients require client protocol 134, which scopes
  Tasks and Workpads to `global`, `project`, or `thread`, gives each Task an
  `associatedProjectId`, and reduces a transcript `task_context` part to the
  Task's display fields. Upgrade clients together with the server.
  ([#34](https://github.com/kcosr/sedes/pull/34))

- Agent tools `task.list@4`, `task.get@2`, `task.create@2`, `task.update@2`,
  `workpad.list@2`, `workpad.get@2`, `workpad.revisions@2`,
  `workpad.create@2`, `workpad.update@2`, `thread.archive@2`, and
  `workspace.open@3` replace their previous versions. Task and Workpad scopes
  take `{ kind: "project", projectId? }`, defaulting to the caller's project,
  instead of a workspace scope; `thread.archive` names its disposition
  `move_to_project`; `workspace.open` accepts an optional `projectId` to add a
  directory to an existing project, and restores a removed location only when
  the call names that location's project, authorized like reaching it.
  Callers must describe these tools again;
  the previous versions and earlier `task.list` cursors are rejected. An
  individual native MCP session retained across the upgrade, such as a
  sidecar-retained Claude query, keeps the old schemas until its runtime
  restarts.
  ([#34](https://github.com/kcosr/sedes/pull/34))

- The HTTP Task and Workpad APIs use the `project` scope instead of
  `workspace` (`{ kind: "project", projectId }`, and
  `scopeKind=project&projectId=…` for Workpad lists). Settle, archive, and
  bulk stack requests name the open-Task disposition `move_to_project`
  instead of `move_to_workspace`.
  ([#34](https://github.com/kcosr/sedes/pull/34))

- A Task update or move whose response was lost before the upgrade can't be
  replayed: retrying it with the same mutation ID reports that the ID was
  reused. Read the Task again and make a new request.
  ([#34](https://github.com/kcosr/sedes/pull/34))

- Browser and packaged clients require client protocol 133, which adds
  projects to the application snapshot and a `projectId` to every workspace.
  Upgrade clients together with the server.
  ([#33](https://github.com/kcosr/sedes/pull/33))

- Agent tools `workspace.open@2`, `workspace.list@5`, and `agent.context@3`
  replace their previous versions: `workspace.open` returns `projectId`,
  `workspace.list` adds each workspace's `project`, and `agent.context` adds
  `projectId`. Callers must describe these tools again; the previous versions
  and earlier `workspace.list` cursors are rejected. An individual native MCP
  session retained across the upgrade, such as a sidecar-retained Claude
  query, keeps the old schemas until its runtime restarts.
  ([#33](https://github.com/kcosr/sedes/pull/33))

- `GET /api/workspaces` is removed; use `GET /api/projects`, which lists every
  project with its locations, including removed ones.
  `POST /api/workspaces/open` requires a `project` assignment and returns the
  location's `projectId`.
  ([#33](https://github.com/kcosr/sedes/pull/33))

- Agents and Tool clients can no longer restore a removed project:
  `workspace.open` of a directory whose project was removed is a conflict.
  Restore the project in **Settings → Projects**. A removed location of an
  active project is restored only when the call names that project.
  ([#33](https://github.com/kcosr/sedes/pull/33),
  [#34](https://github.com/kcosr/sedes/pull/34))

- Claude now requires Claude Code 2.1.287 or newer and uses Agent SDK 0.3.287.
  Update Claude Code on every execution host. Rebuild local workers for
  `claude_runtime@3` and upgrade Claude sidecars for
  `claude_persistent_runtime@4`, which preserves skill command classification
  and the updated history behavior.
  ([#29](https://github.com/kcosr/sedes/pull/29))

- Browser and packaged clients require client protocol 132 for searchable
  skill aliases. Upgrade clients together with the server.
  ([#29](https://github.com/kcosr/sedes/pull/29))

- Codex uses the generated 0.160.0 app-server profile. Rebuild the server,
  execution sidecars, and Electron Local together; mismatched compiled Codex
  profiles are rejected. Codex app-servers and managed TUI commands now require
  0.160.0 or newer; upgrade them on each execution host.
  ([#27](https://github.com/kcosr/sedes/pull/27))

- Remote OpenCode requires a matching sidecar build with private OpenCode
  runtime capability major 2 and tool capabilities. Upgrade existing execution sidecars before
  connecting this backend. (#17)

- Browser and packaged clients now require client protocol 131 for the OpenCode
  v2 backend identity and terminal Stop diagnostics alongside runtime-only
  turn-throughput measurements and optional OpenCode path overrides. (#17, #20)

- Claude current context telemetry requires `query.context_usage`. Rebuild
  local workers and upgrade Claude sidecars with this server using the current
  capability versions listed above. (#24)

- Claude conversation Stop is bounded and recoverable. Rebuild local helpers
  and upgrade Claude sidecars with this server using the current capability
  versions listed above. Migration 119 closes old unconfirmed Stop receipts
  without sending a new cancellation. (#17)

- Browser and packaged clients must use client protocol 128, which adds
  reviewed Task snapshots to settle/archive previews and completion requests. (#19)

- Browser and packaged clients must use client protocol 127, which adds
  confirmed live background-work counts to sidebar thread summaries. (#16)

- Codex persistent runtimes require Codex runtime protocol 2 so tool-policy
  refreshes cannot reuse an older sidecar’s cached session configuration.
  Upgrade existing sidecars before reconnecting. No database migration or
  browser protocol change is required for this fix. (#15)

- Codex viewed images use a new `viewed_image` transcript item, introduced
  in client protocol 123. This build requires client protocol 135; see the
  client protocol entries above and below. (#11, #13, #14)

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

- Android: a speaker button in each ended turn's footer queues the turn's
  reply for voice playback, as completion speech would read it. It appears
  while voice is on. ([#62](https://github.com/kcosr/sedes/pull/62))

- Agent tool `client.replay_turn` (**Replay turn reply**, Client controls)
  does the same from an agent; `{}` repeats the agent's previous reply.
  Enable it per thread. ([#62](https://github.com/kcosr/sedes/pull/62))

- An **Automations** page lists every automation by status (Needs attention,
  Upcoming, Paused, Suspended) or by project, with search and row actions. Open
  it from **More** or **View all** on the sidebar's automation groups.
  ([#58](https://github.com/kcosr/sedes/pull/58))

- Each automation has its own page: its state with an action when it needs
  you, its definition, and its run history (the latest five, or all runs with
  **Problems** and **Skipped** filters and run details). A full-page editor
  creates and edits automations, and a new one can be saved and enabled in one
  step.
  ([#58](https://github.com/kcosr/sedes/pull/58))

- The automation API adds `GET …/automation/capability`, a run-history `filter`
  with counts, `resume` when resolving an uncertain run, and `after` for
  schedule previews. The CLI adds `runs --filter` and `resolve [--resume]`.
  Migration 135 adds run indexes.
  ([#58](https://github.com/kcosr/sedes/pull/58))

- Automation run history shows how each run's agent turn ended (Finished,
  Failed, or Interrupted), with its duration, **Go to turn**, and its usage
  when experimental usage is enabled; a run whose turn is still going reads
  **Running**. Runs in the API and CLI include their turn, and **Problems**
  includes failed turns. Migration 136 records turn outcomes and fills them in
  for existing runs.
  ([#59](https://github.com/kcosr/sedes/pull/59))

- Agent thread switches can request one recording on an exact thread while
  Android is in the background and native voice is already ready. The request
  waits for turn completion and reply playback without changing the screen,
  including when the app reopens.
  ([#57](https://github.com/kcosr/sedes/pull/57))

- Workpads show the thread's active count in the header and an icon in the
  sidebar. Toggle checklist boxes directly in saved documents; each change
  creates a revision, preserves drafts, and detects concurrent edits.
  ([#56](https://github.com/kcosr/sedes/pull/56))

- Android **Keep listening** records through pauses until Send, with an optional
  default for new recordings and a configurable limit of one hour by default. Interrupted
  dictation is saved encrypted for Retry, Send, Copy, or Discard; timed-out or
  interrupted recordings never submit silently.
  ([#53](https://github.com/kcosr/sedes/pull/53))

- Android voice can clean up Markdown before speaking, preserving link labels,
  code contents, and reading pauses. The device-local setting defaults to on.
  ([#51](https://github.com/kcosr/sedes/pull/51))

- Agent client controls manage basic voice settings, end interactions, and switch
  threads after reply playback, defaulting to the client that started the turn.
  ([#50](https://github.com/kcosr/sedes/pull/50))

- Task creation supports pinning in the add row and paste-many dialog.
  ([#50](https://github.com/kcosr/sedes/pull/50))

- Android native voice provides spoken notifications, manual and automatic
  recording, and background controls through OpenAI or a self-hosted
  [OpenAI-Compatible Speech Server](https://github.com/kcosr/openai-speech-server),
  with encrypted device credentials and model discovery. Script and Voice
  delivery are selected per event; Codex, Pi, and Claude support live progress
  announcements. Recording preserves composer drafts.
  ([#45](https://github.com/kcosr/sedes/pull/45), [#49](https://github.com/kcosr/sedes/pull/49))

- The Android voice card shows its thread, current state, and playback or
  recording controls, with thread navigation and quick Voice settings. Large
  controls remain usable on narrow screens.
  **Show voice bar when off** keeps the card available while voice is disabled.
  ([#48](https://github.com/kcosr/sedes/pull/48), [#53](https://github.com/kcosr/sedes/pull/53))

- Codex threads can use **Ultrafast** speed when the account's Codex model
  catalog offers it. When a model offers both Fast and Ultrafast, the
  composer's lightning button opens a **Speed** menu, and a rocket marks
  Ultrafast; a model with only Fast keeps the one-click toggle. Saved Agents
  offer every speed the model has. A new tier appears after the Codex daemon
  restarts. Migration 129 widens the stored service-tier values.
  ([#44](https://github.com/kcosr/sedes/pull/44))

- Opt-in Claude worker lifecycle diagnostics record process exits, cleanup and
  fencing reasons, probe failures, and affected session UUIDs to diagnose
  lost retained sessions across server restarts. (#41)

- Agents can delete completed Tasks at the expected revision with
  `task.delete` (`sedes_task_delete`). The tool description limits use to
  the user's request.
  ([#40](https://github.com/kcosr/sedes/pull/40))

- Tasks have a **Backlog**: open Tasks that aren't current work wait in a
  collapsed Backlog section between the open Tasks and Completed. Send a Task
  there, or take it out, from its ⋯ menu, with the B key, or with the Backlog
  switch in the edit dialog. Pin stays independent: a pinned backlog Task sits
  at the top of the Backlog section. View options › Only gains Backlog, and
  the Tasks header has a Pin button that shows only pinned Tasks. Task counts
  still include backlog Tasks.
  ([#39](https://github.com/kcosr/sedes/pull/39))

- **Settings → Projects** shows Task and Workpad counts for active and removed
  projects, including completed Tasks and archived Workpads. Removal dialogs
  and **Also remove project** show the project-owned saved work that will be
  hidden; thread-owned items are separate.
  ([#34](https://github.com/kcosr/sedes/pull/34))

- Projects can span several directories and environments. Each directory on
  one environment is a location of exactly one project, such as the same
  repository on this computer and on an SSH host. A project's name is
  editable and independent of its directories.
  ([#33](https://github.com/kcosr/sedes/pull/33))

- **Settings → Projects** lists each project with its locations. Rename a
  project, add a location, move a location to another or a new project, merge
  a project into another, and remove or restore a location or a whole
  project. Removing a project lists every blocker by location; restoring one
  lets you choose which removed locations to restore and reports each. A note
  lists names that several active projects share, with a **Merge** action.
  Merging deletes the merged project and can't be undone.
  ([#33](https://github.com/kcosr/sedes/pull/33))

- **Add project** asks which project a directory joins: a new project named
  after the folder, or an existing one described by the environments it is
  on. A directory that is already a location can be moved here or restored,
  and one whose project was removed can restore that project.
  ([#33](https://github.com/kcosr/sedes/pull/33))

- Find Claude skills by their safe native aliases in the skill picker,
  including directory names supplied for renamed skills. Selecting a match
  invokes the canonical skill.
  ([#29](https://github.com/kcosr/sedes/pull/29))

- Show Claude and OpenCode context occupancy in the composer and Session stats,
  and OpenCode transcript counters across the retained active branch. These
  work with experimental usage accounting disabled. Unavailable or invalidated
  context estimates remain unknown until fresh provider evidence arrives. (#24)

- **View options** for each Tasks view: sort by **Pinned, then newest**,
  **Recently updated**, or **Title**; show **Open** or **Completed** Tasks;
  show only pinned Tasks, Tasks with notes, or Tasks with files; group All by
  project; include thread Tasks in Project; and search notes. Each view
  remembers its own options on the device. Options that hide Tasks show as
  removable chips under the scope control, and the header then counts the
  Tasks shown, such as "1 of 3".

- Ctrl+Shift+L (Command+Shift+L on macOS) opens and closes Tasks in a
  thread. Inside Tasks, N adds, `/` searches, and the arrow keys move between
  Tasks; on a Task, Enter expands it, Space completes it, E edits, P pins, M
  moves, Delete deletes, and Ctrl/Command+Enter adds it to the prompt.
  **Keyboard shortcuts** in the Tasks menu lists them.

- Pasting several lines into the Tasks add row creates one Task per line, up
  to 50, after a confirmation that previews them. List bullets, numbers, and
  checkboxes are removed.

- **Open task** on a Task card in the transcript opens Tasks and expands the
  live Task, switching to a view that contains it.

- OpenCode v2 can run on Linux execution hosts locally, through SSH, or through
  outbound HTTP(S) sidecars, using the same owned/external runtime and tools.
  Remote Disconnect preserves native work; external backend Stop retires only
  Sedes's attachment. Add host-local `sedes opencode-owner` inspection and exact
  recovery commands for retained native-store ownership fences. (#17)

- Add stock OpenCode v2 2.0.18 with an owned resident `opencode2` daemon or an
  existing authenticated local server on Linux. Supports native history,
  Send, Steer, Queue, Stop, model selection, saved Agents, native
  approvals/forms, staged files/images, viewed images, skills and manual compact.
  Native Progressive tools use a bundled per-call MCP bridge; owned roots can
  use CLI tools and scoped execution variables. Reconnect never automatically
  resends an uncertain input. (#17)

- Escape in Settings goes up one level, like the **‹** links: from an editor
  to its item, from an item to its list, and from a page to the Settings list
  or the workspace. An open dialog, menu, or picker closes first, a text field
  only loses focus, and unsaved edits still ask before they are discarded. (#21)

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

- Ctrl+Shift+F (Command+Shift+F) focuses and selects sidebar search instead
  of opening Find in thread, which keeps Ctrl+F. Scope **Clear** also clears
  sidebar search.

- Client-control agent tools report the client's rejection reason instead of
  a generic message. ([#62](https://github.com/kcosr/sedes/pull/62))

- **Park** replaces Settle: a parked thread leaves the working set until new
  input returns it to Active, including an automation run, so parking an
  automated thread hides it until the automation next runs. The API and agent
  tools still report the state as `settled`. ([#61](https://github.com/kcosr/sedes/pull/61))

- The automation page and editor replace the automation dialog, and
  `/threads/<id>/automation` links open the page.
  ([#58](https://github.com/kcosr/sedes/pull/58))

- Automation states look the same in the sidebar, header, menus, and pages:
  one icon, a muted pause for paused automations, red for a failed run, and
  amber for an unknown outcome. Run history says **Delivered** (the agent
  received the prompt) instead of "completed".
  ([#58](https://github.com/kcosr/sedes/pull/58))

- A fork run's result thread is titled with the run time, such as
  "Nightly review · Oct 6, 3:15 AM".
  ([#58](https://github.com/kcosr/sedes/pull/58))

- Android voice preferences and speech credentials persist across connection
  switches and deletion. Thread selections and saved input remain specific to
  each server and account.
  ([#55](https://github.com/kcosr/sedes/pull/55))

- Android saved dictation offers grouped **Copy text**, **Discard**, **Send**,
  and **Add to composer** controls. Adding text opens the original thread and
  preserves its draft and the recording without sending. Interrupted recordings
  show a short status and can be sent without an extra checkbox; unfinished
  transcription offers **Retry**.
  ([#55](https://github.com/kcosr/sedes/pull/55))

- Voice settings offer searchable models, voices, and threads, with separate
  default recording targets and playback filters. The voice card can choose a
  current or next target without changing the default; headset and notification
  Start use the saved default, while automatic replies keep their source thread.
  ([#49](https://github.com/kcosr/sedes/pull/49), [#53](https://github.com/kcosr/sedes/pull/53))

- Mobile Prompts supports search, and voice thread pickers open without raising
  the keyboard.
  ([#53](https://github.com/kcosr/sedes/pull/53))

- Workpads shares the Tasks and Files panel layout, with header search and view
  options, scope navigation, row actions, and one editing and revision toolbar.
  Thread and Project views follow the active thread; Global retains its selection.
  Scope changes protect unsaved drafts and preserve the panel layout.
  ([#52](https://github.com/kcosr/sedes/pull/52))

- `thread.status@3` and `thread.list@6` expose read-only thread pin state.
  ([#50](https://github.com/kcosr/sedes/pull/50))

- Android HTTPS and secure WebSocket connections now trust user- and
  MDM-installed certificate authorities, including for authenticated Sedes
  traffic. Certificate and hostname checks remain enabled.
  ([#45](https://github.com/kcosr/sedes/pull/45))

- Codex Fast mode is now called **Speed** in the composer, docs, and saved
  Agent settings. Changing to a model that doesn't offer the selected speed
  returns the thread to Standard, as does reconnecting after the account's
  catalog stops offering it; Ultrafast never steps down to Fast. A managed
  TUI won't start or keep running with a speed the model no longer offers.
  ([#44](https://github.com/kcosr/sedes/pull/44))

- Tasks View options no longer have a Show group: Completed is always the
  collapsed section at the end of the list. Sorting orders Tasks within each
  section, with pinned Tasks always first, so "Pinned, then newest" is now
  Newest.
  ([#39](https://github.com/kcosr/sedes/pull/39))

- Rows in the Tasks list that show a scope or location line are taller, and on
  phones their notes, files, and pin indicators move to that line so the title
  gets the full width.
  ([#39](https://github.com/kcosr/sedes/pull/39))

- Side panels keep one size in every thread. Resizing Files, Workpads, Tasks,
  or Terminals resizes it in every thread's layout, and opening, collapsing,
  or closing another panel leaves its width alone; Chat takes the remaining
  space. Panels tabbed together or split against each other keep their
  per-thread size. Layouts saved before the upgrade keep their sizes until you
  open, dock, or resize the panel.
  ([#37](https://github.com/kcosr/sedes/pull/37))

- Workpads has its own button in the thread workbench bar, beside **Tasks**,
  and behaves like it: select it to open, show, or close Workpads. Tasks and
  Workpads no longer appear in the **Panels** menu or among the open-panel
  shortcuts; the menu keeps Chat, Files, and Terminals.
  ([#37](https://github.com/kcosr/sedes/pull/37))

- The Tasks, Files, Workpads, and Terminals panel headers use the chat
  header's smaller action icons, with the same hit areas.
  ([#37](https://github.com/kcosr/sedes/pull/37))

- The docked Tasks header shows the thread environment's color, like the other
  panel headers.
  ([#37](https://github.com/kcosr/sedes/pull/37))

- Tasks and Workpads keep one place in every thread, so switching threads no
  longer swaps them. They are the outer columns, on the edges and in the order
  you last set by opening, closing, or docking either one; Chat, Files, and
  Terminals arrange inside them per thread, so a bottom Terminals panel spans
  only Chat and Files.
  ([#37](https://github.com/kcosr/sedes/pull/37))

- A project's Tasks and Workpads are shared by every location of the project,
  on every host. Tasks' **Project** view and Workpads' **Project** scope
  follow the current thread's project, adding a Task there never asks for a
  location, and destination pickers and All list each project once. A
  project's own Tasks and Workpads stay with it when a location moves or is
  removed, and merging carries them into the target. **Settings → Projects**
  shows each active project's Task count. Task file links still open against
  the thread you are viewing.
  ([#34](https://github.com/kcosr/sedes/pull/34))

- Agents reach a project's Tasks and Workpads from any environment that hosts
  one of the project's active locations. Under **Ask outside this
  environment**, a project hosted only elsewhere asks for approval; a Tool
  client needs one of the project's environments allowlisted. A project with
  no active location is outside every environment.
  ([#34](https://github.com/kcosr/sedes/pull/34))

- Visibility change: Project Tasks and Workpads created in a location that was
  later removed reappear while their project is active.
  ([#34](https://github.com/kcosr/sedes/pull/34))

- Migration 127 moves location-scoped Tasks and Workpads to their projects,
  rewriting stored Workpad scopes and Task snapshots no provider has received;
  delivered snapshots stay byte-identical so provider history keeps verifying.
  It stops without changes if saved work refers to a location that no longer
  exists. The migration is one-way; back up the state directory, including
  `overlay.sqlite`, before upgrading.
  ([#34](https://github.com/kcosr/sedes/pull/34))

- Scope filters by project instead of by directory name and lists the projects
  with a location on the scoped environment. A saved project-name filter
  becomes a project filter when exactly one project matches; otherwise it is
  cleared.
  ([#33](https://github.com/kcosr/sedes/pull/33))

- The Projects view, project stacks, and Archived group threads by project.
  Rows of a project with several locations are tagged with what tells their
  location apart, and cards, thread headers, and pickers name the project and,
  where needed, the folder or location ("Project · Location"). Usage's
  per-directory dimension and the Tool client default are labelled Location.
  ([#33](https://github.com/kcosr/sedes/pull/33))

- **New thread** asks for a Project, then a Location, then a Target on that
  location's environment, prefilled from Scope.
  ([#33](https://github.com/kcosr/sedes/pull/33))

- Migration 126 groups existing directories into projects by display name:
  same-named directories form one project when each environment has at most
  one active directory of that name, and separate projects otherwise. Removed
  directories join only when unambiguous. The migration is one-way; back up
  the state directory, including `overlay.sqlite`, before upgrading, then
  review **Settings → Projects** and merge separate checkouts of the same work.
  ([#33](https://github.com/kcosr/sedes/pull/33))

- Raise the per-account backend limit from 32 to 64. ([#32](https://github.com/kcosr/sedes/pull/32))

- Claude imports and sessions whose saved permission mode is no longer
  allowed launch with an explicit allowed mode, preferring `default`.
  Native defaults cannot silently broaden the initial permission mode.
  ([#29](https://github.com/kcosr/sedes/pull/29))

- **Archived** follows the sidebar's Scope and shares its search, with a status
  line showing the match count, Scope, search, and **Clear scope**. View options
  sort by Recently archived, Last active, or Title and group by Date, Project,
  or None. Rows show the backend, a two-line title, location details, and the
  archive age, with an always-visible Restore button that reports progress and
  failures inline. The list shows 100 threads at a time with **Show more**.
  ([#28](https://github.com/kcosr/sedes/pull/28))

- Qualify Codex 0.160.0 and preserve the managed TUI inline transcript despite
  the upstream fullscreen default. ([#27](https://github.com/kcosr/sedes/pull/27))

- In a thread, Tasks docks beside Chat as a workspace panel instead of a
  floating card, and resizes, collapses, docks on another edge, and closes
  like Files and Workpads. Phones keep a bottom sheet. The card's pin is
  gone. Docked Tasks opens at about a third of the stage, and its button keeps
  an outline while Tasks is collapsed, by hand or to make room for another
  panel.

- One scope control, **Thread**, **Project**, **Global**, and **All**,
  replaces the old view switcher and its project and thread picker. Each view
  shows its open count and follows the current chat, and a view that does not
  apply says why. **All** lists every Task, grouped by project with each
  thread's Tasks under its project, and replaces **Include nested scopes**.

- Tasks are added from a separate add row instead of **Search or add task**.
  Enter adds the Task and keeps focus for the next one, and Shift+Enter opens a
  notes field. Search has its own button and never blocks adding.

- Task rows are compact: a completion circle, a one-line title, and quiet
  notes, file, and pin indicators. The whole row drags on desktop, without a
  grip. Completed Tasks are muted, struck through, and kept in a collapsed
  **Completed** section, most recently completed first; pinning no longer
  lifts them above open Tasks.

- Selecting a Task expands it in place, with its whole title, its notes,
  files, when and where it was added, and **Add to prompt**, **Edit**, and
  **Move to…**. Lists without group headings show where each Task belongs on
  a second line. **Edit** opens a dialog with labelled fields, **Belongs to**,
  Files, Pinned, and **Delete…**. On phones, a Task opens as a detail view in
  the sheet.

- Each Task row has a **⋯** menu with **Add to prompt**, **Edit…**, **Pin**,
  **Move to** (this thread, this project, Global, or a searchable choice), and
  **Delete…**, so touch and keyboard users can move a Task without the editor.

- Tasks in the composer are compact pills above the message box; a completed
  or deleted Task shows a muted or warning pill with a tooltip. The
  transcript's Task card shows a short notes preview and keeps the Task ID and
  revision under **Details**. The Tasks button shows a count of the thread's
  open Tasks.

- Stored Tasks preferences migrate on first load. Tasks starts closed after
  the upgrade, even if the card was open or pinned, and then opens on the view
  you last chose instead of a fixed default view. A Global default with nested
  scopes becomes All, nested scopes become Project's **Include thread tasks**,
  and content search becomes **Search notes**.

- OpenCode uses native execution-host defaults with optional Advanced path
  overrides. Multiple runtimes can share a database; ownership and recovery
  now track each scoped runtime independently. Provider connection runs after
  HTTP startup so Settings stays available during connection failures. (#17)

- Live Pi qualification uses the local AW Qwen model. OpenCode live
  qualification can explicitly send Qwen chat-template low-reasoning settings
  while retaining its read-only tools, token budget, and deadline. (#17)

- Stop uses the existing native conversation control independently of history
  loading, with a fixed 30-second deadline. Unconfirmed Stop requests no longer
  block the Queue indefinitely, and retrying one does not cancel newer work. (#17)

- Settings has a new navigation. On desktop the sidebar lists its pages in
  five groups while Settings is open, under **Back to chat** or **Back to
  workspace**, and `/settings` opens the last page viewed or **General**. On
  phones, or with the sidebar hidden, `/settings` is a grouped list with
  descriptions and each page has a **‹ Settings** link. The **Settings
  category** picker and **All settings** are gone. Every page shares one
  layout: one title size, switches for on/off settings, and a sticky save bar
  on forms. (#21)

- Environments and Backends show the list beside the selected item when the
  Settings content is at least 960px wide, and stack below that. Each
  environment, backend, editor, add step, and pending host has its own address
  under `/settings/environments/` or `/settings/backends/`, so links, browser
  Back, and Android Back reach it directly. An item has **Overview** (health
  first), **Backends** or **Connections**, and **Activity** tabs; editing
  happens beside the list; removal and pairing revocation are in a **Danger
  zone**; internal IDs appear only under **Activity**. Pending hosts are listed
  under **Awaiting approval** instead of **Review hosts**, and the backend
  defaults sit above the backend list. Projects uses the same page layout. (#21)

- Agents move to **Settings → Execution → Agents** (`/settings/agents`) with
  the same list and detail layout; **More → Agents** and **Create an Agent**
  open it there. (#21)

- Dialogs share one design: fixed sizes, a pinned title and actions with the
  primary action last, errors shown inside the dialog, and no backdrop blur.
  Confirmations are one small dialog without a close button, and only
  irreversible actions use a solid red button, so **Archive** is neutral.
  Unsaved-changes prompts share one dialog with **Keep editing**. On touch
  screens and narrow windows, medium and larger dialogs and long menus open as
  bottom sheets with 44px rows, while confirmations stay centered. Deleting an
  automation now confirms in the app instead of the browser. (#21)

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
  **Thread actions** starts with the thread's settings, such as the model and
  reasoning level, on every device, even though the composer also shows them. (#21)

- The workbench bar and panel headers grow with their text, so a title no
  longer crowds the top edge under Android text zoom. They are slightly taller
  (52px, or 54px on touch), and toolbar icons are larger (18px, or 20px on
  touch); the chat header's action icons are one step smaller. The chat
  header's title and project rows are evenly balanced beside the worktree
  picker, the phone's expandable Search and worktree row is larger, and the
  sidebar separates a thread's details from its Group label. (#21)

- The composer's buttons and model and reasoning selectors are larger. When
  the composer's controls do not fit, for example during a turn in a narrow
  window, the reasoning selector steps aside and returns when there is room;
  it is always available in **Thread actions**. (#21)

- Opening a thread on a touch tablet, or by touch or pen on a hybrid device, no
  longer focuses the composer and raises the on-screen keyboard. Mouse and
  keyboard use on desktop still focus it. (#21)

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

- Claude history reads task notifications Claude received while running a
  tool, and other queued input, where Claude read them; they stay inside
  their turn, so existing threads show the same turns.
  Upgrade sidecars together with the server: the sidecar build changes and
  sidecar runtime protocol 14 now also carries the queued-input marker.

### Fixed

- A failed automation run, or one with an unknown outcome, returns its parked
  thread to Active. ([#61](https://github.com/kcosr/sedes/pull/61))

- The sidebar's State view lists snoozed and parked automated threads under
  Snoozed and Parked instead of Scheduled. ([#61](https://github.com/kcosr/sedes/pull/61))

- An automation whose last run's outcome is unknown shows as needing
  attention instead of looking active or paused.
  ([#58](https://github.com/kcosr/sedes/pull/58))

- Automation notices in a thread no longer break mid-word on phones.
  ([#58](https://github.com/kcosr/sedes/pull/58))

- Sidebar Projects-view titles stay readable next to a long location tag.
  ([#58](https://github.com/kcosr/sedes/pull/58))

- Force-resetting a thread forked by an automation run ends that run.
  ([#59](https://github.com/kcosr/sedes/pull/59))

- The Automations list shows a run whose turn is still going as **Running**,
  as the automation page does, instead of "Delivered".
  ([#60](https://github.com/kcosr/sedes/pull/60))

- Sidebar Tasks icons match the header button.
  ([#56](https://github.com/kcosr/sedes/pull/56))

- Preferred Android microphones reconnect despite device ID changes, and the
  picker refreshes when devices change. Missing or ambiguous selections never
  silently switch microphones; Bluetooth routing supports paired endpoints with
  different names.
  ([#55](https://github.com/kcosr/sedes/pull/55))

- Android voice shows **Default thread needed** when the playback filter
  requires a thread that the current connection has not selected.
  ([#55](https://github.com/kcosr/sedes/pull/55))

- Windows desktop upgrades handle long temporary paths while removing older
  full installations, including upgrades to client-only builds, instead of
  misleadingly reporting that Sedes cannot be closed.
  Retained Start Menu and desktop shortcuts are refreshed against the new
  executable, and the installer launches it directly after completing setup.
  ([#54](https://github.com/kcosr/sedes/pull/54))

- macOS desktop packages include the local-network permission description.
  ([#53](https://github.com/kcosr/sedes/pull/53))

- Database upgrades preserve the deployed migration 133 checksum and correct
  input admission checks without changing stored messages or receipts.
  ([#53](https://github.com/kcosr/sedes/pull/53))

- Voice submissions show their full text immediately, honor **Seek on send**,
  and preserve the typed draft. Failed or unsent inputs larger than the composer's
  64 KiB limit offer **Copy full text**.
  ([#46](https://github.com/kcosr/sedes/pull/46), [#53](https://github.com/kcosr/sedes/pull/53))

- Agent tool groups scroll horizontally on narrow screens, keeping the rightmost
  groups reachable by touch.
  ([#50](https://github.com/kcosr/sedes/pull/50))

- Android voice startup and Resume recover the current activity and thread
  context after configuration changes and immediately show a pending service
  start. Silent recordings end locally without submitting audio for transcription.
  ([#49](https://github.com/kcosr/sedes/pull/49), [#53](https://github.com/kcosr/sedes/pull/53))

- Android voice retries empty transcripts and handles audio-focus interruptions
  without spurious errors or loss of recognized text. Stop and Off cancel pending
  retries; failure to acquire audio focus remains an error.
  ([#47](https://github.com/kcosr/sedes/pull/47))

- Claude availability probes wait for complete process output, avoiding
  intermittent false unavailable errors.
  ([#45](https://github.com/kcosr/sedes/pull/45))

- Electron managed Local accepts the server's versioned health response.
  ([#45](https://github.com/kcosr/sedes/pull/45))

- Changing a thread setting right after Codex confirmed a Fast mode change
  no longer fails with "The Codex thread or settings changed in another
  client." Backend-confirmed settings revisions now reach open clients.
  ([#44](https://github.com/kcosr/sedes/pull/44))

- Forking a Codex thread with Fast selected no longer fails before the fork
  is created.
  ([#44](https://github.com/kcosr/sedes/pull/44))

- Deleting or restoring queued inputs no longer causes an unnecessary thread
  reconnect when the HTTP response arrives before older stream updates,
  keeping subsequent queue controls responsive.
  ([#43](https://github.com/kcosr/sedes/pull/43))

- Claude worker cleanup now accepts process groups containing only exited
  processes, avoiding shared-worker shutdowns that disconnect unrelated
  conversations. Rebuild and upgrade local workers and remote sidecars. (#42)

- A Task added while the Pinned filter is on is created pinned instead of
  disappearing, and opening a Task that a filter hides no longer turns the
  filter off.
  ([#39](https://github.com/kcosr/sedes/pull/39))

- Attached Tasks are stored in a fixed attachment format instead of the live
  Task shape, so changing Task fields can't make stored or signed message
  attachments unreadable.
  ([#39](https://github.com/kcosr/sedes/pull/39))

- Codex threads retain their saved security policy when a restart or upgrade
  replaces the UDS connection to a persistent app-server. Newer settings
  notifications also survive an in-flight resume response. Idle threads whose
  saved policy is no longer allowed open as history only until an allowed policy
  is selected, without starting a native session.
  ([#38](https://github.com/kcosr/sedes/pull/38))

- Slower conversation snapshots no longer overwrite newer completion attention,
  which could leave an unread dot stuck or restore it after acknowledgment.
  ([#36](https://github.com/kcosr/sedes/pull/36))

- Tool client default-location errors and location-removal guards now use
  accurate location terminology while preserving project-level diagnostics.
  ([#34](https://github.com/kcosr/sedes/pull/34))

- Archived thread messages now load through passive history readers in the
  browser and agent tools, without resuming an agent or issuing tool credentials.
  Older pages and turn lookups remain available; restoring a thread permits
  normal execution again. Backend read failures report safe, actionable tool
  errors instead of a generic internal error. Unreadable native history still
  leaves archived thread details available, and retryable history failures
  acquire a fresh reader on the next attempt. Open viewers receive restored
  inventory even when the provider cannot reconnect.
  ([#35](https://github.com/kcosr/sedes/pull/35))

- Removing a project or location while terminal work blocked it could return
  an internal server error. Terminal conflicts now return their own error from
  every route.
  ([#33](https://github.com/kcosr/sedes/pull/33))

- A Tool client whose default location was removed now shows **needs
  attention** and refuses requests that use that default, instead of treating
  the removed location as available.
  ([#33](https://github.com/kcosr/sedes/pull/33))

- **New thread** on the welcome page now follows the sidebar's current Scope
  rather than raw saved preferences, so a stale filter no longer narrows its
  choices.
  ([#33](https://github.com/kcosr/sedes/pull/33))

- Reopening a dialog while it closes now keeps the new opening visible and
  focused. Closing dialog surfaces let clicks through, including when quickly
  reopening the file editor's conflict dialog.
  ([#30](https://github.com/kcosr/sedes/pull/30))

- Claude history retains eligible external-origin messages and chooses queued
  inputs using native delivery evidence, matching the updated SDK while
  keeping internal startup markers hidden.
  ([#29](https://github.com/kcosr/sedes/pull/29))

- Searching **Archived** no longer lists non-matching fork parents, and the
  page no longer re-renders for unrelated application events, which made large
  archives slow to use. Thread menus mount their dialogs only when first
  opened, the sidebar no longer builds lineage for archived threads, and
  events that change nothing no longer re-render the app.
  ([#28](https://github.com/kcosr/sedes/pull/28))

- Linux x64 server and full Electron packages retain only the compatible
  msgpackr N-API addon, removing bundled musl and Node 20 ABI variants that
  caused server archive dependency checks to fail. Glibc arm64 packages omit
  msgpackr's musl-only optional addon and use its JavaScript implementation.
  ([#27](https://github.com/kcosr/sedes/pull/27))

- Accept Codex 0.160.0 settings, image references, errors, and account metadata.
  Populate existing item timestamps in live and reloaded history, and retain
  meaningful interrupted-turn errors without changing normal Stop behavior.
  ([#27](https://github.com/kcosr/sedes/pull/27))

- Saving agent tools on an existing idle thread now refreshes the saved policy
  in open clients after runtime retirement. Subsequent edits no longer report
  a false conflict because the client still holds the previous policy revision.
  ([#26](https://github.com/kcosr/sedes/pull/26))

- Archive progress now offers **Dismiss** throughout. Closing progress keeps
  the archive workflow running, including required choices, and reports failures
  that arrive after dismissal or navigation. Pending archives are shared across
  entry points; choosing Archive again reopens progress for the existing request.
  ([#25](https://github.com/kcosr/sedes/pull/25))

- With reduced motion turned on, the composer shrinks back after its text is
  cleared or Chat is collapsed and restored. Before, it stayed at its tallest
  height, up to 220px of empty text area.

- Sending an OpenCode message no longer flashes a disconnected warning while
  its native queue and history catch up. Actual connection loss and uncertain
  unfinished work still require recovery.

- Opening the Task editor no longer collapses the Task list to nothing or
  scrolls the Tasks header away; the editor is a dialog with the list visible
  behind it.

- Task edits are no longer lost silently on Escape, selecting another row,
  switching view, searching, or Android Back. Closing the editor with unsaved
  changes asks first.

- Saving or completing one Task no longer disables every control in Tasks or
  drops keyboard focus. Only that Task's action waits, so you can keep adding
  Tasks and working on other rows.

- While a Task is dragged over the chat, the **Move task to** zone stops above
  the composer, so the composer's **Add task to prompt** target stays visible.

- Workspace panels no longer squeeze below their minimum widths when several
  are open: Chat keeps 360px, Tasks 300px, and Files and Workpads 320px while
  there is room. A panel opened or restored where the visible panels no longer
  fit collapses the least recently used side panels instead, with an
  announcement.

- **New group…** now leads the **Move to group** picker, under the search,
  instead of sitting below every group.

- OpenCode's bundled MCP helper now launches through both the generated Sedes
  CLI and the sidecar entry point. (#17)

- Keep terminal output visible after a live theme switch. The terminal now
  recolors in place instead of reattaching, keeps explicit truecolor output,
  and its frame follows the light theme instead of staying dark. (#21)

- Serve deep links such as `/settings/backends` or a thread URL when the
  server's checkout or install path contains a dot-directory, such as
  `~/.local`. They previously failed with HTTP 500. Update the server. (#21)

- Restore rounded corners and borders that undefined styles had removed:
  Settings cards, fieldsets, and status blocks, workpads, context excerpts, and
  the stack group label. Environment and backend status colors follow the
  theme instead of fixed hex colors. (#21)

- Show Settings validation errors on the fields that need fixing, described in
  words instead of raw paths, and clear them when you move to another page or
  item. Review comment errors appear inside their dialog instead of behind it,
  the operation-error dialog has a title, and archive and terminal errors are
  shown as errors instead of grey text. (#21)

- Keep row and approval option menus from covering their own trigger or card,
  and keep sidebar filter pickers as wide as their trigger instead of spilling
  over the chat. (#21)

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

- The Ctrl+Shift+Arrow (Command+Shift+Arrow) panel docking shortcut; dock from
  the panel menu. Ctrl+Shift+Up/Down now always moves between sidebar threads.
  ([#63](https://github.com/kcosr/sedes/pull/63))

- **Remind now** is gone; pin the thread and add a task instead. Snooze keeps
  its optional reminder. ([#61](https://github.com/kcosr/sedes/pull/61))

- Tasks on Home and Archived, including their corner Tasks button. Tasks now
  appears only beside a thread. To see Global Tasks, open any thread and
  choose **Global** in Tasks. (#31)

- The `/agents`, `/agents/new`, and `/agents/<id>` addresses. They now open
  the workspace without a redirect; update bookmarks to `/settings/agents`. (#21)

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
