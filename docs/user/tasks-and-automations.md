# Tasks and automations

Tasks remember work outside a transcript. Automations start work on a schedule.
They complement provider conversations but do not replace them.

Use **Pin new task** in the add row to choose the new task's pin state. The
paste-many dialog has an independent **Pin these tasks** switch. A pinned-only
view starts with pinning enabled, and either control can override that default.

## Track work with Tasks

A Task contains:

- a title;
- optional notes or follow-up steps;
- complete, pinned, and backlog state;
- optional absolute file references; and
- one scope: Global, Project, or Thread.

Tasks belong to the current Sedes user and survive restarts. They are not
provider conversation messages, Git issues, or TODO comments in the project.

Choose scope by where you expect to find the work later:

| Scope | Use it for |
| --- | --- |
| **Global** | Work not tied to one repository or conversation |
| **Project** | Work shared by several threads in one project |
| **Thread** | Follow-up owned by one conversation |

A Project Task belongs to the whole project, so every
[location](concepts.md#project-and-location) of the project lists it, on every
host. It stays with the project when you move or remove a location, and is
hidden while the project is removed. A Thread Task follows its thread.

Pin a Task to keep it at the top of its section. Send a Task to the
**Backlog** when it is still open but not current work: it waits in a
collapsed **Backlog** section, out of the way but not lost. Pin and Backlog are
independent, so a pinned backlog Task is a high-priority backlog item and sits
at the top of the Backlog section.

Complete a Task when the work is done. Completing a Task unpins it and takes it
out of the Backlog; reopening it returns it to the open list. Completion does
not send a provider message or park its thread.

## Open Tasks

Tasks appears beside a thread. In a thread, choose **Tasks** from the
**Panels** menu (▾) in the workbench bar, or press Ctrl+Shift+L
(Command+Shift+L on macOS) to show or hide Tasks, opening it if needed. While
Tasks is loaded, the **Tasks** button (the checklist icon) in the bar shows or
hides it too. Home, Archived, Usage, and the automation pages have no Tasks; to
see Global Tasks, open any thread and choose **Global**.

On desktop, Tasks is a workspace panel, on the Right by default, in place of
whatever the Right showed. Like Files and Workpads, you can resize it,
maximize it, move it to another region from **Tasks panel actions**, or close
it (see [Arrange panels](conversations.md#arrange-panels)). It stays loaded,
and in the same place, as you switch threads, and its content follows the
current chat. While Tasks is hidden, by you, by another panel opened in its
region, or to make room, the button keeps an outline; select it to show Tasks
again.

On phones and other narrow screens, Tasks is a panel like Files and
Workpads: it comes in front, and its button appears once it is loaded.
Hiding it with its button, or Android Back, returns to Chat and keeps it
loaded; **✕** closes it and returns to Chat (see
[Arrange panels](conversations.md#arrange-panels)).
Resizing the window across that width keeps Tasks as it was, with any edit
in progress.

The button's badge counts the current thread's open Tasks, backlog Tasks
included. The Tasks header counts the view's open Tasks, Backlog included,
like its scope segment, or "1 of 3" while a search or **Only** narrows them.

Only open Tasks directly scoped to a thread, backlog Tasks included,
contribute to that sidebar row's Task count. Project and global Tasks, and Tasks on fork descendants, are not
rolled into the parent row.

## Choose a view

The scope control at the top of Tasks has four views, each with its open
count:

- **Thread**: Tasks of the current thread.
- **Project**: Tasks of the current thread's project, from all of its
  locations and hosts. Turn on **Include thread tasks** in **View options** to
  add the Tasks of threads in any of the project's locations.
- **Global**: Tasks not tied to a project or thread.
- **All**: every Task.

The views always follow the current chat. A view that does not apply, such as
Thread in an archived thread, is unavailable; point at it, or tap it on a
phone, to see why.
Tasks opens on the view you last chose; when that view is unavailable, it falls
back to Project, then Global.

**All** is one list of every Task, in the view's sort. In All, and in Project
with **Include thread tasks**, each row shows where its Task belongs on a quiet
line under the title: **Global**, the project's name, or the thread's title,
followed in All by its project. In a project with several locations, a
thread's row also says where the thread runs, such as its host or folder.

## Add Tasks

Type a title in the add row under the scope control and press Enter. Its
placeholder names where the Task goes: **Add a task to this thread…**, **Add a
task to this project…**, or **Add a global task…**. A Task added in Project
belongs to the whole project, so Sedes does not ask for a location. In All, new
Tasks are Global. Focus stays in the add row, so you can type the next Task at
once. Searching never blocks adding.

- Press Shift+Enter, or select **Add details**, to add notes before adding the
  Task. In the notes field, press Ctrl+Enter (Command+Enter on macOS) or select
  **Add task**. **Add a task with notes** in the Tasks menu opens the same
  field.
- While **Only** › **Pinned** or **Only** › **Backlog** is on, a new Task is
  created pinned or in the Backlog to match, so it stays in view.
- Paste several lines to create one Task per line. Sedes asks first, in a
  **Create N tasks?** dialog that previews the titles. It ignores empty lines,
  removes list bullets, numbers, and checkboxes, and accepts up to 50 lines at
  a time.

On phones, the add bar sits at the bottom of Tasks, above the on-screen
keyboard. If a Task cannot be added, Tasks shows the error and returns the
title to the add row unless you have started typing another.

## Find Tasks

Select **Search tasks** (or press `/`) to filter the current view by title.
Turn on **Search notes** in **View options** to match notes as well. In search
and add inputs, Escape clears the focused field while keeping focus; Escape
again when empty leaves the field. The search stays open until you close it.

**View options** (the filter icon) controls what the current view shows:

| Option | Choices |
| --- | --- |
| **Sort** | **Newest** (the default), **Recently updated**, or **Title** |
| **Only** | Any of **Pinned**, **Backlog**, **With notes**, and **With files** |
| **Include thread tasks** | Project only; off by default |
| **Search notes** | Off by default |

Each view remembers its own options on this device. While **Only** hides
Tasks, a chip for each choice, such as **Pinned only**, sits under the scope
control, and the filter icon shows a dot; select a chip's **×** to remove it.
When nothing matches, the list offers to reset them. **Include thread tasks**
shows the same way, as a **Thread tasks** chip and the dot, while it is on in
Project; it adds Tasks rather than hiding them, so the empty list does not
offer to reset it. On phones, View options are in the **Tasks panel
actions** menu (**⋮**).

The **Pin** button in the Tasks header, beside Search, is the same setting as
**Only** › **Pinned**: select it to see only pinned Tasks, and again to see
them all.

The list always has the same shape: the open Tasks, then a collapsed
**Backlog** section, then a collapsed **Completed** section, each with its
count and shown only when it has Tasks. Sort orders the Tasks within each
section, and pinned Tasks always come first. **Newest** puts the most recently
created first, so a new backlog Task sits at the top of the Backlog; editing or
moving a Task does not change its creation order. Completed Tasks are never
pinned, and with **Newest** the most recently completed come first.

**Only** › **Pinned** narrows every section to pinned Tasks; pinned backlog
Tasks stay in the Backlog section. **Only** › **Backlog** makes the backlog
Tasks the list, grouped like any list in All, with no Backlog section. Neither
shows completed Tasks.

## Work with a Task

Each row shows the completion circle, the title, and small indicators for
notes, the number of linked files, and a pin. Its **⋯** menu appears on hover
or focus, and always on touch screens. On touch screens, a row with a line
saying where its Task belongs shows the indicators at the end of that line, so
the title has the row's whole width.

Select the circle, or press Space, to complete a Task. Completed Tasks are
muted, struck through, and collected in the collapsed **Completed** section.
Select the circle again to reopen it.

Choose **Send to Backlog** in the row menu, or press B, to move a Task into
the collapsed **Backlog** section; **Take out of Backlog** returns it. When
the open list is empty but the Backlog is not, the list says so.

Opening a Task from a transcript card shows it even when a search or **Only**
option would hide it, and expands its Backlog or Completed section. The search
and options stay as they were; the Task stays shown until you change them.

Only the Task you act on waits for the server. The add row and the other rows
stay available, and errors appear at the top of the list until you dismiss
them.

### See the details

Select a row, or press Enter on it, to expand it in place. One row is
expanded at a time, and its title shows whole. The detail shows:

- the notes as plain text, with **Show more** for long notes;
- the linked files, which open in Files when the thread's location is
  available;
- when the Task was added and where, with a link to its thread, and when it
  was last edited or completed; and
- **Add to prompt**, **Edit**, and **Move to…**.

On phones, selecting a row opens its detail in place of the list. **Back to
tasks** returns to the list, and so does Android Back; Back again returns to
Chat. The detail has **Edit** and **Add to prompt** at the bottom.

### Edit a Task

Choose **Edit** to open the **Edit task** dialog. The list stays visible behind
it. You can change:

- **Title** and **Notes**;
- **Belongs to**, a searchable list of this thread, this project, Global, and
  your other projects and threads, which moves the Task;
- **Files**, where **Add file** takes an absolute path and reports a problem
  on the field;
- **Pinned**; and
- **Backlog**.

A completed Task can't be pinned or sent to the Backlog: both switches are off
and say to reopen the Task first.

Choose **Save**, or press Ctrl+Enter (Command+Enter on macOS). Closing with
unsaved changes asks before discarding them. If the Task changed elsewhere
after you opened the dialog, Save is refused with a message in the dialog;
close it and open the Task again to see the latest version. **Delete…** at the
bottom left deletes the Task after confirmation.

### Use the row menu

The row's **⋯** menu has:

- **Add to prompt**;
- **Edit…**;
- **Pin** or **Unpin**;
- **Send to Backlog** or **Take out of Backlog**;
- **Move to**, with **This thread**, **This project**, **Global**, and
  **Choose…**, which searches every project and thread; and
- **Delete…**.

**This project** is the current thread's project. **Choose…** and **Edit**'s
**Belongs to** list each project once, named as in the sidebar; projects that
share a name show a host or path hint.

Deleting a Task is permanent and asks first. Prompts that already carry the
Task keep their copy.

Archived threads are not offered as destinations. Moving a Task that links to
files out of its project asks first, because the absolute file paths do not
change.

There is no Undo. To take back a completion, open the **Completed** section
and select the Task's circle to reopen it. To take back a move, move the Task
back with **Move to** or **Edit**'s **Belongs to**. Delete cannot be taken
back, which is why it asks first.

### Drag a Task

On desktop, drag a Task by its row:

- onto **Thread**, **Project**, or **Global** in the scope control to move it
  there;
- onto the list to move it to the current view's scope, except in All;
- onto the chat to move it to that thread. The **Move task to** zone covers the
  conversation and stops above the composer;
- onto the composer to add it to the prompt without moving it; or
- onto a sidebar thread to move it there. Dropping on a collapsed stack assigns
  it to the visible top thread; pause over the stack to open its roster and
  choose another member.

On touch screens, or with the keyboard, use **Move to** instead.

### Use the keyboard

These keys work while focus is in Tasks and not in a text field. **Keyboard
shortcuts** in the Tasks menu lists them.

| Key | Action |
| --- | --- |
| N | Add a task |
| `/` | Search |
| Up and Down arrows | Move between Tasks and headings; Home and End go to the first and last |
| Enter | Show or hide the details |
| Space | Complete or reopen |
| E | Edit |
| P | Pin or unpin |
| B | Send to or take out of the Backlog |
| M | Move to… |
| Delete | Delete, after confirmation |
| Ctrl+Enter (Command+Enter on macOS) | Add to prompt |
| Escape | In search/add inputs, clear the field, then leave it; elsewhere, close the details, then the search |

P and B do nothing on a completed Task. The Right arrow moves from a row to its
**⋯** button. On a group, **Backlog**, or **Completed** heading, the Right and
Left arrows expand and collapse it.

## Link files to a Task

A Task can list absolute file paths as metadata. In a thread whose location
is available, select a file in the Task's details to open it in Files. The
path resolves against the location of the thread you are viewing, by the same
rules as an absolute Markdown link: a file in one of the location's Files roots
opens there, and a file elsewhere opens only when its folder is inside the
environment's allowed workspace roots, through a hidden root that does not
appear in the Files tree. A Project Task viewed from another location or host
resolves its paths there, where they may not exist.

The path does not grant filesystem access and is not automatically sent to an
agent. Missing, sensitive, ambiguous, or disallowed paths, and paths outside
the allowed workspace roots, report that the file isn't available in Files.
See [Files and context](files-and-context.md#follow-file-links).

## Add a Task to a prompt

Choose **Add to prompt** from a Task's details or its **⋯** menu, press
Ctrl+Enter (Command+Enter on macOS) on its row, or drag it onto the composer.
Sedes adds the Task to the current thread's composer as a compact pill with
the Task's title and a remove button. A completed Task's pill is muted and a
deleted Task's pill shows a warning; hover over the pill to see why. On phones,
Add to prompt keeps Tasks open so you can add more Tasks. Switch to Chat when
you are ready to review the pills and send the prompt.

Before delivery, the pill follows live Task renames and completion state. At
Send, Queue, or Steer acceptance, Sedes records an immutable snapshot so the
historical prompt remains stable. A Task deleted before acceptance blocks the
delivery and leaves the draft intact. A completed Task is still valid.

In the transcript, the sent message shows each Task as a card with the title
captured at send time and a short preview of its notes. **Open task** opens
Tasks and expands the live Task, switching to a view that contains it.
**Details** shows the Task ID and, where recorded, its revision.

A prompt can contain up to 16 unique Task references and may consist only
of Task references. Long pill lists scroll above the message box. The captured
Task details, message text, and other text context share the 256 KiB input
budget, so large Tasks can reach that budget before the count limit. A rejected
delivery leaves the draft intact. Adding a Task does not enable Task-management
tools for the agent and does not grant access to the Task's file paths.

Structured Task references cannot be represented in Codex TUI keystrokes. Use
Chat for that prompt.

## Park or archive threads with open Tasks

Park and archive previews list the affected open Tasks and let you choose
**To project**, **To global**, **Keep**, or **Complete all**. The choice applies
to every open Task in the selected scope. **To project** moves each open
Thread Task to its thread's project. **Complete all** marks those Tasks
done and keeps them attached to their original threads. Tasks already completed
remain unchanged.

Parking one thread affects only its own Tasks. Archiving can also include
descendant forks; the preview groups their Tasks separately. Bulk stack actions
show Tasks from the affected stack members. Lists show up to 100 Tasks per group
and state how many additional Tasks are not shown; **Complete all** includes
those additional Tasks too.

If the Tasks change after you open the preview, completion is rejected. Single-thread
park and archive previews refresh automatically; for bulk stack actions, select
**Refresh impact** to review the updated Tasks before confirming again. Stashes
remain separate: completing Tasks does not consume stashed prompts.

Lifecycle completion is available in the browser and packaged clients. The
agent archive tool offers only to project, to global, or keep; agents can use
the ordinary Task update tool to complete individual Tasks explicitly.

## Schedule work with an automation

An automation sends a prompt on a schedule. A thread can have several independent,
named automations: for example, a daily update and several one-time reminders.
Each has its own prompt, schedule, enabled state, run history, and problems.
Editing or pausing one does not replace or pause its siblings.

Create and configure the source thread through the normal thread interface. It
can still be a draft. Automations use its model, reasoning, tools, workspace,
and execution settings; they have no separate thread-configuration editor.

Open **Automations** from the thread's header or thread actions to see its
collection. The page lists only that thread's automations, whatever the
sidebar's scope, and its back link, named after the thread, returns to the
thread. **Add automation** creates another automation. The global
[Automations page](#see-all-automations) also opens individual automations.

An automation's name is its own: you can rename it independently of the source
thread.

### Create an automation

1. Open the source thread's automations and choose **Add automation**.
2. Give it a name, such as "Daily update" or "Call the dentist".
3. Write the **Prompt**, independently of any unsent composer text.
4. Choose **When** it should run and check the schedule preview.
5. Under **Run in**, choose **This thread** or **Fork**.
6. Optionally add a [precheck](#use-a-precheck) and choose the recurring missed-run policy.
7. Choose **Save and enable**, or **Save as paused** to enable it later.

Saving an enabled automation creates and enables it in one operation. If the
server rejects its execution settings, it explains the problem instead of
leaving a partially configured enabled schedule. Names need not be unique:
actions always target the selected automation's identity.

### Set the schedule

| Kind | Fields |
| --- | --- |
| **Once** | A date and time in your time zone |
| **Every interval** | Minutes (at least 5), hours, or days, plus the first run |
| **Cron** | A five-field expression and a time zone |

Cron follows its named time zone. Intervals repeat a fixed duration. The preview
uses the server's schedule calculation and rejects schedules that run more often
than every five minutes.

Recurring schedules choose how to handle missed occurrences after downtime or
while the source is snoozed: **Run once when Sedes is back** coalesces them into
one run; **Skip missed runs** advances to a future occurrence and records the
skipped work. This policy does not discard a prompt already waiting for normal
delivery because the source is busy, materializing, or at queue capacity.

A one-time reminder waits while its source is snoozed. After its agent turn
succeeds, its thread shows no schedule icon, while its result notice remains
until dismissed. Dismissing that notice removes the finished reminder from the
automation collection; the conversation and any result thread remain. If you
dismiss while the agent is still working, removal waits for the turn to end.
A later failure is shown again and keeps the reminder available. An interrupted
turn, including one you stop, is not a failure: its notice is neutral, and the
reminder is removed once that notice is dismissed, as after a success.

**Run now** is a separate invocation and does not rearm a consumed schedule.
On a **This thread** reminder, the thread shows the latest run's notice, so a
**Run now** replaces the earlier result notice. After it succeeds, the reminder
is removed once its turn finishes; otherwise, once you dismiss that run's
notice. A **Fork** reminder keeps each result thread's notice until you
dismiss it. Before the reminder is removed, you can choose a new future date
and enable it to schedule another occurrence. Dismissing an older result does
not remove that new schedule. Changing its name or prompt does not rearm it.

### Edit or delete an automation

Open an automation and choose **Edit**, or use its row menu. Changes belong only
to that automation. Concurrent edits require reloading the current definition;
a deleted automation is not silently replaced by a sibling or recreated.

An unsent run waiting for admission retains the prompt captured for that run.
Changing its schedule or run mode, pausing, or deleting the automation cancels
that pending intent. Editing only its name or prompt does not rewrite an
already captured invocation. Work already sent to the thread keeps its normal
queue, interruption, and recovery lifecycle.

**Delete automation** removes its schedule from the collection. Its source and
result threads remain. Resolve uncertain delivery before performing controls
that would discard its recovery state.

## See all automations

Open **Automations** from the sidebar's **More** menu. The collection comes from
the server and includes automations whose source threads or fork families have
not been loaded in the sidebar. Source scope and search narrow the collection.
Rows identify each automation by its own name and show its source thread,
schedule, state, and latest run. Several automations on one thread appear as
separate rows; the thread itself still has one sidebar row.

Open a row for its definition and history. Its actions address that automation,
including **Run now**, **Pause** or **Enable**, **Edit**, and **Open thread**.
An outstanding problem remains visible even when another automation on the
same thread succeeds or runs. Successful one-time reminders remain available
until no result notice remains to dismiss.

## Open an automation

Each automation has its own detail link. The page names its source thread:
select the name, or choose **Open thread** from **⋯**, to open it. Individual
runs link to their actual result thread. The back link, and Escape, return to
wherever you opened the automation, such as the thread's collection, where you
can add another automation without changing the current one.

- **Run now** invokes the saved prompt once, including its precheck. It works
  independently of the recurring cursor or exhausted one-time schedule.
- **Pause** stops future scheduling and cancels a deferred unsent invocation.
- **Enable** resumes an eligible schedule.
- **Edit** updates the selected definition.

Execution may wait when the source is busy or its creation is unresolved. Runs
that are waiting for admission are durable and survive a server restart; they do
not occupy a running worker while they wait.

### When an automation needs you

An unknown delivery outcome means Sedes cannot prove whether the prompt or
fork reached the provider. Sedes preserves that run and does not blindly repeat
it. Open the actual thread and resolve the run through **Mark as failed**.
For eligible recurring work you can also resume the schedule. Resolving an
exhausted one-time occurrence does not schedule it again.

A delivery failure belongs to its automation. A later successful delivery from
that same automation can supersede it; a sibling's success cannot. Use
**Acknowledge failure** on the automation page, or dismiss its thread notice,
to acknowledge the indicated run only. Skipped or cancelled work does not
clear a prior delivery problem. A failure of the assistant's turn after
delivery also needs attention and appears in the result notice and run history.
It does not change the recorded delivery result or pause a recurring schedule.
Dismissing the earlier delivery notice cannot acknowledge this later problem.

An interrupted turn, whether you chose **Stop** or something else ended it, is
not a failure. Its result notice is neutral and can be dismissed, run history
shows **Interrupted**, and the automation is not marked **Failed** and does not
bring a parked thread back.

### Read the definition

The definition shows the automation's name, prompt, schedule, missed-run policy
for recurring work, run mode, precheck, and creation/update times. The source
thread remains the authority for model and execution configuration.

## Automation states

| State | Meaning |
| --- | --- |
| **Active** | Enabled and eligible for future scheduled occurrences |
| **Paused** / **Not started** | Future scheduling is disabled |
| **Finished** | The one-time occurrence has been consumed; a successful reminder remains until no notice remains to dismiss |
| **Waiting on source** | An unsent run is deferred until its source or capacity allows delivery |
| **Sending** / **Waiting for turn** | A run is being delivered or is in the normal thread queue |
| **Failed** | A delivery failure or failed agent turn needs attention |
| **Outcome unknown** | Delivery needs reconciliation before safe retry |
| **Thread archived** / **Snoozed** | Source inventory state suppresses scheduling |

Sidebar and thread-header summaries aggregate all attached automations. They
show counts, upcoming work, and attention without choosing an arbitrary sibling.
Opening the collection identifies which automation needs action.
Finished reminders alone show no sidebar or thread-header schedule icon, even
while their result notices remain. Other active or paused schedules and
outstanding problems still show their own status.

## Park an automated thread

[Park](organize-work.md#park-quiet-work) moves a thread out of your working set
without pausing its automations. A **This thread** run brings the source back
when its prompt is delivered. A **Fork** run starts its result thread while the
source can remain parked. A failed or unknown delivery brings attention to its
source; skipped work leaves it parked.

Snooze and archive apply to all automations attached to the source. One-time
reminders wait through snooze; recurring schedules apply their missed-run policy.
An archived source or removed project suspends future work until restored.
Pausing an individual automation affects only that automation.

## Choose a run mode

### This thread

Every run sends its prompt to the source thread. If the source is a draft, the
first admitted input starts its conversation. Later inputs continue it through
the normal queue. The automation does not send any unsent composer text.

### Fork

Every run creates a separate result from the original source:

- If the source is still a draft, Sedes uses **New with same settings** to
  create an empty thread with the source's saved configuration.
- If the source is started, Sedes uses its native fork support at an eligible
  completed checkpoint.

The system selects the path when the run is admitted. A source that is starting,
busy, or awaiting recovery can make the run wait. After a result has been
reserved, retries recover that same result even if the source changes later.

The automation never starts reusing its previous result. To schedule further
work on a result thread, attach a separate automation to it. Neither path copies
automation definitions. Draft copies are independent threads with automation
provenance; native forks also retain their conversation lineage.

Native fork support depends on the backend and a valid completed checkpoint.
A started source that cannot fork fails visibly; Sedes does not replace the fork
with an empty copy. A backend that supports copying drafts but not native forks
can run draft copies only while the source stays a draft. No separate model,
reasoning, tools, or thread-creation recipe is stored in the automation.

## Use a precheck

A precheck is a bounded shell command that runs in the source's authorized
workspace before delivery, including for **Run now**. Exit 0 permits delivery;
a nonzero exit skips it. Standard error is diagnostic only. Standard output is
added to the prompt only when requested, successful, and within the size limits.

**Test precheck** executes the command and previews its outcome without sending
a prompt. Timeout is 1–60 seconds, 30 by default. The command uses the execution
context supported by Sedes; unsupported execution contexts fail explicitly.

A completed precheck runs at most once per invocation. If delivery subsequently
waits, the saved result and output are reused, with the output's capture time.
An interrupted check fails instead of rerunning a shell command whose effects
may already have occurred. A new manual invocation can run it again.

The command has the execution account's authority. Keep it small and reviewed,
and avoid printing credentials. Its output is treated as untrusted data by the
assistant.

## Approvals and unattended expectations

Automations use the thread's normal model, reasoning, tools, sandbox, network,
and approval settings. If an approval or answer is required, the turn waits in
the ordinary thread interface. Execution authority is checked again before
submission. Sedes tool access outside the automation's permitted boundary fails
closed.

## Review run history

History includes scheduled and manual invocations, with their captured definition
revision, delivery state, precheck result, deferral reason, and actual result
thread. The **All**, **Problems**, and **Skipped** filters and pagination help
inspect older runs. A successful one-time reminder and its history leave these
views once no result notice remains to dismiss. Sedes retains the internal records
needed for thread provenance and duplicate-request protection.

Delivery and assistant completion are different events: **Delivered** confirms
that the input reached the provider; the later turn outcome can be completed,
interrupted, or failed. **Go to turn** opens the actual thread and turn when
available. Run details retain timestamps, diagnostics, and any coalesced missed
occurrences. Retries and recovery preserve the original invocation identity.

Operators can manage the same model with the
[Automation CLI](../operator/automation-cli.md).

Previous: [Files and context](files-and-context.md) · Next:
[Provider features](provider-features.md)
