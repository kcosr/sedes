# Conversations and the composer

Ordinary chat replies and user messages retain their full text. Tool previews and
reasoning can still show an explicit truncation notice. A message that exceeds
the supported conversation size produces an error instead of displaying a
silently shortened reply. The complete serialized message limit is 16 MiB, and
the containing history page must also fit its limit.

This guide covers the full conversation workflow, from an empty draft through
running, queued, completed, and forked work.

## Speak to a thread on Android

After configuring [Android voice](../operator/clients/voice.md), use the
microphone on the voice card under the composer to send spoken text. The card
appears once voice is connected and set to Manual or Response. If voice cannot
connect, **Settings → Voice** shows the problem and a retry button; the rest of
the app keeps working. The microphone targets the thread shown on the card.
Voice sends a separate message and preserves the unsent composer draft. It can
also make the first send to an empty thread.

Enable **Pin default voice thread** to use your default thread as the initial
recording target while browsing elsewhere. The row picker can override it for
one recording. If no initial target is available, Start asks you to choose one
without changing the saved default. An unavailable retained voice thread reports
an error and stays selected until you release it or choose another target.

The card's first line always names its thread, using its title or **Untitled
thread**: the thread being spoken or recorded to, or, when idle, the thread a
recording would use. An explicit choice takes priority. Otherwise, pinning uses
the default thread; without pinning, it follows the visible available thread.
With no thread visible, it uses the retained voice thread, then the default.
An unavailable visible thread or no available target makes the card ask you
to choose a thread.
The second line is the state, such as **Ready · Response · Auto-listen on**,
**Speaking** with the notice kind and queued count, or **Listening**. If voice
needs to resume, the card offers **Resume**.

Voice retains its last active thread after playback or recording ends, including
Stop or Cancel. Browsing changes the next in-app recording target but preserves
that background destination. While idle and showing the retained fallback,
**Next** releases it and restores the default selection. Next stays disabled
when the card follows a visible or explicitly chosen thread. Releasing does
not record, send, navigate, or change the draft.
Off, a connection change, an ended voice session, or enabling pinning clears
retention. Turning pinning off during an interaction retains its current thread.

Tap the title and status area to open the voice target thread. Its separate
chevron opens **Choose target thread**, a popup available with pinning on or off.
While idle, it chooses the next recording started in the app; while listening,
it changes the current recording target.
The choice leaves the viewed thread and saved default unchanged, and navigation
does not redirect it. The choice is consumed when a new in-app recording
starts, and clears when voice is turned Off or the connection changes.
Headset and notification Start use the pinned default, otherwise the retained
voice thread, otherwise the saved default. They ignore the viewed thread and
preserve your pending in-app choice. Idle headset or notification **Next** releases
the retained destination. Automatic notification replies keep their own targets.
The popup lists the visible thread first. On mobile, search stays visible and
the keyboard stays closed until you tap it. **Default voice thread** in quick
or full settings uses the same search and rows inside a modal or mobile sheet.
Once recognition finishes, its target and delivery policy stay fixed through
any connection recovery. The left status icon opens the **Voice** sheet with
**Audio mode**, **Auto-listen**, **Keep listening by default**, **Follow composer mode**, **Pin default voice
thread**, **Only play from default voice thread**, **Default voice thread**, and
**All voice settings**. The playback filter limits automatic playback to the default thread; it does not change
where explicit recordings go.

**Keep listening by default** is initially off. Enable it in either voice settings
menu to start new manual and auto-listen recordings in infinity mode. The infinity
button changes only the current recording; changing the saved preference takes
effect on the next recording. The idle Start button shows infinity when that
default is on and a microphone when it is off.
The three action positions stay fixed: Next, Stop, Record while idle or playing;
Keep listening, Cancel, Send while recording. Unavailable actions stay disabled.
On narrow screens the title and status appear above the buttons.

Spoken input queues while a thread is running. Enable **Follow composer's
selected mode** to use the client's Queue/Steer preference instead. When
supported, Steer addresses the current turn or conversation; if that target
is no longer available at admission, or other queued messages must deliver
first, the message queues. An unavailable thread produces an error rather than
redirecting the message elsewhere.

Response mode speaks selected notifications and may listen afterward. Manual
mode keeps completion speech silent but can still listen after a completion;
other selected notices remain spoken without listening. Automatic listening
requires both the event's **Speak then listen** setting and **Auto-listen**,
plus a current, idle target with no blocking input or unresolved admission. It
never types an answer into an approval or question form.

**Record** ends speech and starts a reply to the spoken thread, even with
Auto-listen off. During speech, **Next** skips both the speech and its follow-up
recording; while idle and showing a retained fallback, it releases that thread.
Playback **Stop** in the app or notification cancels the interaction and clears
queued speech and pending agent-requested voice actions. It leaves voice enabled
and does not stop the agent. Headset Play/Pause and Next preserve queued speech.
While voice is recording or recognizing, Stop becomes **Cancel**, which discards
the recording unsent and preserves queued playback. **Off** clears
the voice queue and hides the card unless **Show voice bar when off** is on in
**Settings → Voice**; then a dimmed card stays, and its status icon opens the Voice
sheet to turn voice back on. The notification silence bell suppresses
automatic voice and script delivery, while explicit recording remains
available. The card shows the latest voice error until your next voice action
or the next interaction.

To hear a reply again, tap **Play response aloud**, the speaker after **Copy
response** in a finished turn's footer. It appears only while voice is set to
Manual or Response with speech configured. The reply joins the voice queue
behind anything already playing. With **Auto-listen** on, it can then record a
new message to that reply's thread when the thread currently accepts input. It reads the
response text that a spoken completion would. When the phases selected under
**Response text** hold no text, it reads the whole reply instead. That happens
when **Response text** selects no phases, or when the turn has text only in
unselected phases, such as Provisional commentary.
**Record**, **Next**, and **Stop** work as for any notice. See
[Replay a reply](../operator/clients/voice.md#replay-a-reply).

If Sedes rejects a spoken message, voice reports that it was not delivered. If
voice cannot tell whether a message arrived, or Sedes asks it to try again
later because the thread is busy starting, changing, or being created, it keeps
the message under **Pending input recovery** in **Settings → Voice** and checks
again on its own without resending, while voice stays available for other
notices and recording. **Resume input** explicitly authorizes another attempt
with the same message identity, used only if Sedes never received it.
**Discard** deletes the saved message from this device; it cannot withdraw a
message Sedes already received.

A spoken first send to an empty thread counts as delivered once Sedes has
recorded it. If creating the conversation is then interrupted, use the thread's
recovery card, as for a typed first send; see
[First send is uncertain](troubleshooting.md#first-send-is-uncertain).

## Turn speed

Completed Pi turns can show a small **tok/s** value at the left of the turn
footer. It is the main agent's output tokens, including reasoning, divided by
the combined time spent on its model requests. Request startup and network
latency count; tool execution, approval waits, compaction, and gaps between
requests do not. This measures response throughput across the turn, so a long
tool call does not make the model appear slower.

The value appears only when every response was measured successfully. Failed,
stopped, and older unmeasured turns have no value. A response error also hides
the value when Pi retries or recovers from a context overflow successfully.

It works without enabling experimental usage accounting. Sedes keeps the most
recent 100 measured turns in memory while that Pi session remains loaded;
stopping or unloading the runtime, or restarting the server, discards them.
Refreshing the browser can retain them while the same session is loaded.
Codex, Claude, and Grok do not currently provide this measurement.

## Context and Session stats

The composer context meter and **Thread actions → Session stats** show the
provider's available context estimate and transcript counters without enabling
experimental usage accounting. Pi, Claude and OpenCode provide both; Codex
provides context, and Grok does not provide these statistics.

Claude reports estimated current occupancy against its effective auto-compaction
window. OpenCode reports the latest measured assistant request against that
model's context window, so new prompts and tool results may not appear until the
next measurement. OpenCode counters cover the full retained active branch,
including turns outside the loaded history page. Compaction or a model change
can lower the estimate or leave it unknown until fresh evidence arrives.

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
3. Choose its location: the environment and directory. A project with one
   available location selects it for you.
4. Choose a target on that location's environment when more than one is
   available.
5. Choose a saved Agent or **Custom**.
6. Review the model and other settings, enter a title, and create the thread.

Template, Project, Location, and Target dropdowns let you search the available
choices. Typing only filters the list; choose a result to apply it.
**Configure manually** stays available in the template dropdown while searching.
Use Up/Down and Enter to select, or Escape to close the list and keep the form.
A project whose locations are all unavailable is listed but cannot be chosen;
its entry says why.

The sidebar Scope prefills the form. A scoped project is preselected, and an
Environment or Target already selected in Scope limits the locations and
targets offered. When the scoped project has no location there, choose another
project.

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

From an existing thread, choose **New with same settings** in **Thread
actions** or in the thread's sidebar context menu. Sedes creates an independent
empty draft in the same project and target and copies the source thread's
eligible next-turn settings and agent-tool policy.

It does not copy the source title, draft, stashes, attachments, Task
references, pending input, automation, transcript, Goal, terminal, runtime, or
fork lineage. Use [Fork from a completed turn](#fork-from-a-completed-turn)
when you need history.

## Navigate messages

When you open a thread, its known title and project context appear while the
conversation loads. A loading message remains below the header until the backend
is ready. You can hide the Chat panel during loading; conversation actions
become available after the thread connects.

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

The picker is searchable on desktop and mobile. Mobile search leaves the
keyboard closed until you tap it; an empty search keeps the saved order. If another client changes the prompt library while the
picker is open, use its refresh control or reopen it.

### Add a Task

Choose **Add to prompt** from a Task, or drag the Task onto the composer. It
appears as a compact pill above the message box: a live structured reference,
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
conversation: Claude takes it at its next opportunity, usually when the tool
call it is running finishes, and it never interrupts work. If the turn is still
running, the message joins it at that point; otherwise it starts the next turn.
OpenCode v2 also steers the conversation at its next native opportunity. Its
input remains pending until exact native consumption is observed. Stop tries
to withdraw each unconsumed native input; an uncertain outcome stays visible
for review and is never resent automatically.
Grok has no Steer, so active-turn input waits in Queue.

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
Sedes can prove the provider never accepted it; it is never redirected into a
different active turn. A Steer the provider accepted but never used comes back
to you as not sent, as described under [Stop a turn](#stop-a-turn).

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

An idle voice submission also appears as a normal chat message once Sedes
admits it. It leaves any typed draft intact and honors **Seek on send** on the
device where you spoke. Routine sending labels stay hidden for both typed and
spoken messages. Local voice supplies the complete recognized text for the first
submitted bubble, without truncation or a preview label. Other server-owned
submissions appear as bubbles once their full content is available. The provider's
matching transcript message replaces that presentation without creating a duplicate.
Voice input admitted as Queue or Steer still uses the pending-input rows, as do
failed or uncertain deliveries that need attention.

### Work with queued input

Queued entries are shown in order. An entry that has not crossed the provider
boundary can be deleted or restored to an empty composer. Once delivery is
dispatching or uncertain, Sedes cannot safely retract it and does not offer a
cosmetic dismiss action. A failed or not-sent entry offers **Restore**, which
returns its text to an empty composer without sending, and **Dismiss**, which
removes it; each entry clears on its own.

Restore is disabled for user input above the composer's 64 KiB limit. Use
**Copy full text** to preserve the complete text, including failed or not-sent
input. Copy leaves the queued entry and current composer unchanged. Copy it
before dismissing the entry if you want to keep it.

When Steer is supported, you can convert the user-created queue head to
**Steer** without changing the current draft. An ordinary Queue entry already
ahead of the composer must be delivered, removed, or converted before a later
direct Steer can be admitted.

### Send more than one Steer

You can steer a running turn several times without waiting. Each Steer gets
its own card in the pending-input strip, in the order you sent them, and the
composer stays available for another Steer or Queue.

Sedes still sends Steers to the provider one at a time, in first-in,
first-out order: each crosses to the provider before the next is sent. A card
shows **Steering** until its own message appears in history, and then
disappears, independently of the others. Several steers the provider takes
together appear in the order you sent them.

On Claude, the message appears as soon as Claude takes it, at that point in
the running turn rather than after Claude's final answer, and it stays there
after a reload.

If the turn ends while Steers are still waiting (on Claude, a Steer that
arrives after the final answer starts the next turn itself), **Send** is
available again. Your new message waits in the queue behind those Steers and
is sent only after each of them has appeared or been returned to you, so it
never runs ahead of them.

### Stop a turn

**Stop** requests the backend's supported interrupt. Stopping does not erase
work already persisted by the provider, and it does not imply that every
external side effect was rolled back. If the outcome cannot be confirmed, use
the displayed recovery action rather than repeating Stop.

Stop preserves these input distinctions:

- Sedes's own Queue is untouched: queued entries keep their order and run
  after the stopped turn. A Steer card Sedes has not yet sent to the provider
  is also still Sedes's own work.
- A Steer the provider proves it withdrew shows **Not sent**. Restore it to
  the composer or dismiss it; later queued entries wait for those choices.
  Sedes never resends it. OpenCode can leave an input unconfirmed when native
  withdrawal fails or exceeds the Stop deadline; that pending input may still run.
- A Steer the provider already used stays with the stopped turn.

If the provider's runtime ends or Sedes restarts before the provider used a
Steer, Sedes also returns it as not sent when it can prove that. When it
cannot, the card stays unconfirmed or says the outcome is unknown. Either way
Sedes never resends it.

| Backend | How Stop handles a Steer the provider has not used |
| --- | --- |
| Claude | Stop asks Claude to withdraw it before interrupting. Claude's own queued work, such as a finished background task's notification, can still start a turn afterwards. |
| Pi | Stop clears Pi's steering queue before interrupting. |
| Codex | Codex discards it when it interrupts the turn. Sedes reports it not sent once the stopped turn's history is final without it. |
| Grok | Grok has no Steer; active-turn input waits in Queue. |
| OpenCode v2 | Stop interrupts the session, then requests withdrawal of each exact Sedes-owned pending input within the same deadline. Only proven withdrawal marks it not sent. Failed or uncertain cleanup stays unconfirmed and may leave native work pending. |

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
thread is parked or archived. The sidebar shows a stash count. Each thread
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

The sidebar and thread preview also show live background work: a slow grey
spinner for subagents, or a solid grey dot when only commands or other tasks
remain. An active main turn's blue spinner takes priority, followed by the blue
unacknowledged-completion dot. Opening the thread acknowledges completion and
reveals any remaining background indicator. Hover for counts by kind. Uncertain
or disconnected observations do not claim that background work is still live.

## Find text in a thread

On narrow screens, Bookmarks and thread settings stay in the main thread
header, alongside the automation button when the thread has an automation.
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

## Arrange panels

A thread's workbench has five panels: Chat, Files, Workpads, Tasks, and
Terminals. On desktop, the stage has five regions: the Middle, and Left,
Right, Top, and Bottom around it. Each region shows one panel. By default Chat
is in the Middle; Files, Workpads, and Tasks are on the Right; and Terminals is
at the Bottom.

Opening a panel shows it in its region. The panel that region showed is
hidden but stays loaded, so its drafts, scroll, and editor content survive; it
returns only when you open it again. Hiding a panel or moving it away leaves
its region empty, and the rest of the stage grows to fill the space. Selecting
a thread shows its Chat wherever Chat is.

The workbench bar above the panels has a button for each loaded panel, in the
order Chat, Files, Workpads, Tasks, Terminals. A filled button means the panel
is visible; an outlined one means it is loaded but hidden. Select a button to
hide a visible panel or show a hidden one in its region. The **Panels** menu
(▾) lists every panel with its state, such as **On the right** or **Loaded,
hidden**:

- Select a row to open that panel in its place.
- Use the button at the end of a row to open the panel in another region,
  which becomes its place.
- **Reset layout** leaves Chat alone in the Middle, closes the other panels,
  and restores the default places, asking first if unsaved changes would be
  lost. Panel sizes are kept.

Each panel header has these controls:

- **Maximize** fills the stage with the panel; the others stay loaded behind
  it. **Restore**, Escape, or opening another panel returns the layout as it
  was. Escape is left to a focused text field or terminal, or an open menu or
  dialog. Maximize isn't saved.
- **✕** closes the panel and unloads it, and asks first if unsaved changes
  would be lost. Chat's ✕ only hides it; on phones Chat has none.
- **⋯ → Move to** puts the panel in the Middle, Left, Right, Top, or Bottom.
  For a panel on the Left or Right, **Full height** lets its region take the
  corners it shares with Top and Bottom; for Top or Bottom, **Full width**
  does the same with Left and Right. When two regions want the same corner,
  the most recent choice wins. By default the sides run full height and Top
  and Bottom span the Middle only.

Drag the divider beside a panel to resize it, or double-click the divider to
return it to its default size. Chat keeps a 360px minimum width. Where each
panel opens, which panels are loaded, the corner choices, and sizes are saved
on this device and shared by every thread. The Terminals panel and its tabs
belong to each thread; see [Terminal panes](terminals.md).

When the window is too small for the visible panels' minimum sizes, Sedes
hides the regions you used least recently and announces which. It never hides
Chat or the Middle. Hidden panels stay loaded and come back when there is room.

On phones and other narrow screens, the workbench shows one panel at a time:
use the bar's buttons or the **Panels** menu to switch. Files, Workpads, and
Tasks each take the whole stage while in front. Regions, Maximize, and Move to
don't apply. Returning to Chat uses the same retained state rather than
rebuilding the file view.

Chat is home on a phone. Closing or hiding another panel returns to Chat, and
so does Android Back, or browser Back from Terminals. A panel you hide or go
back from stays loaded, and its button brings it back as you left it. In Tasks
and Workpads, Android Back first returns from an open task or workpad to the
list. On Android, Back from Chat opens the navigation drawer.

Previous: [Core concepts](concepts.md) · Next:
[Organize and reuse work](organize-work.md)
