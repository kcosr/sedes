# Settings

Open **Settings** with the gear button in the sidebar footer. Some settings
follow the Sedes user through the server; many appearance and interaction
choices belong only to the current browser or packaged client.

## Move around Settings

Settings opens as a page in the main workspace. The thread you were viewing
stays loaded behind it, with its draft, uploads, scroll position, and terminal
sessions, and running work continues.

Pages are grouped. A page appears only where this client can use it; for
example, **Connection** exists only in the Electron app, and **Server** and
**Voice** only in the Android app.

| Group | Pages |
| --- | --- |
| Preferences | General, Appearance, Mobile, Terminal, Voice |
| Account | Prompts, Notifications |
| Execution | Environments, Backends, Projects, Agents |
| Access | Tool clients, Paired clients, Connection or Server |
| Support | Diagnostics |

**With the desktop sidebar showing**, the sidebar lists the Settings pages by
group in place of your threads. The thread list is kept as it was and returns
when you leave. The row at the top, **Back to chat**, returns to the thread you
were viewing; it reads **Back to workspace** when you did not come from a
thread. Opening `/settings` goes to the page you last viewed in this browser
tab, or to **General**; it opens that page's list, never an item or editor you
left open.

**On a phone, or with the desktop sidebar hidden**, `/settings` shows every
page in a grouped list with a one-line description, and the return control sits
at the top of the list. Each page has a **‹ Settings** link back to the list.
The menu button at the top left opens thread navigation on a phone; on desktop
it shows the sidebar again, which then lists the Settings pages.

Every page has its own address, such as `/settings/backends`, and browser or
Android Back and Forward walk the same path as the **‹** links. Page
navigation and the return destination are local to the current client session;
they do not change ownership or persistence of the settings below.

### Escape goes up one level

Press Escape to go up one level, the same way as the **‹** links:

- an editor returns to the item it edits, and an item returns to its list;
- a page returns to the Settings list on a phone or with the sidebar hidden;
- the Settings list, or any page while the sidebar lists Settings, returns to
  the workspace.

An open dialog, menu, picker, popover, or sheet takes Escape first and only
closes. In a text field, the first Escape only leaves the field (a search field
may also clear); press Escape again to go up. Holding the key down never
skips several levels. With unsaved edits, Sedes asks before discarding them, as
it does for the **‹** links and Back. On **Prompts** and **Tool clients**,
Escape closes an open editor before it leaves the page.

## Which settings follow you

| Kind | Examples | Where it applies |
| --- | --- | --- |
| User library or policy | Saved prompts, Tool clients, OpenAI composer-skill visibility, notifications | Every client for the current Sedes user |
| Browser presentation | Theme, activity detail, environment colors, animations, history page size, seek on send, mobile history seek control | This browser or packaged client |
| Thread setting | Model, effort, permissions, tool policy, Codex execution settings | One thread |
| Project catalog | Remembered directories, removal and restoration | Every client for the current Sedes user, in the server database |
| Execution configuration | Environments, targets, model policy, allowed roots, provider paths | Every client for the current Sedes user, in the server database |
| Installation bootstrap | Listener, state path, packaged-client origins | Server startup file managed by the operator |

## Environments, backends, and targets

**Environments** lists this machine, SSH hosts, and paired outbound hosts.
**Backends** lists the Pi SDK, Codex, Claude, and local Grok backends, grouped
by environment. Both pages show a list and the selected item.

### List and detail

When the Settings content area is at least 960 pixels wide, the list stays on
the left and the selected item opens beside it. On narrower windows and on
phones the page stacks: the list, then the selected item on its own with a
**‹ Environments** or **‹ Backends** link back. Returning to the list restores
its filters, its scroll position, and focus on the row you left.

Each item, editor, and add step has its own address, so a link opens it
directly and browser or Android Back walks back through it:

| Address | Opens |
| --- | --- |
| `/settings/environments/ID` | One environment |
| `/settings/environments/ID/edit` | Its editor |
| `/settings/environments/~new` | The **Add environment** chooser |
| `/settings/environments/~new/local`, `…/~new/ssh`, `…/~new/pair` | One kind of new environment |
| `/settings/environments/~pending/ID` | A host awaiting approval |
| `/settings/backends/ID`, `…/ID/edit`, `/settings/backends/~new` | A backend, its editor, a new backend |

Action addresses start with `~` so that they never collide with an item's ID;
an item can be named `new` or `pending` and still has its own address.

A link to a removed item, or to a host that was already accepted, denied, or
has expired, says the item is unavailable.

Each row shows an icon, the name, a summary (where an environment runs and how
many backends it has; a backend's provider and how many connections it has),
one status, and a **⋯** menu with **Edit**, **View activity**, and **Remove…**.
Search environments by name, host, or backend, and filter them by status.
Search backends by name, provider, environment, host, or connection name, and
filter them by environment, provider, and status. In a narrow list, **Filters**
opens these controls and shows how many are active. The **Needs attention**
status filter includes pending or unapplied configuration, runtime errors,
upgrades, unreachable hosts, and unknown operation outcomes. Hosts waiting for
approval are listed first, under **Awaiting approval**.

### An environment or backend

The header shows the name, its kind (**Local**, **SSH**, or **Paired**, or the
backend's provider with **Default** or **Disabled** where they apply), one
status, the action the current state calls for (such as **Retry connection**),
**Edit**, and a **⋯** menu with the other lifecycle commands. A destructive
command such as **Stop** comes last in that menu. Three tabs follow:

- **Overview** starts with a health summary: the runtime state, its last error,
  and the action to take, so an unreachable host is visible on the first tab.
  An environment then shows **Host**, **Workspace access**, and **Environment
  variables**. A backend shows **Provider and connection**, **Policy**,
  **Models**, and **Environment variables**. **Danger zone** comes last, with
  **Remove environment** or **Remove backend** and, for a paired host,
  **Revoke pairing** or **Reapprove pairing**. Each asks for confirmation.
- **Backends** (on an environment) lists the backends that run there, with
  **Add backend** for that environment. **Connections** (on a backend) lists
  its named connections and marks the **Default for new threads**.
- **Activity** shows the runtime state and **Technical details**: connection
  preference, configuration state, saved and applied revisions, active or
  unconfirmed resources, and for a remote host the sidecar version and upgrade
  state. Internal identifiers such as environment, backend, pairing, and
  installation IDs appear only here, each with a copy button. A remote
  environment also offers **Recovered operations** here.

### Edit and add

**Edit** opens the editor in the detail pane. A backend editor takes the full
width of the page. Links at the top jump to its sections: **General**,
**Access**, **Operations**, and **Variables** for an environment; **General**,
**Connection**, **Policy**, **Models**, **Connections**, and **Variables** for a
backend. Executable paths, home directories, and timeouts sit in a collapsed
**Advanced** group. Each connection and model rule can be collapsed. The bar at
the bottom shows whether there are unsaved changes and offers **Cancel** and
**Save environment** or **Save backend**; **Saved** appears there briefly after
a save. An error appears on the field that needs fixing; an error that belongs
to no single field is described in words above the form. Errors clear when you
move to another item. Runtime commands pause while an editor is open.

**Add environment** opens a chooser in the detail pane: **Local machine** (one
per account), **SSH host**, or **Pair a host**. Local and SSH open their form
in the same pane. **Pair a host** shows the pairing commands, a **Download
connector** link, and the hosts already waiting. A registered host appears
under **Awaiting approval**; select it, compare its registration code, set the
access under **Access to grant**, and choose **Accept host**, or choose
**Deny**. See [Outbound hosts](../operator/outbound-hosts.md).

**Add backend** opens a new backend form; from an environment's **Backends**
tab it starts in that environment. Choose the **Execution environment** before
the **Backend type**; types that environment cannot run are disabled. All named
connections for one backend share its environment, and existing environment
bindings remain fixed.

Above the backend list, **Defaults** holds two account-wide settings: **Default
connection for new threads**, whose choices read Environment / Backend /
Connection, and **Grok CLI research**, the local research tool on Sedes, which
is configured separately from environment backends. On a narrow page they fold
into one summary line; select it to change them, then choose **Save defaults**.

Provider executables and authentication must already be installed for their
execution account. Pi's SDK and provider connection run on Sedes; a remote Pi
environment supplies workspace tools. Credential fields refer only to approved
host-scoped credentials; Settings never displays their values.

### Saving and runtime state

Configuration saves follow this Sedes user across clients and restarts. The
saved revision is the desired setting; the applied revision and status show
what the runtime has confirmed. Another client's edit can cause a conflict:
refresh and review before saving again. Leaving unsaved edits, by a link, Back,
Escape, or selecting another item, asks whether to discard them. Existing
thread identities cannot be redirected to a different host, provider home, or
native store by editing labels. Create a new target identity for different
execution authority.

Runtime state, configuration application, and host connection are reported
separately: an online host need not have a connected provider, and a disabled
backend can still own a running runtime. A row and a header show the one status
that needs the most attention; the item's **Overview** explains it. The **⋯**
menu stays in the same place and order, offering only the actions supported in
the current state.

**Stop** remains available while a host is unreachable or requires recovery. It
records that the service must not start automatically; host shutdown and cleanup
remain unconfirmed until the host is reachable, so this does not advertise
**Confirmed stopped**. Filtering or navigating away retains in-progress commands
and their original outcome checks.

Environment **Disconnect** leaves admitted remote work running and prevents
automatic reconnection until you choose **Connect**. **Stop** persists an intent
to stop the managed service. **Restart** and **Upgrade and restart** show the
current interruption impact before acting. A live terminal, active turn,
unsettled result, or unknown state defers an automatic replacement; a shell at
its prompt is live. Until then the outdated sidecar keeps serving, the status
shows **Upgrade available**, and the replacement happens on its own once the
work settles. Only an incompatible sidecar needs an explicit upgrade. While a command
is still running, Sedes checks its outcome automatically and keeps other
actions paused; **Refresh status** checks immediately. An unavailable or
unknown response does not mean the service stopped. Backend **Disconnect** is
available only for a remote provider runtime. Local Pi SDK, Codex, Claude, and
Grok use the impact-confirmed **Stop** or **Restart** controls instead.

These controls do not provide tenant or user administration. All requests use
the current server-derived account. Claude supports local and persistent remote
runtimes over SSH or outbound connections on Linux/macOS with Node.js 24.18+.
Native Windows Claude is unsupported. Previously disabled remote definitions
retain their historical associations; supported Linux/macOS definitions can be
explicitly enabled after checking the remote setup.
Remote Grok and Cursor runtimes remain unsupported.

## Environment variables

Environment and backend editors include **Environment variables** with two uses:

- **Tools & commands** supplies defaults for new threads. Environment defaults
  also apply to new ordinary terminals; backend, Agent, and thread overrides do
  not change ordinary terminals.
- **Backend startup** supplies values when Sedes launches an owned backend
  process. The editor stays enabled while it runs. Saving does not restart the
  process; changes remain pending until restart. The tab is disabled for external
  Codex processes and Pi's in-process SDK; inherited startup settings are not
  applied to those runtimes.

For tools and commands, precedence is **Environment → Backend → Agent →
Thread**. A later definition overrides an earlier one. Expand a variable to see
its sources. Choose **Reset to inherited** to remove a local override, **Unset
here** to remove a variable from the effective environment, or **Remove** to
remove a variable defined only at the current scope. An empty literal value
keeps the variable present with an empty value.

Add a **Literal value** or a secret reference. An **Environment reference**
names a variable on the execution host. A **Protected file** reference names an
absolute file path there. Secret values are resolved by the host and are never
returned to the editor. References remain visible so you can review which credential is
selected. Literal values are stored and displayed as text; use a secret
reference for credentials. Values are not shell expressions and are not
expanded with `${...}`.

Sedes-owned authority, provider identity, process-loader, and terminal-control
names cannot be edited. Unsupported variable delivery fails before work starts;
it does not silently run without the requested variables.

Existing threads retain their saved variable layers when defaults change.
Review a thread under **Thread actions → Environment variables…**, then use
**Fork with changes…** when a different configuration is needed. See
[Thread environment variables](conversations.md#thread-environment-variables).

## Projects

Open **Settings → Projects** (or `/settings/projects`) to manage projects and
their locations. Each project row shows its name and counts of locations,
Tasks, and Workpads, including for removed projects. Task and Workpad counts
cover items owned directly by the project, including completed Tasks and
archived Workpads; they exclude global and thread-owned items. Each location
underneath shows its environment, path, thread count, and whether it is
available. The list includes removed projects and locations, marked **Removed**,
and locations on unavailable environments. Search by project name, folder, path,
or environment, or use the searchable environment and status selectors. In a
narrow list, choose **Filters** to open these selectors. An inline note lists
project names that several active projects share, each with a **Merge** action.

Choose **Add project** to browse an existing directory or enter its absolute
path, then choose the project it belongs to: a new project or an existing one.
On mobile, Add project opens as a bottom sheet. The same action is available
beside **New thread** in every sidebar view and inside the New thread form, and
a project's **Add location…** action opens it for that project. Adding from the
form preserves your inputs and selects the location after it becomes
available. Allowed workspace roots are access grants configured separately in
the environment's editor, under **Workspace access**.

Each row's menu holds its actions. A project can be renamed, given another
location, merged into another project, removed, or restored; a location can be
moved to another or a new project, removed, or restored. Removal hides threads
from the working inventory and creation choices; files, history, drafts, and
saved application data remain intact. Removing a location keeps the project's
Tasks and Workpads; removing the project hides them too until you restore it.
The removal confirmation shows the project's Task and Workpad counts. When
removing its last active location, **Also remove project** shows those counts
so you can see the additional saved work that will be hidden.
Stop running or queued work, resolve uncertain operations, pause schedules, and
end terminals before removal; removing a project lists anything that still
blocks it. Restoration rechecks current directory access; unavailable hosts or
revoked roots may require attention first. Paused schedules stay paused. See
[Manage projects](organize-work.md#manage-projects) for what each action moves
or keeps.

## Agents

**Settings → Agents** (`/settings/agents`) manages saved Agents. **More →
Agents** in the sidebar footer opens the same page, and **Create an Agent** in
**New thread** opens its create form. Like Environments, the page shows the
list of Agents beside the selected Agent at wide sizes, and stacks the two with
a **‹ Agents** link on narrow ones. Each row shows the Agent's backend, name,
override count, and Sedes tool policy.

An Agent's editor is its detail: `/settings/agents/ID` opens it, and
`/settings/agents/~new` (**Create Agent**) starts a new one. Links at the top of
the editor jump to its sections, the bar at the bottom saves or cancels, and
**Danger zone** holds **Delete Agent**. The old `/agents` addresses now open
the workspace instead; update bookmarks to `/settings/agents`. See
[Manage saved Agents](organize-work.md#manage-saved-agents) for what an Agent
stores and how threads use it.

## Notifications

Configure **Settings → Notifications** to choose Script and Voice delivery for
each event. Each event has a **Script** switch and a **Voice** choice. Script
delivery invokes one executable on the Sedes server. Enter its absolute
**Server script path**, optional **Arguments (one per line)**, and **Timeout
(seconds)** when using that channel. Voice delivery chooses **None**, **Speak**,
or **Speak then listen** on Android. Turn on **Enable notifications** and save.
These settings follow the current Sedes user across clients and server restarts.

Fresh settings select no script events, speak every event, and choose **Speak
then listen** for **Turn completed**. They include Final and Unclassified
completion text. Provisional text can repeat progress already spoken; select it
only if that repetition is useful. **Turn progress**, **Approval requested**,
**Input requested**, and **Nonblocking questions** offer only None or Speak, so
they never open the microphone automatically. **Automation started** offers
Speak then listen, but it behaves as Speak: the notice targets the automation's
thread while its turn is running, and that turn finishing makes the target out
of date. See [Voice](#voice) and [Android voice](../operator/clients/voice.md)
for local audio modes, microphone settings, and target selection.

Available events are **Turn progress**, **Turn completed**, **Turn failed**,
**Turn interrupted**, **Snooze wake**, **Automation started**, **Automation
failed before starting**, **Approval requested**, **Input requested**, and
**Nonblocking questions**. Turn progress is a completed live assistant update
before the turn finishes, from Codex, Pi, or Claude. A turn event
requires an authoritative terminal outcome; a pause in output or a disconnected
backend does not count. Snooze wake means its deadline was reached. A completion
that wakes a snoozed thread produces the selected turn event, not an additional
wake notification. Manual wake and Remind now do not emit notifications.
Automation started means the agent input was accepted after any pre-check;
becoming due, waiting in the queue, and a pre-check skipping a run do not count.
Automation failed before starting covers definitive failures before successful
acceptance. Approval requested covers new approval decisions and confirmation
dialogs. Input requested covers new blocking questions, choices, text input, and
editor requests, including Codex blocking questions. Nonblocking questions covers
questions an agent asks while it keeps working, such as Codex async questions;
the notification carries the question count, never the question text. These
three events fire when the backend accepts a new request, even without an open
browser; reconnecting or redisplaying the same pending dialog does not notify
again. Answering, approving, rejecting, or dismissing a request does not send a
notification or affect an already emitted hook.

The bell in application navigation **silences** automatic script and voice notifications without
changing their configuration. A blue bell indicates notifications are enabled
and unsilenced; a gray slashed bell indicates they are silenced or disabled in
Settings. Silence follows the user across clients and
restarts. Resuming does not send a backlog. Opening a thread, acknowledging its
completion, or dismissing a wake reminder has no effect on these passive hooks.
An already running script cannot be unsent. Silence cancels automatic voice
work, while explicit microphone recording remains available.

**Send test notification** invokes the script using the fields currently in the
form, including unsaved edits. It works while disabled or silenced and displays
an immediate result. It does not save the form. Regular events have no delivery
history, read receipts, or automatic retries. Hooks are best effort: events may
be lost during shutdown or when script execution is at capacity, and script
failures never fail agent work.

For the JSON input contract and server-side execution behavior, see
[Notification scripts](../operator/configuration.md#notification-scripts).

## General

### Click project and environment names to filter

This setting is off by default and saved on this client. Enable it to click or
tap an underlined project or environment name on a sidebar thread card to
filter the thread list without opening the thread. Keyboard users can focus a
name and press Enter or Space. Back clears active sidebar filters as usual.
Environment names, including Local, appear when there are multiple
environments; they are hidden when there is only one or the current scope
already identifies the environment.

### Opening panels

The **Panels** menu lists Chat, Files, and Terminals in a fixed order; Tasks
and Workpads have their own buttons beside it.
A checkmark means the panel is already open, including when it is collapsed.
Select an open panel to focus or restore it, or a closed panel to open it.

Choose whether opening Chat, Files, Workpads, or Terminals normally shows that panel by
itself or alongside the panels already in the workspace. The choice belongs to
this browser or packaged client. Hold Shift while opening a thread, file, or
terminal to use the opposite presentation for that action. The descriptive
caret menus continue to open the requested panels together.

### Activity detail

Choose **Detailed activity** to receive expandable reasoning and tool details,
or **Activity summaries** to receive bounded counts, status, elapsed time, and
explicit provider-supplied summaries. Changing modes reloads the browser's
conversation projection. Summary mode reduces what the server sends to this
browser; it does not change provider retention.

### Show OpenAI skills in composer

When available, this user-level preference shows OpenAI Templates, Sites, and
Visualize skills across Codex connections. It controls discovery in the
composer, not installation of arbitrary skills or their provider permissions.

### Right Option focuses composer

Enable this to use the physical right Option/Alt key to focus the composer
before dictation. It is off by default because right Alt enters AltGr
characters on some keyboard layouts.

### Earlier messages

Choose how many earlier turns are loaded per history page: 5, 10, 25, 50, or
100. A larger page reduces paging but transfers and renders more conversation
at once. Bookmarks can seek to a distant turn without requiring you to page
manually through every intervening window.

### Seek on send

When enabled, a newly sent message stays pinned near the top while its reply
streams, leaving a stable reading area below it. The reserved space remains
until you scroll the last message to the composer or send again.

## Diagnostics

Open **Settings → Diagnostics** for streaming, thread-loading, seek, and composer
input troubleshooting controls. **Seek on send** itself remains in General.

These diagnostic categories are focused troubleshooting
tools. Leave them off for normal use. When support asks for a reproduction,
clear the browser-local diagnostics buffer, enable only the relevant category,
reproduce once, then use **Copy log**. The buffer is bounded and intended to be
content-free, but review diagnostic material before sharing it.

The bottom of this page shows **Version**: the Sedes build this client is
running, for example `Sedes 0.1.0`. When the connected server runs a different
build, the server's version is shown beside it. Include that line whenever you
report a problem.

Follow [Debug diagnostics](../developer/diagnostics.md) rather than enabling
every category indefinitely.

## Appearance

- **Theme** follows the system or forces Light or Dark.
- **Environment colors** visually distinguish configured execution
  environments. Choose a palette and tune tint intensity, fade, and coverage;
  individual environment assignments are derived rather than stored.
- **Animated chat background** adds a subtle point field behind conversations.
- **Smooth streaming** fades in response text and eases live-edge following.

The operating system's Reduce Motion preference disables the optional motion
effects even when their toggles are on.

## Prompts

**Settings > Prompts** manages one ordered library of reusable prompt text.

1. Choose **Add prompt**.
2. Give it a short title and the exact text to insert.
3. Save, then reorder the library as desired.

Edit or delete prompts from the same page. Choose the **Refresh prompts**
button if another client has changed the library. Titles and text follow the Sedes user across clients;
there is no per-prompt desktop/mobile assignment.

Enable **Show Prompts** to make the library available from this client's
composer. Choose **Above composer** or **Composer toolbar** placement. Show and
placement are browser-local even though the library itself is server-side.

For picker behavior, see
[Use a saved prompt](conversations.md#use-a-saved-prompt).

## Mobile

The composer shows the same compact reasoning selector as desktop, such as
**High**, when the selected backend offers it. Model and other settings remain
available through **Thread actions**, which lists the thread's settings on
every device. When the composer's controls do not fit, the reasoning selector
steps aside until there is room again.

**Refocus composer after sending** returns focus to the message field after
Send, Queue, or Steer in a mobile layout so the on-screen keyboard remains
available. Turn it off when you prefer the keyboard to dismiss. It does not
change desktop focus behavior.

**Show history seek control** displays the draggable history control beside a
conversation on mobile layouts. Turn it off to remove the control and its touch
target. Desktop history navigation is unchanged.

## Terminal

**Cursor blink** controls both regular terminals and the Codex TUI on this client.
It defaults off on Windows and on elsewhere. On Windows, leaving it off reduces
idle rendering; changing it does not reconnect sessions. Detection uses the browser
or Electron renderer's platform, not the backend server's OS. The choice is stored
locally in this browser or packaged client and is not server or thread policy.

Terminal settings apply to managed browser terminals, including eligible Codex
TUI sessions:

- **Confirm before ending active terminals** is enabled by default and applies
  only to this client. Clicking a terminal tab’s **X** offers **Cancel**,
  **Close tab** (leave it running), or **End terminal** (end it and remove its
  history). Persistent remote terminals require confirmed sidecar process
  cleanup too. Older transport-only records can show **Disconnect and remove**;
  that action confirms connection closure, not remote process cleanup. Turn
  confirmation off to act directly with
  **X**. Ended terminals are always removed without confirmation. Removal
  affects the terminal and its retained history across clients. Closing the
  panel or using Android Back only closes the views. The panel’s **+** menu
  also lets you remove terminals without opening their tabs.
- **Font size** controls terminal text size.
- **Scrollback** controls how many terminal lines, from 1,000 through 20,000,
  the current browser retains in memory.

Font size and scrollback do not change provider history or terminal process output. The
server independently retains up to 20,000 rows in its bounded restore
checkpoint. Increasing browser scrollback cannot recover rows erased by a
terminal `CSI 3 J` sequence or history removed by **End terminal** or **Remove
terminal**.

## Voice

The Android app's **Voice** page configures
[Android voice](../operator/clients/voice.md) for the selected server
connection. Its settings are saved on this device for
that connection and Sedes user. The caret on the voice card opens a **Voice**
sheet with Audio mode, Auto-listen, and Follow composer mode; its **All voice
settings** row opens this page.

While voice connects, the page shows **Connecting voice to this server…**. If
voice cannot connect, it shows the error and **Retry voice connection**; the app
also retries on its own and when it returns to the foreground. The rest of the
app does not wait for voice.

- **Audio mode** chooses Off, Manual, or Response. **Enable voice** selects
  Response, and **Resume voice** restarts a stopped voice session. The status
  line below reports what voice still needs, such as microphone permission,
  speech configuration and a key, or the Sedes notification connection. When
  notifications are unavailable, explicit recording still works.
- **Speech provider** selects OpenAI or **Own speech server**.
  Configure its endpoint, transcription and speech models, voice, and speed.
  The catalog offers available model and voice suggestions. Credentials are
  entered in a native dialog and stored encrypted on this device for that
  provider and endpoint; they are separate from the Sedes pairing credential.
- **Show voice bar when off** keeps a dimmed voice card under the composer
  while Audio mode is Off, so its Voice sheet can turn voice back on. By
  default Off hides the card. The switch changes only what the app shows.
- **Voice thread** is the target for explicit recording when no thread is
  visible. Its picker lists the current Voice thread first. Untitled threads
  appear as **Untitled thread**.
- **Microphone input** lists Android's inputs. Inputs that share a name add
  their type, such as Bluetooth or USB, and then a number.
- **Pending input recovery** lists spoken messages whose delivery is uncertain.
  Voice keeps checking them without resending. **Resume input** checks again
  and resends the same message only if Sedes never received it. **Discard**
  deletes the saved message from this device and stops checking; it cannot
  withdraw a message Sedes already received.

Up to three recent voice errors appear at the top of the page. **Clear errors**
hides them on this device until a newer error occurs.

## Server and connection

Android exposes **Server** settings for its saved direct connections. Under
**Add a connection**, enter a **Connection name** and the complete HTTP or HTTPS
**Sedes server URL**, choose **Add & connect**, then enter the server's pairing
code. Paths and embedded credentials are not accepted. **Saved connections**
marks the **Selected** one and offers **Connect** and **Remove…** for each.

Electron instead exposes **Connection** settings. The current connection is
shown there; choose **Switch connection** to leave the current server and open
the connection chooser. The chooser provides:

- **Local**, a built-in connection that runs only for this Electron application
  session;
- **Direct** asks for a complete HTTP or HTTPS server origin; and
- **SSH** asks only for a system OpenSSH host alias and the remote Sedes port.

Local uses private configuration and state beneath Electron's user-data
directory. It stops when Electron exits and is not a background service.
Opening the chooser does not stop it. Choosing Direct or SSH asks for
confirmation because active Local agents and terminals will end after the
replacement connects. A failed or cancelled candidate restores Local; a
successful switch stops Local before showing the replacement. Connections do
not share or migrate server state.

Electron tries the last connection that completed session validation on its next
launch. A failed attempt returns to the chooser instead of selecting another
server. User names, keys, agents, proxy jumps, and host verification for an SSH
profile come from the desktop account's existing OpenSSH configuration; Sedes
does not store them or prompt for passwords and passphrases. Provider
executables and authentication needed by Local remain separately installed for
the desktop account.

Plain HTTP is unencrypted. Use it only for an explicitly configured Sedes
server on a private network whose clients you trust. Prefer private HTTPS such
as Tailscale Serve whenever traffic leaves a same-device path, or use
Electron's managed SSH connection to a remote loopback server. See the
[Android](../operator/clients/android.md) or
[Electron](../operator/clients/electron.md) guide before connecting a packaged
client.

## Related controls outside Settings

Thread templates are managed from **New thread**. See
[Manage thread templates](organize-work.md#manage-thread-templates).

Per-thread Sedes tool policy is managed through **Thread actions > Agent
tools…**. See [Let an agent use Sedes tools](provider-features.md#let-an-agent-use-sedes-tools).

## Tool clients

**Settings > Tool clients** creates credentials for external users of the
generated `sedes` CLI. This is an advanced integration feature, not required
for ordinary browser use.

A Tool client has:

- a name;
- exact allowed tool IDs;
- a required default execution environment;
- an explicit set of allowed environments;
- optional default location and thread selections; and
- enabled, disabled, rotated, or revoked credential state.

A project's Tasks and Workpads are reachable when any environment that hosts
one of the project's active locations is allowed. Listing them together with
the Tasks of the project's threads needs every such environment, and a project
with no active location is not reachable. The default location's project is
the client's current project while that location is active.

Creation and rotation show the bearer token exactly once. Choose **Reveal
token** and copy the generated configuration before closing the dialog; Sedes
cannot show the value later. If a create or rotate response is lost, explicitly
rotate again or revoke it. Disable is reversible, rotation invalidates the
previous generation, and revoke is permanent.

The copy action warns before placing a durable token in plain-HTTP
configuration. A bearer token sent over HTTP can be read by anyone able to
observe that network. Prefer an HTTPS endpoint and grant the smallest tool and
environment set needed.

Previous: [Provider features](provider-features.md) · Next:
[Troubleshooting and recovery](troubleshooting.md)
