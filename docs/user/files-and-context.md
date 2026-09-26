# Files and context

The Files panel lets you inspect the current project without leaving Sedes.
Composer attachments and context excerpts are separate ways to bring file or
transcript material into a conversation.

## Know the three file-related features

| Feature                 | Use it when                                                        | What the agent receives                         |
| ----------------------- | ------------------------------------------------------------------ | ----------------------------------------------- |
| **Files panel**         | You want to browse, read, edit, download, or compare project files | Nothing automatically                           |
| **Context excerpt**     | Exact displayed text or diff lines should accompany one prompt     | An immutable quoted snapshot with provenance    |
| **Composer attachment** | The agent needs a durable copy of a whole file or image            | Verified immutable bytes staged for that thread |

Files roots are separate from attachments and excerpts. **Primary** is the
stable project directory. A thread may prefer one of the linked worktrees
discovered from Primary's Git metadata, and a supplemental root adds an
explicitly selected directory. None changes the agent's working directory or
attaches content to a message.

## Open and navigate Files

Choose **Files** from the application header’s **Panels** menu. Files is
available only when the thread's exact execution environment supports file
operations. Local projects use the local engine. Supported SSH projects require
the operator's managed sidecar; Sedes does not substitute server-host files
when remote operations are unavailable.

The panel retains its tree, open tabs, scroll, and editor drafts while
collapsed. On a narrow screen it becomes a foreground sheet. Opening a file
link or Task shortcut makes Files visible automatically. That opening follows
the device's **Opening panels** preference; Shift-click temporarily uses the
opposite presentation without changing the preference.

The tree honors configured roots and Git ignore information when available.
Git is optional for ordinary browsing, but required for Changes.

When Primary belongs to a Git repository, the thread header offers a searchable
worktree selector. Sedes asks that exact local or SSH environment for Git's
registered worktrees; it does not scan sibling directories. Selecting one
stores the thread's preferred worktree on the server. The preference follows
the thread across clients, and Files Browse, Files Compare, and relative file
links in chat use that checkout. Selecting Primary clears the preference.
Files retains its root tabs for the effective project root and explicitly
attached supplemental directories; it has no separate worktree selector.

The selector uses concise provenance relative to Primary: **Merged** means the
worktree head is the same as or already contained by Primary, **Unmerged**
means it has commits not contained by Primary, and **Unknown** means Git could
not complete the comparison. Exact ahead/behind counts are supporting details,
not the main label. **Current** marks the thread's selection and **Missing**
marks a checkout that disappeared.

Discovery is lazy and cached: application startup does not run Git merely to
populate this control. Opening the selector or Files, refreshing, resolving a
relative link, or asking a thread agent to list worktrees can refresh the
registered topology. A mounted Files panel can also observe the repository's
narrow Git worktree metadata. The same contract applies through a capable
managed SSH sidecar; Sedes never treats a remote path as a local one.

An agent running in the thread can list the same admitted worktrees and
revision-check a set or clear operation through the `thread.worktree_*` tools.
The preference is UI and file-navigation context only: it does not move the
thread, change its project, or alter any provider, agent process, or terminal
working directory. Those continue to start from Primary unless explicitly
managed outside this preference.

The selector can remove an available linked checkout after confirmation. Sedes
refuses a checkout with tracked, untracked, or staged changes and never forces
removal. Git keeps the branch and commits, but ignored files and build output
inside the removed checkout may be deleted with its directory. A missing
checkout can instead be forgotten. Either operation clears any thread
preferences that pointed at it; a complete discovery of an externally removed
worktree also clears the stale preference and Files falls back to Primary.

## Read, preview, and download

Sedes can:

- read and edit existing UTF-8 text files;
- render Markdown previews;
- preview recognized raster images;
- show supported file metadata and Git status; and
- download an opened regular file as its exact saved bytes.

Text reads and saves are bounded to 16 MiB. Larger text is reported as
truncated rather than opened as a complete editable file. Recognized images
larger than the preview limit are identified but not previewed. Exact download
is separate from preview and supports saved files up to 1 GiB.

Creating, renaming, and deleting files are not currently implemented in the
Files panel.

## Edit safely

Open an editable text file, make changes, and save. Each editor starts from an
opaque file revision. If the saved file changed since it was opened, Sedes does
not silently overwrite it; choose among:

- **Reload** to discard your local draft and read the newer saved file;
- **Overwrite** to replace the saved version deliberately; or
- **Keep editing** to retain the local draft while you decide.

Refreshing the tree or panel never silently replaces a dirty editor. Closing a
surface prompts before discarding unsaved content.

As with most editors, a different program can still change a file in the small
window around the final operating-system write. Review important changes with
Git after saving.

## Attach supplemental directories

A project with Files support can attach up to eight additional directories.
Use this for related documentation, a neighboring repository, or another
allowed source tree that should be browsable beside the primary project.
You can also attach a repository beneath Primary. Select its root tab and
open **Compare** to diff that repository, even when Primary itself is not a
Git repository.

The directory must be allowed on the same execution environment. Attachments
cannot equal Primary or overlap another supplemental root. They may contain
or sit beneath Primary. Removing a supplemental root
removes only the Files association; it does not delete the directory or its
contents.

Supplemental roots do not change:

- the thread's working directory;
- the provider target;
- which project owns the thread; or
- what files the agent sees automatically.

## Compare Git changes

Choose **Changes** in Files for a root that belongs to a Git repository.
Click the source pair in the compact toolbar to open **Comparison settings**.
**Uncommitted**, **Staged**, and **Branches** set up common comparisons; choose
the base, comparison source, and strategy there.
Revision pickers search branch names, commit messages, and hashes. Local
branches, remote branches, tags, and recent commits have separate groups;
commits show their message, date, and short hash, newest first. Commit history
starts at the current branch; choose another branch or **All branches** in the
picker to change its scope. Search covers the bounded loaded catalog; a notice
identifies a limited catalog. Remote branches reflect locally available refs;
comparison does not fetch from the remote.

For branch review, choose the target branch as **Base** and your feature branch
as **Compare**. **Changes introduced by compare branch** compares their common ancestor
to the feature branch. **Differences between sources** compares their current
contents directly. **Swap sides** reverses the endpoints. Refresh follows named
branches and tags, while a selected commit stays pinned. It uses the displayed
comparison; apply edited source settings with **Compare**.

A persistent, resizable changed-file navigator accompanies the continuous diff
on wider panels. Filter filenames, expand directory groups, select a file, or
use previous/next controls in each file header. The file count sits beside the
filter. **View** contains unified/split and line-wrapping preferences. The Files
titlebar refresh button refreshes whichever mode is active. Scrolling updates the selected file and loads
nearby diffs automatically. Binary, oversized, and failed files retain a
navigation position; failed reads offer Retry. Narrow panels use a file drawer
and unified diffs, restoring your chosen split layout when widened.

**Open file** switches to Browse at the current file. Returning to Changes
keeps your reading position. Navigation preferences and semantic file/line
anchors are retained locally for the server, principal, workspace, root, and
repository. Reloading obtains fresh comparison handles. If the comparison
changed, Sedes returns to the file header with an explanation; missing
revisions require selecting endpoints again. Browser storage restrictions can
limit retention to memory.

Open **Review** to start a review and keep comments and reviewed flags. During
a review, its toolbar button shows reviewed-file progress. **Comments** opens
the current review inspector; **History** shows earlier reviews separately.
Historical comments never annotate the current comparison. A published comment
is local to Sedes and does not publish to Git hosting. Diff-line context
attachment continues to target the current conversation draft.

Changes is read-only against Git. It does not stage files, edit the worktree,
create commits, or rewrite refs. Unsaved Browse drafts are excluded and called
out explicitly. Supplemental roots and linked worktrees use their own Git
state. An unsaved comment whose comparison changed cannot be saved onto the
replacement comparison; copy the draft before selecting new lines.

## Capture an exact context excerpt

Context excerpts preserve exact displayed text for one prompt. You can capture
from:

- a completed ordinary chat message;
- a read-only source-file selection;
- visible text in a rendered Markdown preview; or
- settled lines in a Git Changes diff.

Select the text and choose **Add to message** or **Add note**. **Add note** lets
you attach your own explanation to the quote. The resulting card is part of the
durable draft and follows stash, queue, retry, Send, and Steer.

In the note editor, **Add note & send** attaches the quote and note and sends
it together with everything already in the composer, including text, other
excerpts, attachments, and Tasks. During an active turn, the action follows the
composer's selected delivery mode and is labeled **Add note & steer** or
**Add note & queue**. **Add note** alone keeps the combined draft for later.
Uploads, draft conflicts, and pending composer actions must finish before sending.

After delivery, the excerpt is immutable conversation content. Sedes does not
reread the file or source turn during replay. Paths, line numbers, item IDs,
revisions, and Markdown hints help explain where the quote came from; they do
not grant permission to open the source later.

You cannot capture streaming text, a selection across messages, hidden text,
tool controls, or an actively edited file. Save or switch to read-only preview
first when necessary.

## Follow file links

Rendered chat and Markdown previews recognize supported file links and absolute
path references. If the path resolves uniquely within the project's available
primary, supplemental, or linked-worktree roots, Sedes opens it in Files and,
when possible, selects the requested one-based line. A relative chat link uses
the thread's preferred linked worktree when set; otherwise it uses Primary. A
relative link inside a rendered Markdown file stays anchored to that source
file's root and directory.

The link still passes normal root, environment, file-type, and sensitive-file
checks. Merely rendering a link does not authorize a path, attach a directory,
or grant the agent access. Ambiguous, truncated, missing, or disallowed targets
fail instead of guessing.

Task file shortcuts remain workspace-scoped and relative paths use Primary.
They retain the same safety checks.

## Attach whole files or images to the composer

Choose files, paste into the focused composer, or drop files onto it. Upload
finishes before the immutable object is linked into the saved draft. An
in-flight or pending card can be removed with its X before delivery.

Per input, attachment limits are:

- at most 8 attachments;
- at most 25 MiB for one general file;
- at most 16 MiB for one recognized image;
- at most 64 MiB across all attachments; and
- a display name of at most 255 UTF-8 bytes.

Recognized images are checked by bytes and dimensions, not trusted solely by
extension. The maximum image dimension is 16,384 pixels per side. A failed
integrity, staging, or capability check blocks the complete delivery rather
than sending a partial attachment set.

Attachments follow drafts, stashes, queues, retries, first-send recovery, and
Steer. After sending, they render as immutable history cards. Sedes stages the
bytes into the exact thread execution environment; the browser does not choose
the agent-visible path.

Provider support differs. Every backend can receive a supported staged-file
manifest in its implemented topology, while native image input depends on the
provider and selected model. See [Provider features](provider-features.md).

Attachments, context excerpts, and structured Task references cannot be sent
as terminal keystrokes in Codex TUI. Switch back to Chat or remove them before
terminal submission.

## View images and diagrams

Completed fenced `mermaid` blocks render as diagrams in chat and Markdown
previews. Invalid or unsafe definitions fall back to literal source. Select an
inline image or diagram, or use **Expand**, to open the viewer. It supports
fit-to-window, 25–400% zoom, pinch, Control/Command-scroll, keyboard controls,
drag, scroll, and touch pan.

Supported provider-generated images appear as their own transcript items and
are loaded on demand. When Codex views a local image that Files can read, a
**Viewed file snapshot** follows its notice; it shows the file as Sedes read
it, even if the file later changes or disappears. In the packaged Android
client, long-press an inline or expanded image to **Save image** or **Copy
image**. Desktop browsers retain
their normal image context menu.

## Treat file content as sensitive

The same trusted-client boundary that protects prompts and transcripts must
protect file browsing and attachments. A user who can access Sedes can inspect
allowed roots and send those bytes to the configured provider. Do not expose a
file-capable Sedes server to untrusted clients.

For implementation limits and operator topology, see
[Workspace Files](../internals/workspace-files.md) and
[Composer attachments](../internals/composer-attachments.md).

Previous: [Organize and reuse work](organize-work.md) · Next:
[Tasks and automations](tasks-and-automations.md)
