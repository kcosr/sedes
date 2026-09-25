# Development and testing

Use Node.js 24.18 or newer. npm 11 is the tested package-manager baseline.

New to the repository? Start with the [Developer overview](overview.md). For
browser-test authoring use [E2E testing](e2e-testing.md), and for release
readiness use the [Release process](release-process.md).

## Install discipline

Always install, test, and build with `NODE_ENV` unset:

```sh
env -u NODE_ENV npm ci
```

An exported `NODE_ENV=production` makes npm omit development dependencies and
causes Vitest to resolve React's production build. Typical symptoms are missing
Vitest/Playwright modules or `React.act is not a function`. Reinstall with the
command above before debugging the application.

For E2E tests, install the pinned Playwright Chromium if it is not already
present:

```sh
npx playwright install chromium
```

Do not commit `node_modules`, `dist`, `test-results`, local state, provider
sessions, credentials, Android build output, or generated Capacitor runtime
files.

## Standard verification

The normal sequence is:

```sh
env -u NODE_ENV npm run typecheck
env -u NODE_ENV npm test
env -u NODE_ENV npm run build
env -u NODE_ENV npm run test:e2e
```

- `typecheck` checks repository-local documentation links, generated agent-tool
  contracts, and the E2E timing baseline before compiling the client and server
  TypeScript projects without emitting.
- `test` runs unit, component, and integration tests with disposable state.
  Vitest defaults to at most eight workers to keep host load bounded. Use
  `npm test -- --maxWorkers=N` to explicitly choose a different limit.
  Most provider boundaries are fake-backed; the Codex lifecycle/TUI fixtures
  also execute the pinned Linux-x64 Codex artifact against local fixture
  providers and require `/usr/bin/tmux` for TUI coverage. They do not use an
  authenticated external provider account.
- `build` checks documentation and generated agent-tool contracts, cleans
  `dist`, builds the client, compiles the server/CLIs, builds the SSH operations
  sidecar artifact, and marks the Sedes, automation, and provider CLI entry
  points executable.
- `test:e2e` builds once, schedules each spec as an isolated job with its own
  server, port, state, and artifact directory, and merges the results.

Documentation-only changes normally need link/config validation and the
proportionate deterministic checks; they do not justify live-provider calls.

Run the documentation check directly with:

```sh
env -u NODE_ENV npm run check:docs
```

The unit suite parses every checked-in backend configuration example through
the strict top-level schema, reference checks, and compiled provider-module
preparation without opening storage or starting provider processes.

## Playwright topology and artifacts

In parallel mode the npm coordinator treats each `.spec.ts` file as one
indivisible job with its own loopback port, disposable state, and
production-shaped server. With `--lanes=1`, matching specs run together as one
server job. Output always stays beneath the printed
`test-results/e2e-runs/run-*` directory; parallel jobs live under
`jobs/NNN-of-NNN`, while a single job writes directly beneath its run
directory. Failure
screenshots/traces/video, explicit review screenshots, logs, and the final
report remain within that invocation.

Use `test:e2e:serial` to diagnose ordering, `test:e2e:prebuilt` for one-lane
iteration against an already verified build, and `test:e2e:parallel:prebuilt`
for the normal isolated four-lane schedule without rebuilding. Explicit
`--lanes=N` values from 1 through 12 remain available; use 12 only on a host
provisioned for twelve concurrent servers and browsers. Run these npm commands,
not raw Playwright. Every spec must be independently runnable and must not rely
on another spec's process, state, workspace, or order.

The committed rounded timing baseline is a scheduling input, not an acceptance
threshold. Adding, renaming, or removing a spec requires updating it from an
explicitly selected successful full run. Inspect changed screenshots,
including an in-flight streaming state. The complete authoring, isolation,
artifact, and timing contract is in [E2E testing](e2e-testing.md).

## Generated contracts

Agent-tool schemas and adapter metadata are generated from the canonical
manifest and checked automatically before typecheck/build:

```sh
env -u NODE_ENV npx tsx \
  src/server/agent-tools/schema/check-agent-tool-artifacts.ts --write
env -u NODE_ENV npm run check:agent-tool-contracts
```

Use the write form only after deliberately changing the canonical tool catalog
or schema version. Review the checked-in artifacts, bundled skill consumers,
live named-command paths, schema-derived CLI parameter/help behavior, CLI
adapters, and server definitions as one contract change. CLI command-path
normalization is startup-validated and must remain unique after dots are split
and underscores become hyphens.

Codex protocol artifacts are pinned separately:

```sh
env -u NODE_ENV npm run check:codex-protocol
```

Use `generate:codex-protocol` only for an intentional protocol-baseline update.
Review the generated manifest, hashes, stable method inventory, codecs, release
evidence, and corresponding backend tests as one change. A production build
also runs `check:codex-generated-runtime` against its emitted server binding so
the checked source profile and the executable artifact cannot silently diverge.

ACP bindings and the reviewed Grok release/profile have independent checks:

```sh
env -u NODE_ENV npm run generate:acp-protocol
env -u NODE_ENV npm run check:acp-protocol
env -u NODE_ENV npm run check:grok-source-routes
env -u NODE_ENV npm run check:grok-profile
```

Run the ACP generator only for an intentional pinned SDK/binding update, then
review the generated runtime types and all ACP-backed providers. The Grok
checks validate the checked-in source-route extraction, artifact hashes,
reviewed release/build identity, and admitted profile; they do not contact a
live provider. Do not use the capture or probe commands as routine generation
or release gates.

The sidecar can be built and checked independently:

```sh
env -u NODE_ENV npm run build:sidecar
env -u NODE_ENV npm run check:sidecar-build-repeatability
env -u NODE_ENV npm run build:pi-sandbox-worker
env -u NODE_ENV npm run check:pi-sandbox-worker-build-repeatability
env -u NODE_ENV npm run build:claude-runtime-worker
env -u NODE_ENV npm run check:claude-runtime-worker-build-repeatability
```

A source development server configured for the managed SSH sidecar requires an
existing valid `dist/sidecar/manifest.json`. A normal production build creates
it. The Pi sandbox worker is likewise a pinned, self-contained artifact; its
repeatability check rebuilds it twice and verifies identical bytes, manifest,
digest, size, and restrictive modes. The standard production `build` gate runs
that check before cleaning and creating the final build outputs.

Remote terminal assets require the matching architecture, Node ABI, and glibc
profile. Follow [Sidecar native builds](sidecar-native-build.md) to build and
verify portable Linux PTY assets; incompatible terminal assets must leave
management, Files, and provider connections independently available.

Local Claude targets launch the separate provider-private
`dist/claude-runtime-worker` artifact; its repeatability check also audits the
bundle's provider-owned source boundary. SSH Claude targets use the persistent
sidecar build, which embeds the same source-audited worker and manifest beside
the backend-private runtime host.
They do not launch the local worker over an attachment-owned SSH subprocess.

## Specialized deterministic gates

Principal Tool client changes require the repository/service credential,
scope/race, HTTP, CLI, normalized provenance, and Settings component tests.
When the UI or CLI surface changes, also run the production-built CLI
integration and the `agent-tool-policy.spec.ts` browser job. Credential visual
artifacts must remain masked; inspect desktop/narrow screenshots and scan the
run directory for issued `hatc1_` values rather than relying only on DOM
assertions. Management/provenance DTO changes require one deliberate browser
protocol advance with strict old-version rejection, never a dual parser.

Database migrations for Tool client policy/verifiers and immutable initiating
client provenance are one-way. Migration tests must exercise direct database
invariants, wrong tenant/principal denial, expected-revision races, verifier
generation changes, and backup/rollback expectations. Thread-reference restart
coverage must close and reconstruct production composition rather than merely
replace one authority object.

`npm run test:c5c-production-lifecycle` builds and exercises production-shaped
shutdown/restart, external UDS/TCP survival, unavailable-target isolation, and
owned-stdio process-group/native-lock ordering. It currently requires Linux
x64, procfs, and a compatible operator-installed Codex command.

After client, Capacitor dependency/configuration, or native Android changes,
run:

```sh
env -u NODE_ENV npm run android:verify
```

That requires JDK 21 plus Android SDK Platform 36. See
[Android](../operator/clients/android.md) for
the exact native-project and device boundaries. Electron platform, packaging,
or shared-client changes also require:

```sh
env -u NODE_ENV npm run electron:verify
```

That command syncs the exact built frontend, packages the current-host
application and Local server runtime, inspects its content/native-module
boundary, and runs the actual unpacked application outside the source tree
under Xvfb. The smoke covers Local health/session validation and cleanup plus
Electron HTTP/SSE/WS, managed SSH, switching/rollback, and native file
download. See [Electron](../operator/clients/electron.md) for the platform and
release-artifact contract.

## Live-provider suites

Do not run commands matching `test:real-pi*`, `test:real-codex*`,
`test:real-claude*`, or `test:real-grok*` by default.
They consume live provider capacity or exercise authenticated external state
and require explicit user authorization for the relevant backend change.

When a backend-specific change affects protocol handling, streaming, history,
lifecycle, tools, interactions, or provider integration, ask whether to run the
relevant live suite. The main Pi gate is self-limiting: it refuses to prompt
until exactly one authenticated `xai/grok-4.5` provider/model pair is available
at low reasoning with read-only tools. Do not weaken the gate, substitute a
model, or point it at an existing session.

```sh
env -u NODE_ENV npm run test:real-pi
```

The CLI-specific Pi gate also requires the explicit test opt-in:

```sh
SEDES_RUN_REAL_PI_CLI=1 env -u NODE_ENV npm run test:real-pi-cli
```

Codex live scripts include private fixture coverage and optional authenticated
sub-gates, but repository policy still treats the entire `test:real-codex*`
family as opt-in. Some create disposable provider threads and archive only the
exact native ID they created. Never point a live gate at an existing user
thread or weaken its model/settings safety checks.

Important opt-ins include:

- `SEDES_RUN_REAL_CODEX_AGENT_TOOLS=1` for the generated CLI skill exercise
  and both Native MCP modes, where `codex exec` receives the same
  `mcp_servers.sedes` entry Sedes sends in thread config and calls a real
  Sedes listener;
- an absolute `SEDES_REAL_CODEX_UDS_SOCKET` together with
  `SEDES_REAL_CODEX_UDS_MODEL=gpt-5.6-luna` for an operator socket;
- an absolute `SEDES_REAL_CODEX_TUI_HOME` for a disposable authenticated
  managed-TUI thread; and
- `SEDES_REAL_CODEX_SSH_HOST`, canonical absolute
  `SEDES_REAL_CODEX_SSH_UDS_SOCKET` and
  `SEDES_REAL_CODEX_SSH_WORKSPACE`, plus
  `SEDES_REAL_CODEX_SSH_MODEL=gpt-5.6-luna` for SSH UDS.

The persistent-runtime canary uses a disposable bundled sidecar around an
existing authenticated UDS provider. It creates one Luna-low, read-only thread,
disconnects during streaming, reopens the application receipt database, and
verifies the same runtime, durable outcome recovery, and complete native history:

```sh
SEDES_REAL_CODEX_PERSISTENT=1 \
SEDES_REAL_CODEX_UDS_SOCKET=/canonical/absolute/path/to/codex.sock \
SEDES_REAL_CODEX_UDS_MODEL=gpt-5.6-luna \
  env -u NODE_ENV npm run test:real-codex -- \
  -t "retains a real Luna turn"
```

It stops its disposable sidecar and unsubscribes its new thread, leaving the
native thread retained. It never stops the shared app-server. The outer carrier
is local Unix, so this live canary does not qualify actual SSH networking;
controlled OpenSSH integration tests cover that carrier separately.

The generated-image canary is a further opt-in inside the Codex live suite. It
requires the approved shared UDS endpoint and exact Luna model, asks the live
provider to generate one image, and exercises the normalized artifact path:

```sh
SEDES_REAL_CODEX_GENERATED_IMAGE=1 \
SEDES_REAL_CODEX_UDS_SOCKET=/canonical/absolute/path/to/codex.sock \
SEDES_REAL_CODEX_UDS_MODEL=gpt-5.6-luna \
  env -u NODE_ENV npm run test:real-codex -- \
  -t "publishes one real generated image"
```

This consumes authenticated model and image-generation capacity. It creates a
non-ephemeral native Codex thread, unsubscribes from it, and leaves it retained;
it does not archive or delete the provider thread. Run it only with explicit
authorization that includes that retained-session and capacity impact.

If a relevant live suite is not run, say so explicitly in the handoff and do
not imply that the backend was live-verified.

The Claude gate uses the externally authenticated subscription and makes a real
model request only after its exact executable, account, model, effort, and
tool-safety preflight succeeds:

```sh
SEDES_REAL_CLAUDE_EXECUTABLE=/absolute/path/to/claude \
SEDES_REAL_CLAUDE_CONFIG_DIRECTORY=/absolute/provider-home \
  env -u NODE_ENV npm run test:real-claude
```

It requires a logged-in first-party `claude.ai` subscription with a nonempty
subscription type and no API-key override, exactly one `claude-sonnet-5`/low
catalog entry, `dontAsk`, an empty tool list, and no MCP servers. It creates two
disposable provider sessions and retains their native history. The Native MCP
file adds a third: the production `ClaudeSdkSession` with no built-in tools,
strict MCP configuration, and only the thread's `sedes` server, in `default`
permission mode approving only `mcp__sedes__*` calls. It verifies the server
connects, the reference stays out of the CLI arguments, and one Individual
tool call round-trips through a real Sedes listener.
The driver test covers reopen; the managed-worker test completes an active
turn while the main client is detached, then reattaches without resubmitting.
That test uses real worker stdio with local framed sockets standing in for
the SSH carrier; it does not verify a remote SSH server or login.

That bounded live gate verifies text streaming, persistence, usage, and reopen;
it deliberately does not claim live coverage for native image input, semantic
tool projection, subagents, or skills. Those paths use deterministic
official-SDK-shaped unit, integration, and browser fixtures. Manual compaction
remains intentionally unsupported. A separately reviewed, capacity-bounded
live canary still requires explicit authorization.

The Grok gate uses the production owned-stdio runtime, curated child
environment, native HOME/GROK_HOME account state, and cached-token
authentication. The lifecycle canary selects and verifies the catalog default,
exercises unrestricted tools, subagents, cancellation, restart recovery, and
authoritative replay in a disposable workspace. A separate focused attachment
test submits one deterministic PNG plus one staged text-file resource link and
checks both an image-sensitive response and the exact file canary. Neither test
deletes the retained native session. Both consume authenticated provider
capacity and remain explicitly opt-in.

```sh
SEDES_REAL_GROK=1 \
  SEDES_REAL_GROK_EXECUTABLE=/canonical/absolute/path/to/grok \
  env -u NODE_ENV npm run test:real-grok
```

Append `-- tests/real-grok/grok-image-input.test.ts` to run only the focused
user-attachment regression.

Grok generated-image output has a separate double gate. It asks the live
provider to call `ImageGen`, reads the resulting local JPEG through the exact
native-session authority, and verifies normalized artifact publication:

```sh
SEDES_REAL_GROK=1 \
SEDES_REAL_GROK_GENERATED_IMAGE=1 \
SEDES_REAL_GROK_EXECUTABLE=/canonical/absolute/path/to/grok \
  env -u NODE_ENV npm run test:real-grok -- \
  tests/real-grok/grok-generated-image-output.test.ts
```

This consumes authenticated model, tool, and image-generation capacity. It
closes the active session after the assertion but does not delete the retained
native Grok session. Authorization must cover both the capacity use and the
retained provider state.

## Live installation helpers

The live streaming smoke and thread measurement scripts are operational tools,
not deterministic test fixtures. `measure:thread` is read-only;
`test:smoke-live-streaming` creates and sends a real thread and does not clean
it up. Their safe use is documented in
[Operations](../operator/operations.md#live-smoke-and-measurement-commands).

## Backend-facing changes

Before changing a backend-facing or cross-cutting contract, follow
[Backend integration rules](../internals/backend-integration-contract-rules.md).
Audit Pi,
Codex, Claude, and Grok explicitly, preserve provider-private protocols, update
truthful capabilities, and test both implemented and intentionally unsupported
paths.
