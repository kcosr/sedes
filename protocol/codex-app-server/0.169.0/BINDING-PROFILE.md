# Codex app-server 0.169.0 binding profile

This directory records the sole generated production profile, adopted routes,
artifact provenance, and native qualification evidence.

## Release authority

The source is release `rust-v0.169.0`, tag object
`a41fe5b443652cbdbee57717fbb9fd78d8d8b32a`, peeled commit
`d32063f96c2dff1dc96af839b3952abb6acfeda4`. Repository main is not release
authority. `release.json` pins the npm package, native package integrity, tarball
hashes and executable hashes for Linux x64 and macOS arm64/x64.

Stable and experimental TypeScript and JSON Schema exports run twice against the
pinned executable, with fresh isolated native homes. Raw exports must be
byte-identical. `official/` preserves those exports; `generated/` and
`generated-experimental/` contain canonical bundles. Protocol manifests record
the inventories and hashes. The generator copies each adopted TypeScript
transitive closure into the server-private binding and rewrites relative imports
to explicit `.js` NodeNext imports. Standalone Ajv validators are generated from
the selected official definitions and verified through the built ESM binding.

The old generated profile is removed. Runtime admission requires stable Codex
>=0.169.0, independently of artifact provenance. Earlier runtimes can ignore
`model/list.modelProvider` and return an unrelated default-provider catalog.
Newer stable runtimes keep this single parser and receive an installation
advisory until qualified. Operator-owned executables are not digest-pinned.

## Adopted directions

`adoption-manifest.json` records 78 directions: 27 client requests, one client
notification, 10 server requests, and 40 server notifications. RPC recognizes all
88 official stable notification methods. Valid unconsumed notifications are
bounded and discarded without payload retention. A malformed notification can
invalidate only its exactly identified thread when its reviewed routing contract
still yields one bounded identity; unknown or ambiguous routes remain fatal.

The selected experimental definitions cover reviewed thread discovery/read,
start/resume/fork/unarchive, settings updates, command approvals, MCP elicitation,
and thread-started/settings/read-state notifications. Other adopted directions
use the stable definitions. No route tries a second profile after rejection.
`thread/turns/list` and `thread/items/list` provide stable paginated history.

Native thread identity, cursors, providers, settings and metadata remain private
to Codex. The browser consumes normalized contracts. Closed structural schemas
compose with explicit semantic field allowlists, identity checks, collection and
string bounds, lifecycle checks, and scoped ownership. Unknown fields do not gain
meaning through permissive parsing.

## Metadata and capability dispositions

The 0.169.0 refinements explicitly admit these reviewed additions:

- Assistant moderation/display metadata is validated and kept private; it does
  not execute native Chat presentation instructions or expose new browser actions.
- Nullable item-completion token counts are bounded telemetry, not aggregate
  usage or completion authority.
- Settings executor-environment metadata and thread attachment metadata are
  bounded native observations. They grant no additional executor or thread
  attachment capability.
- URL/file audio references in user input and function-call output remain
  metadata. Audio submission, playback and retrieval are unsupported.
- Provider-specific model selection uses each thread's native provider for
  reasoning, modality and Speed validation, with generation-scoped catalog
  identity. Normalized model provider identity remains the Sedes connection.

Existing item timestamps preserve observed lifecycle timing; inconsistent
wall-clock completion times are omitted rather than assigned a duration.
Generated-image IDs and paths remain native metadata. Only available in-band PNG
bytes enter output artifacts; file-backed output remains explicitly unavailable.
Native read-state and section metadata do not change Sedes attention or groups.
Required-human command approval remains unsupported and fails closed. Unadopted
provider administration, queue, sampling and output-deferral APIs add no capability.

Command and write-stdin approvals retain exact current-turn correlation and
supported decision semantics. Unsupported MCP elicitation variants fail closed;
supported forms project normalized fields through the interaction broker.
Neither telemetry nor advisory notifications constitute mutation acceptance,
delivery, settings confirmation or terminal evidence.

Pi SDK, Pi, Claude, Grok and OpenCode keep their existing protocols, capabilities,
model policy and native-state ownership. No normalized browser or provider-feature
contract changes in this cutover.

## Qualification

[runtime-compatibility/README.md](runtime-compatibility/README.md) describes the
current native checks and their limits. The original empty-thread and raw MCP
isolation probes remain separately reproducible in `scripts/codex-probes/`;
their observations alone do not authorize production tool capabilities. Production
agent-tool authorization remains the scoped native-thread lease and broker contract.

## Licensing

Official exports derive from `@openai/codex` 0.169.0 at
`https://github.com/openai/codex`, released under Apache-2.0. Generated upstream
headers are preserved. The npm package is a development dependency, not a
packaged Sedes runtime dependency. No native binary or tarball is committed.
