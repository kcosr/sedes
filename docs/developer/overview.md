# Developer overview

Sedes is a TypeScript application that puts one normalized application layer
in front of Pi, Codex, Claude, and Grok conversations. The browser works with
Sedes identities and protocol types. Provider-native history, identifiers,
events, transports, and process topology remain private to the corresponding
server backend.

This guide answers three questions for a new contributor:

1. Where does a change belong?
2. Which contracts must it preserve?
3. What is the smallest truthful verification for it?

For commands and environment setup, see
[Development and testing](development.md). For the complete authority and
projection model, read [Architecture](../internals/architecture.md).

## Repository map

| Path                                                                   | Responsibility                                                                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/protocol/`                                                 | Versioned, provider-neutral browser/server schemas and DTOs. This is the wire-contract boundary.                                      |
| `src/client/`                                                          | React UI, normalized stores, API/SSE clients, browser-local presentation preferences, and platform adapters.                          |
| `src/server/application/`                                              | Application queries and use cases that compose persisted state for presentation.                                                      |
| `src/server/domain/`                                                   | Application-owned behavior such as tasks, inventory, automations, prompts, bookmarks, and attention.                                  |
| `src/server/conversations/`                                            | Thread lifecycle, actor serialization, normalized projection, delivery, history, queueing, and interactions.                          |
| `src/server/events/`                                                   | Application/thread SSE, replay, snapshot publication, and runtime coordination.                                                       |
| `src/server/backends/`                                                 | Normalized backend contracts plus provider-private Pi, Codex, Claude, and Grok modules.                                               |
| `src/server/config/`                                                   | Strict installation configuration parsing, schema, fingerprints, and backend/target preparation.                                      |
| `src/server/identity/`, `src/server/security/`                         | Server-derived request scope, HTTP defenses, installation secrets, and process/file locking.                                          |
| `src/server/agent-tools/`                                              | Canonical agent-tool catalog, scoped invocation authority, HTTP/sidecar adapters, and generated schemas.                              |
| `src/server/execution/`                                                | Local and SSH path, process, channel, workspace, and operations authority.                                                            |
| `src/server/db/`                                                       | SQLite connection, migration plan, backup boundary, and scoped repositories.                                                          |
| `src/server/http/`, `normalized-app.ts`                                | HTTP admission, validation, security, route presentation, and normalized API handlers.                                                |
| `src/server/production-application.ts`                                 | Production composition root. Inspect this when adding a service or changing ownership/lifecycle.                                      |
| `src/server/sidecar/`                                                  | Built, installed, and invoked managed-SSH operations sidecar.                                                                         |
| `src/server/managed-workers/`                                          | Digest-verified local launch substrate for closed installation-owned provider workers.                                            |
| `src/server/workspace-*`, `composer-attachments/`, `output-artifacts/` | Cross-cutting file/context/tool/attachment/artifact engines and their local/sidecar providers.                                        |
| `src/server/provider-features/` and `src/client/provider-features/`    | Closed, versioned provider-specific feature envelopes and renderers intentionally exposed through Sedes.                              |
| `src/internal/`                                                        | Internal generated or bundled protocol material that is not a browser contract.                                                       |
| `src/cli/`                                                             | Shipped command-line entry points, including automation and provider helpers.                                                         |
| `config/`                                                              | Strict checked-in operator configuration examples used by documentation and tests.                                                    |
| `skills/`                                                              | Checked-in Sedes skill instructions and generated-contract consumers shipped with the source tree.                                    |
| `packages/`                                                            | Small native-client package boundaries, including Electron connection-runtime, Local-server-runtime, and workspace-download packages. |
| `tests/unit/`                                                          | Focused units, schema checks, migration invariants, and component behavior.                                                           |
| `tests/integration/`                                                   | Multi-service composition, persistence, lifecycle, and deterministic provider-boundary coverage.                                      |
| `tests/e2e/`                                                           | Browser workflows, each spec scheduled as an isolated server job.                                                                     |
| `tests/real-*`                                                         | Explicitly authorized, capacity-consuming provider gates; never routine verification.                                                 |
| `scripts/`                                                             | Build, generation, validation, probes, package verification, and E2E coordination.                                                    |
| `protocol/`                                                            | Version-pinned protocol evidence and generated-adoption baselines. It is code-adjacent evidence, not user documentation.              |
| `android/`, `electron/`                                                | Native packaging projects. Generated assets and package output stay untracked.                                                        |
| `docs/user/`, `docs/operator/`, `docs/developer/`, `docs/internals/`   | User workflows, installation operations, contributor workflow, and normative system/subsystem contracts.                              |

## Request and event flow

The common conversation path is:

```text
React view
  -> normalized client store / API client
  -> validated HTTP mutation or SSE subscription
  -> scoped application service or thread mutation gateway
  -> serialized ConversationActor for that Sedes thread
  -> normalized ConversationBackendDriver contract
  -> provider-private Pi, Codex, Claude, or Grok driver
  -> normalized turns, items, settings, interactions, and capabilities
  -> in-memory projection + application overlay
  -> snapshot/replay/delta over thread SSE
  -> revision-checked client store
  -> React view
```

Application inventory has a separate application SSE stream. A small HTTP
session handshake carries protocol compatibility, CSRF, and installation
capability metadata without carrying inventory. A cold application stream
captures a fresh authoritative snapshot after subscribing, then delivers only
changes concurrent with or newer than that snapshot. A retained opaque cursor
receives only its contiguous suffix when possible.
Managed terminal traffic uses a guarded WebSocket path. Ordinary mutations use
HTTP receipts; the authoritative visible state arrives through normalized
snapshots and events. The exact transport is less important than the ownership
rule: a browser request never supplies tenant or principal authority, and
provider identifiers never become browser mutation authority.

The conversation actor is the serialized owner of one active Sedes thread.
Provider history is the durable transcript, while the current actor generation
owns the normalized in-memory projection. Sedes merges application-owned
overlay state—drafts, pending input, inventory, tasks, settings, and attention—
without treating that overlay as provider transcript history.

## Ownership boundaries

### Shared protocol

Put a type in `src/shared/protocol/` only when both browser and server must
agree on its normalized wire meaning. Schemas should reject unknown or obsolete
shapes. A shared DTO must not contain provider SDK objects, provider-native
identifiers used as authority, raw JSON-RPC/ACP frames, or transport-specific
state.

A shared protocol change normally requires all of the following:

- server production and test producers;
- client consumers and strict parsing;
- protocol-version consideration where an old client could misinterpret the
  new contract;
- wrong-scope, malformed, and unsupported behavior; and
- browser or integration coverage proving the end-to-end meaning.

Do not add alias fields, dual parsers, or fallback routes unless an explicit
migration requires them.

### Client

The client owns presentation: component layout, browser-local preferences,
transient optimistic rendering, current viewport state, and normalized store
retention. It does not reconstruct server authority or infer features from a
backend/model name. Render controls from normalized capabilities or a closed
provider-feature registration.

Keep network calls in the API/transport layer and state transitions in stores
or focused feature modules. Components should consume normalized data rather
than parse provider wording or inspect native payloads.

### Server application and domain

The server owns identity scope, admission, persistence, mutation receipts,
ordering, revisions, and normalization. Classify every new piece of state as
installation-, tenant-, principal-, execution-environment-, workspace-, or
thread-owned before choosing a repository key or cache. The current one-user UI
does not justify global principal state.

Domain and application code should depend on contracts. Production wiring
belongs in `production-application.ts`; route validation and presentation
belong at the HTTP boundary. Side effects must pass through the same scoped
service authority as equivalent browser operations.

### Backends

Backends own provider protocols, native IDs, history interpretation,
correlation, settings conversion, transport, and process topology. Shared code
talks to them through `src/server/backends/contracts.ts` and module contracts.
Provider-specific browser behavior is valid only as:

1. private backend behavior;
2. a registered, versioned provider-feature envelope; or
3. an existing provider-neutral semantic item or interaction.

Before changing any backend-facing or cross-cutting contract, read
[Backend development](backend-development.md).

### Execution environments and files

An execution environment, not a backend, defines path and operation authority.
Local and SSH workspaces have different admission and availability mechanics.
Files, attachments, workspace tools, managed processes, and sidecar routes must
preserve the selected environment and its configured roots; a path string is
not authority by itself.

## Persistence and migrations

Sedes stores application overlay state in SQLite. Provider conversation stores
and provider authentication remain outside this database. The connection
enables foreign keys, WAL mode, and a bounded busy timeout; production startup
owns migration and pre-migration backup behavior.

Migrations live in `src/server/db/migrations/` and are registered in numeric
order by `src/server/db/migrate.ts`. Applied migration names and SQL checksums
are verified, so an old migration is immutable after release. Add a new
numbered migration for every schema change.

For a migration change:

1. Define the ownership and tenancy keys before writing SQL.
2. Add the next migration and register it once in the migration plan.
3. Preserve foreign keys, uniqueness, revision fences, and cleanup behavior in
   the database—not only in services.
4. Test migration from the relevant prior schema as well as a fresh database.
5. Test direct database invariants, wrong-scope access, restart reconstruction,
   and optimistic races when applicable.
6. Update repository/service tests and operator-facing backup or cutover docs
   when the operational contract changes.

Do not edit an applied migration to make a new test pass. Do not support an
in-place downgrade. Production may create a verified pre-migration SQLite
backup under the state directory; restoring requires the matching older binary
and provider state considerations described in
[Operations](../operator/operations.md#state-upgrades-and-backups).

## Generated and build artifacts

Generated material has an explicit source and check. Treat changes to it as a
reviewable contract update, not formatting noise.

| Artifact                                      | Source/check                                                                                               | Policy                                                                                                                                                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Agent-tool schemas and adapter metadata       | Canonical agent-tool manifest; `npm run check:agent-tool-contracts`                                        | Regenerate through the owning schema tooling and review server, CLI, and client impact together.                                                                                                                               |
| Codex protocol adoption files and built binding | Pinned Codex release and generation scripts; `npm run check:codex-protocol`, then `npm run build` / `npm run check:codex-generated-runtime` | Update only as an intentional pinned protocol-baseline change; verify both source artifacts and the emitted executable binding.                                                                                                  |
| ACP bindings                                  | Pinned ACP SDK inputs; `npm run check:acp-protocol`                                                        | Review generated bindings and affected backend tests together.                                                                                                                                                                 |
| Grok ACP profile and release evidence         | Pinned Grok artifact/profile evidence; `npm run check:grok-profile` and `npm run check:grok-source-routes` | Treat a reviewed runtime release or source-route change as an intentional provider adoption, not a routine regeneration.                                                                                                       |
| E2E timing baseline                           | A selected successful complete run; `npm run check:e2e-timing-baseline`                                    | Refresh `tests/e2e/timing-baseline.json` only with `update:e2e-timing-baseline -- <result.json>` after adding, renaming, or removing a spec.                                                                                   |
| Managed SSH sidecar                           | Server-owned sidecar sources; `build:sidecar` and repeatability check                                      | `dist/sidecar` is build output and is not committed.                                                                                                                                                                           |
| Claude runtime worker                         | Provider-private worker sources plus the managed-worker artifact check                                     | Built output is digest-pinned, disposable, and not committed.                                                                                                                                                                  |
| Pi sandbox worker                             | Worker sources; `build:pi-sandbox-worker` and repeatability check                                          | Built output is pinned and verified as part of production build.                                                                                                                                                               |
| Browser/server output                         | Vite and TypeScript through `npm run build`                                                                | `dist/` is disposable and untracked.                                                                                                                                                                                           |
| Capacitor/Electron synced assets and packages | Current production build plus platform sync/packaging commands                                             | Electron packages the current-platform Local runtime and Electron-ABI native modules. Never commit copied assets, generated runtime manifests, Gradle/Electron output, installers, APKs, state, configuration, or credentials. |
| E2E screenshots, traces, logs, and reports    | E2E coordinator invocation                                                                                 | Keep under ignored `test-results/`; inspect relevant screenshots before handoff.                                                                                                                                               |

When a check says generated output is stale, use the documented generator. Do
not hand-edit generated output to silence it.

## Common change recipes

### Add or change a user-visible application feature

1. Classify the feature's owner and persistence boundary.
2. Define or update the normalized shared schema.
3. Add database/repository/domain behavior when state is durable.
4. Wire the application service and route with server-derived scope.
5. Update normalized stores and components.
6. Cover domain failure, wrong scope, revision/race behavior, and the primary
   browser workflow.
7. Update user, operator, and internals documentation according to who sees or
   owns the feature.

### Change an API or event

Start from `src/shared/protocol/`, trace every producer and consumer, and keep
the HTTP/SSE presentation closed. Consider replay, replacement snapshots,
idempotency, retained clients, frame/byte bounds, and old-client rejection.
Test malformed input and reconnect/replacement behavior, not only the happy
route.

### Change a backend

Keep the provider-specific implementation inside its backend directory. Update
capabilities truthfully, audit every compiled backend, and provide an explicit
implemented or intentionally unsupported disposition. Cover attach, history,
live events, cancellation, recovery, and unsupported/fail-closed behavior as
applicable. Do not run a real-provider suite without explicit authorization.

### Change files, attachments, or execution behavior

Audit local and every configured SSH/sidecar path. Preserve root containment,
canonical/lexical path rules, environment revision, bounded payloads, and
wrong-environment denial. Read the relevant internals document before changing
the contract.

### Change a browser workflow

Add focused unit/component coverage first. Add or update one independently
runnable E2E job when the behavior crosses routes, persistence, SSE, browser
layout, or packaged-client-sensitive interaction. Inspect desktop and narrow
screenshots when layout changes. Follow [E2E testing](e2e-testing.md).

### Add diagnostics

Diagnostics must be explicitly gated, content-safe, bounded, observational,
and documented. They must not change API authority, event semantics, state, or
timing-sensitive behavior. Follow [Debug diagnostics](diagnostics.md#adding-diagnostics).

## Test selection matrix

Run the smallest relevant tests while iterating, then the standard sequence
before handoff when risk warrants it.

| Change                             | Focused checks                                                                                   | Additional required or likely checks                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Markdown only                      | `npm run check:docs`                                                                             | `npm run typecheck` when documentation references generated/check inputs or the normal handoff calls for the full precheck.                    |
| Pure utility/domain logic          | Relevant `vitest` file(s)                                                                        | `npm test`, `typecheck`, and build before broad handoff.                                                                                       |
| React component/store              | Relevant component/store tests                                                                   | A relevant E2E spec for cross-view or persisted behavior; inspect screenshots for layout changes.                                              |
| Shared API/SSE protocol            | Producer/consumer unit and integration tests                                                     | Protocol version/rejection coverage, relevant E2E, full standard verification.                                                                 |
| Database migration/repository      | Migration-from-prior and fresh-database tests; repository/service tests                          | Restart reconstruction, scope/race/integrity tests, full standard verification.                                                                |
| Backend protocol/history/lifecycle | Backend unit/integration fixtures and cross-backend capability audit                             | Ask before the relevant `test:real-*`; report when it was not run.                                                                             |
| E2E spec add/rename/remove         | Spec alone through coordinator                                                                   | Successful full suite and explicit timing-baseline refresh.                                                                                    |
| Shared client code                 | Client tests and standard build                                                                  | Both `npm run android:verify` and `npm run electron:verify`.                                                                                   |
| Android-only native/configuration  | Relevant native/client tests and standard build                                                  | `npm run android:verify`.                                                                                                                      |
| Electron-only native/configuration | Relevant native/client tests and standard build                                                  | `npm run electron:verify`.                                                                                                                     |
| Sidecar                            | Focused integration tests and `build:sidecar`                                                    | `check:sidecar-build-repeatability`, plus affected SSH paths.                                                                                  |
| Pi sandbox worker                  | Focused sandbox tests and `build:pi-sandbox-worker`                                              | `check:pi-sandbox-worker-build-repeatability`.                                                                                                 |
| Release preparation                | Every contract/protocol/repeatability check in the release checklist, then standard verification | Both client verifiers after shared-client changes; the relevant verifier for every platform artifact; live suites only with explicit approval. |

Always run commands with `NODE_ENV` unset. Do not invoke raw Playwright; use
the repository coordinator. The complete commands and live-suite safety policy
are in [Development and testing](development.md).

## Backend contributor entry point

The short workflow is in [Backend development](backend-development.md). The
normative backend contract is
[Backend integration contract rules](../internals/backend-integration-contract-rules.md).
Read it completely before adding a backend or changing a backend-facing or
cross-cutting feature. At minimum, expect to audit:

- compiled module registration and production composition;
- configuration schema, examples, startup preparation, and model policy;
- target/execution-environment compatibility;
- discovery, create/bind, attach, history, live events, submit, cancel, and
  shutdown ownership;
- normalized capabilities, settings, items, interactions, usage, and errors;
- native ID/cursor confinement and persistence keys;
- application and browser feature disposition for every compiled backend;
- unsupported, unavailable, and fail-closed paths; and
- deterministic fixtures plus explicitly authorized live verification.

Provider guides under [Operator backends](../operator/backends/) explain the
operator-visible lifecycle. They are not substitutes for the normative
integration contract.

## Documentation expectations

Documentation is part of the implementation:

- `README.md` is the release landing page, not a complete reference.
- `docs/user/` explains tasks and visible concepts without internal jargon.
- `docs/operator/` explains installation bootstrap, principal execution configuration, security,
  operation, clients, and backend prerequisites.
- `docs/developer/` explains repository workflow and contribution mechanics.
- `docs/internals/` records durable authority, invariants, subsystem contracts,
  and implemented design.
- `protocol/` holds pinned evidence, not user documentation.
- Design proposals, plans, and reviews live outside the repository. Landing a
  feature includes updating the current product documentation; a design
  document is not a substitute for that.

Update every affected audience in the same change. Use relative links, current
names, executable examples, and explicit unsupported behavior. Do not preserve
obsolete shapes in prose. Run `npm run check:docs` and inspect the rendered
Markdown structure, tables, headings, and navigation—not only link validity.

## Before opening a review

- Read `AGENTS.md` and the relevant internals/operator references.
- Confirm the working tree contains no generated or local runtime artifacts.
- Review the diff for accidental provider leakage or ownership changes.
- Run proportionate focused tests and the required broad gates.
- Record any relevant live-provider suite that was intentionally not run.
- Update documentation and checked-in examples with the implementation.
- For E2E work, report the run directory, outcome, duration, and screenshot
  review.
- For release work, follow the [release process](release-process.md).
