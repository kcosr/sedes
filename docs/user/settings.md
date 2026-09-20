# Settings

Open **Settings** from the sidebar footer. Some settings follow the Sedes user
through the server; many appearance and interaction choices belong only to the
current browser or packaged client.

Settings opens as a page in the main workspace. On desktop, use the category
list on the left. On phones, choose a category from the Settings home page or
use the **Settings category** picker at the top; it stays visible while you
scroll. **All settings** returns to the category list.

Categories have direct links, such as `/settings/backends`, and support browser
Back and Forward. The Back control inside an environment or backend returns to
its list or detail. **Back to chat** returns to the thread you were viewing,
keeping its draft, uploads, scroll position, and terminal sessions. Running work
continues while Settings is open. Opening Settings directly offers **Back to
workspace** instead.

Category navigation and the return destination are local to the current client
session; they do not change ownership or persistence of the settings below.

**Click project and environment names to filter** (General) is off by default
and saved on this client. Enable it to click or tap an underlined project or
environment name on a sidebar thread card to filter the thread list without
opening the thread. Keyboard users can focus a name and press Enter or Space.
Back clears active sidebar filters as usual. Environment names, including Local,
appear when there are multiple environments; they are hidden when there is only
one or the current scope already identifies the environment.

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

Use **Environments** to browse local, SSH, and paired outbound environments.
Search by name, host alias, or associated backend, and filter runtime states.
Open an environment to see its **Backends**, edit
**Configuration**, or inspect **Activity & diagnostics**. **Add backend** in that view uses the selected
environment. **Add environment** offers Local machine, SSH host, and Pair a host;
connector setup instructions appear only in the pairing flow. When a host awaits
approval, choose **Review hosts** from the environment directory.

The global **Backends** view groups Pi SDK, Codex, Claude, and local Grok
configurations by environment. Search backend or connection names, hosts, and
provider types; combine environment, provider, and status filters. **Needs
attention** includes pending or unapplied configuration, runtime errors, upgrades,
and unknown operation outcomes. Returning from a detail or editor preserves
inventory filters and scroll. **Edit** and the row action menu stay visible.
On phones, compact rows keep more backends in view. Tap **Filters** to open
the full-width filter controls; its badge shows how many filters are active.

Provider executables and authentication must already be installed for their
execution account. Pi's SDK and provider connection run on Sedes; a remote Pi
environment supplies workspace tools. Credential fields refer only to approved
host-scoped credentials; Settings never displays their values.

Choose an environment before a backend type when adding from the global view.
Unsupported types are disabled for that environment. All named connections for
one backend share its environment, and existing environment bindings remain
fixed. **Default connection for new threads** is account-wide; its chooser names
Environment / Backend / Connection. **Research provider** configures the local
research tool on Sedes separately from environment backend groups.

Configuration saves follow this Sedes user across clients and restarts. The
saved revision is the desired setting; the applied revision and status show
what the runtime has confirmed. Another client's edit can cause a conflict:
refresh and review before saving again. Leaving unsaved edits asks whether to
discard them. Existing thread identities cannot be redirected to a different
host, provider home, or native store by editing labels. Create a new target
identity for different execution authority.

Inventory runtime state, configuration application, and host connection have
separate labels: an online host need not have a connected provider, and a disabled
backend can still own a running runtime. Open a backend, or an environment's
**Activity & diagnostics**, for the explanation and **Actions** menu. A relevant
primary action such as **Retry connection** may also appear. The menu stays in a
consistent location and order, offering only supported actions for the current
state. **Diagnostics** reveals saved/applied revisions, version and upgrade
state, connection preference, and active resources.

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

Add literal values or secret references. An **Environment reference** names a
variable on the execution host. A **Protected file reference** names an absolute
file path there. Secret values are resolved by the host and are never returned
to the editor. References remain visible so you can review which credential is
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

Open **Settings → Projects** (or `/settings/projects`) to manage remembered
directories. This page includes removed projects and projects on unavailable
environments. Search by name or path, or use the searchable environment and
project status selectors. On mobile, choose **Filters** to open these selectors.

Choose **Add project** to browse an existing directory or enter its absolute
path. On mobile, Add project opens as a bottom sheet. The same action is available
beside **New thread** in every sidebar view and inside the New thread form.
Adding from the form preserves your inputs and
selects the project after it becomes available. Allowed workspace roots are
access grants configured separately in the environment's **Configuration**.

**Remove** hides the project and its threads from the working inventory and
creation choices. The confirmation shows its thread count. Files, history,
drafts, and saved application data remain intact. Stop running or queued work,
resolve uncertain operations, pause schedules, and end terminals before removal.

Select **Removed projects** in the status filter and choose **Restore** to use a
project again. Adding the same directory on the same environment also restores
its original identity and associations. Restoration rechecks current directory
access; unavailable hosts or revoked roots may require attention first. Paused
schedules stay paused. See [Manage projects](organize-work.md#manage-projects)
for the retention behavior.

## Notifications

Configure **Settings → Notifications** to invoke one executable script on the
Sedes server when a selected event occurs. Enter its absolute **Script path**,
optional **Arguments** (one argument per line), and **Timeout**, choose events,
then enable notifications and save. Settings follow the current Sedes user
across clients and server restarts.

Available events are **Turn completed**, **Turn failed**, **Turn interrupted**,
**Snooze wake**, **Automation started**, **Automation failed**, **Approval requested**,
and **Input requested**. A turn event
requires an authoritative terminal outcome; a pause in output or a disconnected
backend does not count. Snooze wake means its deadline was reached. A completion
that wakes a snoozed thread produces the selected turn event, not an additional
wake notification. Manual wake and Remind now do not emit notifications.
Automation started means the agent input was accepted after any pre-check;
becoming due, waiting in the queue, and a pre-check skipping a run do not count.
Automation failed covers definitive failures before successful acceptance.
Approval requested covers new approval decisions and confirmation dialogs. Input
requested covers new blocking questions, choices, text input, and editor requests,
including Codex blocking questions. Nonblocking questions covers questions an
agent asks while it keeps working, such as Codex async questions; the
notification carries the question count, never the question text. These three
events are opt-in. They fire when the backend accepts a new request, even
without an open browser; reconnecting or redisplaying the same pending dialog
does not notify again. Answering, approving, rejecting, or dismissing a request
does not send a notification or affect an already emitted hook.

The bell in application navigation **silences** external notifications without
changing their configuration. A blue bell indicates notifications are enabled
and unsilenced; a gray slashed bell indicates they are silenced or disabled in
Settings. Silence follows the user across clients and
restarts. Resuming does not send a backlog. Opening a thread, acknowledging its
completion, or dismissing a wake reminder has no effect on these passive hooks.
An already running script cannot be unsent.

**Send test notification** invokes the script using the fields currently in the
form, including unsaved edits. It works while disabled or silenced and displays
an immediate result. It does not save the form. Regular events have no delivery
history, read receipts, or automatic retries. Hooks are best effort: events may
be lost during shutdown or when script execution is at capacity, and script
failures never fail agent work.

For the JSON input contract and server-side execution behavior, see
[Notification scripts](../operator/configuration.md#notification-scripts).

## General

### Opening panels

The **Panels** menu lists Chat, Files, Workpads, and Terminals in a fixed order.
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

Edit or delete prompts from the same page. Choose **Refresh** if another client
has changed the library. Titles and text follow the Sedes user across clients;
there is no per-prompt desktop/mobile assignment.

Enable **Show Prompts** to make the library available from this client's
composer. Choose **Above composer** or **Composer toolbar** placement. Show and
placement are browser-local even though the library itself is server-side.

For picker behavior, see
[Use a saved prompt](conversations.md#use-a-saved-prompt).

## Mobile

The composer shows the same compact reasoning selector as desktop, such as
**High**, when the selected backend offers it. Model and other settings remain
available through thread settings.

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

## Server and connection

Android exposes **Server** settings for its one locally saved direct endpoint.
Enter the complete HTTP or HTTPS origin, choose **Test**, then **Save &
connect**. Paths and embedded credentials are not accepted.

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

Saved Agents and thread templates are managed through **More > Agents** and
**New thread**, not the Settings page. See
[Organize and reuse work](organize-work.md#manage-saved-agents).

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
- optional default project/thread selections; and
- enabled, disabled, rotated, or revoked credential state.

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
