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

Choose **Global**, **Project**, or **Thread**, then search that scope.
**Thread** follows the current thread, and **Project** follows its project.
Their dropdowns let you browse another thread or project until you switch
threads again. When navigation changes the viewed scope, Workpads returns to
that scope's list. A selected document stays open when the scope stays the
same, including **Global** and switching threads within the same project in
**Project** view. If the editor has unsynced changes or a workpad change is
still in progress, confirm before leaving or choose **Keep editing** to see
its result. Synchronized drafts remain available by
reopening the workpad and choosing **Edit workpad**.

The project dropdown lists your projects, named as in the sidebar.
Enable **Include nested scopes** to include
its descendants, such as the workpads of a project's threads. Choose **New
workpad** to create a titled document in the selected scope.

A Project workpad belongs to the whole project, so every
[location](concepts.md#project-and-location) of the project shares it, on
every host. It stays with the project when you move or remove a location, and
is hidden while the project is removed. A Thread workpad follows its thread. A
workpad's header and list rows name its scope, such as **Project · sedes**.

Open a workpad to read it, rename it, or choose **Move workpad** and a destination
scope. **Archive workpad** removes it from the active list without losing its
content or history. Select **Archived** to find it and **Restore workpad** to
resume editing. Archiving a thread preserves its workpads in their current scope.

## Edit and save

Choose **Edit workpad** to open your working draft. Typing autosaves the draft
to Sedes and syncs it across your clients. Draft sync does not publish the text
or create document revisions. **Save workpad** commits your changes as one
revision; **Done editing** leaves the synced draft available for later.
**Discard draft** resets it to the saved document.

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
to highlight surviving text by its last editor. Hover, focus, or tap a passage
for the author, time, and revision. Agent edits show the contributing thread's
current name, with a stored name used if that thread is no longer available.
Your edits appear as **You**.

Use the revision selector or arrows to step through complete earlier documents.
Attribution follows the selected revision. **Revision details** shows additions
and removals with the revision's editor; removed text is not inserted into the
document view.

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
