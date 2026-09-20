# ACP V1 binding boundary

This directory owns Sedes's reusable, backend-neutral ACP V1 wire binding.
It pins the public `@agentclientprotocol/sdk` 1.3.0 schema, applies a reviewed
closed-object overlay, generates one projecting decoder per adopted definition,
and runs a Sedes-owned JSON-RPC peer over an assured framed transport.
Provider-specific method meanings and SDK connection engines do not belong here.

## Semantic disposition matrix

| Protocol value                                                                          | Binding evidence                                                                                                                                                                                                         | Backend authority or non-evidence                                                                                                                                                   |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON-RPC envelopes, IDs, method descriptors, results                                    | Strict kind/correlation fields, safe IDs, projection of non-semantic additive envelope members, exact pending-method correlation, immutable bounded snapshots, deadlines, and delivery classification                    | A response is not proof of a backend effect beyond the descriptor's operation/delivery evidence.                                                                                    |
| Protocol/capability negotiation                                                         | Exact V1, immutable capability snapshots, truthful fixed reverse-handler advertisement, advertised auth methods, selected position encoding, boolean-config support, additional-directory reporting, and finite profiles | Backend profiles decide which supported extensions and reverse authorities are supplied; omitted capabilities remain denied.                                                        |
| Session, terminal, tool, message, permission, mode, config, plan, MCP ACP, and auth IDs | Non-empty bounded strings; catalog/page uniqueness and exact request/response references where the protocol defines them                                                                                                 | Existence, ownership, current turn, current session state, and cross-page/cross-session uniqueness are backend authority.                                                           |
| Paths                                                                                   | Portable syntactic absolute-path form, no NUL, and byte bounds                                                                                                                                                           | The backend must canonicalize for the execution environment and enforce platform syntax, roots, existence, symlinks, executability, and session/workspace ownership before effects. |
| MCP servers                                                                             | Absolute stdio executable, unique stdio env names, unique ACP server IDs, and syntactically valid HTTP(S) URLs                                                                                                           | Destination/SSRF policy, headers, credentials, process authority, and connection ownership are backend/operator authority. Duplicate HTTP headers remain legal.                     |
| Modes, config options, permission options, auth prompts, commands, and list pages       | Unique bounded lookup keys and exact current/selected membership; ordered arrays are preserved                                                                                                                           | UI labels are display data. Lifecycle transitions and uniqueness outside the received catalog/page remain backend-owned.                                                            |
| Terminal/file allocation hints                                                          | Terminal output retention is capped at 256 KiB and text reads at 10,000 lines before reverse authority                                                                                                                   | Backends may impose smaller limits and must still scope each effect to an authorized environment/session/resource.                                                                  |
| Integer and numeric annotations                                                         | Required uint32/uint64/int64 fields use the JSON safe subset and documented bounds; resource sizes and costs are nonnegative; usage satisfies `used <= size`                                                             | Usage, cost, resource size, priority, and exit values are telemetry/display data, not completion, billing, or process-truth evidence. No sum or monotonicity is inferred.           |
| Timestamps                                                                              | Consumed session timestamps use calendar-valid RFC 3339 syntax                                                                                                                                                           | Timestamps do not establish ordering, freshness, or completion. Annotation timestamps remain bounded opaque display hints.                                                          |
| URIs and cursors                                                                        | Bounded JSON strings are preserved exactly; MCP HTTP/SSE URLs alone receive URL syntax checks                                                                                                                            | Image/resource/plan/auth links are opaque and never dereferenced for authority. Cursors are opaque and do not prove page ordering or continuity.                                    |
| `_meta`, terminal-auth `env`, raw tool input/output                                     | Preserved as bounded JSON according to the official open-map contract                                                                                                                                                    | They are explicitly non-evidentiary. The binding never assigns semantics based on their keys or values.                                                                             |
| Session updates                                                                         | Same-session wire order is preserved with bounded keyed scheduling                                                                                                                                                       | Tool/message/plan lifecycle, usage/cost monotonicity, terminal truth, and cross-update state machines belong to the backend/application consumer.                                   |

Initialization is strict by default: agent-to-client notifications received before
the initialize response is committed are denied without reaching authority. A
release profile may opt exact registered notification descriptors into a bounded
pre-initialize buffer when provider evidence proves that ordering. The buffer has
independent count and aggregate wire-byte limits, accepts only structurally valid
notifications whose descriptor profile and handler are active, and never admits
reverse requests. After a valid initialize response fixes immutable negotiated
capabilities, buffered notifications drain in arrival order through the ordinary
capability, authority, ordering, and deadline path. Initialize failure, connection
closure, malformed active traffic, and buffer overflow discard the buffer and grant
no notification authority. Notifications without an active dependency do not enter
this buffer. Diagnostics expose only buffered count and bytes, never buffered
payloads.

Agent-to-client notifications are actionable only when the binding has the exact
notification descriptor, its required profile is active, and its handler is
registered. Notifications without that active dependency—including unknown,
unregistered, inactive-profile, and wrong-direction methods—are ignored before,
during, and after initialization after only generic envelope and frame bounds. The
binding does not run a route schema, authorize, dispatch, log, persist, or retain
their payload. Ignored count and byte counters remain payload-free diagnostics
rather than failure budgets, and valid ignored-notification volume does not fence
a connection. Both counters saturate at the maximum safe integer without retaining
notification payloads. Active notifications retain strict schema, capability,
authority, ordering, and recovery behavior.
Protocol cancellation remains handled; unknown requests, responses, and malformed
envelopes are not covered by this notification-only disposition.

Active notification handler counts are bounded flow-control watermarks. The
frame consumer awaits admission when either the global or same-ordering-key
watermark is full, which propagates pressure into the bounded carrier queue
instead of closing a healthy connection for an ordinary finite burst. Handler
completion releases capacity, and connection close or shutdown wakes blocked
admission. Handler failure and deadline expiry remain protocol-fencing
conditions.

That admission preserves the single wire order and the exact notification tails
used by response-settlement cutovers. A later inbound response, cancellation,
or reverse request therefore remains ordered behind an asynchronous notification
that is awaiting capacity; Sedes does not create an unbounded lookahead,
disk spool, or reordered "control lane." Registered high-rate routes instead use
the shared synchronous inline handler to authorize and reduce each notification
without allocating semantic queue work, so their ordinary bursts leave response
demultiplexing live. Locally initiated outbound cancellation also remains
serviceable while asynchronous inbound work is backpressured.

The generated closure manifest classifies every reachable object pointer. A
generation check fails on unclassified schema drift, and differential fixtures
prove that closed shapes remain official-schema-valid while declared `_meta`
and terminal-auth environment maps stay open and bounded.

Each known message is first captured as bounded prototype-free JSON, recursively
projected onto the fields declared by its single selected schema, validated by the
closed schema, and frozen again before semantic predicates, capability checks,
ordering, authorization, handlers, or backend callers can observe it. Additive
fields are therefore upgrade-tolerant but non-evidentiary. Reviewed `_meta` maps
and terminal-auth `env` records retain their complete bounded contents. Unknown
union discriminators and invalid known fields remain invalid. JSON-RPC envelope
projection never relaxes kind ambiguity, response correlation, IDs, error cores,
or the protocol version.

The decoder result is itself recaptured as bounded prototype-free JSON before the
semantic validator runs. This applies equally to generated and extension decoders:
a decoder cannot introduce accessors, `toJSON`, functions, class instances,
mutable children, oversized replacement data, or ambient object prototypes at a
consumer boundary.

## Shared carrier and image data

ACP uses the shared 128 MiB provider frame capacity also used by owned NDJSON,
Codex framing, and WebSocket framing. The effective carrier capacity is exposed
to the binding, and a binding cannot configure a larger frame. ACP image
`data` is a standard base64 string whose carrier-level string bound is the
shared frame rather than the former smaller generic JSON-string ceiling;
standard open-map JSON array and node counts use the same aggregate frame bound
so byte-array representations that fit the carrier are not rejected by a
smaller generic item quota. Depth, object-property count, and route-specific
semantic fields retain their own bounds.

Outbound requests normally treat cancellation cooperatively: the binding sends
the protocol cancellation and retains correlation until a response, deadline,
or connection close settles it. A caller may explicitly select
`abandonOnCancellation: true` for a request whose result is safely
request-local. A crossed write first settles one bounded protocol cancellation;
only then does the binding retire that exact request, release an untransferred
notification cutover, and reject with delivery-classified
`acp_binding_request_cancelled`. A proven-unsent request retires immediately.
A bounded disposition tombstone ignores only late responses to abandoned
requests. Unknown response IDs and duplicate responses to ordinarily settled
requests remain fatal.
For a request with a streamed notification side channel, the adapter must also
retain one bounded, payload-free draining disposition until the source-defined
end marker and refuse a successor stream acquisition meanwhile. If it cannot
do that, it must not opt the request into abandonment. When the reviewed source
can legitimately settle a zero-item stream without emitting that marker, the
adapter may register a synchronous, one-shot abandoned-settlement observer. The
binding invokes it without decoding, retaining, or exposing the late response
payload; it is an exact end signal, not a second response path.

Standard prompt content blocks preserve wire order. Raw image base64 remains
binding-private and must not enter diagnostics or normalized browser state. A
provider profile may register one exact source-reviewed outbound capability
correction for an under-advertised standard request descriptor. Such a
registration does not mutate the peer capability snapshot or authorize any
other descriptor or content kind.

An unavailable reverse request receives the static JSON-RPC method-not-found
response without authorization or dispatch; its mere presence is not a
connection-fatal unknown-request condition. Unknown responses and malformed
envelopes remain fatal. Failure or uncertain delivery of the terminal error may
still fence the connection.

Reverse-request concurrency is a current-work watermark. An excess request
receives a static JSON-RPC overload response without authorization or dispatch;
ordinary transient concurrency does not close the connection. Active IDs and a
bounded rolling window of recently answered or rejected IDs remain fail-closed
against duplicates, while older IDs age out instead of turning normal sequential
traffic into a connection-lifetime quota. No reverse-request payload is retained
for replay protection.

`semantic-dispositions.json` is the machine-readable companion to that closure
manifest. It inventories every reachable ignored `format` pointer and
mechanically selected path, URI/link/URL, timestamp, cursor, identifier,
lookup-name, and ordered-array pointer. Its cross-field rows name the exact
schema members involved in negotiation, membership, correlation, numeric,
ordering, backend-authority, and non-evidentiary rules. Generation fails when
the pinned adopted schema and any reviewed pointer set diverge.
