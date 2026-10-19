# Changelog

User-facing changes are collected here before release. See the
[release process](docs/developer/release-process.md) for version policy and checks.

## [Unreleased]

### Breaking Changes

- Upgrade server and browser/packaged clients together for client protocol
  **167**. Sedes tool policies replace cross-boundary approval modes with
  independent project/environment limits: queries filter to scope and direct
  outside requests are denied. Legacy thread-only policies are disabled for
  review rather than broadened. Saved Agent and thread-create tool contracts
  advance to version 6. See [tool policy sets](docs/user/tool-policies.md).
  ([#96](https://github.com/kcosr/sedes/pull/96))

- Upgrade OpenCode execution sidecars with the server for private OpenCode
  runtime protocol **3**, which reports the observed native version. See
  [OpenCode setup](docs/operator/backends/opencode.md).
  ([#93](https://github.com/kcosr/sedes/pull/93))

- Automation management now uses explicit automation IDs and the
  `/api/automations` collection. Update automation agent-tool versions and
  operator scripts; create/run-now requests require stable mutation keys.
  The operator CLI attaches to existing threads. See the
  [automation CLI](docs/operator/automation-cli.md).
  ([#88](https://github.com/kcosr/sedes/pull/88))

- Upgrade Codex execution sidecars with the server for Codex runtime protocol
  **4**, which clears retained attach metadata after native archive changes.
  See [Codex archival](docs/operator/backends/codex.md#archiving-conversations).
  ([#85](https://github.com/kcosr/sedes/pull/85))

- Client protocol **167** also includes dismissible runtime notices, Page
  responses, HTML page downloads and shared download metadata,
  larger composer reference lists, the updated
  native voice bridge, Windows notification script paths, multiple named
  automations per thread, dismissal of automation results, and removal of
  unused global inventory totals and bulk Park task confirmation fields.
  Rebuild Android
  and Electron with their bundled clients. See
  [Page responses](docs/user/html-previews.md#send-a-page-response),
  [voice input](docs/operator/clients/voice.md), and
  [notification scripts](docs/operator/configuration.md#notification-scripts).
  ([#81](https://github.com/kcosr/sedes/pull/81), [#83](https://github.com/kcosr/sedes/pull/83), [#87](https://github.com/kcosr/sedes/pull/87), [#88](https://github.com/kcosr/sedes/pull/88), [#92](https://github.com/kcosr/sedes/pull/92), [#95](https://github.com/kcosr/sedes/pull/95))

### Added

- Dismiss runtime warning banners, including Codex MCP failures and Claude
  usage warnings. Repeated notices with identical text and severity retain one
  copy per thread; a new occurrence after dismissal can appear again. See
  [thread warnings](docs/user/provider-features.md#check-provider-accounts-and-warnings).
  ([#98](https://github.com/kcosr/sedes/pull/98))

- Mobile and touch inline **Fork from here** asks for confirmation before creating a
  thread. See [forking](docs/user/conversations.md#fork-from-a-completed-turn).
  ([#98](https://github.com/kcosr/sedes/pull/98))

- Reuse named Sedes tool policy sets across backends, with Account → Environment
  → Backend → Agent → Thread defaults and template selections. Apply a set to
  an existing thread and customize it before saving. Threads show the current
  named set or Custom; presentation edits retain the association. New threads,
  forks and same-settings copies retain independent policy snapshots.
  ([#96](https://github.com/kcosr/sedes/pull/96))

- Download the selected saved HTML page revision from the expanded viewer or
  Pages library on web, desktop, and Android. Images are embedded in one UTF-8
  HTML file; unsaved interaction state and Sedes host controls are excluded.
  See [page downloads](docs/user/html-previews.md#download-a-page).
  ([#92](https://github.com/kcosr/sedes/pull/92))

- Threads support multiple named recurring schedules and one-time reminders.
  Run on **This thread**, or **Fork** a fresh result each time, copying saved
  settings from drafts. Busy sources defer unsent work. Successful one-time
  reminders show no sidebar schedule icon and leave the collection once no
  result notice remains to dismiss, including after a later **Run now**; their
  conversations remain. A failed turn arriving after dismissal surfaces again;
  an interrupted turn, including **Stop**, is not a failure and shows a neutral
  notice. Existing automations migrate in place with their names, schedules,
  run history, and dismissed notices; on first start, one-time reminders that
  already succeeded with no notice left to dismiss leave the collection. A
  thread's **Automations** page lists only its own automations and links back
  to the thread; an automation's page names its thread and returns to wherever
  you opened it. See
  [automations](docs/user/tasks-and-automations.md#schedule-work-with-an-automation).
  ([#88](https://github.com/kcosr/sedes/pull/88))

- Published HTML pages can collect responses through Sedes's **Send** control.
  Responses go to the page's thread, queue while it is busy, and remain in
  compact single-row chat cards. Expand a card for the exact submitted text
  and saved page revision. See [Page responses](docs/user/html-previews.md#send-a-page-response).
  ([#83](https://github.com/kcosr/sedes/pull/83))

- While Android voice is listening on another thread, **Target this thread**
  switches the entire unsent recording to the viewed thread without restarting
  capture or changing queued replies. See
  [voice controls](docs/operator/clients/voice.md#targeting-and-controls).
  ([#82](https://github.com/kcosr/sedes/pull/82))

- Android voice combines speech with the current Chat draft when foreground on
  the recording's thread, including attachments and other context. Composer
  owns submission and recovery after accepting the speech, and keeps the sent
  message anchored as turn details arrive when Seek on Send is enabled. See
  [voice input](docs/operator/clients/voice.md).
  ([#81](https://github.com/kcosr/sedes/pull/81))

### Changed

- Parking threads keeps open Tasks attached without prompting for task handling,
  including stack parking. Archive task choices remain available. See
  [parking](docs/user/organize-work.md#park-quiet-work).
  ([#95](https://github.com/kcosr/sedes/pull/95))

- OpenCode accepts stable stock releases **2.0.29 or newer**, tested through
  **2.0.32**, with an updated SDK/schema profile and an active advisory for
  newer-than-tested runtimes. See [OpenCode compatibility](docs/operator/backends/opencode.md).
  ([#93](https://github.com/kcosr/sedes/pull/93))

- Archiving and restoring Codex threads also updates their native archive state
  by default, while preserving local archive controls when a backend is missing
  or offline. Existing archives require a manual sweep; set
  `SEDES_CODEX_ARCHIVE_SYNC=false` to disable future native archiving. See
  [Codex archival](docs/operator/backends/codex.md#archiving-conversations).
  ([#85](https://github.com/kcosr/sedes/pull/85))

- Composer prompts support up to 16 thread references and 16 Task references.
  Long reference lists scroll above the message box; the shared 256 KiB input
  budget still applies. See [thread references](docs/user/files-and-context.md#reference-another-thread)
  and [Task references](docs/user/tasks-and-automations.md#add-a-task-to-a-prompt).
  ([#83](https://github.com/kcosr/sedes/pull/83))

- Android playback **Stop** now releases the retained voice destination as well
  as clearing queued speech. The next recording honors an explicit choice or
  pinned default, then the viewed thread or normal fallback. See
  [voice controls](docs/operator/clients/voice.md#targeting-and-controls).
  ([#84](https://github.com/kcosr/sedes/pull/84))

- Android's idle voice bar uses **Target this thread** beside Start when its
  destination differs from the viewed thread or is missing, including pinned
  and explicit choices, without changing the saved default. Retained targets
  keep their release action, labelled **Release voice target** when no available
  thread is viewed; playback, headset, and notification Next are unchanged. See
  [voice controls](docs/operator/clients/voice.md#targeting-and-controls).
  ([#82](https://github.com/kcosr/sedes/pull/82), [#90](https://github.com/kcosr/sedes/pull/90))

- Chat draft text, speech, stashes, and restored queued input now use the same
  256 KiB UTF-8 limit. Text and materialized context share the existing input
  budget; attachment-file limits remain separate. Each thread can retain up to
  50 stashes and 8 MiB of serialized stash content; refusing another stash leaves
  the current draft intact. See [stashed prompts](docs/user/conversations.md#put-a-draft-aside-with-stashes).
  ([#81](https://github.com/kcosr/sedes/pull/81))

### Fixed

- The server no longer exits when a client resets a refused terminal or
  outbound-host WebSocket upgrade, when storage fails while a terminal records
  its history (only that terminal fails), or when a Codex TUI that missed its
  startup deadline cannot be closed. Upgrade requests for unknown paths now get
  a 404 and are closed instead of holding their connections open.

- Threads with very large snapshots no longer resend a full checkpoint, and
  eventually disconnect, when a small update follows a snapshot replacement
  on a slow connection. Inventory streams no longer close in the same case.

- Android voice holds queued playback while foreground dictation is saved and
  submitted through the composer, so a newly accepted message suppresses the
  older reply on that thread before it starts speaking. See
  [voice input](docs/operator/clients/voice.md).
  ([#97](https://github.com/kcosr/sedes/pull/97))

- Restore supported OpenCode reasoning-effort choices after native model
  catalog validation. See [OpenCode settings](docs/operator/backends/opencode.md#conversations-and-settings).
  ([#94](https://github.com/kcosr/sedes/pull/94))

- OpenCode pending forms stay visible during concurrent history refreshes, and
  answered forms cannot reappear from an older interaction read.
  ([#93](https://github.com/kcosr/sedes/pull/93))

- Codex 0.163.0 no longer disconnects discovery, history reads, or turn
  completion when native read-state metadata arrives. The generated protocol
  is refreshed while retaining Codex 0.162.1 as the runtime minimum; native
  read/unread controls remain unsupported. See
  [Codex compatibility](docs/operator/backends/codex.md#version-compatibility).
  ([#91](https://github.com/kcosr/sedes/pull/91))

- Codex threads keep model, reasoning, Speed, and permissions editable between
  runs while automations remain enabled. Same-thread automation uses current
  thread settings; active-work and recovery safeguards remain in place. See
  [Codex settings](docs/user/provider-features.md#speed).
  ([#90](https://github.com/kcosr/sedes/pull/90))

- Sidebar cards no longer repeat the same scheduled run or snooze wake time on
  both lines, or add a draft label beside the existing draft icon. Distinct
  deadlines and status context remain visible.
  ([#89](https://github.com/kcosr/sedes/pull/89))

- Codex advisory metadata no longer forces conversation history reloads.
  Completion replay and already-active inventory wakes avoid unchanged
  publications, and thread-summary reads reuse prepared SQL statements.
  ([#89](https://github.com/kcosr/sedes/pull/89))

- Automation delivery reconciles saved acceptance despite UI publication
  failures or dispatch timing races. Stopping a turn preserves its Interrupted
  history without leaving the automation in flight or resending its input.
  ([#88](https://github.com/kcosr/sedes/pull/88))

- Automation pages share aligned headings, readable schedule descriptions,
  distinct Finished icons, and compact phone save controls. Removed reminders
  keep their name when known, and navigation avoids repeating the same thread
  or destination. ([#88](https://github.com/kcosr/sedes/pull/88))

- macOS preview packages ad hoc sign Sedes and its helpers with their bundle
  identities, fixing Local Network connections that failed when launched from
  Finder. Package verification rejects mismatched or incomplete signatures.
  ([#86](https://github.com/kcosr/sedes/pull/86))

- Native Windows Codex executable discovery, linked-worktree discovery, and
  workspace search results use the execution host's path conventions. Windows
  downloads and file links also reject final symbolic links consistently.
  Windows outbound Files admit nested roots and discover viewed images using
  native containment checks while rejecting paths outside the allowed roots.
  Native process and file helpers use built-in Windows PowerShell modules even
  when launched from PowerShell 7.
  Rebuild the server, Windows execution sidecars, or Electron Managed Local
  where these operations run; upgrade retained sidecars when their work can
  safely be stopped. See [native host validation](docs/operator/outbound-hosts.md#native-support-and-validation-limits).
  ([#87](https://github.com/kcosr/sedes/pull/87))

- Windows source checkouts preserve required generated-file line endings, and
  browser-test servers close gracefully through IPC before forced cleanup.
  Full Electron verification releases its native PTY probe after success or
  failure and requests graceful Windows server shutdown through parent IPC.
  See [native Windows verification](docs/developer/development.md#native-windows).
  ([#87](https://github.com/kcosr/sedes/pull/87))

- Windows terminals release owned PTY resources after shell exit without
  repeated cleanup calls and report cleanup failures in their exit status.
  Windows terminal journals recover incomplete trailing writes without a
  read-only file-flush failure. Notification scripts accept native Windows
  executable paths and clean up their owned descendants on exit or timeout.
  Rebuild the Windows server or execution sidecar before its next safe restart.
  ([#87](https://github.com/kcosr/sedes/pull/87))

- Sending an inline Page response exits preview interaction mode and returns
  focus to the chat controls.
  ([#85](https://github.com/kcosr/sedes/pull/85))

- Old threads can be archived when their backend is no longer registered.
  Unavailable saved conversations no longer appear active to archive and bulk
  Park controls; active work and unresolved operations still block those actions.
  ([#85](https://github.com/kcosr/sedes/pull/85))

### Removed

## [0.2.0] - 2026-10-14

### Breaking Changes

- Codex app-servers and managed TUI commands require **0.162.1 or newer** on
  every execution host. Rebuild the server, execution sidecars, and Electron
  Local together for the updated generated protocol profile. See the
  [Codex upgrade requirements](docs/operator/backends/codex.md).
  ([#73](https://github.com/kcosr/sedes/pull/73))

- Upgrade browser and packaged clients together with the server for client
  protocol **155**. Rebuild and upgrade execution sidecars and local workers
  for agent-tool CLI/relay protocol **6** and OpenCode MCP protocol **4**;
  older compiled runtime contracts are rejected. Notification scripts now use
  payload version **5**: update separately copied hooks with the server and
  review Script/Voice event and reply-phase settings.
  ([#9](https://github.com/kcosr/sedes/pull/9), [#10](https://github.com/kcosr/sedes/pull/10), [#12](https://github.com/kcosr/sedes/pull/12), [#15](https://github.com/kcosr/sedes/pull/15), [#17](https://github.com/kcosr/sedes/pull/17), [#38](https://github.com/kcosr/sedes/pull/38), [#44](https://github.com/kcosr/sedes/pull/44), [#45](https://github.com/kcosr/sedes/pull/45), [#73](https://github.com/kcosr/sedes/pull/73), [#75](https://github.com/kcosr/sedes/pull/75), [#77](https://github.com/kcosr/sedes/pull/77), [#78](https://github.com/kcosr/sedes/pull/78))

- Claude requires Claude Code **2.1.287 or newer** on every execution host
  and uses Agent SDK 0.3.296 (tested with Claude Code 2.1.296). See the
  [Claude upgrade requirements](docs/operator/backends/claude.md).
  ([#29](https://github.com/kcosr/sedes/pull/29), [#78](https://github.com/kcosr/sedes/pull/78))

- Back up the full state directory before upgrading: database migrations are
  one-way. Existing locations are grouped into projects, and location-owned
  Tasks and Workpads move to their projects. Review **Settings → Projects**
  after upgrading; saved work in removed locations becomes visible while its
  project remains active. Follow the [backup and upgrade guide](docs/operator/operations.md).
  ([#8](https://github.com/kcosr/sedes/pull/8), [#33](https://github.com/kcosr/sedes/pull/33), [#34](https://github.com/kcosr/sedes/pull/34), [#53](https://github.com/kcosr/sedes/pull/53))

- Task and Workpad APIs use `project` scope instead of `workspace` and
  `move_to_project` instead of `move_to_workspace`. Use `GET /api/projects`
  instead of `GET /api/workspaces`; opening a location requires a project
  assignment. Refresh agent-tool descriptions and list cursors, and restart
  retained native MCP sessions. Read Tasks again before retrying pre-upgrade
  mutations whose replies were lost. Completed Tasks can no longer be pinned
  or backlogged; existing completed Tasks are unpinned.
  ([#33](https://github.com/kcosr/sedes/pull/33), [#34](https://github.com/kcosr/sedes/pull/34), [#39](https://github.com/kcosr/sedes/pull/39))

- Reconfigure Android voice after upgrading: older preferences and default
  thread selections reset. Device speech keys and version-2 saved dictation
  remain; older per-connection keys are removed and older recording manifests
  cannot resume. Self-hosted speech servers must advertise per-model
  `realtime` capabilities; hosted recognition uses supported base model IDs.
  See [voice setup](docs/operator/clients/voice.md).
  ([#49](https://github.com/kcosr/sedes/pull/49), [#51](https://github.com/kcosr/sedes/pull/51), [#53](https://github.com/kcosr/sedes/pull/53), [#55](https://github.com/kcosr/sedes/pull/55), [#67](https://github.com/kcosr/sedes/pull/67), [#68](https://github.com/kcosr/sedes/pull/68))

- Automation run resolution returns `{ run, automation }`; update scripts
  reading that API response. The thread inventory API no longer accepts
  `remind`. ([#58](https://github.com/kcosr/sedes/pull/58), [#61](https://github.com/kcosr/sedes/pull/61))

### Added

- Agents can show PNG, JPEG, GIF, and WebP image files directly in chat with
  `image.show`. Sedes retains the captured image after its source changes or
  disappears; enable **Show image** in the thread’s **Images** tools.
  ([#78](https://github.com/kcosr/sedes/pull/78))

- Drag individual threads into Groups or onto another thread to create a Group.
  Reference threads in a prompt by dragging them into the composer or choosing
  them with **@**; references survive drafts, stashes, and queued delivery.
  Type after **@** to filter by title, provider, project, or environment, with
  sidebar status indicators, provider icons, keyboard selection, and focus
  retained in the composer. Suggestions keep project and environment labels
  together after the title in wide popups and on a compact second line in
  narrow ones.
  ([#78](https://github.com/kcosr/sedes/pull/78))

- Claude threads support **Compact context** while idle, with retained earlier
  turns, expandable summaries, session statistics, and recovery for uncertain
  outcomes. See [manual compaction](docs/operator/backends/claude.md#manual-compaction).
  ([#76](https://github.com/kcosr/sedes/pull/76))

- A device-local default thread unifies quick navigation and Android voice.
  Choose it in General settings or a thread's context menu; it appears above
  Pinned with activity and unread status, and opens with Ctrl/Command+Shift+H.
  ([#75](https://github.com/kcosr/sedes/pull/75))

- Agents can publish revisioned [HTML previews](docs/user/html-previews.md)
  from files or inline HTML, with local images, optional viewport dimensions,
  fullscreen viewing, and a thread Pages library. Previews load automatically;
  tap to interact in chat while fullscreen and library views accept input
  immediately. An optional [server preview browser](docs/operator/page-previews.md)
  provides screenshots and console output for agents before publishing.
  ([#75](https://github.com/kcosr/sedes/pull/75))

- Codex **Partial** replies appear inline, with a separate notification section
  for Script and Voice delivery, initially off. Partial text can also be selected
  for completion notifications and playback. Work stays active until the turn ends.
  ([#73](https://github.com/kcosr/sedes/pull/73))

- Codex subagent activity shows both model and reasoning inline when either
  differs from the spawning agent, and suppresses them when both match. Both
  use the supplied identifiers without display-name capitalization.
  ([#73](https://github.com/kcosr/sedes/pull/73))

- Projects span locations across execution environments, with rename, move,
  merge, remove, and restore controls. Project Tasks and Workpads are shared
  across those locations. ([#33](https://github.com/kcosr/sedes/pull/33), [#34](https://github.com/kcosr/sedes/pull/34))

- Android native voice supports spoken notifications, headset/background
  recording, reply replay, agent client controls, saved encrypted dictation,
  and **Keep listening** through pauses. Off, Input, and Speak modes separate
  recording from automatic speech; recording destinations and playback filters
  have independent settings. ([#45](https://github.com/kcosr/sedes/pull/45), [#48](https://github.com/kcosr/sedes/pull/48), [#49](https://github.com/kcosr/sedes/pull/49), [#50](https://github.com/kcosr/sedes/pull/50), [#51](https://github.com/kcosr/sedes/pull/51), [#53](https://github.com/kcosr/sedes/pull/53), [#55](https://github.com/kcosr/sedes/pull/55), [#57](https://github.com/kcosr/sedes/pull/57), [#62](https://github.com/kcosr/sedes/pull/62), [#67](https://github.com/kcosr/sedes/pull/67), [#68](https://github.com/kcosr/sedes/pull/68))

- Automations have a searchable overview, dedicated editor, and run history
  with turn outcomes, duration, usage, and **Go to turn**. Uncertain outcomes
  have explicit recovery actions in the UI, API, and CLI.
  ([#58](https://github.com/kcosr/sedes/pull/58), [#59](https://github.com/kcosr/sedes/pull/59))

- Tasks and Workpads offer Thread, Project, Global, and All views with search,
  counts, sorting, and saved preferences. Tasks add backlog, pinning, bulk
  paste, keyboard actions, and prompt attachments. Workpads add editable
  checklists and confirmed permanent deletion. Agents can delete completed
  Tasks when requested. ([#37](https://github.com/kcosr/sedes/pull/37), [#39](https://github.com/kcosr/sedes/pull/39), [#40](https://github.com/kcosr/sedes/pull/40), [#50](https://github.com/kcosr/sedes/pull/50), [#52](https://github.com/kcosr/sedes/pull/52), [#56](https://github.com/kcosr/sedes/pull/56), [#65](https://github.com/kcosr/sedes/pull/65))

- OpenCode v2 2.0.18 runs on Linux locally or through SSH/outbound sidecars,
  with owned or external runtimes, native history, streaming, steering,
  approvals, files, images, skills, and scoped agent tools.
  ([#17](https://github.com/kcosr/sedes/pull/17))

- Codex and Claude support Native Sedes agent tools. Codex, Claude, and Pi
  show expandable viewed-image rows; Claude skill aliases are searchable.
  Live background work appears in the sidebar, while context meters and Pi
  turn throughput remain available without usage accounting.
  ([#10](https://github.com/kcosr/sedes/pull/10), [#11](https://github.com/kcosr/sedes/pull/11), [#14](https://github.com/kcosr/sedes/pull/14), [#16](https://github.com/kcosr/sedes/pull/16), [#20](https://github.com/kcosr/sedes/pull/20), [#24](https://github.com/kcosr/sedes/pull/24), [#29](https://github.com/kcosr/sedes/pull/29))

- Experimental usage accounting records turn and subagent tokens and estimated
  costs, with a Usage explorer, CSV export, and coverage labels. Enable it with
  `SEDES_EXPERIMENTAL_USAGE=1`; the feature defaults off.
  ([#8](https://github.com/kcosr/sedes/pull/8))

### Changed

- Bookmarks now sit in the assistant response footer and jump to the start of
  its text. Response previews include the whole turn, including replies after
  steering or question answers.
  ([#78](https://github.com/kcosr/sedes/pull/78))

- Automatic turn voice notices skip speech and follow-up recording when a newer
  message has been sent in the same thread. See [voice behavior](docs/operator/clients/voice.md).
  ([#77](https://github.com/kcosr/sedes/pull/77))

- Agent-requested listening waits for playback and uses the requested thread
  even with Auto-listen off. Background handoffs preserve the viewed thread and
  draft, and announce their destination when recording-thread announcements are
  enabled. Stop and superseded source replies cancel pending handoffs.
  See [agent voice controls](docs/operator/clients/voice.md#agent-controls).
  ([#77](https://github.com/kcosr/sedes/pull/77))

- Images, Mermaid diagrams, and HTML previews share compact fullscreen
  [zoom controls](docs/user/files-and-context.md#view-images-and-diagrams).
  Images and diagrams support inline pinch zoom and pan, and images use the
  assistant column's width. Chat header options are more compact, and Escape
  exits sidebar search without clearing its filter.
  ([#75](https://github.com/kcosr/sedes/pull/75))

- Voice keeps the last reply target after playback ends, even while another thread
  is open. Idle **Next** returns to the viewed thread; navigating to a different
  thread while idle selects it. See [voice controls](docs/operator/clients/voice.md).
  ([#74](https://github.com/kcosr/sedes/pull/74))

- Codex Speed offers Standard, Fast, and Ultrafast according to the model
  catalog and independent Fast/Ultrafast enablement. Explicit user goal edits
  are recorded with their user origin. The managed TUI keeps its inline
  transcript. ([#27](https://github.com/kcosr/sedes/pull/27), [#44](https://github.com/kcosr/sedes/pull/44), [#73](https://github.com/kcosr/sedes/pull/73))

- Panels occupy remembered Middle, Left, Right, Top, or Bottom regions with
  **Move to**, **Maximize**, and a shared Panels menu. Narrow screens hide
  less-recently-used regions; phones return to Chat when another panel closes.
  Chat includes a pin control, and the sidebar can filter for open Tasks.
  ([#37](https://github.com/kcosr/sedes/pull/37), [#63](https://github.com/kcosr/sedes/pull/63), [#66](https://github.com/kcosr/sedes/pull/66), [#72](https://github.com/kcosr/sedes/pull/72))

- Settings has grouped navigation, deep links, consistent dialogs, and touch
  controls; saved Agents live at `/settings/agents`. Archived threads share
  sidebar scope/search and offer sorting and direct restore. Sidebar search
  uses Ctrl/Command+Shift+F. ([#21](https://github.com/kcosr/sedes/pull/21), [#28](https://github.com/kcosr/sedes/pull/28), [#30](https://github.com/kcosr/sedes/pull/30), [#64](https://github.com/kcosr/sedes/pull/64))

- **Park** replaces Settle in the UI; new input returns parked threads to
  Active. State organization keeps unseen completions under Needs attention.
  Archive/park previews offer to complete affected Tasks and protect against
  stale choices. ([#19](https://github.com/kcosr/sedes/pull/19), [#61](https://github.com/kcosr/sedes/pull/61), [#72](https://github.com/kcosr/sedes/pull/72))

- Codex, Claude, and Pi accept multiple ordered Steers. Stop preserves
  undelivered inputs for explicit restore or dismissal; uncertain delivery
  never resends automatically. Force reset is scoped to its thread and
  unfinished forks and resolves abandoned provider interactions.
  ([#12](https://github.com/kcosr/sedes/pull/12), [#13](https://github.com/kcosr/sedes/pull/13), [#17](https://github.com/kcosr/sedes/pull/17))

- New threads default to Custom settings; accounts support up to 64 backends.
  Android accepts user- and MDM-installed certificate authorities while
  retaining certificate and hostname validation.
  ([#6](https://github.com/kcosr/sedes/pull/6), [#32](https://github.com/kcosr/sedes/pull/32), [#45](https://github.com/kcosr/sedes/pull/45))

- Release maintenance uses concise PR-linked notes, an explicit version policy,
  and automatic changelog/version checks during typecheck and build. Unreleased
  notes summarize the current upgrade instead of superseded protocol steps.
  ([#73](https://github.com/kcosr/sedes/pull/73))

### Fixed

- Android uses patched Capacitor 8.4.3 to block internal HTTP proxy navigation;
  rebuild the Android client after upgrading. See the
  [release verification and advisory dispositions](specs/release-0.2.0.md).
  ([#80](https://github.com/kcosr/sedes/pull/80), [upstream advisory](https://github.com/advisories/GHSA-rvm3-566m-v7fv))

- Windows file and image attachments send without a false reconciliation
  requirement. Supplemental Files roots use Windows path rules for sensitive
  directory checks and labels. Deploy and restart the server; no client or
  sidecar upgrade is required. See [remote attachments](docs/operator/outbound-hosts.md#approve-and-configure).
  ([#79](https://github.com/kcosr/sedes/pull/79))

- Windows Codex sessions preserve the account environment required by configured
  MCP servers, and failed MCP startup appears as a thread warning. Rebuild and
  upgrade Windows sidecars or Managed Local, then restart the affected Codex
  backend. See [Codex setup](docs/operator/backends/codex.md).
  ([#79](https://github.com/kcosr/sedes/pull/79))

- Pi sessions await extension shutdown before disposal, preventing retained
  extension timers from crashing the server during catalogue reads or
  reconnects. Deploy and restart the server; no sidecar upgrade is required.
  ([#78](https://github.com/kcosr/sedes/pull/78))

- Remote Codex, Claude, and OpenCode CLI tool settings retain correct
  availability after sidecar connection and reconnection. Deploy and restart
  the server; this fix does not require a sidecar upgrade.
  ([#78](https://github.com/kcosr/sedes/pull/78))

- Claude reports organization-policy startup failures clearly and recognizes
  subagent replies without attributing them to pending parent-thread input.
  ([#78](https://github.com/kcosr/sedes/pull/78))

- Agents can read and update Workpads up to the existing 262,144-unit text
  limit across Native and CLI surfaces. Size and Unicode errors explain the
  rejected edit without committing it. Rebuild CLI executables and execution
  sidecars together for the updated private tool protocols. See
  [Workpad limits](docs/user/workpads.md#edit-and-save).
  ([#78](https://github.com/kcosr/sedes/pull/78))

- Codex retains verified Sedes creation identity after first-input
  force reset, so recovered sessions keep tool eligibility without replaying
  abandoned input. Tool settings show current backend eligibility separately
  from saved grants, and eligibility updates preserve live transcript streams
  without changing the saved policy revision. Existing affected sessions have an audited
  [offline repair](docs/operator/operations.md#repair-tool-eligibility-after-force-reset).
  ([#78](https://github.com/kcosr/sedes/pull/78))

- HTML previews publish successfully from workspace files even when downloads
  complete immediately. ([#77](https://github.com/kcosr/sedes/pull/77))

- Automation details link consistently to the Automations list and expose
  **Open thread** beside it. Queue/Steer choices open directly above their button.
  ([#74](https://github.com/kcosr/sedes/pull/74))

- Headset Play/Pause finishes transcription and sends speech in Keep listening.
  Any explicit Send with an empty transcript ends without a completion tone and
  continues queued speech; Play/Pause leaves a Send already in progress. Ordinary
  recording Play/Pause and headset Stop discard unsent recordings without leaving
  a recording failure to dismiss.
  ([#74](https://github.com/kcosr/sedes/pull/74))

- Codex live/history parsing, empty-thread recovery, saved security policy,
  settings updates, speed changes, and forks survive reconnects and races.
  ([#18](https://github.com/kcosr/sedes/pull/18), [#26](https://github.com/kcosr/sedes/pull/26), [#27](https://github.com/kcosr/sedes/pull/27), [#38](https://github.com/kcosr/sedes/pull/38), [#44](https://github.com/kcosr/sedes/pull/44), [#70](https://github.com/kcosr/sedes/pull/70))

- Claude history and forks preserve compactions, queued inputs, terminal
  outcomes, and usage without phantom turns or duplicate counts. Lost
  processes leave interrupted turns; Stop and cleanup account for background
  work and child processes. Retained remote output is recovered and reclaimed.
  ([#9](https://github.com/kcosr/sedes/pull/9), [#12](https://github.com/kcosr/sedes/pull/12), [#14](https://github.com/kcosr/sedes/pull/14), [#29](https://github.com/kcosr/sedes/pull/29), [#42](https://github.com/kcosr/sedes/pull/42), [#45](https://github.com/kcosr/sedes/pull/45))

- Archive history loads without resuming an agent; archive progress survives
  navigation. Tool-policy changes, queued-input controls, completion attention,
  and removed-connection handling retain their current state.
  ([#7](https://github.com/kcosr/sedes/pull/7), [#15](https://github.com/kcosr/sedes/pull/15), [#18](https://github.com/kcosr/sedes/pull/18), [#25](https://github.com/kcosr/sedes/pull/25), [#35](https://github.com/kcosr/sedes/pull/35), [#36](https://github.com/kcosr/sedes/pull/36), [#43](https://github.com/kcosr/sedes/pull/43))

- Android voice preserves drafts and recognized text, handles microphone
  reconnection and audio-focus interruptions, and prevents historical replies
  from triggering automatic speech. Opt-in diagnostics trace runtime lifecycle,
  remote event forwarding, and playback without recording message text.
  ([#41](https://github.com/kcosr/sedes/pull/41), [#46](https://github.com/kcosr/sedes/pull/46), [#47](https://github.com/kcosr/sedes/pull/47), [#49](https://github.com/kcosr/sedes/pull/49), [#53](https://github.com/kcosr/sedes/pull/53), [#55](https://github.com/kcosr/sedes/pull/55), [#69](https://github.com/kcosr/sedes/pull/69), [#71](https://github.com/kcosr/sedes/pull/71))

- Automation status reflects running turns, failed runs, and unknown outcomes;
  failed runs reactivate parked threads and force reset ends affected fork runs.
  ([#58](https://github.com/kcosr/sedes/pull/58), [#59](https://github.com/kcosr/sedes/pull/59), [#60](https://github.com/kcosr/sedes/pull/60), [#61](https://github.com/kcosr/sedes/pull/61))

- Task edits protect unsaved changes and keep other rows usable. Mobile
  Add to prompt and settings stay open for further actions; Escape clears
  Tasks/Workpads input before leaving it. Menus, terminal themes, archived
  search, and deep links remain usable across layout changes.
  ([#21](https://github.com/kcosr/sedes/pull/21), [#28](https://github.com/kcosr/sedes/pull/28), [#39](https://github.com/kcosr/sedes/pull/39), [#65](https://github.com/kcosr/sedes/pull/65), [#72](https://github.com/kcosr/sedes/pull/72))

- Windows desktop upgrades handle long temporary paths and refresh shortcuts;
  macOS packages declare local-network access. Linux server/full Electron
  packages retain compatible native dependencies, and Electron Local accepts
  versioned server health responses.
  ([#27](https://github.com/kcosr/sedes/pull/27), [#45](https://github.com/kcosr/sedes/pull/45), [#53](https://github.com/kcosr/sedes/pull/53), [#54](https://github.com/kcosr/sedes/pull/54))

### Removed

- **Remind now**; pin the thread and add a Task instead. Tasks opens alongside
  a thread, including its Global view, rather than from Home or Archived.
  ([#31](https://github.com/kcosr/sedes/pull/31), [#61](https://github.com/kcosr/sedes/pull/61))

- Old panel docking/collapse controls and Shift-click full screen; use
  **Move to**, **Maximize**, and the Panels menu. Workpads' nested-scope and
  archive switches are replaced by its shared views and Archived section.
  ([#63](https://github.com/kcosr/sedes/pull/63), [#65](https://github.com/kcosr/sedes/pull/65), [#66](https://github.com/kcosr/sedes/pull/66))

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
