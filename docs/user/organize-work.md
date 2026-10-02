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
| **Projects** | Browsing by project, with optional fork-family nesting |
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

The Projects view shows one group per project. When a project has more than
one location, each row is tagged with only what tells its location apart: a
remote environment when the project spans environments (Local is never named),
and the folder when the project has several folders on that environment and
the folder name differs from the project's. Cards in Timeline, State, and Flat
list name the project the same way, for example `sedes › sedes-context`.
Search matches project names as well as location paths and environment names.

## Thread activity indicators

Each thread row shows one leading activity indicator. Failures and requests
for your input or approval take priority. After those, the order is:

1. A blue spinner while the main turn is active.
2. A blue dot when a turn finished while you were away and you have not
   acknowledged its completion. The title keeps its slightly heavier weight.
3. A slower grey spinner while subagents are still working.
4. A solid grey dot while background commands or other background tasks remain.
5. The ordinary draft, schedule, inventory, or idle presentation.

Opening the thread acknowledges completion. If background work remains, its
indicator then appears. Hover the indicator for separate subagent and command
counts; the thread preview uses the same priority. Reduced-motion preferences
keep the subagent ring static. Background work alone does not emphasize the
title or change the thread's input controls.

These observations are supplied by the backend, currently Claude. Sedes hides
background indicators when their live state is unknown, the runtime is unloaded,
or the application is reconnecting; absence is not proof that external work
has stopped.

## Manage projects

A project groups the directories you work in, across your environments. Each
directory on one environment is a **location** of exactly one project, such as
the same repository checked out on this computer and on an SSH host, or
several related repositories on one host. Open **Settings → Projects** to see
every project with its locations underneath. A project row shows its name and
location count; a location row shows its environment, path, availability, and
thread count. Removed projects and locations stay listed with a **Removed**
tag. Allowed workspace roots remain separate: adding a location remembers a
directory within existing access grants.

Filter by environment, status, or search text. The filters apply to
locations, and a project is shown when any of its locations matches, with only
the matching locations under it. A project without locations stays listed
unless you filter by environment.

**Add project** asks for a directory and the project it joins: a new project,
named after the folder and editable, or an existing project, listed with the
environments that host it ("sedes — on Local, aw-personal +1"). An existing
project is preselected only when exactly one project has the folder's name and
it has no location on the chosen environment, which is the same repository on
another host; otherwise a new project is the default. A project's **Add
location…** action opens the same dialog for that project. Adding a directory
that is already a location never duplicates it:

- an active location is selected in its project, and a removed one is restored
  into its project;
- when you chose a different existing project, **Move here** moves the
  location there instead, restoring it if it was removed; a removed location
  can also be restored in its own project with **Restore in**;
- a location of a removed project offers **Restore project** or **Add to
  another project**, which moves the location to the project you chose and
  restores it.

The same directory spelling on another environment is a separate location.

Use a project's menu to **Rename** it, to **Merge into** another project, or to
remove or restore it. Use a location's menu to **Move to project**, which can
also split it into a new project, or to remove or restore it. Moving or merging
carries a location's threads, Tasks, Workpads, and other saved records with it.
A merge moves every location of the project, removed ones included, and then
deletes the merged project; it can't be undone. Running, queued, or uncertain
work blocks moving and merging.

When several active projects share a name, an inline note above the list names them
with a **Merge** action, so separately added checkouts of the same work can be
combined.

**Remove location** hides one location and its threads from ordinary inventory
and creation pickers. Its directory, Git worktrees, provider history, drafts,
Tasks, and other saved records remain intact, and thread inventory states are
preserved. End live or interrupted terminals, resolve running, queued, or
uncertain work, and pause enabled schedules first. Removal stops new work and
conversation discovery for that location. When it is the project's last active
location, you can also remove the project in the same step.

**Remove project** removes every active location of the project at once. If
anything blocks it, Sedes lists every blocker by location, such as running
work, enabled schedules, terminals, or busy agents, with the affected threads.
**Restore project** restores the project and lets you choose which removed
locations to restore with it; the locations its removal took on available
environments are preselected, and each one reports whether it was restored. A
location of a removed project is restored with its project, or by moving it to
another project and restoring it there.

Restoration rechecks current access to each directory; paused schedules remain
paused until explicitly enabled. Removal retains storage; it is not a permanent
data purge.

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

Project Scope lists the projects with a location on the scoped environment, or
every project when neither an Environment nor a Target is selected. Selecting a
project includes all of its locations, including unavailable locations'
historical threads. Environment and Target narrow those results. A selected
project stays selected when you change environments; a combination where the
project has no location shows an empty result. Projects with the same name
are told apart by their environments or paths.

A project-name filter saved by an earlier version of Sedes becomes a project
filter once the sidebar has a current inventory, when exactly one project
matches the name; otherwise it is cleared.

With **Click project and environment names to filter** enabled in
**Settings → General**, project links on sidebar cards filter to that project.
Environment links narrow by the specific environment. Tasks, files, and agent
permissions keep their existing location and environment boundaries.

Changing Environment clears an incompatible Target. Choose **Ungrouped** to see threads without a Group, or
**Clear** to reset the entire Scope without changing search or visibility
toggles.

Environment, Target, and Project Scope prefill **New thread**: the scoped
project is preselected, its locations are limited to the scoped environment or
target, and a scoped target is preselected. When the scoped project has no
location there, choose another project.
Group Scope only filters inventory; creating a thread while a Group
is selected does not assign that thread to the Group. Use the new thread's
context menu to add or move its Group membership.

Scope affects sidebar results, counts, shelves, and defaults in **New thread**,
and the list in **Archived**. It does not move or retarget the thread already
open in the workbench. An out-of-scope routed thread may remain open.

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

**Move to group** opens a searchable list of your Groups with the current one
checked; on a phone it opens as a sheet. Type in **Search groups** to filter,
then select a Group with the pointer or the arrow keys and Enter to move the
thread there. When nothing matches, **Create group “name”** creates that Group
and moves the thread into it in one step. **Remove from group** takes the
thread out of its current Group, and **New group…** opens a small dialog that
asks only for the **Group name** (prefilled with your search) and creates the
Group with this thread in it. Typing a search never changes membership.

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
remain attached. If open Tasks exist, the settlement preview lists them. Choose
whether to move them to the project or global list, keep them open, or
**Complete all** while leaving them attached to the thread.

## Archive finished work

Archive removes a thread from the normal sidebar and blocks new delivery until
the thread is restored. Choose **Archive** from the thread's menu or row. Sedes
first checks the thread; when nothing needs a decision, it archives at once.
When the thread has forks, open Tasks, stashed prompts, pending questions, or an
isolated workspace, **Archive this thread** opens so you can choose first.

Open **Archived** from the sidebar's **More** menu to find archived threads,
open them read-only, or restore them. The list follows the sidebar's Scope and
shares its search, so narrowing one narrows the other; the sidebar's Show
toggles and pinned-only do not apply. A line under the search box shows how
many archived threads match, the active Scope, and the search. Choose **Clear
scope** there to reset the shared Scope, which matters on phones where the
sidebar is hidden.

**View options** sorts by **Recently archived** (the default), **Last active**,
or **Title**, and groups by **Date**, **Project**, or **None**. Title order is
never grouped by date. Sedes remembers these choices on this device. Each row
shows the backend, the title on up to two lines, the project, a Target whose
name differs from its backend, the thread's worktree branch, and marks for an
unavailable project, environment, or Target. The age at the end of the row is
the time since archiving (or last activity when sorted that way); hover the row
for both dates. A fork shows the fork mark before its age; choose it to open
the fork point in the source thread. The page shows 100 threads at a time;
choose **Show more** for the next 100.

Choose the restore button at the end of a row to return the thread to Active;
right-click or long-press a row for the same **Restore to Active** and the
thread's other actions. A failed restore leaves the row in place with the
reason.

Archiving preserves the transcript, title, pin, Group membership, stashes, and
other durable thread state. A restored pinned thread returns pinned. Archive is
not deletion.

Fork families can have descendant Tasks and stashes. The archive preview lets
you choose the supported family scope and requires an explicit disposition for
open Tasks. **Complete all** completes the open Tasks in that selected scope
and leaves them attached to their owning threads. Read the preview instead of
assuming that archiving a parent also archives or completes its descendants.

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

Open **Settings → Agents** (`/settings/agents`), or **More → Agents** in the
sidebar footer, to create a reusable backend configuration and Sedes agent-tool
policy, including reusable environment-variable overrides. Choose **Create
Agent** for a new one, or select an Agent to edit it; **Delete Agent** is in
its **Danger zone**. **Create an Agent** in **New thread** opens the same form.
The **Project** and **Configure using** target under **Validate against** are
validation context, not fields stored in the Agent.

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
