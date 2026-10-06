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
close Tasks. Home, Archived, Usage, and the automation pages have no Tasks; to
see Global Tasks, open any thread and choose **Global**.

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

An automation sends a thread a prompt on a schedule. Each thread can have at
most one automation. It contains:

- a prompt, separate from the composer draft;
- a one-time date and time, an interval, or a five-field cron schedule;
- whether each run uses this thread or a new fork of it;
- an optional local shell precheck; and
- for a recurring schedule, what to do with runs missed while Sedes was down.

A thread with an automation opens it from:

- the automation button in the thread header;
- **Automation…** in **Thread actions**, or in the thread's menu in the
  sidebar (right-click or long-press the row);
- **Open automation** on a thread notice about an automation run; and
- its row on the [Automations page](#see-all-automations).

For a thread without one, **Thread actions** and the sidebar menu offer
**Automate…**, which opens the editor for a new automation. When the thread
can't take an automation, **Automate…** is unavailable; point at it to see
why. Older links to a thread's automation open its automation page.

### Create an automation

1. Choose **Automate…** on the thread.
2. Under **Prompt**, write the prompt. It is sent to the agent in this thread
   on every run, as if you typed it.
3. Under **When**, choose the schedule and check **Next runs**.
4. Under **Run in**, choose **This thread** or **A new fork each run**.
5. Optionally, add a [precheck](#use-a-precheck).
6. For a recurring schedule, choose what happens **If Sedes was down**.
7. Choose **Save and enable** to start the schedule, or **Save as paused** to
   enable it later.

A new automation starts as every day, beginning at the next whole hour, in
this thread, with no precheck. After saving, its automation page opens. If the
automation is saved but cannot be enabled, the editor stays open, says why,
and the automation is kept paused.

### Set the schedule

**When** offers three kinds of schedule:

| Kind | Fields |
| --- | --- |
| **Once** | A date and time in your time zone |
| **Every interval** | A number of minutes (at least 5), hours, or days, and **Starting**, the first run; the interval counts from it |
| **Cron** | A five-field expression (minute, hour, day of month, month, weekday) and a **Time zone**, your browser's zone at first |

Under the fields, the schedule reads as a sentence, such as "Every weekday at
9:00 AM Europe/Berlin". An expression outside the common forms reads as
"Cron" followed by the expression and its zone. A cron schedule's times are in
its own zone. A whole-day interval repeats a fixed number of hours, so its time
of day is shown in UTC.

**Next runs** shows the next three times, as Sedes will schedule them. Save
waits until Sedes has checked the current schedule, and a schedule it rejects,
such as one that would run more often than every five minutes, shows the
reason there.

**If Sedes was down** applies to recurring schedules:

- **Run once when Sedes is back**, the default, merges the missed runs into
  one run, which says how many it merged.
- **Skip missed runs** waits for the next scheduled time; a run more than a
  minute late is recorded as skipped.

### Edit or delete an automation

Choose **Edit** on the automation page, or **Edit…** in its row menu on the
Automations page. The editor has the same sections, with links at the top to
each. Changes apply from the next run; **Run now** and **Pause** act on the
saved version.

**Save** is available once you change something and the form is valid, and
returns to the automation page. **Cancel** puts your edits back; for a new
automation, it leaves the editor. Leaving with unsaved changes asks first:
**Keep editing**, or **Discard and leave**.

- If the automation changes elsewhere while you edit, Save is refused until you
  choose **Reload automation**, which discards your edits.
- If it is deleted elsewhere, the editor says so, and saving creates a new
  one.
- While its last run's outcome is unknown, the automation can't be changed.
  [Resolve that run](#when-an-automation-needs-you) first.

**Delete automation…**, at the bottom of the editor or in the automation
page's **⋯** menu, asks first. Scheduled and manual runs stop and the schedule
is removed. The thread, its messages, and any result threads stay, but the run
history is no longer shown. Deleting returns to the Automations page.

## See all automations

Open **Automations** from the sidebar footer's **More** menu, or choose **View
all** on a sidebar group of automations: **Upcoming** in Timeline,
**Scheduled** in State, or **Automations** in Projects.

The page lists every automation, including those on archived threads, and the
header counts them. **Search automations** matches thread titles and the start
of each prompt. The page follows the sidebar's Scope, which the two share. A
line under the search shows the Scope, the grouping, and, while the list is
narrowed, how many automations match; choose **Clear scope** there to reset the
Scope.

**View options** groups by **Status**, the default, or **Project**. By status,
each automation is in exactly one group:

| Group | Contains | Order |
| --- | --- | --- |
| **Needs attention** | **Failed** and **Outcome unknown** | Most recent problem first |
| **Upcoming** | **Active** and **Sending** | Next run first |
| **Paused** | **Paused** and **Not started** | By title |
| **Suspended** | **Thread archived** and **Snoozed**; collapsed at first | By title |

By project, each project's automations follow the same status order. Select a
group heading to collapse or expand it. Sedes remembers the grouping and the
collapsed groups on this device.

Each row shows the [state](#automation-states) glyph, the thread title, and a
line with the schedule, project, and backend. At the end of the row are the
next run, the problem ("Failed 21h ago"), or the state ("Paused"), over the
last outcome ("Delivered 23m ago"). A row that needs attention shows what went
wrong in place of the schedule, and whether scheduling continues ("next
6:30 AM" or "Scheduling paused"). On narrow screens, the second line shows the
outcome and the schedule, and only the next run stays at the end.

Select a row to open its automation page. The row's **⋯** menu, shown on hover
or focus and always on touch screens, has **Run now**, **Pause** or
**Enable**, **Edit…**, and **Open thread**. An unavailable action follows the
same rules as on the automation page (see [Open an automation](#open-an-automation)):
the menu shows a short hint, and pointing at the action says what to do.

## Open an automation

An automation's page shows its state, definition, and runs in one scroll.
**‹ Automations** returns to where you came from, or to the Automations page.
The sidebar keeps the thread selected.

The header shows the thread title, a [state](#automation-states) chip, and a
line with the next run, or what holds it ("scheduling paused", "runs
suspended", "snoozed until…"), then the project and backend. Its actions are:

- **Run now** sends the prompt once without changing the schedule. It works
  while the schedule is paused, and the precheck still applies.
- **Pause** or **Enable** (the pause and play buttons) stops or resumes
  scheduled runs. Pausing does not stop a run that has already started.
- **Edit** (the pencil) opens the editor.
- **⋯** has **Open thread** and **Delete automation…**. On phones, **Pause**
  or **Enable** and **Edit** move into this menu.

Some actions wait for the automation or its thread. Point at an action to see
what to do:

| While | Unavailable | Says |
| --- | --- | --- |
| The last run's outcome is unknown | **Run now**, **Pause** or **Enable**, **Edit**, **Delete automation…** | "Resolve the unknown run first" |
| A run is in progress | **Run now**, **Pause** or **Enable**, **Delete automation…** | "Wait for the current run to finish" |
| The thread is archived | **Run now**, **Enable**, **Edit** (**Pause** still works) | "Restore the thread first" |
| The thread is snoozed | **Run now** | "Unsnooze the thread first" |

On the automation page, **Run now**, **Enable**, and **Edit** are also
unavailable while the thread can't take an automation.

### When an automation needs you

A callout under the header says when an automation needs a decision:

| Situation | Callout | Actions |
| --- | --- | --- |
| The last run failed | "Last run failed", how long ago, and what went wrong | **Open thread** |
| The outcome is unknown | "Sedes can't tell whether the last run reached the agent." | **Open thread**, **Mark as failed…** |
| Not started | "Paused. This automation won't run until you enable it." | **Enable** |
| The thread is archived | "Runs are suspended while the thread is archived." | **Restore thread** |
| The thread is snoozed | "Scheduled runs are skipped until …", with the wake time | **Unsnooze** |

**Open thread** opens the thread the run used: this thread, or a fork run's
own thread.

When Sedes cannot prove whether a run reached the agent, it records the
outcome as unknown, pauses the schedule, and never sends the prompt again on
its own. Open the thread to see whether the agent got the prompt, then choose
**Mark as failed…**:

- **Mark failed and resume** also enables the schedule again, in the same
  step.
- **Mark failed, keep paused** leaves the schedule paused.

Marking the scheduled run of a one-time automation as failed ends that
automation, so it can't resume.

### Read the definition

The **Definition** card shows the saved automation:

| Item | Shows |
| --- | --- |
| **Prompt** | The prompt, four lines at first; **Show all** shows the rest |
| **Schedule** | The schedule sentence; the next three runs, while a recurring schedule is enabled; and, for a recurring schedule, what happens if Sedes was down |
| **Run in** | **This thread** or **A new fork each run** |
| **Precheck** | The command, its timeout, and whether its output is added to the prompt; or **None** |
| **Created** | When the automation was created and last updated |

## Automation states

Sedes names an automation's state with the same words everywhere. The first
state that applies wins:

| State | Glyph | Meaning |
| --- | --- | --- |
| **Sending** | Spinner | A run is in progress; **Waiting for turn** while it waits behind the thread's current turn |
| **Failed** | Red warning triangle | The last run failed |
| **Outcome unknown** | Amber warning triangle | Sedes can't tell whether the last run reached the agent; the schedule is paused until you resolve it |
| **Thread archived** | Archive box | Runs are suspended until the thread is restored |
| **Snoozed** | Moon | Scheduled runs are skipped until the thread wakes |
| **Active** | Repeat arrows | Enabled; runs on schedule |
| **Paused** | Pause circle | Paused after at least one run |
| **Not started** | Pause circle | Paused and never run, such as an automation saved as paused |

Failed and Outcome unknown automations need attention everywhere: in the
Automations page's **Needs attention** group, in the sidebar's State view, and
on their sidebar rows. Paused is never shown as a warning.

Elsewhere in Sedes:

- **Sidebar rows** of threads with automations show the repeat arrows, the
  pause circle while paused, not started, or suspended, and the spinner while
  a run is sending. A failed or unknown last run adds a warning badge. In
  groups of automations, the row's time is the next run; in the Projects
  view's **Automations** group, a row without one shows **Paused** or **Not
  started**. In card density, the second line names the problem, the paused
  state, or the next run.
- **The thread header's automation button** shows the same glyph as the row.
  It turns red after a failed run and amber when the outcome is unknown; hover
  over it for the state, such as "Automation · next Tmrw 2:00 AM".
- **The thread preview** has an "Automation ·" line with the state or next
  run.
- **Thread notices** say that an automation triggered the thread, or, in red,
  that the run failed. **Open automation** opens the automation page while the
  thread that owns the automation still has it; **Dismiss** removes the
  notice.

Upcoming times read the same everywhere: "in 45m", a time today, "Tmrw
9:00 AM", a weekday within the week, then a date.

## Choose a run mode

### This thread

The automation sends its prompt to the attached thread. It uses the same model,
reasoning, sandbox, network, approval, and tool configuration as a manual turn
on that thread. The automation prompt is separate from any draft currently in
the composer.

### A new fork each run

Each run creates a normal child from a stable completed checkpoint, then
queues the automation prompt after the child's provider binding is durable. An
empty draft source creates a fresh child. The source thread remains the
automation anchor and each run gets its own conversation, so runs don't pile
up in the source thread.

A fork run's thread is titled with the source thread's title and the run time,
such as "Nightly review · Oct 6, 3:15 AM". The time is in the cron schedule's
time zone, or otherwise in UTC and marked "UTC".

Forking needs a completed turn and a backend that can fork. When the thread
can't fork, **A new fork each run** is unavailable and says why. Sedes does not
fall back to this thread when a fork run becomes unavailable later.

## Use a precheck

A precheck is a bounded shell command that decides whether a run goes ahead.
It runs before every run, manual runs included. Under **Precheck**, open
**Before each run**, turn on **Run a precheck**, enter the **Shell command**
and its **Timeout**, and choose **Test precheck** before saving.

For a local project, Sedes runs the command through `/bin/sh -lc` in the
authorized workspace:

- exit code 0 permits the run;
- a nonzero exit skips it;
- standard error is diagnostic only; and
- standard output is added to the prompt only when **Add output to the
  prompt** is on, the command exits 0, and the output fits the bounds.

**Test precheck** runs the command once and says what a run would do: **Would
run the agent**, **Would skip this run**, or that the precheck failed, with
its exit code, duration, whether output would be added to the prompt, and the
output and errors. Nothing is sent to the agent, but the command does run.

Precheck timeout is 1–60 seconds, 30 by default. SSH command execution is not
implemented, so a precheck configured on an SSH thread fails rather than
running a remote shell.

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

The automation page's **Runs** section lists scheduled runs and **Run now**
runs, newest first. Its heading counts all runs and the problems among them;
select the problem count to list only those.

At first it shows the latest five runs. **Show all runs** shows the whole
history in a scrolling list, with **Load more** for older runs and a filter:
**All**, **Problems** (failed and unknown runs), or **Skipped**. **Show fewer**
returns to the short list. New runs appear as they happen.

Each row shows when the run was due or requested, its state, and a summary:
**Scheduled** or **Manual**, missed runs merged into it ("missed ×2 merged"),
why it was skipped ("precheck exit 1", "missed while Sedes was down", or
"thread was snoozed"), and how the precheck went. Select a row to see its
details, in place on desktop and in a sheet on phones:

- **Timeline**: when the run was due, claimed, started, and accepted or
  finished, each with the time since the step before;
- **Precheck**: its result, exit code, duration, and output size, and the
  command and timeout as they were for this run;
- what went wrong or why the run was skipped, and the error code;
- **Definition**: the revision the run used, and whether the automation was
  edited since; and
- **Result thread**: a fork run's own thread.

| Run state | Meaning |
| --- | --- |
| **Starting** | Sedes has picked up the run; **Checking** while the precheck runs |
| **Waiting for turn** | The prompt waits behind the thread's current turn |
| **Sending** | The prompt is on its way to the agent |
| **Delivered** | The agent received the prompt |
| **Skipped** | The prompt was not sent; the row says why |
| **Failed** | The run did not deliver the prompt, or you marked an unknown run as failed; the details say why |
| **Outcome unknown** | Sedes can't tell whether the agent received the prompt |

**Delivered** does not mean the agent has finished: its turn can still be
working, or waiting at an approval. Open the thread, or a fork run's result
thread, to follow the work.

If a fork may have been created but Sedes cannot prove it, the run's outcome
is unknown, and Sedes does not repeat it on its own. Follow
[Troubleshooting and recovery](troubleshooting.md).

Operators can manage the same automation model with the
[Automation CLI](../operator/automation-cli.md).

Previous: [Files and context](files-and-context.md) · Next:
[Provider features](provider-features.md)
