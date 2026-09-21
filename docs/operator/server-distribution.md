# Slim server distribution

Sedes can build a self-contained server package with Node kept external. This
is a build and installation interface, not a published binary release channel.
The runtime requires **Node.js 24.18.0 or newer**, with the same Node module ABI
recorded in `BUILD-INFO.json`. Updating Node within that ABI is independent of
Sedes; changing ABI requires a newly built package, including for rollback.

## Targets and native compatibility

| Target argument | Build host and runtime |
| --- | --- |
| `linux-x86_64` | Linux x64 with glibc |
| `linux-arm64` | Linux arm64 with glibc |
| `macos-x86_64` | macOS Intel |
| `macos-arm64` | macOS Apple silicon |

Build on the selected OS and architecture. Cross-compilation, musl Linux, and
Windows server archives are not supported by this command. Existing Windows
source and Electron workflows are unchanged. Target availability does not
certify every distribution: validate each artifact on its intended runtime.

Build prerequisites are npm compatible with the committed lockfile, Python 3,
make, a C/C++ toolchain supporting C++20, and headers for the running Node.
macOS requires Xcode command-line tools. `CC`, `CXX`, and `PYTHON` may select
the host toolchain. `--nodedir` selects an existing Node headers root; otherwise
the pinned node-gyp downloads/caches matching headers. Node must be on PATH.

Both `better-sqlite3` and `node-pty` are always compiled from source with the
locked build-time node-gyp and explicit Node version/architecture. Packaging
deletes prebuilds and old build outputs before invoking node-gyp, forces
SQLite compilation, and keeps only runtime addon outputs. This prevents
SQLite's loader preferring a prebuild compiled for a newer glibc. No dependency
lifecycle hooks run in the staged runtime. Build tools stay in the source
checkout, outside the release.

For **Rocky Linux 8**, Deployments must build on Rocky 8 using its mounted Node
24.18.0+ runtime and a suitable C++20 toolchain, then run the extraction checks
on that host. Its glibc 2.28 cannot load a library requiring glibc 2.29. Inspect
the recorded `nativeLibraries` output and all native runtime files on the
target. A package built on another Linux distribution does not establish
Rocky compatibility. Pi's retained upstream native payload must also pass
the target checks; recompiling SQLite alone is not a compatibility guarantee.

## Build and verify

From a clean committed source checkout:

```sh
env -u NODE_ENV npm ci
env -u NODE_ENV npm run package:server -- \
  --target linux-x86_64 --output /absolute/server-packages
```

The command rebuilds the application, checks dependency completeness,
installs the independent locked server graph, builds native addons, and
verifies both the staging directory and a fresh archive extraction. Outputs:

```text
sedes_<commit-UTC-timestamp>_<12-character-SHA>_<target>.tar.gz
sedes_<commit-UTC-timestamp>_<12-character-SHA>_<target>.tar.gz.sha256
sedes_<commit-UTC-timestamp>_<12-character-SHA>_<target>/
```

The unpacked release is retained for direct use. Existing output names are
never overwritten. Output must be outside the source checkout. Archives and
native binaries must not be committed.

On the deployment host, authenticate the artifact through your normal trusted
transfer channel, then verify the archive checksum and extracted package:

```sh
sha256sum -c sedes_<timestamp>_<sha>_<target>.tar.gz.sha256
tar -xzf sedes_<timestamp>_<sha>_<target>.tar.gz
node sedes_<timestamp>_<sha>_<target>/scripts/verify-server-package.mjs \
  --package "$PWD/sedes_<timestamp>_<sha>_<target>"
```

Verification checks file hashes, modes, relative symlinks, unexpected/missing
files, target and Node ABI. It creates disposable state and configuration,
starts the server on a loopback ephemeral port, fetches the browser HTML and
referenced JS/CSS assets, runs SQLite queries and migrations, spawns a real
PTY, imports backend/provider modules, loads sidecar/worker entry points up
to their argument guards, runs connector help, and requires graceful server
shutdown. It never opens an operator database or runs live providers. Worker
argument probes do not claim a sandbox session or remote transport was tested.
Use the repository's non-live tests for deeper protocol coverage.

## Contents and dependency maintenance

The release contains `dist/server`, `dist/client`, CLI entry points, shared
and internal modules, sidecar/connector bundles, Pi and Claude workers,
`node_modules`, the dedicated manifest and lockfile, `bin` launchers, sample
configuration, offline installer/verifier, license notices, `BUILD-INFO.json`,
`FILES.json`, and `SHA256SUMS`. Provenance records the source revision/branch,
commit and build times, toolchain, exact dependency revisions/integrities,
native build commands, linked libraries, validation checks and limitations.

Codex/Claude CLI executables, Electron, Android, source development
dependencies, source maps, foreign-platform optional/native payloads, and
compiler intermediates are excluded. The dedicated boundary is
`packages/server-runtime/package.json` and its independent lockfile. The
AST-based `npm run check:server-runtime` checks executable imports in server,
CLI, shared, sidecar, and worker source against exact runtime dependencies;
packaging additionally checks compiled modules. When imports or versions
change, update this manifest and run
`env -u NODE_ENV npm install --package-lock-only --ignore-scripts --prefix packages/server-runtime`,
then rerun the check and packaging verification. Root development, Electron,
Android, and provider dependencies remain separate.

The packaged sidecar contains native terminal support only for the selected
target. Heterogeneous remote hosts require separately prepared compatible
sidecar native payloads; this artifact does not advertise foreign terminal
support. Other backend/platform capability restrictions remain in effect.

## Installation, activation, and rollback

Installation is offline: it copies and verifies the dedicated package and
does not run npm or compile native addons. From the source checkout:

```sh
npm run install:server -- --package /absolute/extracted-release
```

Or use the installer shipped inside that release:

```sh
node /absolute/extracted-release/scripts/install-server.mjs
```

Linux defaults to a per-user systemd unit. On macOS pass `--no-systemd` and
operate `bin/sedes-server` with your own supervisor. Review the seeded
configuration before starting the service. Keep Node on the supervisor PATH.
The installer never starts or restarts a service.

Releases remain under `${XDG_DATA_HOME:-$HOME/.local/share}/sedes/releases/<version>`;
`current` switches atomically after verification. `--no-activate` stages only.
`--prefix`, `--bin-dir`, `--list`, `--activate VERSION`, and `--uninstall` retain
their existing meanings. `--force` can replace only an inactive same-version
release. Active releases are never overwritten. Application versions therefore
need to differ to retain both old and new builds for rollback.

Stop the service and back up complete application state, configuration, and
provider state as described in the operations guide before upgrading. To
roll back, restore the matching pre-upgrade state backup, then:

```sh
node /absolute/extracted-release/scripts/install-server.mjs --activate PREVIOUS_VERSION
systemctl --user restart sedes.service
```

Activation rechecks integrity, runtime compatibility, and isolated smoke
tests, including older candidates. A database migrated by a newer version
requires its matching pre-upgrade backup; switching binaries alone is not
a state rollback. Older installations without package inventories must be
rebuilt as dedicated packages before this installer can activate them.

## Operator agent executables

Install and authenticate Codex, Claude Code, and Grok independently for the
Sedes service account. Configure their executable paths in the corresponding
backend settings (and remote execution environments where applicable).
Sedes continues to pass the selected operator Claude executable to the SDK;
there is no bundled CLI fallback. Pi SDK libraries are included, while its
provider credentials and native state remain operator-owned. No provider
credentials, local configuration, or runtime state belong in a release.
