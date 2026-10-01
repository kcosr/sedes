# Tasks and automations

Tasks remember work outside a transcript. Automations start work on a schedule.
They complement provider conversations but do not replace them.

## Track work with Tasks

A Task contains:

- a title;
- optional notes or follow-up steps;
- complete and pinned state;
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

Complete a Task when the work is done. Completion does not send a provider
message or settle its thread.

## Open Tasks

Select the **Tasks** button (the checklist icon) or press Ctrl+Shift+L
(Command+Shift+L on macOS) to open or close Tasks. On desktop, where Tasks
appears depends on the page:

- **In a thread**, Tasks docks beside Chat as a workspace panel, on the right
  by default. Like Files and Workpads, you can resize it, collapse it, dock it
  on another edge from **Tasks panel actions**, close it, or open it from the
  **Panels** menu. It stays open or collapsed as you switch threads, and its
  content follows the current chat.
- **On Home, Archived, and Usage**, the button in the top-right corner opens
  Tasks as a popover. Clicking outside it, pressing Escape, or navigating
  closes it.

On phones and other narrow screens, Tasks opens as a bottom sheet on every
page.

The button's badge counts open Tasks: the current thread's Tasks in a thread,
and Global Tasks on the other pages. The Tasks header shows the open count of
the current view.

Only open Tasks directly scoped to a thread contribute to that sidebar row's
Task count. Project and global Tasks, and Tasks on fork descendants, are not
rolled into the parent row.

## Choose a view

The scope control at the top of Tasks has four views, each with its open
count:

- **Thread**: Tasks of the current thread.
- **Project**: Tasks of the current thread's project. Turn on **Include
  thread tasks** in **View options** to add the Tasks of the project's threads.
- **Global**: Tasks not tied to a project or thread.
- **All**: every Task.

The views always follow the current chat. A view that does not apply, such as
Thread on Home, is unavailable, and its tooltip gives the reason. Tasks opens
on the view you last chose; when that view is unavailable, it falls back to
Project, then Global.

**All** is grouped by project: Global first, then each project, the current one
first, with each thread's Tasks in a group under its project. Select a group
heading to collapse or expand it, or use **Collapse all groups** in the Tasks
menu (**⋯**, or **Tasks panel actions** when docked). Turn off **Group by
project** in **View options** for one flat list.

## Add Tasks

Type a title in the add row under the scope control and press Enter. Its
placeholder names where the Task goes: **Add a task to this thread…**, **Add a
task to this project…**, or **Add a global task…**. In All, new Tasks are
Global. Focus stays in the add row, so you can type the next Task at once.
Searching never blocks adding.

- Press Shift+Enter, or select **Add details**, to add notes before adding the
  Task. In the notes field, press Ctrl+Enter (Command+Enter on macOS) or select
  **Add task**. **Add a task with notes** in the Tasks menu opens the same
  field.
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
| **Sort** | **Pinned, then newest** (the default), **Recently updated**, or **Title** |
| **Show** | **Open** (the default, with completed Tasks in a collapsed section) or **Completed** |
| **Only** | Any of **Pinned**, **With notes**, and **With files** |
| **Group by project** | All only; on by default |
| **Include thread tasks** | Project only; off by default |
| **Search notes** | Off by default |

Each view remembers its own options on this device. The filter icon shows a
dot while **Show** or **Only** hides Tasks; when nothing matches, the list
offers to reset them. On phones, View options are in the sheet's **⋯** menu.

With the default sort, pinned Tasks come first, then the most recently created.
Editing or moving a Task does not change its creation order.

## Work with a Task

Each row shows the completion circle, the title, and small indicators for
notes, the number of linked files, and a pin. Its **⋯** menu appears on hover
or focus, and always on touch screens.

Select the circle, or press Space, to complete a Task. Completed Tasks are
muted, struck through, and collected in a collapsed **Completed** section,
with its count, at the end of the list, most recently completed first. Pinning does not lift
a completed Task. Select the circle again to reopen it.

Only the Task you act on waits for the server. The add row and the other rows
stay available, and errors appear at the top of the list until you dismiss
them.

### See the details

Select a row, or press Enter on it, to expand it in place. One row is
expanded at a time. The detail shows:

- the notes as plain text, with **Show more** for long notes;
- the linked files, which open in Files when the project is available;
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
  on the field; and
- **Pinned**.

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
- **Move to**, with **This thread**, **This project**, **Global**, and
  **Choose…**, which searches every project and thread; and
- **Delete…**.

Deleting a Task is permanent and asks first. Prompts that already carry the
Task keep their copy.

Archived threads are not offered as destinations. Moving a Task that links to
files out of its project asks first, because the absolute file paths do not
change.

### Undo

After you complete or reopen a Task, or move it with **Move to** or by
dragging, a notice at the bottom of the workspace offers **Undo** for about
five seconds. Press F8 to move focus to it. Delete has no Undo, which is why it
asks first.

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
| M | Move to… |
| Delete | Delete, after confirmation |
| Ctrl+Enter (Command+Enter on macOS) | Add to prompt |
| Escape | Close the details, then the search |

The Right arrow moves from a row to its **⋯** button. On a group or
**Completed** heading, the Right and Left arrows expand and collapse it. In a
popover or sheet, Escape closes Tasks once the details and search are closed.

## Link files to a Task

A Task can list absolute file paths as metadata. When the Task is associated
with a project, select a file in the Task's details to resolve it through the
same authorized Files rules used by Markdown links.

The path does not grant filesystem access and is not automatically sent to an
agent. Missing, sensitive, outside-root, ambiguous, or unsupported paths fail
closed. See [Files and context](files-and-context.md#follow-file-links).

## Add a Task to a prompt

Choose **Add to prompt** from a Task's details or its **⋯** menu, press
Ctrl+Enter (Command+Enter on macOS) on its row, or drag it onto the composer.
Sedes adds the Task to the current thread's composer as a compact pill with
the Task's title and a remove button. A completed Task's pill is muted and a
deleted Task's pill shows a warning; hover over the pill to see why. Add to prompt needs an open thread,
so it is unavailable on Home, Archived, and Usage. On phones, it closes the
sheet and confirms with a notice.

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
to every open Task in the selected scope. **Complete all** marks those Tasks
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
agent archive tool retains its move/keep options; agents can use the ordinary
Task update tool to complete individual Tasks explicitly.

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
