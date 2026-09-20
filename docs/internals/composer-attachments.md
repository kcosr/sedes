# Composer-attachment subsystem contract

Composer attachments are durable, normalized user input. They are distinct
from supplemental Files-panel roots and context excerpts: an attachment owns a
bounded immutable copy of the selected bytes, while a Files root authorizes
live browsing and an excerpt owns already-captured text. They are also distinct
from [provider output artifacts](output-artifacts.md), which capture supported
backend-produced results after the provider boundary and never re-enter the
draft, staging, Task, or delivery-snapshot pipeline.

For user-facing attachment workflows, see
[Files and context](../user/files-and-context.md). For state backup and deployment trust
requirements, see [Operations](../operator/operations.md). Related internal
contracts are [Workspace Files](workspace-files.md),
[provider output artifacts](output-artifacts.md), and the
[backend integration contract](backend-integration-contract-rules.md).

## Contents

- [State and ownership](#state-model-and-ownership)
- [Classification and limits](#classification-and-limits)
- [Delivery and backend projection](#delivery-and-execution-environment-staging)
- [Managed-SSH staging](#optional-ssh-staging-sidecar)
- [Retention and backup](#retention-garbage-collection-and-backup)
- [Verification](#verification-surfaces)

## State model and ownership

An upload begins as client-local pending state. A successful upload becomes a
durable draft link and survives reload. The same ordered attachment links move
into and out of a prompt stash, follow queued input, retry and first-send
recovery, and become immutable attachment parts in normalized history after
delivery.

Restoring a user-created pending or retry-scheduled queue entry copies its
exact ordered attachment links back into the same thread's empty draft in the
same transaction that removes the entry from the active queue. The server
checks the principal, thread, queue state, thread revision, draft revision, and
complete draft emptiness; the browser never reconstructs attachment references
from the queue summary or reuploads the immutable bytes.

Upload is intentionally a two-phase operation:

1. The client creates an opaque UUID and sends the raw body with
   `application/octet-stream` to
   `PUT /api/threads/:threadId/composer-attachments/:attachmentId`. The bounded
   display name and optional declared media type are query metadata; neither is
   content authority.
2. Only after that request succeeds, and only if its local upload slot still
   exists, the client includes the returned attachment ID in the next normal
   compare-and-swap draft save.

Clicking X before completion aborts the request and removes the local slot. A
late success is ignored rather than resurrecting the card. This sequencing
keeps raw streaming independent from the serialized draft revision and leaves
at most an unowned upload for garbage collection.

Canonical bytes and metadata are tenant/principal-owned. Each uploaded ID also
records its origin thread, and every live use is an explicit ordered owner link
for that same principal and thread: draft, stash, queue row, creation attempt,
conversation operation, or submitted snapshot. The server derives tenant and
principal from its request scope; the browser never supplies either authority.
IDs do not grant access, attachments cannot cross a principal or origin thread,
and this remains the ownership boundary when global application authentication
is added later.

The normalized browser descriptor contains only the opaque ID, bounded display
name, classified kind and media type, and byte count. It contains no canonical
blob path, staged agent path, digest, storage key, tenant, principal, native
conversation ID, or execution-environment identity. Durable image previews use
the scoped `GET`/`HEAD .../:attachmentId/content` route and are available only
while the attachment has a live owner. The same authorized route serves
general binary content only as an opaque `application/octet-stream` download
with attachment disposition; the browser never attempts to render it inline.

## Classification and limits

The server streams and hashes each upload and classifies its bytes rather than
trusting the browser MIME type. PNG, JPEG, GIF, and WebP become images only when
their allowlisted extension and signature agree, the full attachment is no more
than 16 MiB, and parsed dimensions are at most 16,384 pixels on either axis and
40 million pixels in total. Spoofed, malformed, mismatched, SVG, and all other
content is a generic `application/octet-stream` file.

One composer input permits:

- at most 8 attachments;
- at most 4 recognized images;
- at most 25 MiB for one file, or 16 MiB for one recognized image;
- at most 64 MiB across all attachments; and
- a non-empty display name of at most 255 UTF-8 bytes, with NUL and line breaks
  rejected.

Uploads are limited to four concurrent streams per principal scope and 100 MiB
of process-wide temporary upload reservation. The principal's retained
canonical blob quota is 1 GiB. Content-addressed storage deduplicates equal
bytes only inside the same tenant/principal scope; a digest is never a
cross-principal reference.

## Delivery and execution-environment staging

Attachments are materialized only when their owning input reaches the delivery
boundary. The application re-resolves every ordered ID and immutable descriptor
under the server-derived scope, opens the canonical blob with no-follow checks,
rehashes it, and uses the actor's exact execution-environment lease. A local
thread stages locally. An SSH or outbound thread stages through its configured operations
sidecar. Missing capability, lease mismatch, scope mismatch, carrier loss,
changed evidence, corruption, or an unavailable attachment fails the delivery;
Sedes never substitutes its own host filesystem or another environment.

The stager chooses a deterministic principal/thread/attachment namespace. It
does not accept a browser, model, backend, or filename-selected destination.
Directories are owner-only, published content is read-only, incoming transfers
are bounded and chunk-hashed, and commit verifies total byte count and SHA-256
before atomically publishing the agent-visible file. The staged path is an
immutable delivery snapshot. Editing an original local file after upload cannot
change it, and the browser cannot ask Sedes to reread an original path.

On Windows, directory privacy is established and verified through Windows
ACLs for the current account, including owner and inheritance checks. Reparse
points are rejected. Published files retain the Windows read-only attribute;
POSIX directory mode bits are not used as evidence of Windows access control.
Failure to establish or verify that boundary rejects staging.

Durable acceptance records ordered, path-free attachment descriptors in the
same immutable delivery snapshot as the original text, context excerpts, and
Task snapshots. That snapshot and its `deliveryOperationId` remain the common
authority for retries, restart reconciliation, and normalized history. Staged
paths and native bytes are delivery-time projections, not separate backend
attachment records.

Path-native backends receive the staged paths, safe descriptors, and SHA-256
digests needed by their wire projection. Native-byte backends instead obtain
exact bytes from a scope/thread-bound canonical blob reader that rechecks
ownership, descriptor equality, byte count, and SHA-256. An `agentPath` may
name a remote or SSH target and is never interpreted as a path on the Sedes
server. Neither projection places bytes, reader functions, or remote paths into
operation fingerprints, normalized history, logs, or browser payloads.

Backend dispositions are explicit:

### Pi

- **Ordinary files:** plain-text staged-path manifest on submit and steer.
- **Native images:** when the selected model declares image input, Sedes reads
  exact verified canonical bytes before adding Pi image content. It never
  rereads `agentPath` locally.

### Codex

- **Ordinary files:** plain-text staged-path manifest on submit and steer.
- **Native images:** an image-capable selected model receives path-native
  `localImage` without a duplicate manifest entry. For a text-only model, the
  image remains in the staged-path manifest.

### Grok

- **Ordinary files:** standard ACP `resource_link` referencing the staged
  `agentPath`.
- **Native images:** stable 1.x runtimes at least 1.0.4 receive exact canonical
  bytes as ordered standard ACP base64 image blocks. Grok creates its own
  model-visible session copy and path.

### Claude

- **Ordinary files:** plain-text staged-path manifest on submit.
- **Native images:** Sedes reads exact verified canonical bytes and adds ordered
  Claude base64 image blocks. It never rereads `agentPath` locally.

### In-memory conformance backend

The test backend implements normalized supported and unavailable paths and
exercises native-image capability projection without creating a production
provider contract.

Native image availability is model-sensitive and may change with the selected
model. File staging availability is also execution-environment-sensitive. The
composer follows the normalized capability document and fails closed if either
authority changes before delivery. Grok's narrow reviewed-profile correction
also requires the registered standard ACP image path and its admitted runtime
floor; explicit provider/model image false remains authoritative.

For Pi and Claude, an admitted image remains both a native visual input and a
Sedes-staged read-only file. Version 2 of the authenticated staged-path
manifest tells those models that native pixels are already available and
reserves the staged path for explicit filesystem requests, such as copying the
image into the repository; projection continues to authenticate version 1
records already present in durable native history. Codex's native `localImage`
already carries the usable path, so Sedes does not add a second image path
when that input is available; on a text-only Codex model the staged-path
manifest remains the only file facet. Grok creates a provider-owned session copy
and supplies that path itself, so Sedes does not add duplicate image guidance
there. Ordinary files retain the backend projection shown above.

Claude's current official model catalog does not expose a per-model image
modality discriminator. The reviewed Claude Agent SDK worker profile therefore
advertises native image input for its admitted Claude models as one backend
contract. Before SDK delivery, Sedes reads each image from the common
scope/thread-bound canonical byte reader, verifies its immutable descriptor,
size, and digest, and emits it in the original attachment order. Ordinary
files remain staged-path manifest entries. A missing reader, changed evidence,
unsupported media type, or failed integrity check rejects the complete input
before it enters the SDK queue.

## Optional SSH staging sidecar

Codex and Claude SSH or outbound targets use the same independently admitted remote staging
provider. Claude reads native-image bytes through the canonical scoped reader;
it never opens a remote `agentPath` on the main host.

An SSH execution environment must opt into composer staging independently with
`operations.enabledCapabilities`. Capabilities form a nonempty unique set on the persistent environment service.
They are independent grants; their enumeration does not grant provider authority.
`workspace_tools` and `workspace_context` must appear together:

```json
{
  "kind": "sidecar",
  "enabledCapabilities": [
    "directory_browser",
    "workspace_files",
    "workspace_tools",
    "workspace_context",
    "composer_attachments",
    "agent_tools_cli"
  ]
}
```

`composer_attachments` exposes a closed `composer_attachments@1` protocol for
open, bounded 256 KiB append, commit, abort, and release operations. It accepts
server-derived staging identities and safe extensions, not arbitrary paths or
commands. Enabling `workspace_files` does not silently enable staging, and
enabling staging does not authorize Files browsing, editing, or the remote
agent-tool CLI. Likewise, `directory_browser` grants only bounded directory
navigation and neither it nor `agent_tools_cli` authorizes attachment staging.
The shared persistent service and carrier lifecycle do not merge their
capability or health authority. With `operations.kind: "none"`, or without the
exact capability, remote attachment delivery is unavailable and no sidecar is
started for it.

## Retention, garbage collection, and backup

An upload that never acquires a live owner expires after 24 hours. Removing a
draft or stash reference removes only that owner link; canonical content stays
while another draft, stash, queue, operation, creation attempt, or submitted
snapshot owns it. Garbage collection deletes attachment rows with no live owner
after their expiry and removes a content-addressed blob after its last scoped
row disappears. Startup also clears interrupted temporary uploads, verifies all
retained blobs, and removes on-disk objects that persistence does not retain.
Corrupt or missing retained content fails closed rather than delivering altered
bytes.

The canonical blob store is under the Sedes application state directory in
`composer-attachments/`; local execution snapshots are under
`execution-attachments/`. SQLite owns attachment identities, descriptors, and
references. Back up the locked/quiescent application state directory as one
unit so the overlay and canonical blob store remain consistent. Canonical bytes
are required for restore; execution snapshots are derived delivery material and
can be rebuilt from them.

Uploaded bytes may contain secrets and delivered paths allow the selected agent
to read those bytes. The same server-derived principal scope, host/origin
checks, network boundary, state-directory permissions, and backup controls that
protect prompts and transcripts also protect attachments. Default production paired
client admission covers ordinary attachment upload and content routes, including
thumbnail fetches. Image thumbnails use
object URLs or the scoped content route, never remote Markdown URLs, and
filenames are display labels rather than HTML, filesystem, or command input.

## Verification surfaces

Changes to this subsystem must cover all of the following:

- strict upload metadata and body limits, signature-based classification,
  dimension limits, concurrency reservations, scoped deduplication, quota
  accounting, interrupted temporary uploads, and content-route authorization;
- principal, origin-thread, and live-owner denial across draft, stash, queue,
  creation-attempt, operation, and submitted-snapshot references;
- compare-and-swap draft adoption, removal during upload, queue restoration,
  retry and restart reconciliation, garbage collection, corruption, and backup
  restoration with the SQLite overlay and blob store kept consistent;
- local and managed-SSH staging, lease and revision fencing, carrier loss,
  chunk and final digest validation, cancellation, read-only publication, and
  the absence of local fallback for remote paths; and
- each compiled backend's ordinary-file and model-sensitive native-image
  projection, including unavailable and fail-closed paths. Provider live suites
  remain separately gated and require explicit authorization.

## Related contracts

[Back to Internals](index.md) · [Workspace Files](workspace-files.md) ·
[Output artifacts](output-artifacts.md) ·
[Backend integration](backend-integration-contract-rules.md)
