# User guide

Sedes is a workspace for running and organizing coding-agent conversations. It
keeps drafts, queued messages, Tasks, files, and organization available across
browser refreshes while Pi, Codex, Claude, or Grok supplies the underlying
conversation.

If Sedes is not running yet, begin with [Getting started](getting-started.md).

## Find a topic

| Goal | Guide |
| --- | --- |
| Learn the names used throughout the interface | [Core concepts](concepts.md) |
| Create a thread, send work, steer a run, save a draft, or find an old turn | [Conversations and the composer](conversations.md) |
| Arrange and reuse work with views, groups, Agents, templates, and inventory states | [Organize and reuse work](organize-work.md) |
| Browse or edit files, compare Git changes, attach files, or capture context | [Files and context](files-and-context.md) |
| Open local or Sidecar SSH shells and understand panel, control, and history behavior | [Terminal panes](terminals.md) |
| Track work or schedule a recurring agent run | [Tasks and automations](tasks-and-automations.md) |
| Share working notes with agents and inspect attributed revisions | [Workpads](workpads.md) |
| Understand backend controls, blocking interactions, and per-thread Agent tools | [Provider features](provider-features.md) |
| Configure appearance, prompts, mobile behavior, terminals, servers, and Tool clients | [Settings](settings.md) |
| Recover from a failed, disconnected, or uncertain operation | [Troubleshooting and recovery](troubleshooting.md) |

## A productive first workflow

1. Add a project for the repository or directory where the agent should work.
2. Create a thread, select a target and model, and send a concrete request.
3. Continue drafting while the agent works. Use **Steer** for an urgent course
   correction or **Queue** for work that should begin after the current turn.
4. Bookmark useful turns, attach exact file or transcript context to later
   prompts, and create Tasks for work that should survive the conversation.
5. Pin active threads, snooze work that has a future follow-up, settle work that
   is quiet, and archive work that is finished.

## Where Sedes saves things

There are two kinds of state worth distinguishing:

- The provider keeps the native conversation and transcript.
- Sedes keeps its organization around that conversation: project and thread
  records, titles, drafts, stashes, pending input, bookmarks, Tasks,
  automations, saved Agents, templates, and inventory state.

That distinction explains why Sedes can import an eligible native conversation
and add organization to it, and why backing up Sedes alone is not a backup of
provider-owned history. Operators should read
[State, upgrades, and backups](../operator/operations.md#state-upgrades-and-backups).

## Everyday safety boundaries

- Pairing authenticates access to one server-derived local principal. Use
  Sedes only on a supported private access boundary. Pairing and internal
  tenant/principal scoping do not create multi-user administration.
- A project admits one configured directory. It does not automatically grant
  access to every path on the machine.
- File links and Task file paths are references, not permission grants.
- An approval mode that requires attendance still requires attendance when a
  turn was started by an automation.
- Recovery callouts are intentionally conservative. Do not repeat an uncertain
  action outside the provided recovery controls merely because its result is
  not visible yet.

See [Operations and security](../operator/operations.md) before exposing Sedes
beyond its default loopback listener.

## Documentation for other roles

- [Operator guide](../operator/index.md) for installation, provider setup,
  production operation, security, and backups
- [Developer guide](../developer/index.md) for the codebase, testing, and
  release process
- [Internals](../internals/index.md) for architecture and subsystem contracts
