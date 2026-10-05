# Workpads

Workpads are shared Markdown documents for working notes. You and agents edit
the same saved document, with revision history and optional text attribution.
They belong to your Sedes account and survive restarts.

## Find and organize workpads

In a thread, select the **Workpads** button (the notepad icon, beside
**Tasks**) to open or close Workpads. It shares the workspace layout with
**Chat** and **Files**. Resize the split, use **Workpads panel actions** to
dock it on another edge, or collapse it; when it is collapsed, the button keeps
an outline, and selecting it shows Workpads again. Its open state and place
stay with you when you switch threads. On narrow screens,
switch between full-stage panels using the buttons, the panel shortcuts, or the
menu. Draft text stays mounted while the panel is collapsed or another panel
is shown. Navigation changes the view, never a document's stored scope.

Choose **Thread**, **Project**, or **Global** above the list. **Thread**
follows the current thread, and **Project** follows its project. To look at
another thread's or project's workpads, open **View options** (the filter icon
in the panel header) and choose **Browse another thread or project…**; a chip
under the scope names it until you remove the chip or switch threads. When
navigation changes the viewed scope, Workpads returns to that scope's list. A
selected document stays open when the scope stays the same, including
**Global** and switching threads within the same project in **Project** view.
If the editor has unsynced changes or a workpad change is still in progress,
confirm before leaving or choose **Keep editing** to see its result.
Synchronized drafts remain available by reopening the workpad and choosing
**Edit workpad**.

Select **Search workpads** (the magnifier in the panel header) to search the
listed scope; Escape clears and closes the search. **View options** also has
**Include nested scopes**, which adds a scope's descendants, such as the
workpads of a project's threads, and **Archived**, which lists archived
workpads instead. Each active option shows as a chip you can remove. Type a
title in the **New workpad** row under the scope and press Enter to create a
workpad there; it opens ready for editing.

A Project workpad belongs to the whole project, so every
[location](concepts.md#project-and-location) of the project shares it, on
every host. It stays with the project when you move or remove a location, and
is hidden while the project is removed. A Thread workpad follows its thread.
An open workpad's toolbar names its scope, such as **Project · sedes**; with
nested scopes included, list rows name theirs too.

Each row's **⋯** menu, and the panel header's **⋯** while a workpad is open,
offers **Rename…**, **Move to** (this thread, this project, Global, or
**Choose…** for any other), and **Archive**. Archiving removes a workpad from
the active list without losing its content or history; find it with
**Archived** and choose **Unarchive** to resume editing. Archiving a thread
preserves its workpads in their current scope. The back arrow in the panel
header returns to the list.

## Edit and save

Choose **Edit workpad** (the pencil in the workpad's toolbar) to open your
working draft. Typing autosaves the draft to Sedes and syncs it across your
clients; the toolbar shows whether it has synced. Draft sync does not publish
the text or create document revisions. **Save workpad** (or Ctrl+S, ⌘S on a
Mac) commits your changes as one revision; **Done editing** (the check) leaves
the synced draft available for later. **Discard draft…** in the panel
header's **⋯** resets it to the saved document after you confirm.

Agents continue reading and editing the saved document while your draft is
open. If that document changes, choose **Review changes** to compare your
starting version and the latest version alongside your editable draft.
Reconcile your text, choose **Use my reconciled text**, and save. Sedes checks
the revision again rather than overwriting intervening changes.

If another client changes your draft while you also have local changes, review
its text and choose **Use latest draft** or **Keep my draft**. Unsynced changes
remain local; closing with unsynced changes prompts before proceeding.

## Read attribution and history

The default view is a complete rendered document. Toggle **Show attribution**
(the highlighter) to highlight surviving text by its last editor. Hover, focus,
or tap a passage for the author, time, and revision. Agent edits show the
contributing thread's current name, with a stored name used if that thread is
no longer available. Your edits appear as **You**.

Choose **Revision history** (the clock) to open a complete earlier document;
**Older revisions** loads more. While an earlier revision is shown, a notice
says so and **Back to latest** returns to the current document. Attribution
follows the selected revision. **Revision details** at the end of the document
shows additions and removals with the revision's editor; removed text is not
inserted into the document view.

Unchanged text keeps its attribution when someone edits nearby. Moved or
substantially rewritten text can count as newly changed text: attribution
records the last edit, not a claim of original authorship.

## Agent access

Enable the relevant Workpad tools for a thread to let its agent list, read,
create, or update workpads. Agents can address other threads' workpads by scope
and thread ID, then use a workpad ID for individual reads and updates.

The thread's **Access boundary** controls which access requires approval.
**Ask outside this thread** requires approval for other threads, project
workpads, and global workpads. **Ask outside this environment** reaches a
project's workpads without asking from any environment that hosts one of the
project's locations, and asks otherwise, including for a project with no
active location; project scope alone does not isolate agents in the same
environment. **Allow without asking** removes boundary prompts. Enabled tools
and principal ownership still apply. See
[Provider features](provider-features.md).

Moving a workpad changes the scope used to authorize both its current content
and history. There are no separate per-workpad sharing grants. Agent edits
update an open viewer through Sedes's event stream, without periodic polling.
Draft changes sync through the same stream, and reconnecting catches missed
updates. These updates preserve your working text and do not wake agents or
send conversation messages.

For implementation contracts, see [Workpad internals](../internals/workpads.md).
