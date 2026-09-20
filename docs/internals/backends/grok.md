# Grok backend internals

This document is the provider-private implementation contract for the Grok
backend. For installation, configuration, operator-visible capabilities,
troubleshooting, and live-suite safety, use the
[Grok operator guide](../../operator/backends/grok.md).

- [Backend maintainer index](index.md)
- [Backend integration contract](../backend-integration-contract-rules.md)
- [Provider output artifacts](../output-artifacts.md)

## On this page

- [Release and parser contract](#release-and-parser-contract)
- [Native authentication and namespace](#native-authentication-and-namespace)
- [Runtime, lifecycle, and history](#runtime-lifecycle-and-history)
- [Model and input projection](#model-and-input-projection)
- [Unsupported and fail-closed behavior](#unsupported-and-fail-closed-behavior)
- [Verification surfaces](#verification-surfaces)

## Release and parser contract

Sedes supports Grok Build through its provider-private ACP stdio protocol on
local Linux x64 and macOS arm64/x64. Configuration and runtime admission use
the compiled `1.x` compatibility profile with `1.0.4` as the reviewed runtime
floor. Prereleases, older releases, malformed builds, and explicitly excluded
incompatible releases are rejected. The build hash is retained as bounded
diagnostic evidence rather than treated as a compatibility key. Sedes is
tested through `1.0.4`; later admitted stable releases continue through
the same pinned `grok-acp/1.0.4` parser and are assessed as newer than tested.
They do not select a second parser or enable unreviewed capabilities.

The version probe's build hash is bounded diagnostic evidence, not a
compatibility key. Runtime admission, ACP profile registration, and capability
projection must remain separate: accepting a later stable executable
cannot activate an unreviewed wire shape or feature.

## Native authentication and namespace

Production preserves normal `HOME` and an explicitly set `GROK_HOME`. Grok owns
its credential storage and refresh lifecycle. Sedes never reads, copies,
parses, persists, or rotates provider tokens, and it never creates a private
Grok home. If the native installation is not logged in, the target reports
authentication required with no provider payload or credential detail.
Disposable homes, copied credentials, Bubblewrap, and probe runners are limited
to historical characterization and tests; production module code does not
import them.

The native namespace is derived from the execution environment and effective
Grok home/config authority. It is not an authenticated-account identifier.
Changing accounts inside that native home therefore preserves the namespace;
Sedes does not claim cross-account continuity because this profile exposes no
reviewed stable opaque account ID.

## Runtime, lifecycle, and history

The initial production profile supports:

- bounded model discovery and model/reasoning policy enforcement;
- bounded native session discovery with immutable Sedes paging;
- provider-assigned session creation;
- initial-title propagation before first input and normalized native rename
  with exact lost-response reconciliation;
- native session import and attach through a bounded provider-authoritative
  history window followed by a no-replay load;
- one serialized ordered ACP projection of the common delivery snapshot,
  including text-, Task-, file-, and image-only prompts, with the shared
  durable operation identity and restart reconciliation;
- exact-active-turn Stop through ACP cancellation, with durable interrupted
  terminal reconciliation and no retry against an adjacent turn;
- normalized user, reasoning, assistant, structurally evidenced command,
  file-read, file-change, web-search, MCP, generic-tool, and parent-side
  collaboration history;
- normalized common plans from durable standard ACP `Plan` replacements;
- durable common image artifacts for exact completed local `ImageGen` and
  `ImageEdit` results;
  and
- session close as unload, never delete.

Native text chunks are incrementally folded into stable bounded semantic blocks
with an exact private digest. The resident projector retains the active turn,
the newest whole-turn display window, and compact unsettled-operation evidence;
it releases a sealed older turn's records, indexes, and fingerprints together.
Live item updates are coalesced on a bounded interval without reprojecting
complete history per token. Chunk count and conversation age therefore do not
become provider-session failure conditions. A Grok terminal
sets the turn's final status but does not discard delayed records for that same
prompt when the native event journal persists them afterward; the next prompt
remains the turn-grouping boundary.

Grok tool interpretation remains provider-private. Sedes reads the reviewed
version-1 `x.ai/tool` taxonomy only from each tool update's nested metadata,
merges sparse input refinements under the stable native tool-call identity, and
never exposes that envelope to the browser. Exact native structure may select
one of the existing common command, file-read, file-change, web-search, or MCP
items. Insufficient, malformed, or unknown evidence remains an ordinary
generic tool; prose titles and tool names are never semantic classifiers. The
normalized semantic kind is latched before first publication and cannot change
on a later patch. Grok's exact `Bash`, `WebSearch`, and `MCP` result variants
are decoded into common bounded output fields, while unrecognized provider
results remain bounded generic-tool details.

Grok's standard ACP `Plan` update is a full-list replacement, not an append.
Sedes accepts only the provider-journal form with the exact native event and
prompt metadata, requires that prompt to be the active turn, and compacts
successive replacements into one bounded plan block at its original source
position. The normalized plan/item identity and ordinal entry identities are
stable across live delivery, native replay, paging, and reopen. ACP priority is
not part of the common plan contract. A completed ACP entry carrying the
reviewed `cancelled` metadata becomes a common cancelled entry; remaining
in-progress entries become completed when the durable turn terminal arrives.
Grok's exact metadata-free turn-end cleanup notification is cosmetic and is
ignored rather than retained as completion evidence. The browser receives only
the existing common plan item, never a Grok-specific plan shape.

Parent-side subagent spawn and finish updates are durable native-history
evidence; intermediate progress is a live-only, metadata-free sample. Sedes
reduces those updates into one stable common collaboration item whose action,
status, summary, and error truthfully advance from spawn through progress to a
completed, failed, or interrupted result. Native replay omits progress and
converges to the same terminal item on reopen. An active collaboration that
leaves the display window retains only its compact private reducer state and is
hidden until settlement, when both the record and reducer state are released.
No child native session identifier, transcript, tool frame, Sedes thread, or
Grok-specific browser contract crosses that boundary.

Grok ACP uses the shared 128 MiB provider frame capacity. Owned NDJSON, ACP,
Codex framing, and WebSocket framing use that same capacity, and both inbound
and outbound queue-byte watermarks admit at least one maximum frame. Queue
limits are cancel/close-aware backpressure watermarks, not smaller Grok input
limits; Grok inherits the owned-NDJSON queue-count watermarks without a
backend-specific override. Its ACP binding likewise inherits shared deadlines
and the common frame-backed admission for standard open-map byte-array values;
Grok adds no resource-limit block. One native history acquisition remains
frame-bounded and request-local; normalized snapshot/page transfer retains the
shared whole-turn and byte limits. Older pages are read from the reviewed
`_x.ai/session/updates` authority through opaque cursors that bind the process
epoch, exact boundary record, prompt-start topology, and the exact final
visible record at cursor issuance. Ordinary appends preserve that issuance
frontier, while a native rewind of the represented timeline filters or replaces
it and invalidates the cursor. The reviewed route exposes no transcript root,
so Sedes does not claim to detect arbitrary out-of-band file rewriting that
preserves all of those anchors. A user prompt may cancel a lower-priority page
read. Already-emitted chunks from that abandoned
read are discarded behind one payload-free exact-sequence drain until their
native final marker; only another history read waits on that drain. Grok queues
those chunks with fire-and-forget forwarding, so its metadata response is not a
chunk-delivery barrier. Sedes keeps the acquisition open until the exact
advertised chunk count and final marker arrive. If that abandoned tail never
terminates, a bounded drain deadline closes the unsafe ACP connection
generation; a replacement connection may reacquire history without admitting
late chunks into a successor read.

Targeted turn lookup scans the retained authoritative history window newest
first and projects only the matching whole turn. Its retained-history boundary
is part of the result: reaching native history start proves absence, while an
older opaque boundary or the caller's candidate ceiling reports bounded-search
exhaustion. It does not start another ACP history acquisition or walk
normalized older-history pages.

One turn retains at most the shared normalized item capacity. Additional
provider activity is folded into one ordinary normalized notice rather than
growing a provider-private map or fencing the prompt. History paging is
request-local common actor work: a turn-starting mutation aborts queued and
in-flight page reads before entering the actor mailbox, without reordering
mutations.

Opaque native event identities remain available for exact duplicate/conflict
checks only while their prompt window or unsettled operation is retained. The
reviewed Grok 1.0.4 history can reuse an event ID after a later prompt/reconnect,
so Sedes scopes that evidence to the exact native prompt instead of treating
the raw ID as session-global; ambiguous promptless reuse remains fail-closed.

Each resident session owns one Grok process. A process loss fences its
generation; recovery starts a fresh process and loads provider-authoritative
history. Handles do not infer success from quiet periods, socket writes, or
prompt responses alone. Unknown outcomes use the same durable operation receipt
and reconciliation state as every backend. The Grok adapter contributes exact
ACP prompt and native-history correlation; it owns no separate attachment,
Task, input-history, or replay authority.

Sedes retains its normalized application title (up to 240 UTF-16 code
units). Grok's native title is a deterministic presentation projection: unsafe
format controls are replaced, whitespace is collapsed, and the result is
bounded to Grok's 100-Unicode-scalar limit. Reconciliation compares that exact
projection while application persistence retains and revision-fences the full
Sedes title. Native rename uses an independent correlated ACP request lane,
so it remains available while a prompt request is running.

Sedes can expose its CLI agent tools in Progressive or Individual mode only to
an exact attached thread after runtime verification. Grok has no Native
Sedes-tool surface. Progressive uses compact catalog discovery and generic
invocation; Individual uses live help and named typed commands. The source
capability is scoped to the server-derived tenant/principal, backend, execution
environment, workspace, and thread. Health, catalog, discovery, creation, and
recovery processes receive no Sedes agent tool authority. Provider filesystem
and terminal reverse authority remain off.
The injected mode environment value is presentation only; each request reloads
current grants, and unavailable CLI admission never falls back to another mode
or surface.

The current Grok launch profile is explicitly unrestricted: Sedes passes
`--permission-mode bypassPermissions --sandbox off` and does not disable Grok's
native web-search, subagent, or ask-user tools. Grok therefore has the same
operating-system authority as the Sedes service account. This is an explicit
operator-selected full-access mode, not workspace confinement. Until the
normalized permission UI lands, any unexpected ACP permission callback is
accepted internally, preferring a one-shot allow option.

## Model and input projection

The backend catalog comes from Grok's initialize model state. Every create,
load, and resume validates the effective model/reasoning tuple against the live
catalog and installation `modelPolicy`. Grok exposes no reviewed native
provider dimension, so `providerIds` are invalid in its policy.

Sedes persists the complete desired model/effort tuple on each thread. New
drafts expose the same normalized model and Effort selectors used by the other
backends, and Saved Agents can capture or override both fields. The filtered
live catalog remains authoritative: a stored selection that disappears or is
later denied remains visible as unavailable and new provider work is blocked.

The reviewed Grok profile proves model/effort selection only on `session/new`.
It does not prove a post-creation model mutation. Consequently, a bound Grok
thread presents its provider-confirmed tuple read-only and directs the user to
create a new thread for another selection; Sedes never silently replaces or
rebinds the native conversation. Import/attach adopts the native effective
tuple only when the thread has no prior desired selection, then verifies the
same tuple on every later attach and before submit.

Submission consumes the common immutable delivery snapshot. Sedes projects
the original text and Task snapshots into the common plain-text model
representation; Task-only input is valid. For each ordered attachment, the
shared delivery service preserves ownership and integrity checks and stages the
exact bytes in Grok's execution environment. Ordinary files become standard
ACP `resource_link` blocks referencing their staged `agentPath`. Images are
read through the scoped canonical blob authority and sent as standard ACP
blocks of the exact form
`{ type: "image", mimeType, data }`, where `data` is standard base64. Files,
images, and Tasks may be submitted without additional composer text. Selected
skills, context excerpts, steering, and concurrent prompt injection remain
unsupported and are rejected rather than silently discarded.

Grok materializes its own model-visible session copy and usable path for an ACP
image. Sedes therefore does not append a second `resource_link`, expose its
staging path, or add duplicate image guidance. The provider-owned copy remains
available for explicit filesystem work while normalized history continues to
show the one application attachment card.

Grok history decoding reports exact native prompt correlation as the common
`deliveryOperationId`. The shared history layer restores the original text,
context, Tasks, and ordered attachment cards from the durable delivery snapshot;
it does not parse Grok echoes or retain a Grok-private copy of the input.

Native-image capability is exposed only after admission of a stable `1.x`
runtime at least `1.0.4`, registration of this reviewed Grok ACP image path,
availability of attachment staging, and selection of a model that does not
explicitly deny image input. Model `_meta.acceptsImages: false` or a declared
input-modality list without `image` wins. The captured top-level ACP
`promptCapabilities.image: false` is the reviewed Grok under-advertisement this
narrow profile correction addresses; it is not a general negotiation bypass.

Provider-output image capability is independent of that input capability. The
owned local Grok profile advertises
`providerOutputArtifacts.nativeImage: true` because it implements the reviewed
completed local `ImageGen` and `ImageEdit` paths through the common durable
artifact service. Both variants use Grok's same source-defined `MediaGenOutput`
and session image writer. Sedes accepts only those two local result variants,
the reviewed fields, and a numbered JPEG path inside the effective Grok home,
canonical workspace namespace, native session, and `images` directory. A
non-null remote `uploaded_url`, video variant, or unreviewed field remains
unsupported. Sedes reads without following the final path, verifies the
raster and 16 MiB bound, and publishes only a path-free normalized artifact
descriptor. The common renderer retrieves those bytes from Sedes's scoped
artifact route.

Grok may also include a relative Markdown image reference such as
`images/1.jpg` in assistant text. That reference is provider presentation, not
byte authority: Sedes removes the recognized reference and inserts the
normalized artifact image adjacent to the image tool item. More generally,
the common Markdown renderer never fetches or displays any Markdown image
destination; only a normalized artifact image item can display provider-output
pixels.

Sedes's provider-neutral durable Queue remains available during an active
turn: it retains the input under application authority and dispatches an
ordinary submission only after Grok is authoritatively settled. Grok owns no
separate provider-private queue.

## Unsupported and fail-closed behavior

The current profile does not advertise interactive permission UX, fork,
compact, bound-thread model switching, structured questions, provider features,
usage, automation, or managed terminals. Native
tool activity is rendered through Sedes's ordinary normalized tool UI;
provider-reported paths remain display metadata and grant no filesystem
authority. Grok's ACP permission choices are not mapped onto Sedes's normalized
interaction UI.

The reviewed ACP event journal has no durable compaction boundary or summary
contract. Grok therefore emits neither normalized compaction items nor
compaction summaries.

The reviewed Grok implementation contains private prompt-queue and mid-turn interjection
machinery, but its reviewed ACP initialize profile advertises no steering
capability and standard `session/prompt` defines a complete prompt turn, not an
exact-target interjection. Sedes therefore does not infer Steer from the fact
that a second correlated request might be accepted while another request is in
flight. Enabling Steer requires a reviewed provider contract for exact active
turn targeting, pre-boundary stale-target rejection, authenticated user-message
materialization, replay grouping, terminal settlement, and cancellation races.

Only the local owned-stdio topology is supported. SSH, external daemons,
containers, releases outside the admitted stable `1.x` line, and shared
multi-session processes are rejected. In particular, remote or SSH Grok output
paths have no implemented artifact reader or sidecar adapter and cannot be
treated as Sedes-local paths.

Native image input and provider-output artifacts remain separate capabilities.
The exact completed local `ImageGen` and `ImageEdit` JPEG paths described above
are implemented; other tool-generated image shapes, image-generation controls,
and a separate image download flow remain unsupported. As for every native-byte
attachment projection, raw base64 is never retained in the delivery snapshot,
normalized history, browser payloads, diagnostics, or logs. A validated
user-image echo supplies native correlation only; the shared history layer
restores the attachment card from the delivery snapshot.

## Verification surfaces

The contract is covered in layers:

- `tests/unit/grok-release-guard.test.ts` and
  `tests/unit/grok-runtime-config.test.ts` cover executable/profile admission
  and installation advisories;
- `tests/unit/grok-acp-connection.test.ts` and
  `tests/unit/acp-v1-generated-bindings.test.ts` cover framing and structural
  ACP boundaries;
- `tests/unit/grok-conversation-driver.test.ts`,
  `tests/unit/grok-normalized-history.test.ts`, and
  `tests/unit/grok-session-lifecycle.test.ts` cover actor-facing lifecycle,
  bounded history, correlation, capabilities, and recovery;
- `tests/unit/grok-tool-normalization.test.ts` and
  `tests/unit/grok-generated-image.test.ts` cover the closed semantic-tool and
  `ImageGen`/`ImageEdit` artifact profiles; and
- `tests/real-grok/` contains opt-in provider gates for lifecycle, image/file
  input, and generated-image output.

The real suites use native account state, consume provider capacity, and run
the unrestricted production launch profile. Their approval requirements and
commands belong in the [operator guide](../../operator/backends/grok.md#opt-in-live-verification).
Do not broaden a production capability from characterization evidence alone;
update the dialect/profile gate, capability document, normalized projection,
fail-closed tests, and this contract together.
