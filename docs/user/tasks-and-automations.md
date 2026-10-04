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
not send a provider message or settle its thread.

## Open Tasks

Tasks appears beside a thread. In a thread, select the **Tasks** button (the
checklist icon) or press Ctrl+Shift+L (Command+Shift+L on macOS) to open or
close Tasks. Home, Archived, and Usage have no Tasks; to see Global Tasks,
open any thread and choose **Global**.

On desktop, Tasks docks beside Chat as a workspace panel, on the right by
default. Like Files and Workpads, you can resize it, collapse it, dock it on
another edge from **Tasks panel actions**, or close it; the **Tasks** button
opens it again. It stays open or collapsed, and in the same place, as you
switch threads, and its content follows the current chat. When Tasks is
collapsed, by you or to make room for another panel, the button keeps an
outline; select it to show Tasks again, which makes room in turn.

On phones and other narrow screens, Tasks opens as a bottom sheet. Resizing
the window across that width closes the sheet, unless you are editing a Task:
then Tasks stays open in the new presentation, with your edit as you left it.

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

**All** is grouped by project: Global first, then one group for each project,
however many locations it has, the current one first, with each thread's Tasks
in a group under its project. Select a group heading to collapse or expand it,
or use **Collapse all groups** in the Tasks menu (**⋯**, or **Tasks panel
actions** when docked). Turn off **Group by project** in **View options** for
one flat list. Without group headings, as in that list or in Project with
**Include thread tasks**, each row shows where its Task belongs on a quiet line
under the title. In a project with several locations, a thread's group heading
or row also says where the thread runs, such as its host or folder.

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

On phones, the add bar sits at the bottom of the sheet, above the on-screen
keyboard. If a Task cannot be added, Tasks shows the error and returns the
title to the add row unless you have started typing another.

## Find Tasks

Select **Search tasks** (or press `/`) to filter the current view by title.
Turn on **Search notes** in **View options** to match notes as well. Escape
clears the search and closes it.

**View options** (the filter icon) controls what the current view shows:

| Option | Choices |
| --- | --- |
| **Sort** | **Newest** (the default), **Recently updated**, or **Title** |
| **Only** | Any of **Pinned**, **Backlog**, **With notes**, and **With files** |
| **Group by project** | All only; on by default |
| **Include thread tasks** | Project only; off by default |
| **Search notes** | Off by default |

Each view remembers its own options on this device. While **Only** hides
Tasks, a chip for each choice, such as **Pinned only**, sits under the scope
control, and the filter icon shows a dot; select a chip's **×** to remove it.
When nothing matches, the list offers to reset them. On phones, View options
are in the sheet's **⋯** menu.

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

On phones, selecting a row opens its detail in the sheet. **Back to tasks**
returns to the list, and so does Android Back. The detail has **Edit** and
**Add to prompt** at the bottom.

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
| Escape | Close the details, then the search |

P and B do nothing on a completed Task. The Right arrow moves from a row to its
**⋯** button. On a group, **Backlog**, or **Completed** heading, the Right and
Left arrows expand and collapse it. In the
phone sheet, Escape closes Tasks once the details and search are closed.

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
Add to prompt closes the sheet so you can see the pill arrive.

Before delivery, the pill follows live Task renames and completion state. At
Send, Queue, or Steer acceptance, Sedes records an immutable snapshot so the
historical prompt remains stable. A Task deleted before acceptance blocks the
delivery and leaves the draft intact. A completed Task is still valid.

In the transcript, the sent message shows each Task as a card with the title
captured at send time and a short preview of its notes. **Open task** opens
Tasks and expands the live Task, switching to a view that contains it.
**Details** shows the Task ID and, where recorded, its revision.

A prompt can contain up to eight unique Task references and may consist only
of Task references. Adding a Task does not enable Task-management tools for the
agent and does not grant access to the Task's file paths.

Structured Task references cannot be represented in Codex TUI keystrokes. Use
Chat for that prompt.

## Settle or archive threads with open Tasks

Settle and archive previews list the affected open Tasks and let you choose
**To project**, **To global**, **Keep**, or **Complete all**. The choice applies
to every open Task in the selected scope. **To project** moves each open
Thread Task to its thread's project. **Complete all** marks those Tasks
done and keeps them attached to their original threads. Tasks already completed
remain unchanged.

Settling one thread affects only its own Tasks. Archiving can also include
descendant forks; the preview groups their Tasks separately. Bulk stack actions
show Tasks from the affected stack members. Lists show up to 100 Tasks per group
and state how many additional Tasks are not shown; **Complete all** includes
those additional Tasks too.

If the Tasks change after you open the preview, completion is rejected. Single-thread
settle and archive previews refresh automatically; for bulk stack actions, select
**Refresh impact** to review the updated Tasks before confirming again. Stashes
remain separate: completing Tasks does not consume stashed prompts.

Lifecycle completion is available in the browser and packaged clients. The
agent archive tool offers only to project, to global, or keep; agents can use
the ordinary Task update tool to complete individual Tasks explicitly.

## Schedule work with an automation

Each thread can have at most one automation. Open **Automation settings…** from
the thread context menu or **Thread actions**.

An automation contains:

- a canned prompt separate from the normal composer draft;
- a date/time, elapsed interval, or five-field cron schedule;
- same-thread or per-run clone execution;
- an optional local shell precheck; and
- a missed-run policy.

New automations start paused. Saving the definition does not schedule a run
until you choose **Enable**. Enabling computes the first deadline.

### Create a basic automation

1. Open **Automation settings…** on the intended thread.
2. Write the exact prompt to run.
3. Choose **Use this thread** or **Start a new cloned thread for each run** when
   clone mode is available.
4. Choose the schedule and review its preview.
5. Select how a missed occurrence should be handled.
6. Save the automation.
7. Choose **Enable**.

Use **Run now** to create a manual occurrence without changing the recurring
schedule. Use **Pause** to stop new scheduled admissions while preserving the
definition and history. Edit or remove the automation from the same screen.

## Choose a run mode

### Use this thread

The automation sends its prompt to the attached thread. It uses the same model,
reasoning, sandbox, network, approval, and tool configuration as a manual turn
on that thread. The automation prompt is separate from any draft currently in
the composer.

### Start a cloned thread for each run

Clone mode creates a normal child from a stable completed checkpoint, then
queues the automation prompt after the child's provider binding is durable. An
empty draft source creates a fresh child. The source thread remains the
automation anchor and each occurrence gets its own conversation.

Clone availability depends on provider capability and source state. Sedes does
not fall back to same-thread execution when an explicitly selected clone mode
is unavailable.

## Use a precheck

A precheck is a bounded shell command that decides whether a scheduled run
should proceed. Enable it, enter the command and timeout, and choose **Test
precheck** before saving.

For a local project, Sedes runs the command through `/bin/sh -lc` in the
authorized workspace:

- exit code 0 permits the run;
- a nonzero exit skips it;
- standard error is diagnostic only; and
- standard output is added to the prompt only when **Include stdout** is
  enabled and the output fits the bounds.

Precheck timeout is 1–60 seconds. SSH command execution is not implemented, so
a precheck configured on an SSH thread fails rather than running a remote
shell.

A precheck is executable code with the authority of the Sedes server account.
Use a minimal, reviewed command; do not place credentials in the command or
printed output.

## Approvals and unattended expectations

Automations do not create a special read-only or unattended execution profile.
They inherit the thread's normal settings. If the provider or Sedes policy
requires an attended approval, the automated turn waits at the ordinary
approval panel until you respond.

Sedes tool access outside the configured **Access boundary**
cannot open a useful unattended prompt for an automation and fails closed.
Design recurring work to remain within its source environment or use an
explicit operator-approved policy.

## Review run history

The Automation screen lists scheduled and **Run now** occurrences, their
outcomes, timing, and precheck result. Use this history to distinguish:

- a run that executed;
- a run skipped by precheck;
- a missed or coalesced schedule occurrence;
- a run waiting for interaction; and
- a failed or uncertain creation/delivery operation.

If clone creation may have succeeded but cannot be proved, Sedes records
recovery and does not automatically repeat it. Follow
[Troubleshooting and recovery](troubleshooting.md).

Operators can manage the same automation model with the
[Automation CLI](../operator/automation-cli.md).

Previous: [Files and context](files-and-context.md) · Next:
[Provider features](provider-features.md)
