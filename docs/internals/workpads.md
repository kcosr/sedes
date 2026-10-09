# Workpads

Workpads are Sedes-owned application documents, independent of provider
transcripts. [User behavior](../user/workpads.md) is documented separately.

## Ownership and authority

Documents, revisions, and human drafts belong to the server-derived
`tenantId`/`principalId` boundary. Request bodies cannot choose an owner or
author. Repository reads and writes constrain both ownership keys, including
history, draft, and pagination paths.

Workpads reuse Task scopes: `global`, `project`, and `thread`. A project
workpad is shared by every location of its project, on every environment.
Scope organizes content and resolves authority; it is not an independent
project isolation mechanism. Agent access uses the shared
[Agent tools](agent-tools.md#project-resources) policy and Access boundary.
`thread` requires approval outside the calling thread, including global and
project resources; `environment` reaches a project workpad from the project's
member environments, those hosting one of its active locations, and asks
otherwise; `unrestricted` does not require boundary approval. These do not
override tool enablement or owner checks.

Authorize historical reads using the workpad's current scope, not the scope
recorded in an old revision. Moving requires authority for source and
destination. Archiving a thread does not delete or relocate its workpads.
Archiving a workpad retains history and disables content editing until restore.

The `workpads` row stores `scope_kind` with exactly that scope's `project_id`
or `thread_id`, enforced by a CHECK, and references `projects` by foreign key.
The scope is also embedded in the current document and in every revision
snapshot. Migration 127 rewrote each workspace scope, in the row, the current
document, and each revision, to the project of the workspace that document or
revision recorded. These documents are internal and unsigned, so no legacy
scope parser remains, and history no longer records which directory an old
revision was scoped to. Commit-time triggers refuse to create a workpad in, or
move one into, a removed project or a thread whose location was removed.

Lists hide the workpads of removed projects and the thread workpads of removed
locations. An exact project query lists only that project's workpads; its
subtree adds the workpads of threads in the project's active locations. For an
agent, a global subtree lists a project workpad only when one of its project's
active locations is on an admitted environment, and a thread workpad only when
its thread's environment is admitted. A removed project is not found to agent
tools, as a source or as a destination.

## List order and counts

`GET /api/workpads` takes the scope (`scopeKind`, with `projectId` or
`threadId`, and `scopeMode`), `query`, `archived`, `limit`, `cursor`, and
`sort`. Lists are flat; the server does not group them. Visibility, the
archived filter, search, and an agent's authority filter apply before
ordering.

`sort` orders a list:

- `updated`, the default: most recently updated first;
- `newest`: most recently created first;
- `title`: by title, ascending.

Ties break by workpad ID, ascending. The agent `workpad.list` tool has no sort
input, so it always lists by `updated`.

Titles compare as SQLite `lower()` values in code point order. ASCII letters
ignore case; other characters, accents, and digits compare as written. Tasks
sorts in the browser with locale collation and numeric order, so the two
panels can differ for non-ASCII letters and numbers: here "Plan 10" sorts
before "Plan 9".

Lists page by keyset. A cursor is opaque and at most 256 characters, like the
history route's. It is `[fingerprint, key, id]`: a fingerprint of its owner and
query, including the sort, page size, and agent authority, then the last row's
sort key and ID. A cursor from any other query or owner fails with
`cursor_invalid` (409). A title travels whole when it fits. Otherwise the
cursor carries a prefix of it and a digest of the whole lowercased title.
Continuation re-reads the row's current title and resumes there only if its
digest matches, meaning the title is unchanged. Otherwise it resumes at the
prefix. A prefix sorts before every title that extends it, so this can repeat
rows but never skips a row whose own title held.

A row whose order changes between pages may be skipped or listed again, as in
any keyset list. That covers an edit under `updated` and a retitle under
`title`. A client that appends pages should deduplicate them by workpad ID.

`GET /api/workpads/counts` takes an optional `threadId` and `projectId` and
returns `{ active, archived }`, split by `archived_at`. Each half holds:

- `thread`: the thread's own workpads;
- `project`: the project's own workpads;
- `projectWithThreads`: the project's subtree, as in `{project, subtree}`;
- `global`: global workpads;
- `all`: the global subtree, every visible workpad.

`thread` is null when the request names no thread; `project` and
`projectWithThreads` are null when it names no project. Counts use the list's
visibility rules in one aggregate query, so each count equals its full list's
length. A malformed ID is a 400. An ID the caller does not own, or a removed
project, is a 404, as in a list. Like every workpad route, the response is
`Cache-Control: no-store`.

## Committed state and attribution

The repository stores a current document and immutable revision snapshots.
Each snapshot includes content, title, scope, archive state, author, timestamp,
attribution spans, and added/removed text. Creation starts at revision zero.
Effective content or metadata changes advance the revision; no-op updates do not.

Author identity comes from the trusted browser or agent-tool caller. Agent
authors retain their thread ID; named Tool clients retain their client ID.
Stored author names are snapshots, while read projections resolve available
current names within the same owner boundary.

Attribution spans use half-open UTF-16 offsets into Markdown source. The
content diff carries unchanged spans forward and attributes added text to the
new revision's author. Removed text is retained in revision changes; prior
snapshots retain its earlier attribution. Full-replacement diff work has a
deterministic complexity bound. When character alignment exceeds its budget,
bounded word and then line alignment preserve unchanged tokens and attribute
changed tokens to the new editor. An update exceeding all three budgets is
rejected rather than resetting existing provenance. Content and attribution size limits also reject
oversized updates atomically.

The client renders Markdown, optionally mapping visible text to source spans.
Attribution is last-change provenance, not semantic authorship or move tracking.
Revision navigation renders complete snapshots. Revision details separately
exposes removed and added text without changing the selected document.

The latest unarchived document opts into interactive GFM checklist boxes.
Parser source positions identify the exact check marker; a toggle replaces
only its middle character in the original Markdown. The update uses that
rendered document's revision, never a newer revision paired with older text.
Each successful toggle follows the ordinary committed update, history, and
attribution path. Pending writes block repeated activation, and a conflict
reloads current content rather than replaying a stale replacement. Historical
revisions, archived documents, and other Markdown surfaces remain read-only.

## Atomic updates

Every update supplies `expectedRevision`. The repository checks it in the same
transaction that writes current state and the new history entry. A stale
revision fails without partial changes, including when a previous response was
lost and the caller retries. There is no additional agent-facing request ID.

Content updates accept one of:

- `replace`: the intended complete text;
- `append`: text appended verbatim; or
- `patch`: exact `oldText`/`newText` replacements.

All patch matches resolve against the same expected document. Each old passage
must occur exactly once and matches cannot overlap. The entire batch succeeds
or fails together. Patch and append operations use their explicit edit ranges
to preserve untouched attribution. Full replacements derive changes by diffing
against the expected content; they do not automatically erase unchanged text
provenance. Every mode writes the same revision and attribution record shapes.

The canonical `workpad.list`, `workpad.get`, `workpad.revisions`,
`workpad.create`, and `workpad.update` tools, each at version 2, share the
Sedes service through native and CLI adapters. A `project` scope in their
input defaults to the caller's project. Agents access committed state, not human drafts.
Listing and history are paginated. Caller-supplied filesystem paths are not
interpreted as server-side content authority.

## Human drafts

Each owner/workpad has one synchronized working draft with two independent
counters: its own `revision` for cross-client compare-and-set and
`baseRevision` identifying the committed content it edits. Autosave updates
only the draft, not document history. A clean draft follows committed changes;
a changed draft retains its text and original base until reconciliation.

Explicit commit checks both the expected draft revision and expected document
revision, commits through the ordinary content-update path, and resets the
draft atomically. Neither opening an editor nor autosaving locks out agents.
The browser preserves conflicting local text and requires a deliberate draft
choice or document reconciliation before retrying. It does not silently merge
or overwrite another client's draft or an intervening committed revision.

Committed mutations publish a small `workpad_changed` invalidation through the
existing principal-scoped application SSE stream. Each event identifies the
workpad, revision, and whether the document or human draft changed; document
bodies remain separate authorized reads. Publication follows the application's
serialized boundary, with failed publications retried by the durable scheduler.
Rejected writes publish nothing.

Application thread summaries include `nonArchivedWorkpadCount`, derived with
the other grouped summary counts from rows owned by that tenant and principal,
scoped directly to the thread, and not archived. The count is not persisted
separately and does not require a Workpad list fetch in the browser. Creation,
archive, restore, and scope moves hand off affected thread summaries to the
application publication boundary after commit. A move retains both the old
and new counted thread IDs, so publication coalescing or retry cannot leave
the source badge stale. Draft, title, and content changes—including checklist
toggles—do not schedule count updates. Snapshot and thread-upsert publication
carry the same count, including after reconnect.

The open Workpads panel subscribes to these events and fetches affected lists,
documents, or drafts without periodic polling. Events arriving during a fetch
or mutation queue a follow-up read. Replayed events and authoritative stream
replacements recover missed updates after reconnects. Historical revision
selection and unsaved working text survive these refreshes.

Updates do not inject provider messages or start turns. Panel visibility and layout are
client concerns; content and synchronized drafts remain principal-owned server
state. Provider protocols and session identifiers are not part of the Workpad
contract.

## Workspace panel host

Workpads is a singleton `workpads` panel instance registered with the workspace
panel tenant registry. The shared layout owns its split/tab placement,
resizing, chrome, collapse state, and narrow-screen foreground selection. Its
stable portal retains the panel across docking, collapse, viewport changes,
and thread switches. Its open and collapsed state, size, and place are shared
across this client's thread layouts (`workspace-panels/companion-layout.ts`);
Thread view follows the active thread and Project view follows its project;
Global and All views are independent of navigation. The selected view and its
options are remembered on the device (`workpads-panel-store.ts`, key
`sedes.workpads.panel`). A changed effective scope clears the selected
document, editor, history, and pending form state and invalidates reads from
the previous scope. The selection and editor survive navigation when the
effective scope stays the same. Navigation or a project catalog update that
would leave an unsynced editor or an in-flight mutation requires confirmation.
Read-only loads do not block navigation. Catalog updates retain any pending
navigation confirmation and its destination. Synced drafts remain
principal-owned server state and can be reopened. Closing the panel or leaving the thread workbench unmounts
it, with unsynced draft protection.
The document scopes remain principal-owned Global, Project, and Thread scopes,
independent of the client panel layout. Hidden panels suspend change
subscriptions and resynchronize when shown again; draft autosave remains
active.
