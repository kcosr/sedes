# Codex app-server 0.153.0 binding profile

This directory records the pinned artifact, generated contracts, adopted
routes, and release evidence used by the production Codex binding.

## Release and generation authority

- Product surface: `codex app-server`, not `@openai/codex-sdk`.
- Release: `rust-v0.153.0`, tag object
  `6bc50f104dcc0192e696cdeae721dfc19b507391`, peeled commit
  `41e22fee981a63b3698df7ed36bad393cda24715`.
- NPM/native package and executable provenance is closed in `release.json`.
- Repository HEAD was not used as release authority.
- Stable and `--experimental` TypeScript and JSON Schema commands run twice
  against the pinned executable with a fresh empty temporary `CODEX_HOME` for
  each pass. The repeated raw outputs must be byte-identical.
- `official/stable` and `official/experimental` preserve the complete command
  output. `generated` and `generated-experimental` preserve the canonicalized
  bundles used for audit and drift checks. Their inventories and hashes are in
  the corresponding protocol manifests.

Production selects exactly one generated parser profile, `0.153.0`; no older
generated profile remains available as a fallback. Executable admission is a
separate contract: stable runtimes at or above `0.153.0` are admitted, build
metadata does not change precedence, and releases newer than the tested-through
threshold retain this same parser and receive an installation advisory.
Prereleases, malformed versions, releases below the floor, and reviewed
incompatible releases fail closed.

## Production route authority

`adoption-manifest.json` is the reviewed production binding inventory. It
records 65 directions:

- 23 adopted and invoked client requests;
- one emitted `initialized` client notification;
- 10 admitted server requests, including three recognized methods that
  intentionally fail closed; and
- 31 adopted server notifications.

The adopted notification count includes four production consumers that were
missing from the original feasibility inventory:

- `account/updated` — lifecycle information intentionally ignored;
- `mcpServer/startupStatus/updated` — startup progress intentionally ignored;
- `skills/changed` — catalog-cache invalidation; and
- `thread/started` — bounded create correlation.

RPC admission separately recognizes all 83 official stable server-notification
methods for this exact release. A non-adopted official notification is
structurally validated and safely ignored; an unknown or wrong-direction method
fails closed. An adopted notification uses its one selected route validator and
then its named Sedes semantic refinement before mutation.

The exact selected parameter validator runs once over a bounded immutable
snapshot. When a known notification fails that validator but its reviewed
0.153.0 route still yields one nonempty native thread ID of at most 512 UTF-16
code units, RPC emits a closed, payload-free failure marker and only that thread
requires an authoritative resnapshot. All 63 routable methods and their
stable/experimental profiles are checked against the pinned schemas. Missing or
invalid route evidence, snapshot failure, malformed envelopes, and unknown
methods remain connection-fatal; no raw fallback parser is used.

Method stability and artifact profile are distinct. The sole experimental
client method is `thread/settings/update`, while enabling `experimentalApi`
changes the selected wire definitions for nine routes:

- client requests `thread/list`, `thread/read`, `thread/resume`,
  `thread/start`, `thread/fork`, and `thread/settings/update`;
- server request `item/commandExecution/requestApproval`; and
- notifications `thread/settings/updated` and `thread/started`.

Those directions select the experimental 0.153.0 artifact directly, with no
stable/experimental fallback. Every other adopted direction selects the stable
artifact.

`thread/turns/list` and `thread/items/list` are stable, invoked routes owned by
the private paginated-history adapter. Legacy history never calls either route
and retains its full-resume interpretation.

The experimental command-approval request has a required `kind`
discriminator. Sedes handles both `kind: "command"` and `kind: "writeStdin"`.
A `writeStdin` approval must include its distinct approval ID, visible command
context, and exactly the ordered `accept` and `cancel` decisions; policy and
network amendments fail closed. Correlation remains bound to the current turn
and original terminal item. The newly generated `openaiForm` MCP elicitation
variant is structurally recognized but intentionally rejected at the semantic
gate because Sedes does not advertise or implement that extension. These
provider-private dispositions do not change the shared interaction contract or
the Pi, Claude, and Grok backends.

## Generated source and runtime validators

The generator copies the complete transitive TypeScript closure for every
adopted params/result/notification definition under
`src/server/provider-protocol/bindings/codex-app-server/generated/0.153.0/`.
Generated relative imports are rewritten to explicit `.js` NodeNext imports,
and generation fails if an extensionless relative import or unreviewed CommonJS
runtime helper remains.

Standalone Ajv validators are compiled deterministically from the selected
stable-legacy, stable-v2, experimental-legacy, or experimental-v2 definition.
They run with no coercion, defaults, property removal, format mutation, or
runtime schema loading. The generated route registry binds each reviewed method
to exactly one params/result validator and official TypeScript type.

The four official JSON Schema roots (stable/experimental × legacy/v2) omit the
otherwise implied `type: "object"` on exactly
`/definitions/ServerNotification`, whose outer `properties` and `oneOf`
branches describe an object envelope. Generation asserts that this is the only
such node in each root, adds that one object-type annotation before Ajv
compilation, and fails if the pointer set or target shape changes. It does not
recursively close or otherwise rewrite official provider schemas; named Sedes
refinements own the reviewed consumed-field closure described below.

The handwritten `CodexAppServerBinding` is the production server-private
facade. It exposes generated mapped types and direction-specific codecs while
keeping backend RPC, lifecycle, release, correlation, recovery, and projection
semantics private to Codex. No feasibility-only facade remains in production.

After a normal build,
`node scripts/provider-protocol/check-codex-generated-runtime.mjs` imports the
emitted production facade and exercises a stable request, the sole experimental
method, the client notification, a server request and result, an adopted
notification, a non-adopted official notification, and bounded failure output.

## Sedes refinements and single-parser rule

Official schemas are the sole structural authority, but many intentionally
permit additive fields and JSON Schema integers do not prove JavaScript safe
integers. Sedes therefore retains named release-specific refinements for:

- exact consumed-field closure and intentional open record/map fields;
- native ID, text, safe-integer, collection, history, and catalog bounds;
- supported outbound subsets and interaction decisions;
- route ownership, create correlation, completion semantics, and projection;
- exact empty-result postconditions; and
- bounded, provider-data-free errors.

Intentional historical projection boundaries may discard non-evidentiary
additive metadata, but they never pass it through as normalized evidence.
Production never tries an old parser, stable profile, or handwritten structural
schema after a generated validator fails. RPC retains only its JSON-RPC
envelope, ID/correlation, replay, deadline, tombstone, delivery, shutdown, and
recovery authority.

## Licensing and provenance

This directory holds Sedes-authored binding decisions, manifests, release and
runtime-compatibility evidence, and the `official/` command output. The
`official/stable` and `official/experimental` trees are verbatim upstream
output of the pinned `codex app-server` export commands; their TypeScript files
carry upstream `GENERATED CODE! DO NOT MODIFY BY HAND!` ts-rs headers. They
derive from `@openai/codex` 0.153.0 (`https://github.com/openai/codex`, release
`rust-v0.153.0`), which declares Apache-2.0 in its package metadata, and are
redistributed here under that Apache-2.0 license. `@openai/codex` is a
development dependency, not a runtime dependency, so it is not listed in the
repository's [third-party notices](../../../THIRD-PARTY-NOTICES.md). Only
SHA-256 digests of the npm tarballs and executables are recorded; no upstream
executable or tarball is committed.
