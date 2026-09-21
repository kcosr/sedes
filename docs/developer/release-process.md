# Release process

Sedes releases currently consist of an annotated `vX.Y.Z` Git tag and a
GitHub release whose notes come from `CHANGELOG.md`. GitHub provides source
archives for the tag. There is no npm publication, binary distribution,
container image, or deployment step. Local Android and Electron build previews
remain documented in their [Android](../operator/clients/android.md) and
[Electron](../operator/clients/electron.md) guides.

Preparation and publication are separate commands so version and changelog
changes can be reviewed before anything is published. Both require a clean
working tree and an `origin` pointing to `kcosr/sedes`. Run them with Node.js
24.18 or newer; publication also needs an authenticated GitHub CLI with release
access. Both commands accept `--dry-run`; previews read remote state but do not
write files, commits, tags, or releases.

When changing the helper, run `env -u NODE_ENV npm run test:release`. Its
disposable Git repositories and simulated GitHub CLI cover preparation,
publication preconditions, and retries without contacting GitHub.

## 1. Define the release

Record in the release issue or reviewed plan:

- release version and intended Git tag;
- source-only release scope;
- supported host platform and Node.js baseline;
- included backend/provider versions and protocol baselines;
- configuration schema and database schema expectations;
- upgrade and rollback boundary;
- known limitations and security boundary;
- whether any live-provider gates are authorized;
- release notes, license, support, and security-reporting destinations.

For the initial release, verify that repository metadata and public-facing
names agree. A `private: true` package is not evidence of a published npm
package, and a debug-signed APK or unsigned/unnotarized desktop bundle is not a
production-signed distribution.

## 2. Freeze the release candidate

Prepare the candidate on a dedicated clean branch/worktree. Ensure:

- all intended changes are committed and reviewable;
- no local state, credentials, provider sessions, `.pi-subagents/`,
  `.plannotator/`, `dist/`, `test-results/`, keystores, generated native
  runtime files, or package outputs are tracked;
- the lockfile matches `package.json` and installation succeeds with
  `env -u NODE_ENV npm ci`;
- configuration examples parse through the current strict schema;
- documentation describes the implemented end state and current limitations;
  and
- version, release notes, and `CHANGELOG.md` are finalized before tagging.

### Version, changelog, and tag

The product version is recorded in the root and Electron package manifests,
their lockfiles, the four Electron workspace packages, and
`src/shared/version.ts`. Android derives its version name and code from the
root manifest. `scripts/version.mjs` keeps these synchronized; private npm
packages still carry the product version. Browser protocol and provider
protocol versions change only when their own compatibility contracts require
it, not merely because a product release is cut.

On a clean preparation branch, preview and then prepare the initial release:

```sh
env -u NODE_ENV npm run release:prepare -- 0.1.0 --dry-run
env -u NODE_ENV npm run release:prepare -- 0.1.0
```

The initial changelog notes are literally `Initial release`. The helper sets
all product versions, dates the release entry with the current UTC date, and
opens a fresh Unreleased section in the same working-tree change. It does not
commit, switch branches, tag, push, or publish. Review and commit those changes
and merge through the normal PR workflow. If preparation fails after writing
files, inspect the diff and finish or restore those specific changes before
retrying; preparation requires a clean tree.

For subsequent releases, collect concise user- and operator-visible notes
under Unreleased, using Breaking Changes, Added, Changed, Fixed, and Removed
as applicable. Include the PR number or link before merging. Empty headings
are removed from released notes and retained in the new Unreleased template.
Choose either an explicit stable version or an increment:

```sh
env -u NODE_ENV npm run release:prepare -- patch --dry-run
env -u NODE_ENV npm run release:prepare -- patch
```

`minor` resets patch to zero; `major` resets minor and patch to zero. Explicit
versions accept an optional `v` prefix. Prerelease versions are not supported
by this workflow. Preparation refuses empty notes, existing release entries
or tags, and versions older than the current product version or no newer than
an existing release. The first release can retain the existing `0.1.0`
product version.

`npm run check:version` checks all version locations. For manual version
maintenance, `npm run version:set -- X.Y.Z` remains available. The `0.1.0`
compared in `scripts/verify-electron-package.mjs` belongs to the Capacitor
Electron platform and is independent of the Sedes release version.

## 3. Audit contracts and generated material

Run the deterministic contract checks relevant to the release:

```sh
env -u NODE_ENV npm run check:docs
env -u NODE_ENV npm run check:version
env -u NODE_ENV npm run check:third-party-notices
env -u NODE_ENV npm run check:agent-tool-contracts
env -u NODE_ENV npm run check:e2e-timing-baseline
env -u NODE_ENV npm run check:codex-protocol
env -u NODE_ENV npm run build
env -u NODE_ENV npm run check:codex-generated-runtime
env -u NODE_ENV npm run check:acp-protocol
env -u NODE_ENV npm run check:grok-source-routes
env -u NODE_ENV npm run check:grok-profile
env -u NODE_ENV npm run check:sidecar-build-repeatability
env -u NODE_ENV npm run check:pi-sandbox-worker-build-repeatability
env -u NODE_ENV npm run check:claude-runtime-worker-build-repeatability
```

`check:third-party-notices` fails when `THIRD-PARTY-NOTICES.md` no longer
matches the installed production dependency closure; regenerate it with
`npm run generate:third-party-notices` after any dependency change and review
the license survey it prints.

The standard typecheck/build gates already run several of these, including the
Codex generated-runtime check at the end of `build`. Listing them separately
makes the release audit explicit; the generated-runtime check requires the
fresh server build immediately above it.

Review any generated diff with its source version, manifest, hashes, release
evidence, and affected backend tests. Never regenerate a protocol baseline
only to make a check green without reviewing the pinned release change.

Dependency advisories are time-sensitive rather than deterministic. On the
release candidate, also run and record both the production and complete trees:

```sh
env -u NODE_ENV npm audit --omit=dev
env -u NODE_ENV npm audit
```

Trace every reported package to its direct owner and determine whether the
affected code is shipped, build-only, or unreachable in the supported shape.
Upgrade or record an explicit reviewed disposition before release. Do not run
`npm audit fix` blindly: provider SDK and packaging updates can change pinned
protocol or platform contracts and require their own review and verification.

## 4. Run deterministic verification

Start from a clean install with `NODE_ENV` unset:

```sh
env -u NODE_ENV npm ci
env -u NODE_ENV npm run typecheck
env -u NODE_ENV npm test
env -u NODE_ENV npm run build
env -u NODE_ENV npm run test:e2e
```

Record the commit, commands, result, host/platform, and material warnings. For
E2E, record the printed run directory, result, total duration, material
per-job changes, and screenshot review. The full suite must use the npm
coordinator and its isolated default schedule.

If the release changes a client or native project, run the corresponding gate:

```sh
env -u NODE_ENV npm run android:verify
env -u NODE_ENV npm run electron:verify
```

Android verification requires JDK 21 and Android SDK Platform 36. Electron
verification inspects the packaged boundary and launches the actual unpacked
current-platform application so its managed Local server and Electron-ABI
native modules must bootstrap outside the source tree.
Do not claim either platform verified when its gate was not run.

## 5. Decide live-provider verification

Real Pi, Codex, Claude, and Grok suites consume provider capacity or touch
authenticated external state. They are never implied by the deterministic
suite and require explicit authorization for the relevant backend.

For each backend materially changed in protocol handling, streaming, history,
lifecycle, tools, interactions, or integration behavior, record one of:

- the authorized live suite, exact command/profile, and result; or
- “not live verified,” with the recommended suite as an additional gate.

Do not weaken self-gates, change prescribed models/settings, reuse an existing
user conversation, or describe fixture-backed integration coverage as live
provider verification. See [Development and testing](development.md#live-provider-suites).

Generated-image canaries for Codex and Grok have additional environment gates.
Both consume model and image-generation capacity and leave a provider-native
session/thread retained after the test. Run them only when authorization covers
those effects, and record that impact with the result. The exact gates and
focused commands are documented in
[Development and testing](development.md#live-provider-suites).

## 6. Verify state and upgrade behavior

Before release, review every migration added since the prior supported release:

- applied migration SQL is new and checksum-locked rather than an edit to old
  SQL;
- fresh-database and relevant prior-schema migration tests pass;
- foreign keys, uniqueness, revision, tenancy, and integrity checks are direct;
- pre-migration backup behavior is preserved;
- operator documentation states stop/copy/restore requirements; and
- downgrade is not presented as supported.

Where possible, rehearse an upgrade using a disposable copy of representative
state. On Linux, rehearse through the installer as well: install the prior
release into a disposable prefix with `npm run install:server -- --prefix DIR
--bin-dir DIR`, start it against the copied state, then install
the candidate the same way, activate it, and confirm the health check and the
rollback path with `--activate`. Never use live production state as an
experimental downgrade target.
Provider-owned transcript/authentication stores need their own backup and
compatibility review; the Sedes overlay backup does not contain them.

## 7. Review release documentation

Read the release as a new operator and as a new user:

- `README.md` explains what Sedes is, its security boundary, supported
  providers, quick start, and documentation routes;
- [Getting started](../user/getting-started.md) reaches a first successful
  thread without internal knowledge;
- [Configuration](../operator/configuration.md) matches every checked-in
  example and the accepted schema;
- [Operations](../operator/operations.md) covers state, backup, restore,
  network exposure, startup, shutdown, and troubleshooting;
- provider and packaged-client guides state prerequisites and unsupported
  boundaries;
- [Architecture](../internals/architecture.md) matches production composition;
  and
- known limitations and live-verification status are explicit.

Run `npm run check:docs`, then inspect rendered headings, tables, code blocks,
and navigation. A link check cannot detect misleading placement or obsolete
prose.

## 8. Tag and publish

Complete and record the verification above against the final release commit.
The helpers check Git, version, and changelog consistency; they do not run the
application test suites or certify release readiness.

Once the prepared changes are reviewed and merged, and publication has been
requested, update the primary checkout without discarding local work:

```sh
git switch main
git fetch origin
git merge --ff-only origin/main
env -u NODE_ENV npm run release:publish -- 0.1.0 --dry-run
env -u NODE_ENV npm run release:publish -- 0.1.0
```

Use the actual selected version for subsequent releases. Publication requires
clean `main` to match the live `origin/main`, the package version to match,
and the latest dated changelog entry to contain notes for that version. It
creates an annotated tag at that exact commit, pushes only that tag, and
creates the GitHub release using those notes. It does not create commits or
push branch changes. A dated changelog entry records preparation; the remote
tag and GitHub release establish publication.

If publication fails after tag creation or push, rerun the same command at
the same commit. A matching annotated local or remote tag is reused; an
already matching GitHub release is reported as complete. Conflicting tags,
release notes, titles, drafts, or prerelease state are refused rather than
replaced. Authentication or API failures stop the command. If main has moved
since a partial publication, stop and inspect the existing tag/release before
manual recovery; do not move a published tag to the newer commit.

No build artifacts are uploaded. Any future binary distribution requires its
own defined packaging, provenance, verification, and signing workflow.

## Release record template

```text
Version/tag:
Release commit:
Tree clean:
Node/npm/platform:
Configuration schema:
Database migration range:
Deterministic verification:
E2E run directory and duration:
Screenshot review:
Pi live verification:
Codex live verification:
Claude live verification:
Grok live verification:
Android verification (if applicable):
Electron verification (if applicable):
Upgrade rehearsal:
Known limitations:
Documentation check:
Published locations:
```

Retain this record with the review evidence. It distinguishes
what was actually verified and published from what the repository is capable
of building.
