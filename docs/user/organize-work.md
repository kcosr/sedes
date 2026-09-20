# Organize and reuse work

Sedes separates a thread's conversation state from how it appears in your
working inventory. You can reorganize threads without changing provider
history, and a running thread does not have to remain in the Active inventory
state.

## Choose a sidebar organization

Timeline is the default on clients without a saved sidebar view. Your saved
view choice stays in effect. **Add project** is always available beside **New
thread**, and you can also add a project while choosing one for a new thread.

Open **View options** and choose one layout:

| View | Best for |
| --- | --- |
| **Projects** | Browsing by repository or workspace, with optional fork-family nesting |
| **Timeline** | Seeing recent activity and future snooze or automation deadlines |
| **State** | Separating attention, running, scheduled, idle, snoozed, and settled work |
| **Flat list** | A compact working set without time or state headings |

Each view remembers its own sort. Timeline, State, and Flat list also remember
their own density, detail, and **Pinned only** choices. Visibility controls for
draft, snoozed, and settled threads apply across views. Collapsed sections,
projects and fork families are saved locally on this client and restored
when you reopen the sidebar or reload the app. Explicitly collapsed projects
stay collapsed even when they contain the current thread.

Large groups initially show a bounded recent set, with an expander for older
rows. An active search shows all matches, and the selected thread remains
visible.

## Manage projects

Open **Settings → Projects** to list remembered directories,
filter by environment, add projects, or remove them from active use. The list
includes unavailable environments. Allowed workspace roots remain separate:
adding a project remembers a directory within existing access grants.

**Remove** hides a project and its threads from ordinary inventory and creation
pickers. Its directory, Git worktrees, provider history, drafts, Tasks, and other
saved records remain intact. Thread inventory states are preserved. End live or
interrupted terminals, resolve running/queued/uncertain work, and pause enabled
schedules before removing the project. Removal stops new work and conversation
discovery for that registration.

Choose **Removed projects** in the project status filter to restore a project. Adding the same
canonical directory in the same environment also restores the original project
and its associations automatically. Adding an already remembered directory
selects the existing project without duplicating it. The same directory spelling
on another environment is a separate project. Restoration rechecks current
access to the directory; paused schedules remain paused until explicitly enabled.
Removal retains storage; it is not a permanent data purge.

## Narrow the sidebar with Scope

The collapsible **Scope** controls filter in this order:

1. Environment
2. Target
3. Project
4. Group

Open a Scope dropdown and type to narrow its choices by name or context, such
as a project path, environment name, or target backend. Environment and backend
icons identify choices in the list and the selected value. Searching does not
change Scope until you choose an option. Use Up/Down to move through results,
Enter to select, or Escape to close without changing the selection. **All** and
**Ungrouped** choices remain available while searching.

Project Scope lists each base project name once. Selecting a name includes
all remembered projects with that exact name across environments, including
unavailable projects' historical threads. Environment and Target narrow those
results. A selected name stays selected when you change environments; a
combination with no matching projects shows an empty result.

With **Click project and environment names to filter** enabled in Settings,
project-name links on sidebar cards apply the same combined name filter.
Environment links narrow by the specific environment. Project stacks and the
Projects view still keep each registered directory separate, and Tasks, files,
and agent permissions retain their existing project and environment boundaries.

Changing Environment clears an incompatible Target. Choose **Ungrouped** to see threads without a Group, or
**Clear** to reset the entire Scope without changing search or visibility
toggles.

Environment, Target, and Project Scope can prefill compatible values in **New
thread**. When a project name matches several eligible environments, choose
an Environment in the existing creation form. The Project dropdown then
resolves a directory within that environment; duplicate names include paths.
An explicit Environment or Target scope already determines the machine.
Group Scope only filters inventory; creating a thread while a Group
is selected does not assign that thread to the Group. Use the new thread's
context menu to add or move its Group membership.

Scope affects sidebar results, counts, shelves, and defaults in **New thread**.
It does not move or retarget the thread already open in the workbench. An
out-of-scope routed thread may remain open. Archived threads use a separate
search surface.

## Find imported provider conversations

After you open a project, Sedes discovers eligible native conversations that
the configured backend reports for that remembered directory. A discovered
conversation appears as a Sedes thread with its provider history; there is no
need to paste or replay its messages into a new thread.

Discovery is intentionally limited to remembered projects and configured
targets. If an expected conversation is absent, confirm the exact project,
execution environment, target, provider account/store, and current Scope. Sedes
does not scan unrelated directories or adopt a conversation from another
provider identity merely because its title or working path looks similar.

An imported thread may initially have no displayable history. It still retains
its native binding and can accept new work when the backend reports the thread
as available and its settings are admitted.

## Search the inventory

Sidebar search filters the currently selected working inventory. It combines
with Scope, inventory visibility, and Pinned-only settings. Search bypasses
thread-group stacking so a matching child is never concealed inside a stack.

Use [Find in thread](conversations.md#find-text-in-a-thread) for text inside one
conversation; sidebar search and transcript search serve different purposes.

## Pin important threads

Pin or unpin a thread with its row action or context menu. Pinning is independent
of Active, Snoozed, Settled, and Archived state.

- Timeline, State, and Flat list extract matching pinned threads into a
  collapsible **Pinned** section, without duplicating them elsewhere.
- Projects keeps its workspace tree and shows the pin on the ordinary row.
- **Pinned only** limits the selected projection to pinned threads.
- A pin survives snooze, settle, wake, archive, and restore.

Pin state follows you across clients. The selected view, Pinned-only setting,
and whether the Pinned section is expanded are local browser preferences.

## Create and use Groups

Each thread may belong to one persistent Group. From a thread's context menu,
you can:

- create a Group using the thread title as an editable starting name;
- move the thread into an existing Group; or
- remove it from its current Group.

**Move to group** opens a searchable picker on desktop and mobile. Type to
filter Group names, then select a destination with the pointer or arrow keys
and Enter. Your current Group is disabled. Escape closes the picker without
moving the thread. **Create group** and **Ungroup** remain available while
searching; typing a search never changes membership.

Select a Group in Scope to filter to it. From that Scope menu you can rename or
delete the selected Group. Deleting a populated Group requires confirmation
and leaves its threads ungrouped; it does not delete or archive them. Empty
Groups remain available until explicitly deleted.

Group membership survives snooze, settle, and archive. Card-density rows show
the Group as a quick-filter badge; compact rows omit the badge.

## Stack related rows

The independent **Stack** setting can be:

- **Off**;
- **Thread groups**, using persistent Group membership; or
- **Projects**, using each thread's existing project.

Stacking is presentation only. It creates no provider relationship and no new
server-side hierarchy. Single threads remain ordinary rows. A stack face
shows the first visible member after the current organization and sort have
been applied. Clicking or keyboard-activating the face opens that thread. On
desktop, hover opens the complete member roster; **View threads** in the stack
context menu provides the keyboard-accessible route. On mobile, open the stack
with a long press or context click to show one bottom sheet containing both the
visible member cards and the stack actions. Select a roster member to open that
thread.

The action location determines the action scope:

- **Settle**, **Unsettle**, and **Archive** on the stack face, its context menu,
  or the mobile roster header apply to the stack.
- Actions on a roster member apply only to that thread. Pin, Snooze, Rename,
  Fork, and other thread-specific actions are available there rather than on
  the stack face.

Every stack action requires confirmation. The preview states how many visible
members the stack contains, how many will change, and whether Tasks, stashes,
or active work need attention. A mixed stack can offer both Settle and
Unsettle; members already in the requested state remain unchanged.

The confirmed target is exactly the roster visible when confirmation begins,
after Scope, search, visibility, organization, and sorting have been applied.
It does not silently include hidden project or Group members, or fork
descendants outside that roster. If any target becomes stale or blocked, none
of the stack is changed. Archive retains isolated execution workspaces.
Restore remains a per-thread action in **Archived**; there is no bulk stack
restore because archived threads are not part of a visible working stack.

The visible parent is the first member after Scope, visibility, organization,
and sort have already been applied. Selecting another member highlights the
stack but does not reorder it. Exact Group Scope and active search bypass
thread-group stacking.

## Snooze work until later

Use **Snooze** when a thread should leave the immediate working set until a
specific future time. Depending on the selected view and visibility settings,
it appears in Snoozed or Upcoming.

Choose a local **Wake date and time**, or use **1 hour**, **Tomorrow**, or
**Next week**. You may add a reminder of up to 1,000 characters; it appears when
the thread wakes so the reason for the follow-up is not lost.

To keep the thread Active and show that same durable, dismissible reminder
immediately, enter the reminder and choose **Remind now**. This does not briefly
move the thread through Snoozed or schedule a deadline.

A snoozed thread wakes when its deadline arrives or when qualifying new runtime
activity requires attention. The wake remains visible until acknowledged.
Pinning and Group membership remain intact.

Snooze is organization, not a provider timer or pause. It does not stop an
active provider turn. Sedes prevents unsafe transitions, such as snoozing after
an automation run has begun dispatching.

## Settle quiet work

Use **Settle** when work is complete or quiet enough to move below the main
working set but should remain readily accessible.

- Timeline and Flat list place unpinned settled threads in a bottom **Settled**
  section.
- State has its own Settled group.
- A pinned settled thread remains in Pinned.
- Projects retains its normal project structure.

Settled is a manual label, not a claim about provider success. Starting new
manual or automated input automatically returns the thread to Active. Stashes
remain attached. If open Tasks exist, review the settlement preview and choose
their disposition explicitly.

## Archive finished work

Archive removes a thread from the normal sidebar and blocks new delivery until
the thread is restored. Open **Archived** to search archived threads, inspect
them read-only, or choose **Restore to Active**.

Archiving preserves the transcript, title, pin, Group membership, stashes, and
other durable thread state. A restored pinned thread returns pinned. Archive is
not deletion.

Fork families can have descendant Tasks and stashes. The archive preview lets
you choose the supported family scope and requires an explicit disposition for
open Tasks. Read the preview instead of assuming that archiving a parent also
archives or completes its descendants.

An active automation run prevents archiving until that run leaves its unsafe
dispatch state.

## Understand row badges and counts

Rows can surface running or attention state, scheduled work, draft state,
stashes, bookmarks, pins, and open Tasks. Counts are deliberately local:

- stash and bookmark counts belong to that thread;
- only open Tasks directly owned by a thread contribute to its Task count;
- workspace/global Tasks and Tasks owned by descendants are not rolled into a
  parent row.

## Manage saved Agents

Use **More > Agents** to create a reusable backend configuration and Sedes
agent-tool policy, including reusable environment-variable overrides. The project and **Configure using** target in the Agent
editor are validation context, not fields stored in the Agent.

At thread creation, Sedes combines the chosen project, Agent, and compatible
target. It then copies the resolved settings into the new thread. Existing
threads do not change when you revise the Agent later. **Session stats** keeps
the captured Agent name and revision as origin information.

The **Environment variables** section previews defaults from **Configure
using**. Only the Agent's own overrides and explicit unsets are saved; inherited
values are resolved again when creating a thread. Startup variables belong to
environment/backend Settings and are not Agent configuration.

## Manage thread templates

Thread templates are available from **New thread**. They require a saved Agent
and store project, target, execution-workspace choice, the Agent reference, and
thread-variable overrides.
They do not store the title.

After editing prefilled values, use the form's actions to update the current
template, save a new template, or reset. Deleting a template does not delete
its Agent or any threads. Deleting a referenced Agent, project, or target leaves
the template visible as **Needs attention** until repaired or deleted.

Previous: [Conversations and the composer](conversations.md) · Next:
[Files and context](files-and-context.md)
