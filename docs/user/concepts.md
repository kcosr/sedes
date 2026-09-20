# Core concepts

This page defines the small set of names needed to understand Sedes. For a
walkthrough, continue to [Conversations and the composer](conversations.md).

## Project

A **project** is a directory Sedes has remembered as a workspace. It is usually
a source repository, but it can be any allowed directory. A project provides
the working directory for a thread and, when supported, the root for Files,
Git status, skills, and native-conversation discovery.

Use **Add project** to choose an execution environment and an allowed absolute
path. Opening a project does not move files or copy a repository. Sedes scans
only remembered projects for eligible provider conversations; it does not
search arbitrary directories.

## Execution environment

An **execution environment** is the machine or managed environment where the
project is located. The most common environment is the same computer that runs
Sedes. **Settings → Environments** also configures supported SSH environments
for this Sedes account.

Environment color cues help distinguish otherwise similar projects and
targets. They are visual labels; the configured target and project determine
where work actually runs.

## Backend and target

A **backend** is a provider integration: Pi SDK, Codex, Claude, or Grok. A
**target** is a configured backend connection paired with one execution
environment. It determines which provider process or endpoint a thread uses.

Targets are configured in **Settings → Backends**. If several targets can serve a
new thread, Sedes asks you to choose rather than guessing. A thread cannot be
retargeted after its provider conversation is bound.

## Agent

A saved **Agent** is a reusable starting configuration for one backend kind. It
can include model and execution-setting overrides and a Sedes agent-tool
policy. It does not contain a project, target, endpoint, credential, or
provider account.

When you create a thread from an Agent, Sedes resolves the Agent against the
chosen project and target and copies the resulting settings into the thread.
The thread is independent after creation: editing or deleting the Agent does
not rewrite existing threads.

Use **More > Agents** to manage Agents. Select **Custom** during thread creation
when you do not want to start from a saved Agent. See
[Manage saved Agents](organize-work.md#manage-saved-agents) for the full
workflow.

## Thread template

A **thread template** combines a saved Agent with a project, target, and
execution-workspace choice. It is a shortcut for the ordinary new-thread form;
the title is never part of the template, and every prefilled value remains
editable.

Templates refer to the current Agent instead of freezing a copy. A template
whose Agent, project, or target is missing is marked **Needs attention** and
must be repaired or deleted before it can create a thread.

See [Manage thread templates](organize-work.md#manage-thread-templates) for the
creation, update, repair, and deletion workflow.

## Sedes thread and provider conversation

A **Sedes thread** is the object shown in the sidebar. A newly created thread
starts as a durable draft and does not yet have a provider conversation. The
first successful **Send** creates and binds exactly one native Pi, Codex,
Claude, or Grok conversation.

After that first send:

- the provider owns the transcript and native conversation identity;
- Sedes owns the title, draft, stashes, pending input, Tasks, automation,
  bookmarks, organization, and recovery records; and
- Sedes presents the different providers through a common conversation UI.

An imported native conversation is the same idea in reverse: Sedes discovers
an eligible conversation in a remembered project and adds a Sedes thread
around it.

## Draft, pending input, and stash

- The **draft** is the content currently in the composer. It is saved as you
  work and can include text, one skill, context excerpts, attachments, and Task
  references.
- **Pending input** has left the composer but has not yet appeared as confirmed
  provider history. It may be sending, steering, queued, failed, or uncertain.
- A **stash** puts the current draft aside for this thread so you can write
  something else, then restore it later.

These are deliberately separate. Once an action transfers content out of the
composer, new typing belongs to a new draft.

## Turn

A **turn** begins with user input and contains the provider's resulting work
and response. A running turn can be bookmarked even before the assistant starts
replying. Finished turns can also be bookmarked; completed turns can be used as
fork points, searched, and selected as context. Work still streaming is not a
completed turn.

## Fork and New

A **fork** creates a separate provider conversation with copied native history
through a supported boundary. The child keeps lineage back to its source.

The thread menu's **New** action is different: it creates an empty, unbound
draft in the same project and target with copied next-turn settings. It copies
no transcript, draft, Task, attachment, queue, automation, or lineage.

## Task and automation

A **Task** is durable work tracked outside provider history. It may be global,
belong to a project, or belong to one thread. A Task can be added to a prompt
as a structured reference.

An **automation** schedules a prompt on one thread. It can run on that thread or
create a child thread for each run. Each thread can have at most one
automation.

## Inventory state

Inventory state is how you organize a thread; it is not the same as whether a
provider turn is running.

- **Active**: ordinary working inventory.
- **Snoozed**: hidden or placed in Upcoming until a deadline or new activity
  wakes it.
- **Settled**: quiet work you want below the working set without archiving.
- **Archived**: removed from the normal sidebar and unable to accept new input
  until restored.

Pinning and Group membership are independent of these states.

## What is local to one browser

Most working data is stored by the server and follows the user across clients.
Presentation choices such as sidebar layout, panel sizes, activity detail,
mobile refocus, and whether the Prompts tab is shown are local to each browser
installation.

Previous: [User guide](index.md) · Next:
[Conversations and the composer](conversations.md)
