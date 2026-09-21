# Workspace Files subsystem contract

Sedes provides a workspace-scoped **Files** panel for local execution
environments and SSH or outbound environments whose operator policy enables the managed
Files sidecar. The panel is retained while hidden and while moving between
threads in the same workspace. On narrow screens it opens as a full-screen
sheet. Moving to another workspace, Home, Archived, or an unknown thread asks
before discarding an unsaved draft. Reloading, closing the tab, or leaving the
site uses the browser's native unsaved-changes confirmation while a draft is
dirty.

For user workflows, see
[Files and context](../user/files-and-context.md). Operator policy and managed-SSH setup live
in [Configuration](../operator/configuration.md). Related internal contracts
are [composer attachments](composer-attachments.md),
[remote Pi workspace tools](pi-remote-workspace-tools.md), and the
[backend integration contract](backend-integration-contract-rules.md).

## Contents

- [Client state and roots](#client-state-and-loading-model)
- [Managed-SSH provider](#optional-ssh-operations-sidecar)
- [Read, edit, and Compare](#reading-and-editing)
- [Context and path resolution](#context-excerpt-snapshot-contract)
- [Security boundary](#security-boundary)
- [Backend dispositions](#compiled-backend-and-environment-dispositions)
- [Verification](#verification-surfaces)
- [Known limitations](#known-limitations)

## Client state and loading model

Browse loads only the selected directory's immediate children. Expanding a
folder requests that folder on demand, so a broad root such as a home
directory does not require an up-front recursive walk. The partial tree keeps
its normal hierarchy and expansion behavior; an uncached expansion may briefly
wait for its one directory request. Tree search is available after the user
chooses **Load full tree to search**. That explicit, cancellable operation runs
one bounded filesystem traversal and pages a retained snapshot, so later pages
do not rescan the root. The full Browse scan is filesystem-only and does not
run Git. The bounded root-topology request described below may run Git
worktree discovery when Files opens or refreshes; file status and comparison
work still begin only in **Compare**.

Direct reads from authorized conversation or task links do not implicitly load
the tree. Tree loading begins only when the browser requests it. Saving uses
the revision captured at read time, and a conflict preserves the client draft
until an explicit resolution action.

## Root ownership and directory discovery

The stable project directory associated with the workspace is its **Primary**
root. It is often on `main`, but its branch is not part of the contract. A
thread may persist one preferred linked worktree as its effective project root
for Files Browse, Files Compare, and conversation-relative file links. This is
first-class thread application state, not Files-panel state and not provider or
terminal state. A file-capable workspace can also attach up to eight
supplemental directories, such as agent context kept beside the project
checkout in the same execution environment. Files root tabs supply the
effective project root and those supplemental directories; linked-worktree
selection lives only in the thread-header control. A supplemental root remains
file-panel state only: it does not change the workspace directory, agent
working directory, thread scope, or native-session discovery.

When Primary is Git-backed, Sedes also asks that exact local or SSH Files
provider for `git worktree list --porcelain -z`. It does not scan the parent
directory, so an intermixed sibling layout can contain unrelated projects
without cross-project discovery. The provider maps a project opened on a
repository subdirectory to the same subdirectory in each linked checkout,
validates the live checkout and Git administration directory, excludes bare
and prunable entries, and returns at most 32 candidates. The server repeats
execution-environment admission and persists an opaque root ID tied to the
live Git worktree identity; paths never become browser selector authority.
Linked worktrees may be siblings of or directories beneath Primary and may
overlap an explicitly attached broader supplemental root.

Discovery is lazy and its admitted topology is cached. Application startup does
no Git work. Opening the thread worktree selector, opening or returning to a
visible Files panel in a foreground document, manual refresh, relative-link
resolution, or the source-thread agent helper can refresh topology. Neither
Browse nor Compare subscribes to filesystem events. Collapsed, inactive, and
background panels retain editor state and defer Browse loading. Returning
refreshes root topology; loaded directories and clean editor contents are
refreshed explicitly. The Files events API remains available for explicit
consumers; its filesystem and Git-metadata invalidations can also refresh
topology when a consumer holds a subscription.
SSH uses the same behavior through `workspace_files@8` and never interprets
remote paths on the Sedes host.

Each principal/thread stores a nullable preferred linked-worktree root ID and
an independent compare-and-swap revision. Null means Primary. Selecting
Primary clears the preference; selecting a linked worktree sets it. The
thread-header selector searches branch labels and paths and projects semantic
provenance relative to Primary: same or contained is **Merged**, a positive
linked-head side is **Unmerged**, and a failed comparison is **Unknown**;
**Current** and **Missing** describe selection and availability. Ahead/behind
counts remain secondary detail. This preference changes the Files/Compare
selection and chat-relative file-link base only. It never changes the stable
project directory, thread execution directory, backend session, agent process
CWD, or terminal CWD. Rendered Markdown-file links remain anchored to their
source file's root and directory. A successful complete discovery that finds a
preferred worktree gone tombstones that root ID, atomically clears all affected
preferences, and falls the UI back to Primary. Failed or truncated discovery
retains prior roots and preferences, and a later worktree reusing a path
receives a new opaque ID.

For each live linked checkout, discovery compares its head to Primary's head
with a bounded `git rev-list --left-right --count`. Equality is `same`; zero
commits on the linked-head side is `contained`; a positive linked-head side is
`unmerged`; and an unavailable comparison is `unknown`. This is commit-graph
provenance, not a claim that an equivalent patch was or was not applied by a
different commit.

The thread selector can request confirmed deletion of an admitted linked
worktree. The provider revalidates the checkout identity, rejects tracked,
staged, or untracked changes, disables hooks, and invokes `git worktree remove`
without force. Git branch and commit objects remain, while ignored contents
and build output inside the checkout may be removed with its directory. A
previously missing checkout is only forgotten from application topology. Both
outcomes tombstone the opaque root and clear every affected thread preference;
remote uncertain outcomes are reconciled by a complete discovery before Sedes
reports success or permits retry.

Attaching a directory is an explicit, workspace-scoped principal action. The
server admits the selected absolute path only when the exact execution
environment's allowed-root policy and live file provider both permit it. The
primary directory and a supplemental directory may not be equal. A supplemental
directory may contain or sit beneath Primary. This supports broader context
trees and nested repositories with independent Compare views beneath a
non-repository project directory. Supplemental directories may not
overlap each other. A supplemental directory also cannot equal another
workspace's canonical directory. Labels are case-insensitively unique within
the workspace.
Files in the overlapping directory remain visible through both trees. Their
root-qualified paths stay distinct, while writes to the
same canonical destination share one serializer and revision check so
concurrent edits still produce only one successful compare-and-swap.
Removing an attachment removes only the association; it does not delete the
directory or its files. Sedes asks for confirmation first when that root has
an unsaved document open.

Both directory-entry surfaces use the same graphical picker. **Add Project**
selects an execution environment first; **Add folder to Files** displays the
current workspace's environment as fixed, read-only context. The picker keeps
manual absolute-path entry available and offers graphical navigation only when
the normalized environment summary reports
`directoryBrowsing: "available"`. The project form may change environments;
the supplemental-root form never accepts a browser-selected environment as
authority.

Graphical navigation calls
`POST /api/execution-environments/:environmentId/directories/browse`. A roots
request returns the environment's operator-configured browse roots. A directory
request returns only its immediate child directories, deterministically sorted
and paged with a bounded opaque cursor. The response omits `parentPath` at a
policy-root boundary, so graphical parent navigation cannot escape that root.
Graphical browsing omits dot-directories and symlinks. Use manual exact
absolute-path entry when the path is authorized but intentionally absent from
the picker; **Load more** continues a page, and the picker reports safety-limit
truncation rather than implying the listing is exhaustive.
Files, directory contents, arbitrary filesystem metadata, provider topology,
SSH aliases, and credentials are not returned. Cancelled or superseded requests
persist nothing.

Browse results are hints, not admission receipts. Selecting a row only fills
the absolute-path field. **Add project** repeats execution-environment
workspace validation, and **Add folder** repeats workspace ownership,
environment, allowed-root, live-provider, sensitive-path, and root-topology
validation. A directory renamed, removed, or made unavailable after browsing
therefore fails the final mutation instead of retaining stale authority.

The panel supports browsing and viewing existing regular files, editing
authorized UTF-8 text, read-only previews for bounded raster images, and a
read-only **Compare** mode for Git-backed roots. Compare lives inside the same
Files panel chrome, uses the active Files root, and never stages, saves, or
rewrites Git state. Creating, renaming, and deleting files are still outside
this surface. Environments without a reviewed file provider reject supplemental
attachments and report file access as unsupported; Sedes never substitutes a
similarly named path on its own host.

## Optional SSH operations sidecar

An SSH environment's principal-owned database definition selects `operations:
{ "kind": "none" }` or a nonempty unique set of separately granted sidecar
capabilities. Files uses `workspace_files`; directory browsing, workspace tools
and context, skills, attachment staging, agent-tool relay, and terminals have
their own grants. Workspace tools and context are selected together. The
persistent service and its runtime channel never imply all those operations.

The sidecar is an owner-only persistent execution service bootstrapped and
reconnected through OpenSSH. Carrier loss or main restart drops attachments,
not remote process ownership. Main's environment registry reconnects to the
exact service identity before admitting operations; intentional Disconnect/Stop
survives restart and suppresses background reconnection.

Filesystem operations reuse the same server-only engine as local Files.
Workspace roots, descriptor identity, revision checks, bounded binary streams,
mutation receipts, cancellation, and scoped provenance remain enforced on the
execution host. Main never substitutes its filesystem for a remote path.
A download interrupted by channel loss fails explicitly; it is not silently
resumed from a different generation. Watches are reestablished by authoritative
refresh, without claiming an offline event backlog.

The service owns bounded command results and unsettled mutation outcomes while
main is absent. Reattachment reconciles an existing operation identity; it does
not repeat an uncertain write. Sidecar restart/upgrade waits for admitted work
to drain or for explicit interruption and preserves unsettled results. Unknown
state or unproven cleanup blocks safe replacement. A mutable operations grant
never changes an environment's immutable host identity or retargets a workspace.

`agent_tools_cli` exposes only an owner-only bounded relay to current Sedes
application authority. While main is disconnected it returns unavailable or a
known/unknown receipted outcome; it does not create an offline task/message
queue. Provider-native history remains outside this transport layer. Pi SDK's
model loop remains on main; only its granted workspace operations run remotely.

Remote artifact and state directories are service-owned. Preserve their modes,
identity records, receipts, and terminal output through backup and upgrades.
Never remove a digest directory or stale-looking socket while a service may
still own it. See [Persistent remote services](../operator/operations.md#persistent-remote-services)
for the lifecycle and recovery boundary.

All filesystem, Git, link, content-classification, write, and watch behavior is
implemented by the same server-only Files engine used by the local provider.
Only its process location changes. Main Sedes continues to own workspaces,
root records, drafts, annotations, conversation links, task links, and browser
state, so clicking links and capturing file context use the same normalized
application paths for local and sidecar-backed files.

## Reading and editing

The tree is deterministic, paged, Git-ignore-aware, and capped at 50,000
scanned files. Text reads are bounded to 16 MiB and report truncation rather
than implying the full file was returned. PNG, JPEG, GIF, and WebP previews use
a full-file 16 MiB limit. A previewable image contains the complete
verified descriptor bytes; a recognized larger image reports that it is too
large without returning a partial payload or creating an image element.
Binary, image, malformed UTF-8, sensitive, and truncated files cannot be
edited. A save accepts at most 16 MiB of UTF-8 text and preserves the existing
file mode.

An opened regular file can be downloaded as its exact saved bytes up to 1 GiB,
independently of the preview and editing limits. Download requires the revision
displayed by the open tab; a stale revision fails instead of silently returning
different content. Unsaved editor changes are not substituted for the saved
file. Local and managed-SSH providers keep the authorized root operation and
opened descriptor alive for the transfer, stream with bounded memory and
backpressure, propagate cancellation, and withhold the final bounded chunk
until the descriptor is proved unchanged. The HTTP response is non-cacheable,
uses a sanitized basename, and does not support byte ranges. A transfer has a
six-hour total deadline; the managed-SSH leg additionally fails after two
minutes without a data or terminal record, and Android applies a 30-second
network-read inactivity timeout.
Removing a supplemental root first cancels downloads using that root, waits
for their descriptor and transport cleanup, and only then removes the root;
new operations cannot enter while that drain is in progress.

Available images start contain-fitted at 100% and can be zoomed through 400%.
The viewer offers explicit zoom and reset controls, bounded native scrolling,
mouse dragging, touch/trackpad scrolling, and arrow-key panning. It preserves
the zoom and focal position independently for each open image tab, while
closing the tab, changing workspaces, or reading a new file revision resets the
view. Browser-level pinch zoom remains available.

Raster classification is default closed. Sedes recognizes the complete PNG,
JPEG, GIF87a/GIF89a, or WebP magic signature only when it agrees with a
case-insensitive `.png`, `.jpg`/`.jpeg`, `.gif`, or `.webp` extension. A
supported signature with a missing, unknown, or mismatched extension and a
supported extension with spoofed or truncated bytes are generic binary. SVG is
also generic binary and is neither decoded nor rendered. The shared classifier
runs both when content is read and when an existing target is revalidated for
editing, so ASCII-looking image bytes cannot enter the UTF-8 save path.

Every read returns an opaque revision token. Saving compares that token with
fresh filesystem identity and timestamp evidence immediately before an atomic
replacement. If the file changed, Sedes preserves the draft and offers:

- **Reload**, which replaces the draft with the latest editable text.
- **Overwrite**, which first reads and validates the latest file, then retries
  once using that new revision and the retained draft.
- **Keep editing**, which dismisses the decision without changing either copy.

Sedes never retries a conflict automatically. A second concurrent change can
therefore produce another conflict. Browse and Compare do not start recursive
filesystem or Git-metadata watching. Use the toolbar Refresh action to refresh
root topology and the selected root's loaded
directories (or its explicitly loaded full-tree snapshot) and to reload a clean
active file. Refresh never silently replaces an unsaved draft. Compare performs
its own explicit Git reads when opened; rerun the comparison with Compare or
the Files titlebar Refresh action to pick up changes to its diffs. That shared
action follows the active mode; Browse refresh does not recompute a comparison. Directory, full-scan, page, content,
and Git budgets apply independently to each root. A
missing, moved, or disallowed supplemental root is shown as unavailable without
preventing access to the other roots. Sedes retains the attachment so it can
become available again after the filesystem or environment policy is repaired.

## Compare mode

The user-facing **Changes** mode is retained beside Browse inside Files.
Both modes share the effective root; open Browse documents and unsaved edits
remain mounted during mode changes. Open file from a diff explicitly selects
its current new path in Browse; deleted content does not open another file.

A single compact toolbar opens comparison settings, display preferences, and
review actions in popovers without displacing the diff. Active review progress
appears on the Review button. Counts sit beside the navigator filter, and
previous/next file actions sit in diff file headers. The comparison registers
a scope-bound refresh callback with the Files titlebar while mounted. Refresh
and saved reading positions use the applied semantic endpoints; unapplied
picker edits are applied only through Compare. Popovers close when the view
is hidden.

The changed-file navigator is grouped, virtualized, resizable, and independent
of patch availability. Actual panel width determines whether it is a persistent
sidebar or a drawer and whether split diffs fit. Preferred split/unified and
wrap/scroll settings remain separate from their effective narrow presentation.
The existing Pierre CodeView renders a continuous document. Unloaded and
terminal states use collapsed non-selectable file items with explicit status
headers, never fabricated patches. Nearby files load through a bounded queue;
large comparisons retain a bounded patch cache and preserve semantic anchors
while distant patches are evicted. Hidden panels stop prefetching. Metadata
pagination remains separate from patch loading.

Repository discovery returns a stable `repositoryKey`. Revision catalogs contain
local/remote branches, tags, and recent commits with messages and commit dates. The current branch
is marked explicitly. Commit history defaults to HEAD and can select another
catalog revision or all branches. Search is over the bounded catalog, whose
truncation is visible. The catalog's optional exact full ref/full commit
resolver supports saved navigation beyond the recent commit window; it accepts
neither arbitrary Git expressions nor refs outside heads/remotes/tags. Named
refs resolve again for refresh; selected commit hashes stay pinned. Direct
comparison shows differences between endpoint contents; merge-base comparison
shows changes from the common ancestor to the Compare endpoint. Mutable
index/working-tree endpoints only support direct comparison.

Navigation is client-local principal-owned state. Authentication status and
management pairing expose an opaque namespace derived from the installation's
persisted key and server-resolved tenant/principal, never from a credential.
It is combined with the server origin. Bounded versioned records scope mode,
endpoint intent, repository identity, file/line/side anchors, up to 32 per-file
return locations, filter, directory expansion, navigator width, display
preferences, and selected review by workspace/root. Writes debounce and flush
on mode transitions, panel hiding, and page hiding. Runtime handles, patches,
and full file contents are not persisted. Invalid/obsolete records are
rejected; storage denial retains bounded memory state. Restoration obtains
fresh handles, resolves semantic endpoints, prioritizes the target file, and
uses exact line anchors only for an unchanged fingerprint. Changed comparisons
return to the file header with a notice. Missing revisions require explicit
reselection.

Changes is read-only against Git and the filesystem. It never stages files,
writes the worktree, creates commits, or rewrites refs. Unsaved Browse drafts
are excluded and called out while Changes is visible. The shell owns root and
Browse state; the comparison surface owns endpoint intent, patch scheduling,
and navigation. Review state remains separate and never supplies historical
inline collections when no current review exists. Historical edits operate on
their original review without creating a current review. Comment creation
checks its captured comparison before and after asynchronous review creation.

The normalized browser contract is version 116; sidecar Files uses the strict
`workspace_files@8` contract, including scoped catalogs and stable repository
keys. Local and SSH/outbound engines use the same revision resolver and bounds.
Pi, Codex, Claude, and Grok consume the shared environment-owned Files surface:
no provider event, SDK, or history contract changes. Unsupported execution
environments retain capability denial and never fall back to server-local Git.

Diff review state is principal-owned Sedes application state scoped to the
current workspace, effective Files root, and canonical repository identity.
Start or reopen a review, add draft or published comments, resolve them, mark
files reviewed, and archive/reopen reviews from Current and History.
“Published” is a Sedes-local review state; it does not publish to Git hosting
or change a remote review. Historical reviews do not recreate stale patches
inline.
Index/worktree comparisons can become stale and require Refresh. Runtime
comparison handles expire after 20 minutes idle and are recreated from their
opaque selections as needed.

## Context-excerpt snapshot contract

In read-only source view, a user can select one or more whole displayed lines
and add their exact text to the active thread draft, with an optional bounded
note. Rendered Markdown preview supports visible-text selection instead. The
Markdown excerpt records the exact visible quote plus bounded semantic hints,
such as nearby quote context, heading ancestry, and source lines when the
renderer can supply them; browser DOM indexes and node identities are not
durable locators. Selection remains available for ordinary copy and does not
attach anything until the user chooses **Add to message** or **Add note**.
The note editor then offers separate **Add note** and idle-only **Add note &
send** actions. Immediate delivery atomically combines the captured excerpt
with the current composer candidate; if submission is unavailable, the
selection and note remain open with the truthful reason.
Completed fenced `mermaid` blocks render inline with the resolved app theme.
The diagram remains associated with the fence's source-line range; an invalid
definition displays its literal source instead of removing the block. Use
**Expand diagram** for the shared zoomable preview without leaving Files.

Each capture snapshots the content already displayed in the panel. A source
excerpt records its opaque read revision, root ID, normalized relative path,
and inclusive displayed line range; it does not reread the file after the
selection. Identical relative paths in different roots therefore remain
distinct. Markdown quote hints and line numbers are restoration aids only. If
later content is stale or a quote is duplicated or ambiguous, Sedes retains
the draft or sent card but does not paint a potentially incorrect highlight.

Context capture is unavailable while the file is actively being
edited, because unsaved editor text cannot truthfully carry the last server
revision. It is also unavailable when the authorized viewer has no selectable
text, when no writable composer is registered, or when the panel workspace
differs from the active thread workspace. The source selection is transient
and clears after attachment; the card in the draft is the durable record.

The excerpt and optional note are stored with the server-side thread draft and
thread-scoped prompt stash. After delivery they are immutable normalized user
message content, so transcript replay can render the same card without reading
the current file. Reopening a normalized file read or file change is a separate
operation that reauthorizes the current principal, thread, workspace,
execution environment, opaque root, and path before seeking the transient
source-line target. A stale, missing, unauthorized, or ambiguous source leaves
the historical card intact.

## Link and absolute-path resolution

Rendered conversation Markdown and Markdown file previews recognize explicit
local `file:` URLs, absolute POSIX path links, and normalized workspace-relative
path links as requests to open a file in the current workspace's Files panel.
An optional one-based `:line` suffix used by coding-tool Markdown is removed
before resolution so it cannot affect file authority. After the server returns
an authorized opaque root and relative path, the suffix becomes a transient
source-line target for that open intent; it is not stored in the tab or Files
UI cache and does not change the resolver's containment rules.
Sedes first resolves absolute references on the server against the current
workspace's available primary, supplemental, and linked-worktree roots. When
Primary and a supplemental root both contain a file, the unique most-specific
root wins: Primary wins over a broader supplemental root, and a nested
supplemental root wins over Primary. Unrelated roots that both claim a match
remain ambiguous and fail closed. For a local execution
environment, an otherwise unmatched regular file may resolve when its
canonical parent is admitted by the environment's configured allowed-root
policy. Sedes prefers its nearest Git worktree root and otherwise persists
the canonical parent as a bounded, principal- and workspace-scoped
**link-only root**. Its opaque ID lets the open
tab survive a refresh or restart, but the root does not appear in the Files
tree and is not a supplemental attachment. Every later read, list, or save
revalidates the canonical hidden root through current execution-environment
authority. Workspace-relative references from a conversation use that
thread's preferred available linked worktree, or Primary when the preference
is null. Workspace-scoped Task references remain anchored to Primary. A
relative reference from a rendered Markdown file is normalized against the
source file's containing directory and carries its opaque root ID; the server
accepts it only when that root belongs to the current principal and workspace.
Dot segments may move within that root, but a traversal above it fails closed
and is not reinterpreted as browser navigation. A successful match opens the
Files panel and uses the same read, sensitive-path, size, and edit rules as a
tree selection.

Rendered file-read and file-change cards expose the same action. Reads target
the first displayed source line. Applied patches target the first new-file hunk
line, applied moves use the destination path, unapplied proposals target the
old-file hunk line, and whole-file writes target line 1. An applied deletion
offers no shortcut because it has no current file to authorize or display.

For ordinary text and source files, the read-only Pierre viewer seeks the
one-based line directly. Markdown stays in its rendered preview: Sedes maps
the requested source line to the rendered block's AST source-position metadata,
then uses the nearest following or preceding rendered block when the line is
blank or otherwise has no rendered node. This is more truthful than matching
raw Markdown syntax against rendered `textContent`. A truncated preview or a
line no longer present reports that it could not reach the requested location
instead of guessing beyond the displayed bytes. Repeated actions carry unique
intent sequences, so an already active file seeks again.

An absolute path outside the configured execution roots, naming a directory,
naming a sensitive file, or belonging to another
principal fails closed. An unresolved explicit `file:` URL fails closed.
Because absolute and relative path syntax is also valid web-link syntax,
unresolved normalized relative candidates retain the existing safe
external-link behavior. A denied
absolute candidate never becomes a localhost URL. The text may have come from
an agent, so rendering alone never grants access and clicking never creates a
visible supplemental attachment. An SSH environment with sidecar operations
disabled remains unsupported for this discovery path and starts no probe,
command, file transfer, or auxiliary connection. A sidecar-enabled environment
performs the same high-level contained discovery in the remote Files engine.

## Task-path resolution

Tasks can retain a bounded list of absolute file paths. These paths are durable
principal-owned task metadata, not file-access authority, and moving a task does
not rewrite them. Adding or updating a task path does not read the filesystem or
claim that the file exists.

When a task is shown in a thread with an available workspace, every stored path
is offered to the same absolute-path resolver used by rendered links. An
allowed primary, supplemental, or link-only file opens in the
existing Files panel; a rejected path remains visible task metadata and reports
that it is unavailable. The server still derives the tenant, principal,
workspace, and execution environment and reapplies every containment and
sensitive-file check. Markdown opens in the usual preview, editable text can
enter the usual editor, and saves retain the same revision/conflict behavior.

## Security boundary

Workspace authority comes from the server-derived tenant and principal. After
an explicit attach, normal file operations identify a workspace, an opaque
root ID, and a normalized relative path; the browser never resends an attached
root's absolute path as authority. The primary root has the stable ID
`primary`, while supplemental root IDs are opaque and meaningful only within
their owning workspace scope. Tab, dirty-document, cache, save-serialization,
and conflict identity all include the root ID, so identical relative paths in
two roots remain independent.

Directory browsing has narrower, ephemeral authority of its own. The server
derives the tenant and principal, resolves the exact execution environment, and
selects one current configured policy root for every page. Local requests
canonicalize and open the directory without following a symlink, revalidate the
opened descriptor within that root, and omit symlinked child directories.
Sidecar requests apply the same high-level checks in the selected remote
environment and are fenced by its configuration revision and live sidecar
generation. Missing, unreadable, non-directory, symlinked, and out-of-root
paths share one non-enumerating failure. Opaque cursors remain bound to the
principal, environment, configuration revision, provider generation, policy
root, and directory. An SSH environment without `directory_browser` reports
browsing unavailable and starts no SSH probe, sidecar, backend, or command; it
never substitutes the Sedes host filesystem.

The local provider revalidates the selected root's canonical path on every
operation, rejects absolute and dot-dot relative paths, does not follow a
target symlink, verifies parent and final-file containment, and repeats the
checks around a save. Listing does not traverse symlinked directories. A root
ID from another workspace, tenant, or principal fails closed; it is never
looked up globally or treated as a path fallback.
Image classification does not add a byte route or alternate authority. Reads
retain the existing sensitive-path and containment checks, open the exact
regular file without following the target symlink, re-resolve the held
descriptor beneath the selected root, and revalidate its identity and metadata
after reading. Only a complete stable descriptor read at or below the cap is
base64 encoded with its allowlisted media type. The browser constructs a
`data:` image URL only after the strict normalized branch validates its
canonical base64 payload and exact decoded byte count.
An absolute path stored on a task does not weaken this route contract. The
client sends it to the common server resolver, which may return primary,
supplemental, or link-only authority only after the normal Files checks pass.

The initial sensitive-file policy is default closed. The following paths are
omitted from listings and denied for reads and writes:

- directories named `.ssh`, `.gnupg`, `.aws`, `.env`, or `.git` — repository
  metadata holds credentialed remotes and hooks that run on the next git
  command, so it is denied on the content routes and not merely hidden from
  listings;
- `.env`, `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.gitconfig`, and
  `.env.*`, except the template names `.env.example`, `.env.sample`, and
  `.env.template`;
- private-key basenames `id_rsa`, `id_dsa`, `id_ecdsa`, and `id_ed25519`;
- extensions `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, and `.keystore`.

The policy is applied to the requested path and again to the canonicalized
path, so an in-workspace directory symlink cannot alias a denied location.

Context-excerpt provenance does not weaken this boundary. A forged root ID,
path, revision, line range, quote, or conversation item ID can affect only the
user-supplied message snapshot and its display label; it cannot cause a file
read, disclose current contents, or select another principal's workspace.
Transcript rendering never performs an automatic source read. Selected text
may itself contain secrets, so capture is an explicit user action and the
result inherits the same conversation-history and deployment trust boundary as
the rest of the prompt.

Git status is the only change-attribution signal. Status is computed within
each root's own repository, and a non-repository supplemental root simply
reports no Git repository. Sedes never asks the primary repository to
attribute paths outside it. Sedes does not infer which conversation or agent
changed a file, and invalidation events carry neither paths nor file contents.

## Compiled backend and environment dispositions

Files authority belongs to the execution environment's reviewed file provider,
not to the conversation backend. The compiled backends therefore have these
truthful dispositions:

### Local execution environments

Pi, Codex, Claude, and Grok use the common local Files provider when the
workspace is admitted by the environment's allowed-root policy. No backend
receives additional file authority.

### Pi on an SSH or outbound workspace

Files is implemented only through the managed sidecar when `workspace_files`
is enabled. The separate `workspace_tools`/`workspace_context` pair does not
imply Files access.

### Codex over SSH or outbound

Files is implemented only through the managed sidecar when `workspace_files`
is enabled. Codex carrier health and Files-sidecar health remain independent.

### Claude over SSH or outbound

Files is implemented through the managed sidecar when `workspace_files` is
enabled. A persistent Claude runtime does not grant Files access by itself.

### Unsupported remote shapes

Remote Grok is intentionally unsupported. Every remote environment without `workspace_files` is
also unsupported and fails closed without host-filesystem substitution.
Directory-picker availability additionally requires `directory_browser`.

The in-memory conformance backend may exercise normalized supported and
unsupported paths, but it creates no production topology contract.

## Verification surfaces

Changes must cover root and principal scope, allowed-root admission, overlap
rules, sensitive-path denial, symlink and descriptor-swap resistance, partial
and full-tree paging, cursor fencing, content classification and limits,
revision conflicts, atomic saves, exact-byte downloads and cancellation,
supplemental-root drain, context snapshots, link-only resolution, task links,
Git Compare and review persistence, and every local/managed-SSH unavailable or
carrier-loss path. Browser coverage must exercise retained state, dirty-draft
navigation, desktop and narrow layouts, context capture, Compare, conflict
recovery, and changed screenshots. Remote paths must never fall back to the
Sedes host.

## Known limitations

- **Compare-and-swap is authoritative only against Sedes itself.** Saves are
  serialized per path in-process and re-check the revision immediately before
  the atomic rename, but `rename(2)` cannot be conditioned on the
  destination's identity. An external process (an agent turn, an editor) that
  replaces or deletes the file inside that window is overwritten without a 409. Concurrent same-file editing between Sedes and another writer is
  therefore best-effort.
- **Managed sidecar Files require Linux.** Local containment uses
  descriptor-relative traversal through `/proc/self/fd` on Linux. On macOS it instead
  validates each admitted canonical path against the open descriptor's device
  and inode before path-based operations. Windows similarly compares the open
  handle's volume/file identity with the canonical path, rejects unavailable
  file identity, and explicitly checks directory type and reparse points.
  Sidecar workspaces require a Linux
  remote host with `/proc`; other remote platforms fail closed.
- **Open editors are not silently re-read.** A file changed on disk while open
  stays at the opened revision until the user saves (which surfaces the
  conflict) or uses the toolbar Refresh action in Browse. Refresh reloads a clean active file;
  an active file with unsaved changes requires explicit discard confirmation,
  so a draft is never replaced underneath the cursor.
- **Execution environments without file support are discovered late.** The
  normalized workspace summary carries no file-capability bit yet, so the
  Files panel can be offered for an unsupported workspace and reports
  `workspace_files_unsupported` after it opens. The server is fail-closed;
  only the client's discovery is imprecise.
- **Primary overlap is intentional.** A supplemental root may contain or sit
  beneath Primary. Equal roots and overlap between supplemental roots are
  rejected on attachment
  and rechecked when reopening availability. External filesystem changes can
  still invalidate a previously admitted root between checks; each root ID
  retains independent containment and per-file compare-and-swap authority.
- **Files changes are refreshed explicitly.** Neither Browse nor Compare
  consumes recursive filesystem or Git-metadata watch capacity. External
  additions, removals, and status changes in loaded directories appear after
  toolbar Refresh or a fresh on-demand directory/full-tree request. Comparisons
  are refreshed separately through their explicit comparison actions.
- **Raster previews remain bounded.** PNG, JPEG, GIF, and WebP files larger
  than 16 MiB are recognized but not previewed. Exact saved-byte download is
  available separately up to 1 GiB; SVG, HEIC, PDF/video rendering, upload,
  image editing, and agent attachment are outside this
  Files-panel contract. The separate immutable composer-attachment contract is
  documented in [`composer-attachments.md`](composer-attachments.md); choosing
  a visible Files-panel item does not implicitly upload or attach it.

## Related contracts

[Back to Internals](index.md) ·
[Composer attachments](composer-attachments.md) ·
[Remote Pi workspace tools](pi-remote-workspace-tools.md) ·
[Backend integration](backend-integration-contract-rules.md)
