# ACP TypeScript SDK 1.3.0 characterization

This directory records the reviewed, no-credential characterization of the
stable ACP V1 surface exported by `@agentclientprotocol/sdk@1.3.0`. It preserves
dependency provenance and the evidence behind the production binding's SDK
boundary; it is neither a vendored SDK nor a backend implementation. See the
[Grok production profile](../../grok-acp/1.0.4/README.md) for the provider
binding built on this contract.

## Decision

Pin the runtime dependency exactly as:

```json
"@agentclientprotocol/sdk": "1.3.0"
```

The package is Apache-2.0 and declares the repository
`agentclientprotocol/typescript-sdk`. The npm tarball has integrity
`sha512-i3h/efaeuMUFAO1HSfo97QZQnnvMd7wWBYtBsdL6UMZg3a78sk3Ffya5Xu7C7tYsXomXoDXJBAzQF2PcFKAhIQ==`,
npm shasum `eafd8f1e0d3eb0ac01b964a173a49f866fda6d73`, and SHA-256
`0baf5b6be1842d00bf989c0211b7e44a15f88769d2fffd5036397ba249becc9f`.
Sedes already uses compatible Zod 4.4.3.

The license is compatible and permissive for this use; retain the package's
Apache-2.0 license text in any distribution that contains it. The tarball has
no `NOTICE` file. There are no runtime or optional transitive dependencies. Its
only peer is Zod; the already-pinned Zod 4.4.3 is MIT-licensed (license SHA-256
`3f1189b28e3866e0d979968d466b78f813f76827cfdca1fbb124cc0a5c8841f8`).

Sedes uses the stable V1 types and method/protocol constants. It wraps the
exported stable JSON Schema with closed, non-mutating runtime validators and
Sedes bounds. The official no-credential fixture may expose the SDK's
object-level stable `Stream` shape at its official-fixture edge, but the assured
transport and the Sedes peer remain authoritative.

The schema declares JSON Schema draft 2020-12, not draft-07. Generate only
reviewed named validators with the repository's `Ajv2020` entry point in strict,
non-coercing, non-defaulting, non-removing mode. Never silently feed it through
the default draft-07 entry point. The package has no runtime or optional
dependencies and one peer range, `zod` `^3.25.0 || ^4.0.0`; Sedes's exact Zod
4.4.3 satisfies it. The binding uses public package exports only—no `dist/*`
deep imports.

Sedes must own JSON-RPC correlation. The SDK connection engine is rejected
for production because its low-level `Connection` and `WireStream` controls are
not exported by the package root and the public engine cannot meet the required
contracts:

- 64 outgoing requests and 64 incoming handlers were admitted without a
  capacity error; the active-session queue also accepted 64 unconsumed updates;
- abort emits `$/cancel_request` but deliberately leaves the request pending;
  source review of the public `SendRequestOptions` declaration proves that it
  exposes no deadline or timeout option;
- a structurally invalid result for the built-in `initialize` request resolves
  successfully;
- a fractional request ID is accepted and duplicate/late responses are merely
  written to raw `console.error` diagnostics; no bounded tombstone is exposed;
- registering `fs/read_text_file` permits the handler to run before initialize
  or capability negotiation;
- parser/notification failures use `console.error` with the raw wire message;
  and
- the built-in extension dispatcher, cancellation, and session router cannot be
  separated from those rejected correlation and diagnostics paths through
  supported package exports.

The engine does preserve a tagged write error, closes on write failure, rejects
pending requests on close, routes sessions correctly, supports parsed custom
extensions, and rejects batches on the stable V1 connection. Those positive
properties make it a useful official compatibility fixture, but they do not
offset the missing bounds, validation, authority, deadline, and redaction
controls.

The adapter decision is final: the assured frame transport feeds a small
Sedes-owned ACP JSON-RPC peer. Only the official no-credential compatibility
fixture adapts that peer edge to the SDK's public object-level `Stream`. Do not
extract a shared correlated-RPC core with Codex: the two protocols share frame
transport mechanics only. ACP correlation, IDs, duplicates, deadlines,
tombstones, cancellation, direction, and reverse work stay in the ACP binding.

Admission limits run before allocating pending state or starting
notification/reverse work. The peer accepts only the closed safe ID subset,
rejects duplicates, retains bounded late-response tombstones, and quarantines
or closes a generation at a hard deadline. Delivery failures retain the frame
transport phase (`not_sent` or `sent_outcome_unknown`), and generation cleanup
is coupled to the peer close. `$/cancel_request` remains request-level
cooperative cancellation;
`session/cancel` remains a separate ACP session mutation. Neither substitutes
for a deadline or changes delivery evidence.

Reverse handlers are registered through closed descriptors with a negotiated
capability predicate. Known but unadvertised filesystem, terminal, permission,
or elicitation requests are denied before resolving any application or
execution-environment authority. Custom extensions use the same descriptor
registry and closed validators. The synthetic `probe/*` profile proves custom
registration without importing Grok and remains the permanent second-profile
conformance fixture.

`ndJsonStream`, `ActiveSession`, the SDK extension dispatcher, experimental V2,
and all experimental HTTP/WebSocket/server adapters are rejected for production
use. Sedes implements descriptor-driven extensions and bounded per-session
queues. It wraps `RequestError` only at the provider-safe error
boundary; raw SDK errors and `data` never reach application diagnostics.

## Reproduction

From the repository root, obtain and unpack the exact package into a disposable
directory, make the repository's installed `zod` visible as its peer dependency,
and run:

```sh
acp_probe_dir="$(mktemp -d)"
npm pack @agentclientprotocol/sdk@1.3.0 --pack-destination "$acp_probe_dir"
tar -xzf "$acp_probe_dir/agentclientprotocol-sdk-1.3.0.tgz" -C "$acp_probe_dir"
mkdir -p "$acp_probe_dir/package/node_modules"
ln -s "$PWD/node_modules/zod" "$acp_probe_dir/package/node_modules/zod"
sha256sum "$acp_probe_dir/agentclientprotocol-sdk-1.3.0.tgz"
node scripts/provider-protocol/probe-acp-sdk-1.3.0.mjs \
  "$acp_probe_dir/package" \
  "$acp_probe_dir/agentclientprotocol-sdk-1.3.0.tgz"
```

The probe verifies the tarball SHA-256 and the resolved Zod version, license,
and license hash before it runs. Its output is the complete canonical
`feasibility.json`, including license audit and closed subsystem decisions. The
focused unit test reruns the same canonical builder without network against
`tests/fixtures/acp-sdk-1.3.0-probe-facts.json` and requires exact object
equality. The fixture is the sanitized raw output of the live characterization,
not a second decision authority.

The probe emits only booleans, counts, public names, and hashes; its secret
diagnostic marker is never written to either evidence file. The live probe
intentionally reads the shipped connection source only to establish why a
private, unsupported import would be required; production code does not import
it.

## Licensing and provenance

This directory holds Sedes-authored characterization notes and the canonical
`feasibility.json` probe facts: booleans, counts, public names, and hashes. It
derives from `@agentclientprotocol/sdk` 1.3.0, published under Apache-2.0 from
`https://github.com/agentclientprotocol/typescript-sdk`. That license text is
retained verbatim in the repository's
[third-party notices](../../../THIRD-PARTY-NOTICES.md), which discharges the
retention obligation recorded above. No upstream source file, tarball, or
executable is committed here; the SDK is consumed only as a pinned npm
dependency.
