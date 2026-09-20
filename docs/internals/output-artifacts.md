# Provider output artifacts

Provider output artifacts are immutable image results produced by a backend
after model work has begun. They are separate from
[composer attachments](composer-attachments.md), which are user-selected input
captured before provider delivery, and from bounded images embedded in a
normalized tool-result card.

The current durable output-artifact implementation is deliberately narrow. It
supports completed Codex `imageGeneration` items whose reviewed native result
contains an in-band PNG and exact completed Grok `ImageGen` or `ImageEdit` tool
results whose JPEG is available inside the owned local Grok session directory.
It does not add image-generation controls or make other provider-generated or
generic tool-result images durable.

For the surrounding ownership model, see [Architecture](architecture.md). For
the contributor requirements that apply when extending this contract, see the
[backend integration contract rules](backend-integration-contract-rules.md#provider-output-artifacts).

## Contents

- [Normalized contract](#normalized-contract)
- [Ownership and access](#ownership-and-access)
- [Codex byte authority](#codex-byte-authority-and-topology)
- [Grok byte authority](#grok-byte-authority-and-topology)
- [Cross-backend disposition](#cross-backend-disposition)
- [Related documentation](#related-documentation)

## Normalized contract

A successfully retained image enters normalized history as an image item whose
artifact representation contains only:

- an opaque artifact UUID;
- canonical image MIME type;
- byte size and lowercase SHA-256 digest; and
- optional bounded filename and alt text.

The native base64 value, provider path, provider URL, and storage path never
enter normalized history, browser events, diagnostics, or logs. Invalid,
unsupported, oversized, incomplete, or unavailable native content produces a
bounded unavailable representation or the backend's truthful non-image
fallback rather than a fabricated artifact. Full and summary snapshots,
history pages, and SSE carry the same descriptor-only representation.

The normalized backend capability document reports
`providerOutputArtifacts.nativeImage: true` for the reviewed Codex and local
owned-Grok paths. Pi and Claude report `false`; input-image or bounded
tool-result-image behavior does not imply this durable output capability.

The content route supports both methods:

```text
GET  /api/threads/:threadId/output-artifacts/:artifactId/content
HEAD /api/threads/:threadId/output-artifacts/:artifactId/content
```

The browser checks the returned size and MIME against the descriptor, applies
the same safe-raster preview validation used by composer images, and creates a
temporary object URL. The URL is revoked when the renderer is replaced or
unmounted. The transcript shows explicit loading and unavailable states and
uses the common expandable image preview. In the packaged Android client, a
touch or pen long-press on either the inline or expanded preview opens the
native **Save image** / **Copy image** menu. Save writes the already retrieved
and validated bytes through Android's system Create Document picker. Copy puts
those bytes on the system clipboard as a private content-provider stream.
Neither action gives Android a Sedes URL, artifact identifier, provider path,
or storage path, and neither action adds a storage or media permission. Desktop
browsers retain their ordinary image context menu. The WebView-to-native copy
uses ordered bounded chunks, and Capacitor argument logging is disabled so raw
image data does not enter Android bridge logs.

Markdown image syntax is not an artifact transport. The common Markdown
renderer never fetches or displays pixels from a Markdown image destination,
whether that destination is relative, same-origin, remote, `data:`, or
`file:`. It renders a bounded omitted-image notice instead. Provider images are
displayed only from normalized image items whose artifact descriptor is
resolved through the scoped content route above.

The server returns the exact content type and length, an ETag derived from the
SHA-256 digest, `private, max-age=3600, immutable` caching, `nosniff`, and an
inline filename derived from the artifact ID and canonical MIME extension.
`HEAD` and conditional `304` responses close the retained file handle without
sending a body.

## Ownership and access

`OutputArtifactService` owns artifact lookup beneath the server-derived tenant,
principal, and thread scope. An artifact UUID is an identifier, not a bearer
credential, and the browser cannot select another principal or turn a
provider/storage path into retrieval authority. Immutable bytes and descriptor
metadata must agree. A wrong scope, thread, or artifact association returns the
ordinary not-found response; retained metadata with missing or corrupt bytes is
an integrity failure.

Canonical artifact bytes are limited to 16 MiB and stored beneath
`$APP_STATE_DIR/output-artifacts/blobs/`. Their metadata lives in the overlay
database, so the database and blob directories remain one quiescent backup
unit.

One stable backend item publication identity resolves to one artifact inside a
thread. Equal bytes are content-addressed and deduplicated only inside the same
tenant/principal scope; an artifact in another thread still has its own scoped
descriptor. The blob store rechecks file type, no-follow open, byte count, and
SHA-256 before serving content, and startup reconciles retained database rows
with stored blobs. Artifact rows follow their owning thread's lifetime.
Unreferenced blobs are reclaimed during artifact-service reconciliation. There
is no separate user-facing artifact retention, delete, or quota control.

Artifact content routes use the same default production paired-client admission as
other management APIs. A valid browser cookie or packaged-client bearer
credential is required in addition to scoped artifact authorization. There is
no artifact-only credential or public signed-content URL. Host/Origin, Fetch
Metadata, CSRF, and CORS checks remain independent protections. Keep Sedes
within a supported private deployment boundary; authentication does not
provide transport encryption for explicitly admitted LAN HTTP. See
[Operations and security](../operator/operations.md).

## Codex byte authority and topology

Codex 0.153.0 defines a closed `imageGeneration` item containing status,
revised prompt, a transparent-background flag, `result`, and `savedPath`.
Sedes accepts only a completed item with canonical padded base64 whose
decoded bytes are a PNG no larger than 16 MiB. It uses the in-band `result` as
byte authority and deliberately ignores `savedPath`; that path is
provider-private convenience state and may not name the Sedes server's
filesystem.

Because the reviewed bytes travel through the Codex app-server protocol, the
artifact path does not require Files, composer staging, or an SSH sidecar. A
provider contract that exposes output only as an execution-environment path
requires a separately reviewed local reader and an explicit managed-SSH sidecar
adapter. That adapter is not implemented: Sedes must not treat a
remote path as local or silently fall back to another environment.

Repeated observation of the same native item through live events, history
replacement, pagination, or reconnect resolves the same immutable artifact.
The common history item is durable and path-free; transient provider content
is not browser authority.

## Grok byte authority and topology

The reviewed local Grok Build profile emits exact completed `ImageGen` and
`ImageEdit` tool results containing `type`, `path`, `filename`, and the
`images` session-folder marker. Both use the same reviewed `MediaGenOutput`
shape. Sedes accepts only those two exact result types, a reviewed numbered
`.jpg` filename, and an exact absolute path beneath the effective Grok home,
canonical workspace namespace, native session ID, and `images` directory. It
opens the file without following the final path, verifies that the directory
resolves inside that exact owned session, bounds the bytes to 16 MiB, and
requires a valid JPEG before publishing through the common artifact service.

The tool result is evidence identifying provider-owned local bytes; its path is
never browser or normalized-history authority. Any matching Markdown reference
such as `images/1.jpg` is removed from the normalized assistant text, and the
common artifact image is inserted adjacent to the tool item. Repeated live,
history, paging, and reconnect observations use the prompt and tool-call
identity to resolve the same artifact.

This reader is valid only for the owned local Grok topology, where Sedes and
Grok share that native filesystem namespace. Remote or SSH Grok artifact
capture has no implemented reader or sidecar adapter and remains unsupported.
Any native output shape other than the exact completed `ImageGen` or
`ImageEdit` result is unsupported and does not advertise artifact support.

## Cross-backend disposition

| Backend | Durable standalone artifact support |
| --- | --- |
| Codex | **Supported:** completed native `imageGeneration` with a valid in-band PNG. |
| Grok | **Supported for owned-local sessions:** exact completed `ImageGen` or `ImageEdit` with a valid JPEG at the scoped session path. |
| Pi | **Intentionally unsupported.** |
| Claude | **Intentionally unsupported.** |

The boundaries outside that table remain important:

- Codex MCP tool-result images remain metadata-only tool-result entries.
  Dynamic-tool image output is omitted, and `imageView` remains a notice rather
  than reading a native path.
- Grok remote or SSH path capture, unreviewed tool output, image-generation
  controls, and a separate download flow are unsupported. Generic ACP image
  result parsing does not create an artifact implicitly.
- Pi tool-result image blocks remain metadata-only entries; the current tool
  card does not render their pixels.
- Claude assistant image blocks remain an omitted notice, and its tool-result
  image blocks remain metadata-only entries.

Input image support is independent. Pi, Codex, and Grok may accept normalized
composer images under their own model- and topology-sensitive input
capabilities without gaining provider-output support. Claude also accepts
verified native composer image bytes, but that input path likewise says nothing
about its output contract.

## Related documentation

- [Composer attachments](composer-attachments.md) — the separate user-input
  byte and delivery contract
- [Architecture](architecture.md#persistence) — storage ownership and backup
  boundary
- [Backend integration contract rules](backend-integration-contract-rules.md#provider-output-artifacts)
  — requirements for extending output support
- [Codex internals](backends/codex.md) and [Grok internals](backends/grok.md) —
  provider-specific lifecycle and topology
