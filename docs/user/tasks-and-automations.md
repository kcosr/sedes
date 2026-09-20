# Tasks and automations

Tasks remember work outside a transcript. Automations start work on a schedule.
They complement provider conversations but do not replace them.

## Track work with Tasks

Open **Tasks** with its dedicated icon in the application header, including
when Chat is collapsed. On a thread, the icon indicates its open Tasks. Tasks
keeps its Global, Project, and Thread views and stays open when you collapse
Chat. On desktop you can pin the floating panel open; on narrow screens it
appears as an edge-attached bottom sheet that stays above the on-screen
keyboard.

A Task contains:

- a title;
- optional notes or follow-up steps;
- complete and pinned state;
- optional absolute file references; and
- one scope: Global, Project, or Thread.

Tasks belong to the current Sedes user and survive restarts. They are not
provider conversation messages, Git issues, or TODO comments in the project.

Pinned Tasks appear first, with open Tasks before completed Tasks within each
pin group. Each group lists the most recently created Tasks first; editing or
moving a Task does not change its creation order.

## Create a Task

1. Select the Global, Project, or Thread view where the Task should begin.
   For Project or Thread, use the searchable selector to choose its destination.
2. Choose **New task**, or type a title in **Search or add task**.
3. Enter the title and choose **Add task** or press Enter. This immediately
   creates the title-only Task in the selected scope.
4. Open the Task and choose **Edit** to add notes, attach absolute file paths,
   change its title, or move it to another available scope. Pin or unpin the
   Task from its row in the list.
5. Save the edited Task.

On desktop, drag a Task by its grip onto a sidebar thread to assign it there.
Dropping on a collapsed stack assigns it to the visible top thread; pause over
the stack to open its roster and choose another member. You can also drop onto
the open Chat surface to assign it to that thread, or onto the composer to add
it to the prompt without moving it. Within the Tasks panel, drop onto the
**Global**, **Project**, or **Thread** scope header to reassign it there;
dropping elsewhere on the Tasks card uses the currently selected scope. On
touch devices, or when using a keyboard, open the Task, choose **Edit**, and
select a scope and search for the destination project or thread. Press
Command+Enter on macOS or Ctrl+Enter elsewhere
to save while editing; Enter in Notes still adds a new line.

Project and Thread views initially follow the current chat. Selecting a specific
project or thread keeps that choice while you navigate with the panel open;
choose **Current project** or **Current thread** to follow the chat again.
Thread choices show their project alongside the title and exclude archived threads.
On mobile, these selectors open a separate searchable chooser with scrolling
results, independent of the Tasks card’s height. A removed destination
requires another selection before adding a Task. Adding a Task to a prompt
still uses the current chat, independently of the Tasks view.

Choose scope by where you expect to find the work later:

| Scope | Use it for |
| --- | --- |
| **Global** | Work not tied to one repository or conversation |
| **Project** | Work shared by several threads in one project |
| **Thread** | Follow-up owned by one conversation |

The Tasks panel can switch among these views and search the selected list.
Pinned Tasks sort prominently. Complete a Task when the work is done; completion
does not send a provider message or settle its thread.

Only open Tasks directly scoped to a thread contribute to that sidebar row's
Task count. Project and global Tasks, and Tasks on fork descendants, are not
rolled into the parent row.

## Link files to a Task

A Task can list absolute file paths as metadata. When the Task is associated
with a project, choose a file link to resolve it through the same authorized
Files rules used by Markdown links.

The path does not grant filesystem access and is not automatically sent to an
agent. Missing, sensitive, outside-root, ambiguous, or unsupported paths fail
closed. See [Files and context](files-and-context.md#follow-file-links).

## Add a Task to a prompt

Open a Task and choose **Add to prompt**. Sedes adds a structured chip to the
current thread's composer.

Before delivery, the chip follows live Task renames and completion state. At
Send, Queue, or Steer acceptance, Sedes records an immutable snapshot so the
historical prompt remains stable. A Task deleted before acceptance blocks the
delivery and leaves the draft intact. A completed Task is still valid.

A prompt can contain up to eight unique Task references and may consist only
of Task references. Adding a Task does not enable Task-management tools for the
agent and does not grant access to the Task's file paths.

Structured Task references cannot be represented in Codex TUI keystrokes. Use
Chat for that prompt.

## Settle or archive threads with open Tasks

Settling and archiving may affect a thread family containing open Tasks. Sedes
shows a preview and asks for an explicit supported disposition instead of
assuming that hiding a thread also completes its work.

Review the counts for the current thread and descendants. Stashes and Task
records remain separate: preserving a stash does not preserve or complete a
Task, and completing a Task does not consume a stash.

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
