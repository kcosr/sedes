# Sidecar transport

The shared sidecar transport carries backend-private runtime messages and
granted Files, workspace tools, processes, and terminals over SSH or an outbound
connector. It does not interpret provider protocols. Local Pi sandbox and Claude
worker carriers share the framing but select no compression.

## Framing and negotiation

Runtime wire version 18 uses control major 3. Hello authenticates the serving
build and discovers supported operations in each direction. The connection
selects its compression mode once. A separately installed policy authorizes
work on persistent SSH and paired hosts. Local worker contexts keep their
fixed dispatch tables. OpenCode's private runtime capability **7** selects
the 2.3.0 SDK/schema profile. Native Pi capability **4** checks the session handle
and generation before a background archive can claim or retire that session.
The `HSC2` frame header occupies 16 bytes.

| Offset | Field |
| --- | --- |
| 0–3 | ASCII `HSC2` |
| 4 | Encoding: 0 identity, 1 zstd |
| 5–7 | Reserved zero bytes |
| 8–11 | Encoded body length, unsigned big endian |
| 12–15 | Decoded body length, unsigned big endian |

Both lengths are positive and bounded by the existing maximum frame size.
Identity lengths match; zstd frames must be smaller than their decoded body.
The body remains the typed JSON or binary stream-data record. Unknown encoding,
reserved bits, invalid lengths, malformed compression, and unexpected compression
close the carrier.

`control.hello` requires a `none` or `zstd` mode and an exact echoed result.
Both hello records are plain. The sidecar commits the mode before queuing its
reply; the caller commits it synchronously inside the protocol peer's response
handling. A transport commits only once. Application operations require hello.
Build identity and capabilities are checked separately and still fail closed.

A carrier read may contain hello and a following compressed record together.
The inbound queue charges each record's declared decoded length and defers
decompression until serial consumption. This lets hello commit before the next
record is checked. Compression before negotiation or after selecting `none`
is an error. A new carrier always starts unnegotiated.

The stable management-v1 protocol remains separate and plain. A service with
an incompatible runtime wire version follows the explicit upgrade-required
path; no HSC1 parser or opportunistic compatibility mode is retained.

## Live execution policy

A normal persistent attachment reads the current service incarnation, controller
epoch, installed policy stamp and readiness through `policy.read`. Main derives
the desired snapshot from the principal's saved settings. It binds staging and
apply to that incarnation and epoch. A fresh controller confirms the installed
revision and SHA-256 digest before issuing ordinary work, including when the
daemon already has the desired snapshot.

`policy.stage` transfers canonical UTF-8 policy data up to 512 KiB in blocks of
at most 6 KiB before base64 encoding. Main waits for the acknowledged offset
before sending the next block. `policy.apply` checks the expected prior stamp
and the new digest, installs the complete snapshot, and updates the management
revision pair. An equal revision and digest can confirm a new epoch or settle a
lost reply. Main reads the actual installation before retrying delivery.

New work requires host support, a matching saved and confirmed subject
generation, and the application's resource checks. Individual roots, targets,
backends and capabilities have separate generations. Main withdraws removed
grants at save and exposes additions after host confirmation. A running
attachment can update these grants while unrelated turns, terminals and file
watches stay on their original connection.

Reading the target picker uses saved settings and available readiness and
health observations. It performs no remote health probes and opens no SSH
connections. Selecting a target or starting work confirms that host's grants
on demand. Explicit remote selection allows ten seconds to confirm the grant and
reacquire the carrier. Once admitted, provider health uses the provider’s own
startup limit. When Codex is already attaching to its native runtime,
selection can wait for that attempt to finish. A workspace keeps its confirmed
root when a newly saved nested root also contains its path. A new open can
retry policy delivery when its path has no applicable confirmed root.
Cancelling that request releases its wait while shared delivery continues.
A save after an idle disconnect can also initiate delivery on the affected host. A known unsupported subject stays unavailable. After carrier
loss, unchanged grants from the last confirmed incarnation keep targets and
features selectable. A foreground driver call or
new turn on a held handle reacquires the carrier and confirms the target on its
current controller before entering the provider. Discovery of a different
incarnation discards the previous selection evidence. Exact settlement, such
as download cancellation and shell result acknowledgement, uses controller
authority even while policy synchronization or service draining is in progress.

For a hosted backend, readiness can report the retained provider's launch
digest, an explicitly empty registry entry, or no inventory observation. A
confirmed exit clears the old digest so Settings shows the edit will apply on
the next launch. Missing observations preserve evidence for the same service
incarnation. A replacement service has to establish its own evidence.

Main polls preparing subjects every two seconds and refreshes settled readiness
every 30 seconds. Failed delivery is retried after 1, 2, 4, 8, 16 and 30
seconds, then on a five-minute retry, a new save, explicit retry or reconnection.
A confirmed conflict between restored local state and a newer or divergent
installed policy fences ordinary work until the operator replaces that service
incarnation. Managed route descriptors travel through a scoped
`policy.acquire_route` call bound to a backend instance and feature generation.
Their endpoint and PATH stay outside hello and policy status. The daemon keeps
each listener while its backend and feature grants retain their generations.
CLI calls return a retryable unavailable error until a replacement controller
confirms those grants. Withdrawal retires the listener, and regranting access
creates a new endpoint.

Recovery can borrow a restricted view of the current connection for an exact
retained operation or attach to an existing service through management. An
offline recovery attachment never launches the daemon. Explicit stop or
disconnect suppresses automatic reconnection. A binary or runtime wire change
continues to use the management upgrade and impact checks.

## Codec and resource bounds

Eligible operation frames of at least 1 KiB use asynchronous native zstd level 1
with a maximum 1 MiB window. Every compressed record is an independent frame;
there is no shared dictionary or batching delay. Incompressible data remains
identity. Control and reserved settlement records are always identity, and
outbound WebSocket permessage-deflate remains disabled.

The encoder attempts to acquire one of the process-wide two finite codec slots
shared with HTTP gzip. If none is available, it sends identity. A carrier has
at most one encoder and one ordered decoder. Decoders wait for a slot, with a
process-wide maximum of 128 waiters and cancellation on carrier closure.

Before native decoding, a structural validator requires one complete ordinary
zstd frame with a checksum, no external dictionary, bounded window and blocks,
and exact input exhaustion. Native decoding verifies compressed contents and
checksum and caps output at the declared decoded length, which must match.
This avoids accepting truncated input or trailing frames through permissive
native decoder behavior. Sidecar Node.js 22.19 and server Node.js 24.18 meet
the native zstd API requirement.

Queues retain decoded-byte accounting. Stream sequence offsets, transfer sizes,
credit, and digests describe original bytes, independent of wire encoding.
Diagnostics for frame and queue bytes likewise describe decoded data.

## Delivery and closure

Outbound entries progress through queued, preparing, prepared, and writing
states. Preparation is separate from the active carrier write. Each queue charge
is released exactly once. Controls queued during encoding take the next write
before the prepared operation. Staging has its own bounded queue. At a
writable boundary, a staged block that has waited 500 ms can advance ahead of
bulk operation writes after one due control frame and one ready interactive
frame. Reserved settlement capacity remains available to foreground work.

Cancellation before a carrier write reports `not_sent` and discards any encoded
result. Once writing starts, the existing delivery-uncertainty rules apply.
Late codec completion cannot revive cancelled or closed work. Independent
compressed records allow a cancelled preparation to be discarded safely.

Clean byte-stream EOF drains already queued complete records before publishing
closure. Pending outbound preparation still settles as `not_sent` and releases
its queue charge even if an inbound decoder delays that final closure.
Explicit shutdown, malformed input, and consumer cancellation abort
decoding and close promptly. Resource cleanup remains owned by the carrier.

## Configuration and backend coverage

SSH and outbound configuration requires top-level `connectionCompression`,
defaulting to true for new environments, explicit legacy imports, and migrated
stored configurations. The local schema excludes it. The migration also updates
saved configuration receipts and their request fingerprints, and historical
configuration snapshots inside pairing receipts.

The field is excluded from environment runtime identity, outbound authorization
revision, and desired/applied runtime fingerprints. A compression-only save
does not retire an owner, revoke a carrier, or restart a provider. Every normal
and recovery attachment samples the latest principal-scoped value; an active
carrier keeps its negotiated mode.

Codex, Claude, OpenCode, native Pi and Antigravity use this transport for
remote runtime traffic. Pi SDK runs its model loop locally and uses the
transport for remote workspace operations. Grok runs locally. Existing
operating-system and capability restrictions remain
authoritative. Browser response compression is a separate installation policy;
provider-native connections do not use this codec.

See [execution environment settings](../operator/configuration.md#execution-environments)
and [persistent remote service upgrades](../operator/operations.md#persistent-remote-services)
for operator controls and upgrade behavior.
