# Workpads

Workpads are Sedes-owned application documents, independent of provider
transcripts. [User behavior](../user/workpads.md) is documented separately.

## Ownership and authority

Documents, revisions, and human drafts belong to the server-derived
`tenantId`/`principalId` boundary. Request bodies cannot choose an owner or
author. Repository reads and writes constrain both ownership keys, including
history, draft, and pagination paths.

Workpads reuse Task scopes: `global`, `workspace` (Project in the UI), and
`thread`. Scope organizes content and resolves authority; it is not an
independent project isolation mechanism. Agent access uses the shared
[Agent tools](agent-tools.md) policy and Access boundary. `thread` requires
approval outside the calling thread, including global and workspace resources;
`environment` checks environment authority; `unrestricted` does not require
boundary approval. These do not override tool enablement or owner checks.

Authorize historical reads using the workpad's current scope, not the scope
recorded in an old revision. Moving requires authority for source and
destination. Archiving a thread does not delete or relocate its workpads.
Archiving a workpad retains history and disables content editing until restore.

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
`workpad.create`, and `workpad.update` tools share the Sedes service through
native and CLI adapters. Agents access committed state, not human drafts.
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
panel tenant registry. The shared layout owns its split/tab placement, resizing,
chrome, collapse state, and narrow-screen foreground selection. Its stable
portal retains the editor across docking, collapse, viewport changes, and thread
switches. Its open and collapsed state is shared across this client's thread
layouts; the selected document and editor stay mounted during thread navigation.
Closing it or leaving the thread workbench unmounts it, with unsynced draft protection.
The document scopes remain principal-owned Global, Project, and Thread scopes,
independent of the client panel layout. Hidden panels suspend change
subscriptions and resynchronize when shown again; draft autosave remains active.
