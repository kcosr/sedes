# Workpads

Workpads are shared Markdown documents for working notes. You and agents edit
the same saved document, with revision history and optional text attribution.
They belong to your Sedes account and survive restarts. Lines show as you type
them: a single line break starts a new line, and a blank line starts a new
paragraph.

## Open the Workpads panel

In a thread, choose **Workpads** from the **Panels** menu (▾) in the workbench
bar. Workpads opens on the Right by default, in place of whatever the Right
showed; move, maximize, resize, or close it like any panel (see
[Arrange panels](conversations.md#arrange-panels)). While Workpads is loaded,
the **Workpads** button (the notepad icon) shows or hides it; when it is
hidden, the button keeps an outline. The button's badge counts the current
thread's non-archived workpads, independently of the panel's filters or
selected scope. Zero is hidden, and counts above 99 display **99+**. Whether
Workpads is loaded, and where, stays the same when you switch threads. On
narrow screens, Workpads fills the screen; switch panels with the buttons or
the menu. Draft text stays mounted while the panel is hidden or another panel
replaces it. Navigation changes the view, never a document's stored scope.

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

**All** is one list of every workpad, in the view's sort, as in Tasks. In
All, and in Project with **Include thread workpads**, each row shows where its
workpad belongs on a quiet line under the title: **Global**, the project's
name, or the thread's title, followed in All by its project. In a project with
several locations, a thread also says where it runs, such as its host or
folder.

When navigation changes the viewed thread or project, Workpads returns to that
view's list. A selected document stays open when the view's scope stays the
same, including **Global** and **All**, and switching threads within the same
project in **Project** view. If the editor has unsynced changes or a workpad
change is still in progress, confirm before leaving or choose **Keep
editing** to see its result. Synchronized drafts remain available by reopening
the workpad and choosing **Edit workpad**.

## Find, add, archive, and delete workpads

Select **Search workpads** (the magnifier in the panel header) to search the
view's titles and text. In search and **New workpad** inputs, Escape clears the
focused field while keeping focus; Escape again when empty leaves the field.
The search stays open until you close it. **View options** (the filter icon)
controls the view:

| Option | Choices |
| --- | --- |
| **Sort** | **Newest**, **Recently updated** (the default), or **Title** |
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
project, Global, or **Choose…** for any other), **Archive**, and **Delete…**.
Archiving removes a workpad from the active list without losing its content or
history. The list ends with a collapsed **Archived** section, shown while the
view has archived workpads, with their count. Expand it to list them, in the
same sort, and choose **Unarchive** from a row's **⋯** or the open workpad to
resume editing. Archiving a thread preserves its workpads in their current
scope.

**Delete…** removes a workpad for good, active or archived, after you
confirm: its content, revision history, and any draft are gone, on every
client, and can't be restored. Archive a workpad instead to keep it out of
the way. Agents can archive workpads but never delete them.

In the list, the Up and Down arrows move between workpads and the
**Archived** heading, and Home and End go to the first and last. The Right
arrow moves from a row to its **⋯** button and the Left arrow back; on the
**Archived** heading they expand and collapse it. **Delete** asks to delete
the workpad and **F2** renames it. Archiving or moving the focused workpad
keeps focus in the list, on the next row.

## Open a workpad

Selecting a row opens the workpad in the panel. The header stays **Workpads**,
with search and View options, and the scope control stays above the
document. The workpad's own toolbar shows its title over its revision line
(which names the workpad's thread, project, or **Global**), then its actions:
**Show attribution**, **Revision history**, **Edit workpad**, and **⋯** with
**Rename…**, **Move to**, **Archive** or **Unarchive**, and **Delete…**.
Deleting the open workpad returns to the list.

To return to the list, choose the selected view again (its tooltip says
**Back to workpads**); with the keyboard, press Enter or Space on it.
Searching or changing a View option also returns to the list. These, and
Android Back, sync an open editor's text before the workpad closes; on
Android, Back closes the workpad, then returns to Chat, then opens the
navigation drawer.
Choosing another view leaves the workpad instead: if its text hasn't synced,
Sedes asks first, and **Leave anyway** discards those changes.

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

Workpads hold up to 262,144 UTF-16 units of text; emoji can count as two units.
Saved revisions also have a 2 MiB limit including attribution and added or
removed text. If an edit reaches that limit, save smaller changes or split the
notes into separate workpads. A rejected save preserves your working draft.

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
create, or update workpads, including archiving them. No tool deletes a
workpad. Agents can address other threads' workpads by scope and thread ID,
then use a workpad ID for individual reads and updates.

The thread's **Allow other environments** and **Allow other projects** rules
control which records its enabled Workpad tools can access. Lists and searches
filter to the permitted scope; exact outside-scope reads or edits fail without
an approval popup. Project Workpads remain shared project documents, and global
Workpads remain shared account documents. Project subtree searches include
only permitted thread Workpads. See [Tool policy sets](tool-policies.md).

Moving a workpad changes the scope used to authorize both its current content
and history. There are no separate per-workpad sharing grants. Agent edits
update an open viewer through Sedes's event stream, without periodic polling.
Draft changes sync through the same stream, and reconnecting catches missed
updates. These updates preserve your working text and do not wake agents or
send conversation messages.

For implementation contracts, see [Workpad internals](../internals/workpads.md).
