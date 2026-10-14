# Source release 0.2.0

This record accompanies the preparation PR for annotated tag `v0.2.0`.
Publication uses the reviewed merge commit on clean `main` matching `origin/main`;
the tag identifies that final commit. GitHub supplies the source archives.
No npm package, signed client binary, container, or deployment is part of this
release. Release notes are the dated `0.2.0` entry in [CHANGELOG](../CHANGELOG.md).

## Scope and upgrade boundary

This minor release includes the accumulated features and breaking changes since
`v0.1.1`: projects, shared Tasks and Workpads, Android voice, automations, Pages,
image tools, thread references, and updated provider integrations. Linux x64
is the verification platform, with Node.js 24.18.0 and npm 11.16.0; Android uses
JDK 21 and SDK 36. Windows received native attachment-path checks during PR #79.
macOS, Windows server/Electron packaging, and physical Android devices were not
release-verified here. Supported deployment boundaries remain in the
[README](../README.md) and [operator guides](../docs/operator/index.md).

| Contract | Release baseline |
| --- | --- |
| Configuration schema | 11, unchanged |
| Overlay database | 108 → 143; new migrations 109–143 |
| Browser/client protocol | 155 |
| Execution-sidecar wire protocol | 14 |
| Agent-tool CLI/relay protocol | 6 |
| OpenCode MCP protocol | 4 |
| Notification payload | 5 |
| Codex | Minimum 0.162.1; generated profile 0.162.1 |
| Claude | SDK 0.3.296; Code minimum 2.1.287, tested 2.1.296 |
| Pi | SDK/AI 0.86.0 |
| OpenCode | Stock v2 2.0.18; Linux integration |
| ACP SDK | 1.3.0 |
| Capacitor core/Android/CLI | 8.4.3 |

Upgrade clients, server, execution sidecars, local workers, and separately copied
notification hooks together as described in the release notes. Migrations are
one-way. Released SQL remains unchanged; startup verifies migration checksums,
creates a pre-migration SQLite backup, and rejects databases newer than the
binary. Stop services before copying state; rollback requires the matching old
binary **and restored old state**. Installer activation rollback restores a
binary, not migrated data. Provider transcript/authentication stores require
their own backup. See [operations](../docs/operator/operations.md).

## Verification

Verification began on candidate `99f63492` after clean root and independent
server-runtime installs. All npm commands ran with `NODE_ENV` unset. Subsequent
changes to this record and PR references do not change the tested application.

| Gate | Result |
| --- | --- |
| Root `npm ci`; server-runtime `npm ci --ignore-scripts` | Passed |
| Typecheck and production build | Passed |
| Version, changelog, docs, agent-tool contracts, E2E timing manifest | Passed through typecheck/build |
| Codex protocol/generated runtime, ACP, Grok static source/profile | Passed |
| Sidecar, Pi worker, Claude worker build repeatability | Passed |
| Production third-party notices | Passed after regeneration; 616 packages, 244 license texts; pruned Claude executables excluded independently of build host |
| Notice generation regression | Passed; Linux/Windows fixture installs produce identical notices while retaining the SDK license |
| Full deterministic unit/integration suite | 16,335 passed, 24 skipped, 3 timeout failures in 660.02s; all three unchanged cases passed in a single-worker recheck (24.46s), yielding 16,338 passing cases across the run and recheck |
| Full coordinated browser E2E and screenshot review | Passed: 143 tests, 48 jobs, default four lanes; 592.774s including build |
| Android assembled-package/native-unit verification | Passed: synchronized assets, native unit tests, instrumentation APK compilation, debug assembly, assembled-package policy checks; device/emulator instrumentation not run |
| Electron packaged application verification | Pending |

The notice generator retains the existing missing license-identifier warning for
`khroma` 2.1.0; collected license text is included. Existing build warnings concern
CSS `::highlight` parsing and large browser chunks.

Browser artifacts remain local under `test-results/e2e-runs/run-4c7y42/`.
Reviewed all 18 Pages/image, 27 voice, and 41 Tasks/Workpads screenshots, plus
eight composer, thread-reference, agent-tool, and in-flight streaming views;
no rendering failures found. Zoom crops, conflict warnings, and recovery states
match their deliberately injected scenarios.

The 592.774s browser run exceeds the 210s reference target but matches recent
local job timings; no browser tests changed during preparation. The longest jobs
were pending-input delivery (129.799s, local estimate 129.813s) and composer state
(125.198s, estimate 125.000s), exercising ordered/recovery state chains. Pages
took 83.424s (estimate 83.710s) for revision/local-resource isolation, retained
images, responsive viewports, and mobile interaction. Coverage and assertions
were retained; the target miss remains a known performance limitation.

No new live-provider suite is part of this release verification. Pi, Codex,
Claude, and OpenCode are **not live verified on this release candidate**;
their relevant suites are recommended additional gates before rollout. Grok
live testing is intentionally omitted because it is unused and unauthenticated.
Earlier authorized Codex work is evidence for its feature PR, not a substitute
for release-wide live verification. Fixture-backed TCP tests do not consume
model capacity and do not establish live-provider readiness.

Migration tests cover fresh databases, prior-schema upgrades including schema
108, project/task rebuilds, integrity, backups, and failure behavior. A
representative-state upgrade/restore rehearsal through the standalone installer
was not performed; this remains an operator rollout check.

## Dependency advisory dispositions

The release audit on 2026-10-14 is **not clean**. After the packaging patch,
`npm audit` reports the following vulnerable package records (including
meta-vulnerable parents, not distinct exploitable flaws):

| Dependency tree | Critical | High | Moderate | Low | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Root production | 1 | 4 | 3 | 3 | 11 |
| Root complete | 3 | 7 | 6 | 3 | 19 |
| Independent server runtime | 1 | 3 | 3 | 0 | 7 |

Capacitor Android was upgraded from 8.4.0 to 8.4.3 to fix the reachable
[internal HTTP proxy navigation advisory](https://github.com/advisories/GHSA-rvm3-566m-v7fv).
The installed patch blocks proxy navigation before plugin handling and rejects
document requests/disabled HTTP proxying. Core and CLI match Android at 8.4.3.
The top-level build-tool `brace-expansion` copy is patched to 5.0.12.

| Remaining package/owner | Reviewed disposition |
| --- | --- |
| Pi → minimatch → brace-expansion 5.0.9 | **Deferred trusted-configuration DoS risk.** Account or trusted-project resource-package filters can reach glob expansion. Pi's published shrinkwrap pins this copy; root overrides/outer-lock edits do not replace it on clean install, and Pi 0.86.1 also pins it. Retain the registry SDK rather than introducing ineffective overrides or repackaging the provider. This copy is not patched; [advisory](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr). |
| Express → proxy-addr | Affected IPv6 trust-subnet configuration is unsupported: application composition forces `trust proxy=false`. |
| concurrently → shell-quote | Development command orchestration only; fixed trusted script commands, absent from shipped server runtime. |
| MCP SDK OAuth client | SDK server exports are used; affected OAuth client/auth-fetch path is not used by Sedes. Native provider authentication runs in the provider binary. |
| AJV/MCP → fast-uri | Fixed code-owned schema resolution, not URL fetching or host-policy authority. Both root and independent-runtime versions audited. |
| css-tree/build tools → source-map-js | Runtime CSS uses SourceMapGenerator/plain CSS output, not affected indexed SourceMapConsumer. Independent runtime copy is patched. |
| Capacitor CLI → xmldom | Build-time native/operator configuration parsing; no runtime XML endpoint. |
| PostCSS/Vite → nanoid | Build only; ordinary generator with nonzero size, not affected custom-generator use. |
| jsdom/Vitest → undici | Test only; production Pi copy is patched. Node's separately bundled undici is not covered by npm audit; production Sedes sockets import `ws`, while an Electron fixture uses global WebSocket. |
| MCP helpers → Hono/ip-address | Affected HTTP/rate-limiter/subnet helper branches are not used by Sedes' SDK server integration. |
| Express/Supertest → qs | Application uses the simple query parser and JSON bodies; affected qs/urlencoded parsing is not enabled. |
| Mermaid → DOMPurify | String sanitization, not affected Node in-place mode; strict locked configuration and SVG validation remain enforced. |
| Mermaid/KaTeX | Advisory requires prior prototype pollution; none established here. Locked configuration and SVG insertion checks reject executable/foreign markup. |
| Vitest/mocker/coverage | Development runner only, invoked non-listening with `vitest run`; no public mock-server deployment. |

These dispositions describe the supported application paths, not a guarantee
that vulnerable packages are safe in other uses. Provider updates and newly
enabled integration paths require renewed review. No blind `npm audit fix`,
SDK vendor patches, or postinstall rewrites were introduced.

## Review and publication

The Windows fix was reviewed iteratively with Keel `claude-default` before PR
#79 merged. The separate release review found platform-dependent notices for
Claude executables that packaging discards. The generator now excludes those
packages, with a passing Linux/Windows fixture regression. A second follow-up
verified the corrected compliance preamble and returned no findings. Release
preparation is reviewed in [PR #80](https://github.com/kcosr/sedes/pull/80).
Public issue/support/security destinations remain documented in
[CONTRIBUTING](../CONTRIBUTING.md) and [SECURITY](../SECURITY.md); the source
license is [LICENSE](../LICENSE), with dependencies in
[THIRD-PARTY-NOTICES](../THIRD-PARTY-NOTICES.md).

Expected publication: [v0.2.0](https://github.com/kcosr/sedes/releases/tag/v0.2.0).
The publication command verifies clean synchronized `main`, exact versions,
dated notes, and annotated-tag identity. Publication does not restart or upgrade
the current live installation.
