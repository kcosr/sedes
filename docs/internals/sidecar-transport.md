# Sidecar transport

The shared sidecar transport carries backend-private runtime messages and
granted Files, workspace tools, processes, and terminals over SSH or an outbound
connector. It does not interpret provider protocols. Local Pi sandbox and Claude
worker carriers share the framing but select no compression.

## Framing and negotiation

Runtime wire version 15 uses one `HSC2` parser with a 16-byte header:

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
before the prepared operation; operation order is preserved.

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

Codex, Claude, and OpenCode remote runtime traffic benefits from this transport.
Pi remains local while its remote workspace operations use it. Grok remains
local-only. Existing operating-system and capability restrictions remain
authoritative. Browser response compression is a separate installation policy;
provider-native connections do not use this codec.

See [execution environment settings](../operator/configuration.md#execution-environments)
and [persistent remote service upgrades](../operator/operations.md#persistent-remote-services)
for operator controls and upgrade behavior.
