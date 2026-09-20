# Repository agent guide

Read `README.md` before changing the application. Preserve the backend-neutral
contracts: Pi-specific SDK types, event parsing, and history interpretation stay
under `src/server/backends/pi`; the browser consumes only normalized protocol
types.

## Changelog and releases

Record user- and operator-visible changes in `CHANGELOG.md` under `Unreleased`.
Use Breaking Changes, Added, Changed, Fixed, and Removed as needed; do not
create duplicate subsections. Keep notes concise, explain compatibility or
upgrade effects, and add the PR number or link after opening the PR and before
merging. The initial release entry is only `Initial release`; do not restore a
catalogue of pre-release development history.

Follow [Release process](docs/developer/release-process.md). Use
`npm run release:prepare -- X.Y.Z` (or `patch`, `minor`, `major`) on a clean
branch to synchronize product versions and roll the changelog for review.
Use `--dry-run` to preview. Commit and merge the prepared release normally.
Publish only when requested, using `npm run release:publish -- X.Y.Z` from
clean `main` matching origin. This creates an annotated tag and a GitHub
release containing changelog notes. Current releases are source-only; there
is no npm publication, binary upload, or deployment step.

Keep product versions synchronized with `scripts/version.mjs`, even though
packages are private. Browser and provider protocol versions are independent
compatibility contracts; a product release alone does not bump them.

## Backend-facing changes

Before adding a backend or changing a backend-facing contract or cross-cutting
feature, read and follow `docs/internals/backend-integration-contract-rules.md`. Update
that guide when the change adds a reusable integration rule, invariant, or
required audit surface. Audit every compiled backend and give each an explicit
implemented or intentionally unsupported disposition through truthful
capabilities. Implement and test every required backend path, including
unsupported and fail-closed behavior. Keep provider protocols, native
identifiers, event/history interpretation, transports, and topology private to
their backend; keep browser contracts normalized. Remove obsolete shapes
instead of adding silent aliases, fallback parsers, bridge routes, or dual
contracts.

## Ownership and tenancy

Before adding a feature, classify its configuration, persisted state, events,
side effects, and controls by their intended ownership boundary: installation
system, tenant, principal, execution environment, workspace, or thread. Keep
operator-owned system configuration distinct from tenant/principal-owned
application state, and document explicit precedence and mutability when more
than one scope can contribute policy.

The current production identity provider intentionally supports exactly one
local principal. Treat that as a product limitation, not as permission to make
principal-owned state globally scoped. Build repositories, service authority,
receipts, queues, event dispatch, caches, and runtime keys around the
server-derived `tenantId`/`principalId` boundary and test wrong-scope denial,
while exposing only the single-principal UI that is truthfully supported now.
Never accept a browser-selected tenant or principal as authority, simulate
tenant administration before authenticated roles exist, or allow one scope's
state to become another scope's fallback.

Use Node.js 24.18 or newer and install with `npm ci`. The standard verification
sequence is:

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Run installs, tests, and builds with `NODE_ENV` unset. A shell-exported
`NODE_ENV=production` makes `npm ci` silently prune devDependencies
(breaking `vitest.config.ts` and Playwright) and makes Vitest resolve
React's production build, which fails most client component tests with
`React.act is not a function`. If client tests fail that way, reinstall
with `env -u NODE_ENV npm ci` and rerun the sequence with `env -u NODE_ENV`
prefixed to each command.

The E2E coordinator uses invocation-scoped disposable state and writes
screenshots beneath the run directory it prints, normally at
`test-results/e2e-runs/run-*/jobs/*/screenshots/` and at
`test-results/e2e-runs/run-*/screenshots/` for single-lane runs. Inspect changed
screenshots, including an in-flight streaming state.

Before adding or changing Playwright coverage, read and follow
[`docs/developer/e2e-testing.md`](docs/developer/e2e-testing.md). Keep every spec independently
runnable; never depend on another spec's warmed process, state, workspace, or
execution order. Treat each spec file as one indivisible scheduled job, reserve
serial suites for genuine same-server state chains, and split long independent
chains without creating tiny files solely for parallelism. On this reference
host, target 210 seconds for the full build-inclusive suite and 200 seconds for
the parallel prebuilt suite under the stable default four-lane schedule. These
are regression signals, not acceptance
gates or portable test timeouts. Never weaken coverage or assertions, split a
genuine same-server state chain, introduce shared state, or use an unrealistic
fixture merely to meet them. A fresh worktree uses the committed rounded timing
baseline; successful local timing medians override it without modifying tracked
files. Adding, renaming, or removing a spec requires refreshing the baseline
from an explicitly selected successful full run with
`npm run update:e2e-timing-baseline -- <result.json>`. Investigate a job around
50 seconds. For a new or changed job around 55 seconds or longer, record the
reason and full-suite timing; a slower job is acceptable when the correct test
boundary or necessary coverage justifies it. Run E2E through the npm
coordinator scripts, not raw Playwright, so ports, state, artifacts, and process
cleanup remain isolated.

Do not run live-provider Pi, Codex, Claude, or Grok suites by default, including
commands matching `test:real-pi*`, `test:real-codex*`, `test:real-claude*`, or
`test:real-grok*`. These suites consume live provider capacity and may require
authenticated external services. When work materially changes a backend's
protocol handling, streaming, history, lifecycle, tools, or provider
integration behavior, ask the user whether to run its relevant live suite
before doing so. If a relevant live suite is not run, explicitly call that out
in the final handoff and recommend it as an additional verification step; do
not imply that the backend was live verified.

When the user authorizes a real-Pi suite, preserve the `test:real-pi` and
`test:real-pi-cli` self-gates on exactly one authenticated `xai/grok-4.5`
provider/model pair with low reasoning and read-only tools verified before
prompting; do not weaken either gate or point it at an existing session.

For live delivery or client-rendering debugging, use only the implemented,
gated diagnostics documented in
[`docs/developer/diagnostics.md`](docs/developer/diagnostics.md) and follow its
troubleshooting playbook before adding new logging.

For a production-shaped local run:

```sh
npm run build
SEDES_CONFIG_FILE="$PWD/config/server.example.json" npm start
```

The explicit path above keeps repository checks deterministic. Without that
override, production startup reads
`${XDG_CONFIG_HOME:-$HOME/.config}/sedes/server.json`.

This serves `http://127.0.0.1:4784`. With that server running, target the
bounded live streaming smoke test explicitly with
`SEDES_SMOKE_URL=http://127.0.0.1:4784 npm run test:smoke-live-streaming`.
Measure a real thread's repeated initial stream without mutation using:

```sh
npm run measure:thread -- THREAD_ID --repeats=3 --url=http://127.0.0.1:4784
```

Restart the server immediately before the command if the first sample must be
a guaranteed cold runtime attach.

## Android packaging

The committed Capacitor project targets Android SDK 36 with JDK 21. After any
client, Capacitor dependency, config, or native-project change, run:

```sh
npm run android:verify
```

Keep `capacitor.config.json` as the single Capacitor config: Capacitor CLI
8.4.0 cannot parse a TypeScript config with this repository's TypeScript 7
compiler. The native WebView must load bundled `dist/client` assets, never a
remote page through `server.url` or `allowNavigation`. Preserve the manifest's
minimal `INTERNET`-only permission set unless a separately approved native
feature requires more authority.

Do not commit copied web assets, generated runtime Capacitor JSON/XML files,
Gradle build output, `local.properties`, APK/AAB files, keystores, or signing
credentials. Android development and endpoint security guidance is in
`docs/operator/clients/android.md`.

## Electron packaging

The committed Electron project uses `@capawesome/capacitor-electron` and
electron-builder. After any client, Capacitor dependency/configuration, or
Electron native-project change, run:

```sh
npm run electron:verify
```

The Electron renderer must load bundled `dist/client` assets from the exact
`capacitor-electron://localhost` origin and connect to a separately operated
backend URL. Preserve sandboxing, context isolation, disabled Node integration,
navigation guards, and default-deny permissions. Do not commit copied web
assets, generated manifests, vendored runtime modules, Electron build output,
installers, signing credentials, or notarization material. Desktop build and
endpoint guidance is in `docs/operator/clients/electron.md`.

For a packaged Android or Electron client on a trusted home LAN, Sedes may
explicitly use `SEDES_BIND_HOST=0.0.0.0` with its exact packaged-client opt-in
and one `SEDES_TRUSTED_LAN_HOST=<private-ip>`. The wildcard socket permits the
same process to receive loopback traffic from Tailscale Serve and LAN traffic
at the trusted address; Host validation must remain exact rather than accepting
every interface address. This direct HTTP mode carries authenticated credentials without transport
encryption, so document and test its firewall/trust boundary
whenever it changes.

For tailnet-only access, keep Sedes bound to loopback and put Tailscale Serve
in front of it. In an explicit packaged-client trusted-LAN mode, the wildcard
listener still accepts Serve's loopback upstream connection. The application's exact
tailnet DNS name must also be in the Host/Origin allowlist when the server
starts:

```sh
SEDES_TAILNET_HOST="$(
  tailscale status --json | jq -r '.Self.DNSName | rtrimstr(".")'
)"
tailscale serve --bg http://127.0.0.1:4784
tailscale serve status
SEDES_CONFIG_FILE="$PWD/config/server.example.json" \
  ALLOWED_TAILSCALE_HOSTS="$SEDES_TAILNET_HOST" npm start
```

Open `https://$SEDES_TAILNET_HOST` from a device on the same tailnet. Do not
bind Sedes directly to its Tailscale IP, and do not use Tailscale Funnel. Do
not enable the wildcard trusted-LAN mode merely for Tailscale access. If the
browser reports a Host, Origin, or cross-site rejection, restart
Sedes with the exact DNS name shown by `tailscale serve status`; configuring
Serve alone does not update the application's allowlist.

Never commit local state, credentials, Pi sessions, `.pi-subagents/`,
`.plannotator/`, `dist/`, or `test-results/`.
