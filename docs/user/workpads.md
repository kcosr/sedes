# Workpads

Workpads are shared Markdown documents for working notes. You and agents edit
the same saved document, with revision history and optional text attribution.
They belong to your Sedes account and survive restarts.

## Open the Workpads panel

In a thread, select the **Workpads** button (the notepad icon, beside
**Tasks**) to open or close Workpads. It shares the workspace layout with
**Chat** and **Files**. Its badge counts the current thread's non-archived
workpads, independently of the panel's filters or selected scope. Zero is
hidden, and counts above 99 display **99+**. Resize the split, use **Workpads panel
actions** to dock it on another edge, or collapse it; when it is collapsed, the button keeps
an outline, and selecting it shows Workpads again. Its open state and place
stay with you when you switch threads. On narrow screens,
switch between full-stage panels using the buttons, the panel shortcuts, or the
menu. Draft text stays mounted while the panel is collapsed or another panel
is shown. Navigation changes the view, never a document's stored scope.

Sidebar thread rows show the same notepad icon when the thread has active
workpads. The sidebar icon has no visible count, like the Tasks icon.

## Choose a view

The scope control at the top of Workpads has the same four views as Tasks,
each with its count of active workpads:

- **Thread**: workpads of the current thread.
- **Project**: workpads of the current thread's project, shared by all of its
  locations and hosts. Turn on **Include thread workpads** in **View options**
  to add the workpads of threads in the project's locations; the count then
  includes them.
- **Global**: workpads not tied to a project or thread.
- **All**: every workpad.

The views always follow the current chat. A view that does not apply, such as
Thread in an archived thread, is unavailable; point at it, or tap it on a
phone, to see why. Workpads opens on the view you last chose; when that view
is unavailable, it falls back to Project, then Global. To find another
thread's or project's workpads, use **All** and search.

**All** is grouped by project, as in Tasks: Global first, then the current
project, then the other projects by name, with each thread's workpads in a
group under its project. Select a group heading to collapse or expand it, or
use **Collapse all groups** in **Workpads panel actions** (**⋯**). **Load
more** continues the last group. Turn off **Group by project** in **View
options** for one list. In lists without group headings, such as that list or
Project with **Include thread workpads**, each row shows where its workpad
belongs on a quiet line under the title: the thread (in All, with its
project), the project, or **Global**. In a project with several locations, a
thread also says where it runs, such as its host or folder.

When navigation changes the viewed thread or project, Workpads returns to that
view's list. A selected document stays open when the view's scope stays the
same, including **Global** and **All**, and switching threads within the same
project in **Project** view. If the editor has unsynced changes or a workpad
change is still in progress, confirm before leaving or choose **Keep
editing** to see its result. Synchronized drafts remain available by reopening
the workpad and choosing **Edit workpad**.

## Find, add, and archive workpads

Select **Search workpads** (the magnifier in the panel header) to search the
view's titles and text; Escape clears and closes the search. **View options**
(the filter icon) controls the view:

| Option | Choices |
| --- | --- |
| **Sort** | **Newest**, **Recently updated** (the default), or **Title** |
| **Group by project** | All only; on by default |
| **Include thread workpads** | Project only; off by default |

Each view remembers its own options on this device. While **Include thread
workpads** is on, a **Thread workpads** chip sits under the scope control and
the filter icon shows a dot; select the chip's **×** to turn it off.

Type a title in the **New workpad** row under the scope and press Enter to
create a workpad there; it opens ready for editing. Its placeholder names
where the workpad goes. In All, new workpads are Global.

A Project workpad belongs to the whole project, so every
[location](concepts.md#project-and-location) of the project shares it, on
every host. It stays with the project when you move or remove a location, and
is hidden while the project is removed. A Thread workpad follows its thread.

Each row's **⋯** menu offers **Rename…**, **Move to** (this thread, this
project, Global, or **Choose…** for any other), and **Archive**. Archiving
removes a workpad from the active list without losing its content or history.
The list ends with a collapsed **Archived** section, shown while the view has
archived workpads, with their count. Expand it to list them, in the same sort,
and choose **Unarchive** from a row's **⋯** or the open workpad to resume
editing. Archiving a thread preserves its workpads in their current scope.

## Open a workpad

Selecting a row opens the workpad in the panel. The header stays **Workpads**,
with search and View options, and the scope control stays above the
document. The workpad's own toolbar shows its title over its revision line
(which names the workpad's thread, project, or **Global**), then its actions:
**Show attribution**, **Revision history**, **Edit workpad**, and **⋯** with
**Rename…**, **Move to**, and **Archive** or **Unarchive**.

To return to the list, choose the selected view again (its tooltip says
**Back to workpads**); with the keyboard, press Enter or Space on it. Choosing
another view, searching, or changing a View option also returns to the list,
and an open editor's text syncs first. On Android, Back closes the workpad
before it opens the navigation drawer.

## Edit and save

In the latest saved document, click a checklist box or focus it and press
Space to check or uncheck an item without opening the editor. Each change
saves immediately as a revision. The surrounding text and any unfinished
working draft are preserved. If the document changed elsewhere, Sedes reloads
the latest version so you can check it before trying again. Checkboxes in
archived workpads and historical revisions are read-only.

Choose **Edit workpad** (the pencil in the workpad's toolbar) to open your
working draft. Typing autosaves the draft to Sedes and syncs it across your
clients; the toolbar shows whether it has synced. Draft sync does not publish
the text or create document revisions. **Save workpad** (or Ctrl+S, ⌘S on a
Mac) commits your changes as one revision; **Done editing** (the check) leaves
the synced draft available for later. **Discard draft…** in the workpad's
**⋯** resets it to the saved document after you confirm.

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
