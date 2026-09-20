# Native terminal assets for the persistent sidecar

The sidecar JavaScript bundle and its native terminal addon are one release.
`node-pty@1.1.0` includes Darwin and Windows prebuilds, but its Linux addon is
compiled during installation. The Linux build uses N-API and needs no
`spawn-helper`; that helper is Darwin-only.

A successful build on a recent Linux distribution does **not** establish
compatibility with Rocky Linux 8. For example, this development container's
addon imports `GLIBC_2.42` symbols. Rocky 8 provides glibc 2.28. Copying that
addon to Rocky 8 will fail even when the CPU architecture and Node version
match.

## Artifact contract

`scripts/sidecar-native-artifacts.mjs` collects the actual native bytes and
returns two separate values:

- `nativeAssets`: release metadata safe to include in the sidecar manifest;
- `sources`: build-only paths and buffers to write alongside the bundle.

Each asset records its platform and architecture, its ABI requirements, and
each file's relative path, size, SHA-256, and mode. All files use mode `0500`.
Linux admits `native/linux-ARCH/pty.node` and records the Node module version
and minimum glibc version.
The glibc requirement is parsed from the binary's ELF version requirements;
it is never supplied as a claim in build configuration.

The collector prefers an explicitly supplied
`node_modules/node-pty/prebuilds/linux-ARCH/pty.node`. That directory must also
contain `sidecar-native.json` with its build's `nodeModuleVersion`, for example
`{"nodeModuleVersion":"137"}` for the currently verified Node 24 build.
Otherwise, on the matching Linux build host, it uses `build/Release/pty.node`
and reads the actual architecture/Node module version from `build/config.gypi`.
An absent architecture has no manifest entry. A malformed, mislabeled, or
symlinked artifact fails the build.

The bundled loader verifies platform, ABI, applicable runtime glibc,
file ownership/mode on POSIX, and digest before loading the addon. Windows
uses file type, link, and digest checks because POSIX mode/UID are unavailable. Node's dynamic
loader remains authoritative for further requirements such as libstdc++.
Terminal support must be loaded lazily: unavailable native assets cannot
disable sidecar management, Files, or provider connection capabilities.

For compiled Linux payloads, this release deliberately checks the recorded
Node module version. Relax that check only after verifying the
actual addon against every admitted Node line; do not infer it from the
JavaScript bundle's minimum Node version.

## macOS and Windows

The pinned `node-pty@1.1.0` package includes actual Darwin and Windows x64 and
arm64 prebuilds, so a Linux release build can package those platforms without
pretending to compile or execute them. `sidecar-native-portable.mjs` checks
Mach-O/PE architecture and reads the exported constant-return
`node_api_module_get_api_version_v1` function directly from each addon. The
reviewed upstream prebuilds declare Node-API 8; the collector records that
actual version, and the loader requires at least that runtime Node-API version.
Unknown executable formats or compiler instruction sequences fail closed.
A supported Node version still has to satisfy the sidecar JavaScript floor.
The system loader remains authoritative for OS/library compatibility.

Darwin admits exactly `pty.node` and executable `spawn-helper` beneath
`native/darwin-ARCH/`. Missing helpers fail packaging; both files are verified
before loading. Apple silicon and Intel get separate entries.

Windows admits exactly `conpty.node`, `conpty_console_list.node`,
`conout-worker.cjs`, and `console-list-agent.cjs` beneath `native/win32-ARCH/`.
The worker is bundled from the pinned dependency, and the console-list agent
verifies its native addon before loading. The PTY bundle resolves both helpers
through verified absolute paths, independent of the working directory or an
installed `node_modules`. Windows terminals require the built-in ConPTY API
(Windows 10 build 18309 or later). Older winpty and optional ConPTY DLL paths
are not admitted. This does not impose a terminal requirement on Files,
provider, or management capabilities.

Run the normal locked dependency install and `npm run build:sidecar` on the
native build host. No extra macOS/Windows PTY build is needed for these pinned
upstream prebuilds. Linux still builds its host addon during `npm ci`, or uses
the explicitly staged Linux prebuild described below. Process ownership helper
requirements are separate from PTY assets; see outbound sidecar operations.

The native packaging unit suite checks real Mach-O/PE metadata, required
helpers, tampering, and independent bundled PTY startup on its running platform.
A Linux run validates Linux execution and cross-platform packaging only;
macOS and Windows execution require native CI or operator validation.

## Building against a Rocky 8 sysroot

The checked-in RPM lock was built twice with Ubuntu Clang 21.1.8 and Node
24.18.0, yielding identical artifact SHA-256
`378286bb24688f1a65610e3cb1c4706cfa8ddd05d13d060bccbe654810b7f70b`.
The bundled PTY also ran under the locked Rocky loader/libc/libstdc++ with
Node reporting runtime glibc 2.28. This verifies baseline userspace
compatibility without changing the Ubuntu host; full remote-environment
integration is a separate check.

The reproducible route is a Linux x64 build using genuine Rocky 8 headers,
libraries, and GCC runtime objects. `scripts/build-sidecar-native-linux.mjs`
uses the host Clang compiler while explicitly disabling host standard include
and library discovery. It does not use symbol-version aliases or rewrite the
result's dependency requirements.

The preparation helper requires Python 3, curl, and system libarchive. It reads only
the [official Rocky repository](https://download.rockylinux.org/pub/rocky/8/)
and does not install packages on the build host. First resolve an exact lock:

```sh
python3 -B scripts/prepare-sidecar-rocky8-sysroot.py \
  --resolve --lock /absolute/path/to/rocky8-sysroot.lock.json
```

Review that file's exact package versions, URLs, and SHA-256 values. Resolution
selects matching x86_64 package families `filesystem`, `glibc`, `glibc-devel`, `glibc-headers`,
`kernel-headers`, `libstdc++`, `libstdc++-devel`, `libgcc`, and `gcc` from BaseOS
and AppStream, and records the repository metadata hashes. The `filesystem` RPM supplies
the distribution's `/lib64` to `/usr/lib64` layout. It fails if a
repository update supplies inconsistent compiler/libc package versions.

For the qualified baseline, materialize the checked-in lock into a previously
absent directory:

```sh
python3 -B scripts/prepare-sidecar-rocky8-sysroot.py \
  --lock scripts/sidecar-rocky8-x64.lock.json \
  --output /absolute/path/to/rocky8-sysroot
```

The helper verifies each RPM digest and extracts only headers, libraries, and
GCC runtime objects using libarchive. It never invokes RPM installation
scripts, a shell, or privileged operations. Absolute package symlinks are
rebased into the isolated root, while traversal, escaping links, and differing
file collisions are rejected. Failed downloads/extraction do not publish an
output sysroot. The lock is retained inside the result.

Reuse that same lock and compiler version for repeatability; resolving
whatever packages are newest is not a reproducible build. Keep the lock with
release build evidence. No RPM, sysroot, or generated binary belongs in Git.

Install Sedes dependencies with `NODE_ENV` unset and use the Node headers
matching the build interpreter. The following command expects the directory
containing `node_api.h` and `node_version.h`, not its parent:

```sh
env -u NODE_ENV node scripts/build-sidecar-native-linux.mjs \
  --sysroot /absolute/path/to/rocky8-sysroot \
  --node-headers /absolute/path/to/node-24.18.0/include/node
```

The default output is `node_modules/node-pty/prebuilds/linux-x64/`.
`--compiler /absolute/path/to/clang++` selects the compiler, and
`--output-directory /absolute/path` stages output elsewhere for distribution
to another build host. Copy all generated files into the exact prebuild
directory before running the normal sidecar build.

The script checks actual ELF architecture and requires a glibc floor no
newer than 2.28. It exercises addon loading plus PTY open/resize/close both on the build host
and under the sysroot's real glibc 2.28 loader before publishing the artifact.
The build Node executable must itself run against that baseline userspace. It records Node/provider versions,
compiler identity, source/header evidence, and the artifact digest in
`build-info.json`. The temporary compilation directory is removed on success
or failure.

Repeat the build and compare the artifact digest before admitting a new
toolchain/sysroot combination. Run the focused native packaging tests:

```sh
env -u NODE_ENV npx vitest run tests/unit/sidecar-native-artifacts.test.mjs
```

These tests launch only a local shell that prints a fixed marker; no provider
is used. The compiler's baseline-loader check must pass before admitting a generated
asset; ELF inspection and execution using only the newer host libc would not
substitute for it. Remote SSH and persistent-terminal integration checks
remain separate.

## Build integration

Pass `sidecarNodePtyPlugin(nativeAssets)` to esbuild and keep the bundle in ESM
format. Bundled CommonJS dependencies require a banner defining `require`
using `createRequire(import.meta.url)` and `__dirname` using
`dirname(fileURLToPath(import.meta.url))`. Source ownership validation must
explicitly admit the reviewed `node-pty` sources and their Node built-ins.
Write each collected source buffer with its declared mode and serialize only
`nativeAssets`, never build-machine paths or buffers.
