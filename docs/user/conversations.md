# Conversations and the composer

Ordinary chat replies and user messages retain their full text. Tool previews and
reasoning can still show an explicit truncation notice. A message that exceeds
the supported conversation size produces an error instead of displaying a
silently shortened reply. The complete serialized message limit is 16 MiB, and
the containing history page must also fit its limit.

This guide covers the full conversation workflow, from an empty draft through
running, queued, completed, and forked work.

## View recorded usage

Recorded usage is **Experimental**. The views below require the server
operator's `SEDES_EXPERIMENTAL_USAGE=1` opt-in. When it is off, Session stats
still shows live context occupancy and transcript counters.

The **Turn usage and cost** icon appears below a finished turn when it has
recorded usage. Hover or focus previews the summary; click or tap pins it.
Click again, press Escape, tap outside, or use mobile Back to close. Failed and
interrupted turns keep their recorded usage, including while the backend is
disconnected. Running turns and turns without recorded usage have no icon.

The compact summary shows input and output tokens, nonzero cache or reasoning
counts, and cost/model information when available. **Cached input** and **Cache
write** are part of **Input**, and reasoning is part of output. Do not add every row together. An em
dash means unavailable, not zero. Cost estimates are not billing receipts;
missing cost is explicitly unavailable. Short status labels indicate partial
or restricted coverage.
**Main agent only** excludes subagent work; it does not by itself mean tokens are
missing from the displayed agent's usage. **Partial** indicates incomplete capture
or allocation within the reported scope.
Previously saved records and current Claude results can retain a conservative
partial classification. Session-wide capture gaps can also affect older turns.

**Thread actions → Session stats** separates durable **Recorded session usage**
from live context occupancy and transcript counters. Session usage can exceed the
sum of displayed turns because some work has no reliable turn attribution.
For Codex, the session table separates **Main agent**, **Subagents** (including
nested agents), and **Total**. Subagent work belongs to the session rather than
the turn that launched it; it can continue after that turn finishes. Claude's
session total already includes its SDK-reported subagent work, without a
separate subagent subtotal.
Small **Partial**, **Main agent only**, **Recorded intervals**, and **Needs
reconciliation** labels explain restricted coverage or unresolved evidence. Inherited turn
usage does not charge copied work to the child session. Grok currently reports
usage as unsupported.

Sedes records on the main server independently of an open browser. Open usage
views refresh periodically; closing them stops those reads. Previously recorded
values remain available offline from the provider, and a refresh failure retains
the last successful display. Older turns may have no recoverable accounting.
For totals across threads over time, open the [Usage page](usage.md).

## Create a thread

Choose **New thread** from the sidebar or landing page. On desktop the form
opens beside the sidebar; on mobile it opens as a bottom sheet.

1. Optionally choose a thread template.
2. Choose the project where the agent should work.
3. Choose a saved Agent or **Custom**.
4. Choose a target when more than one compatible target is available.
5. Review the model and other settings, enter a title, and create the thread.

Template, Environment, Target, and Project dropdowns let you search the
available choices. Typing only filters the list; choose a result to apply it.
**Configure manually** stays available in the template dropdown while searching.
Use Up/Down and Enter to select, or Escape to close the list and keep the form.

A sidebar project-name filter can match projects on several machines. In that
case, choose an Environment before choosing the concrete project directory.
The matching project is preselected when only one is available there; when
several directories have the same name, their paths distinguish the choices.
An Environment or Target already selected in Scope constrains the destination.

The result is a durable draft. Sedes has not created a provider conversation
yet. You can navigate away, refresh, or restart Sedes without losing the
draft.

Agents and templates prefill this ordinary form without locking it. See
[Manage saved Agents](organize-work.md#manage-saved-agents) and
[Manage thread templates](organize-work.md#manage-thread-templates) for their
creation and reuse workflows.

### Thread environment variables

Before creating a thread, open **Environment variables** below the Agent
selection. Review inherited values, add thread-specific values, or explicitly
unset an inherited variable. **Use these values** accepts the draft; **Cancel**
leaves the previously accepted values unchanged. Sedes checks the preview's
configuration and Agent revisions at creation. If defaults changed, review the
refreshed values and create again.

After creation, **Thread actions → Environment variables…** shows the saved
snapshot and each variable's source. It is read-only, including while the thread
is still an unbound draft. Changes to an environment, backend, or saved Agent
do not rewrite that snapshot. Secret references are retained; their values are
resolved on the execution host when needed.

**Fork with changes…** opens an editable copy when the thread supports forking.
The fork keeps the source's captured environment, backend, and Agent layers and
uses the edited thread overrides. The source remains unchanged. Ordinary forks
retain the source snapshot. Backend startup settings are managed separately in
Settings and cannot be overridden per thread.

Codex's managed terminal is unavailable for threads with execution variable
overrides because that handoff cannot yet preserve their saved environment.
The regular chat and command tools continue to use the snapshot.

### Rename a thread

Choose **Rename** from the thread menu, or use the editable title in the header.
Enter a non-empty title and save. Before first send, this changes only the
unbound Sedes draft title. After binding, rename is available only when the
backend supports its native rename operation; Sedes updates the provider and
the Sedes title together. Renaming never creates a thread or changes history.

### Create an empty thread with the same settings

From an existing thread, choose **New** in **Thread actions** or in the
thread's sidebar context menu. Sedes creates an independent empty draft in the
same project and target and copies the source thread's eligible next-turn
settings and agent-tool policy.

It does not copy the source title, draft, stashes, attachments, Task
references, pending input, automation, transcript, Goal, terminal, runtime, or
fork lineage. Use [Fork from a completed turn](#fork-from-a-completed-turn)
when you need history.

## Navigate messages

When you open a thread, its known title and project context appear while the
conversation loads. A loading message remains below the header until the backend
is ready. You can close or collapse the chat panel during loading; conversation
actions become available after the thread connects.

With focus in the chat or an empty composer, press **Command+Up/Down** or
**Ctrl+Up/Down** to jump to the previous or next loaded prompt relative to the
top of the chat viewport. Scrolling manually changes the starting point for
the next jump. Up from within a response returns to its prompt; pressing Up
again moves to the preceding prompt. Navigation stops at the loaded boundaries.
These shortcuts preserve normal text navigation while editing a draft.

## First send

Review the model and execution settings, write the prompt, and choose **Send**.
The first send creates exactly one provider conversation and binds it to the
Sedes thread.

Sedes records the creation attempt before clearing the draft. If the connection
fails at an ambiguous moment, Sedes shows a recovery card instead of silently
creating a second conversation or sending the message twice. Follow that card;
do not manually duplicate an uncertain first send. See
[Troubleshooting and recovery](troubleshooting.md).

## Build a prompt

The composer can contain:

- text;
- one selected skill;
- exact context excerpts captured from chat, files, Markdown, or diffs;
- file or image attachments; and
- up to eight structured Task references.

The whole composer is saved on the server. Text, context, and materialized Task
content share a 256 KiB input limit. Attachment limits are separate and shown
in the attachment picker.

### Use a skill

Choose **Choose skill**, or type `/skill` by itself, to search skills available
for the current project and backend. One selected skill follows the draft
through stash, queue, retry, first send, or Steer. A skill may be sent without
additional text.

### Use a saved prompt

Saved prompts are reusable pieces of text managed under **Settings > Prompts**.
If **Show Prompts tab** is enabled, open **Prompts** above the composer.

- Select a prompt row to append its text and immediately use the current
  delivery action: Send while idle, or the selected Steer/Queue action while a
  turn is active.
- Use the row's **Add to composer** icon to insert the text at the caret and
  keep editing.

The desktop picker is searchable. The compact mobile picker keeps the saved
order but omits search. If another client changes the prompt library while the
picker is open, use its refresh control or reopen it.

### Add a Task

Choose **Add to prompt** from a Task. This adds a live structured reference,
not copied textarea text. Renames and completion changes remain visible until
delivery. At acceptance, Sedes records an immutable Task snapshot for history.
Deleting the Task before acceptance blocks delivery without consuming the
draft. See [Tasks and automations](tasks-and-automations.md).

### Attach a file or capture context

Choose files, paste into the focused composer, or drop files onto it. You can
also select eligible text in a completed message, a read-only file, a rendered
Markdown preview, or a settled diff and choose **Add to message** or **Add
note**. Details are in [Files and context](files-and-context.md).

## Send, Steer, Queue, and Stop

The composer action changes with thread state and provider capability.

| Action | What it means |
| --- | --- |
| **Send** | Start the next turn when the thread is idle. |
| **Steer** | Send a course correction while a turn is running. |
| **Queue** | Save input to run at the next safe idle transition. |
| **Stop** | Ask the provider to interrupt the active turn. |

Pi and Codex steer the exact turn that is running. Claude's Steer goes to the
conversation: Claude delivers it at its next opportunity, which may join the
running turn or start the next one, and it never interrupts work. Grok has no
Steer, so active-turn input waits in Queue.

The selector shows only modes the current backend supports; temporarily
unavailable modes remain visible but disabled. A temporary change in thread
state does not replace your selected Steer mode with Queue. You can select
Queue whenever it is available. For a backend without Steer, the composer uses
Queue without overwriting your saved preference for other backends.

While a turn is active, the split submit button shows merge arrows for Steer
or stacked layers for Queue. The main button submits with the remembered mode.
The chevron opens **Steer** and **Queue**: choosing either changes and remembers
the mode locally without submitting the draft. Tap the main button to submit. The adjacent Stop button interrupts the active turn.

Sedes checks the current server state when it admits an action. If a turn
finishes between clicking and admission, an ordinary delivery intent becomes
Send. A Steer whose exact target has just ended becomes queued work only when
Sedes can prove it was not accepted; it is never redirected into a different
active turn.

### What happens to the composer

Send, Steer, and Queue transfer the captured content out of the composer
immediately. New typing after the clear is a new draft.

- Idle Send appears immediately as a normal user message while provider
  history catches up, and the activity bar above the composer starts at once
  rather than waiting for the provider's first output.
- Steer and Queue appear as pending-input rows above the composer.
- If a clean failure proves the input was not delivered, Sedes restores or
  reconciles it instead of leaving a failed chat bubble.
- If acceptance is uncertain, the contribution remains visibly unconfirmed
  and is not copied back into the composer where it could be sent twice.

The immediate Send bubble is only a responsive local presentation until the
matching provider history arrives. During that interval it is not searchable,
bookmarkable, forkable, or eligible for context capture.

### Work with queued input

Queued entries are shown in order. An entry that has not crossed the provider
boundary can be removed or restored to an empty composer. Once delivery is
dispatching or uncertain, Sedes cannot safely retract it and does not offer a
cosmetic dismiss action.

When Steer is supported, you can convert the user-created queue head to
**Steer** without changing the current draft. An ordinary Queue entry already
ahead of the composer must be delivered, removed, or converted before a later
direct Steer can be admitted.

### Send more than one Steer

You may submit several Steers while the same turn remains active. Their cards
stay in first-in, first-out order while Sedes makes provider calls one at a
time. Each card disappears only when its exact operation is represented in
history.

### Stop a turn

**Stop** requests the backend's supported interrupt. Stopping does not erase
work already persisted by the provider, and it does not imply that every
external side effect was rolled back. If the outcome cannot be confirmed, use
the displayed recovery action rather than repeating Stop.

Stop never removes Sedes's own Queue: queued entries keep their order and run
after the stopped turn. A Steer card Sedes has not yet sent to the provider is
also still Sedes's own work. What Stop does to a Steer the provider has
received but not used yet depends on the backend:

| Backend | A Steer the provider received but has not used when you press Stop |
| --- | --- |
| Claude | Stop withdraws it, so it never runs. Its card shows it failed and was not sent. Restore it to the composer or dismiss it; later queued entries wait for that choice. Sedes never resends it. A Steer Claude already started stays with the stopped turn. Claude's own queued work, such as a finished background task's notification, can still start a turn afterwards. |
| Pi | Stop clears Pi's steering queue, so it never runs. Its card shows it failed and was not sent. Restore it to the composer or dismiss it; later queued entries wait for that choice. Sedes never resends it. A Steer Pi already used stays with the stopped turn. |
| Codex | Codex drops it without reporting that. Sedes counted it as delivered when Codex accepted it, so it is neither in history nor returned to you; send it again if you still need it. |
| Grok | Grok has no Steer; active-turn input waits in Queue. |

### Mobile composer focus

On mobile, Sedes normally returns focus to the composer after Send, Steer, or
Queue so the keyboard remains open. Disable **Settings > Mobile > Refocus
composer after sending** if you prefer focus to leave the field. This choice is
local to that browser or packaged client.

### Enter and line breaks

With a fine-pointer desktop layout, Enter uses the selected Send, Steer, or
Queue action and Shift+Enter inserts a line break. While choosing a composer
command, Enter or Tab selects the highlighted command instead. Input-method
composition is allowed to finish without sending.

On a touch-oriented layout, Enter inserts a line break so the on-screen
keyboard remains useful for multiline prompts. Use the visible composer action
button to Send, Steer, or Queue.

## Put a draft aside with stashes

A stash saves the current composer for this thread and clears the composer for
a different idea.

1. Add the text, skill, context, attachments, and Task references you want to
   save.
2. Choose **Stash prompt**, or press Control/Command+S.
3. Continue working with the now-empty composer.

When stashes exist, the same button opens **Stashed prompts**. Choose a row to
restore it, use **Stash current** to save another draft, or use the delete
control to permanently remove one. Restoring appends stashed text after any
current text and safely merges the structured content; it does not silently
overwrite newer draft work from another client.

Stashes belong to one thread, survive restart, and remain attached when the
thread is settled or archived. The sidebar shows a stash count. Each thread
can hold up to 50 stashes.

## Read agent activity

Consecutive reasoning and tool work is grouped into an **Activity** row so
commands, file operations, searches, and tool calls do not overwhelm the
transcript.

Choose the browser's activity mode under **Settings > General**:

- **Detailed activity** lets you expand normalized reasoning and operations,
  including available command output, file previews, diffs, arguments, and
  results.
- **Activity summaries** sends the browser only compact descriptors and
  provider-supplied reasoning summaries. Open an Activity row and choose
  **Enable details** when you need the full projection.

Tool headers let you scroll filenames and previews horizontally with a touchpad or touch swipe. Command headers show the first line, limited to 512 characters. Scroll or drag
the preview horizontally, or focus the header and use the Left/Right arrow keys.
An ellipsis marks omitted text; expanding the command shows its full retained
input and available output.

Summary mode is a browser-delivery preference, not a provider-retention
setting. It does not remove details from provider history or from Sedes's
server-side execution path. Sedes never invents a summary from hidden raw
reasoning.

During an active Codex turn, a recent provider-supplied reasoning summary may
briefly appear above the composer. Select it to see the complete summary.
Approval and question panels take precedence over that status area.

Claude can start a turn on its own, for example when a background task
finishes. The thread then shows as running and **Stop** is available, even
though you sent nothing.

Claude also shows **Waiting for subagent** or **Background command running**
above the composer while its main response may already be finished. Multiple
jobs show counts. You can send a normal message once the main response ends;
the indicator does not turn that message into Queue or Steer. Reconnecting
shows that background status is being checked instead of claiming the work
finished. Subagent launches and observed completion, failure, or stop appear
as separate blue activity rows in the transcript, without child conversations.
This indicator does not provide individual task stop controls.

## Find text in a thread

On narrow screens, Bookmarks and thread settings stay in the main thread
header, alongside automation settings when the thread has an automation.
Expand the thread toolbar to show **Find in thread** followed by the worktree
picker on one row. Search opens below that row. Collapsing the toolbar hides
search and keeps its query for the next time you open it.

Choose **Find in thread** in the thread header. Type a query, then use Enter or
**Next match** and Shift+Enter or **Previous match**. Optional controls match
case or whole words. The result-position rail can jump directly to a match.

Search covers rendered conversation items and Activity summaries currently
available to the browser. It excludes hidden controls and content that was not
loaded in activity-summary mode. If you need tool details to be searchable,
enable detailed activity first. A just-submitted optimistic message becomes
eligible only after confirmed provider history replaces it.

## Bookmark important turns

Use **Bookmark turn** on the first user message of a turn. Running turns can be bookmarked before reply text arrives, including during
thinking or tool activity. The response preview stays empty until reply text is
available. Finished turns can also be bookmarked,
including stopped or failed turns.

The **Bookmarks** button in the thread header shows every saved turn with both
the user prompt and assistant response preview. A bookmark made during a reply
initially saves the response so far. Its saved preview expands when more of the
same reply is available in the loaded finished turn. It retains the saved text
if loaded history omits or changes that text. If you leave before the turn
finishes, reopening it allows the preview to expand. You can remove a bookmark
while its turn is still running.

Select a bookmark to jump to that turn, even when it is outside the currently
loaded history window. Remove a bookmark from the turn itself or from the
Bookmarks list. Bookmarks follow the user across browsers, and sidebar rows
show their count.

Bookmarks mark turns in the current thread; they do not copy content, change
provider history, or create a global bookmark library.

## Fork from a completed turn

Use **Fork from here** on a completed turn to create a separate thread whose
native history includes that turn. The source conversation continues on its
own branch.

Provider capabilities determine when forking is available:

- Pi and Codex can fork an explicitly selected completed turn while later
  source work is active.
- Claude forks require the source to be idle, with no background agents or
  commands still running in it. Some Claude turns cannot be forked at, such as
  a turn that ended without a final answer or one before Claude compacted the
  conversation; the turn's fork action shows why. If the newest completed turn
  is one of these, **Fork** explains why instead of forking an older turn.
- Generic **Fork** may use a provider-supported latest snapshot; otherwise it
  uses the newest eligible completed turn.

A child inherits eligible settings and records its source lineage. Detaching or
reattaching its sidebar lineage changes organization, not history. Grok does
not currently offer native fork support.

A Claude fork of an earlier turn can include background work that had not
finished by that turn. That work keeps running only in the source. The child
shows a notice saying so, and any results appear in the source thread.

If a fork fails or needs recovery, its thread explains why. **Recover fork** retries
the same fork. **Discard this fork** removes the unfinished fork without
retrying it; confirm with **Discard fork**. It is not offered once the provider
has returned the fork's copy, because **Recover fork** can then finish it
without contacting the provider again. A copy the provider already made is
left untouched. For Pi and Claude forks Sedes never imports it as a thread; a
Codex copy may later appear as a separate thread. **Start a new fork** appears
only when another attempt could succeed.

## Respond to approvals and questions

Provider approvals and structured questions appear above the composer. The
transcript remains available while you answer.

- Decision buttons submit immediately.
- Questionnaires keep local answers while you move between questions and can
  submit an explicitly unanswered response.
- Secret answers are masked and use an ephemeral response path.
- Escape requests an interrupt when available; it does not submit blank
  answers.

Sedes imposes no interaction timeout. An attended approval mode remains
attended, including during automations. For exact behavior, see
[Blocking interactions](../internals/blocking-interactions.md).

## Navigate Chat and Files

Chat and Files are the main workbench surfaces. **Collapse** keeps a surface
mounted, preserving scroll, selections, and unsaved editor content. **Close**
removes it and asks before discarding dirty Files content. The **Panels** menu
restores or focuses a surface and offers **Show all** on desktop.

On narrow screens, Files becomes a foreground sheet. Returning to Chat uses
the same retained state rather than rebuilding the file view.

Previous: [Core concepts](concepts.md) · Next:
[Organize and reuse work](organize-work.md)
