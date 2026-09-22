# Changelog

## [Unreleased]

### Breaking Changes

- Durable usage accounting replaces accumulated token/cost values in live
  snapshots. Requires matching browser and packaged clients using protocol 118.
  Migration preserves old Claude totals separately with unknown coverage.

### Added

- Record Pi, Codex, and Claude usage in the main database, with per-turn
  usage/cost details below replies and offline session totals in Session stats.
  Counts retain model/provider attribution, estimates, and incomplete-coverage
  labels; Grok reports accounting as unsupported.

### Changed

- New thread creation selects Custom by default, while explicit saved-Agent and
  template choices remain available. (#6)

### Fixed

- Show Pi, Codex, and Claude turn failure details with the current failed state,
  and retain quiet details on historical turns. Clear the current explanation
  when newer work starts; Pi retries do not leave a stale failure. Requires
  matching browser and packaged clients using client protocol 117. (#6)

### Removed

## [0.1.1] - 2026-09-21

### Breaking Changes

- `install:server` now requires a verified, extracted server package built with
  `package:server`, instead of a built root checkout. Previously installed
  releases must be rebuilt as dedicated packages before activation or rollback.
  Packages use an independent dependency lock, external Node 24.18.0+,
  source-built SQLite/PTY addons, offline activation, and extraction checks.
  Systemd unit creation and updates now require explicit `--systemd` on each
  install or activation; the former `--no-systemd` option is removed. Linux
  and macOS default to installation without service integration.
  ([#4](https://github.com/kcosr/sedes/pull/4))

### Changed

- Add explicit Electron `client` and `full` distribution profiles. Client keeps
  Direct/SSH connections without a bundled backend; full retains Managed Local
  with shared locked server dependencies and target-pruned native payloads.
  Both use separately installed Codex, Claude Code, and Grok executables.
  ([#4](https://github.com/kcosr/sedes/pull/4))

- Redesign Files Changes with a persistent changed-file navigator, automatic
  diff loading, local reading-position restoration, and separate current/history
  review controls. A compact toolbar opens comparison, View, and Review settings
  without shifting the diff; file counts and navigation sit with the files.
  Revision pickers show commit messages and dates, searchable branch groups,
  scoped history, and branch-comparison presets. Requires matching
  clients and managed sidecars with `workspace_files@8`.
  ([#1](https://github.com/kcosr/sedes/pull/1))

- Clarify Linux, macOS, and limited Windows standalone server support, add a
  Windows entry point, and identify Linux as the developer's primary server host.

- Refresh README examples with desktop conversations, bookmarks, inline diffs,
  and mobile thread and terminal screenshots.

- Make test-host discovery portable: Claude native fixtures use PATH or their
  explicit executable override, and sandbox checks use the current home and a
  temporary canary instead of personal configuration files.

- Point repository links and release tooling at `kcosr/sedes`; remove the local
  validation diary and personal test account name. The live Claude conversation
  test now discovers `claude` on PATH unless an explicit executable is supplied.

- Clarify connection diagrams with transport labels, separate client and
  execution SSH hops, and an outbound-host example showing process ownership.
  The README now identifies the developer's primary setup and most-used backends.

- Upgrade the embedded Pi SDK and integration profile to `0.86.0`, including
  the Electron local server. Pi now defaults to cost-aware cache warming
  during active runs and supports per-model compaction budgets in native
  settings. Custom provider extensions must support transcript-based prompts.
  ([#51](https://github.com/kcosr/sedes/pull/51))

### Fixed

- Keep pending messages queued and retry unavailable backends during startup,
  instead of preventing the server from starting.
  ([#4](https://github.com/kcosr/sedes/pull/4))

- Preserve the browser Host header in the development API proxy so same-origin
  mutations pass origin validation.
  ([Issue #2](https://github.com/kcosr/sedes/issues/2), [PR #3](https://github.com/kcosr/sedes/pull/3))

- Bound changed-file filters so long pasted input cannot interrupt saved Files
  navigation.
  ([#1](https://github.com/kcosr/sedes/pull/1))

- Keep historical review comments and reviewed flags off replacement comparisons;
  editing a historical comment no longer creates an unrelated current review.
  ([#1](https://github.com/kcosr/sedes/pull/1))

- Preserve interrupted status when Pi provider setup returns an error after
  cancellation, in both live output and restored history.
  ([#51](https://github.com/kcosr/sedes/pull/51))
- Preserve the global Pi cache-warming setting for remote and isolated
  sessions, including explicit opt-out. Refresh displayed usage for cache
  warming while idle and include known warming requests without creating
  assistant messages. ([#51](https://github.com/kcosr/sedes/pull/51))
- Electron local-server packages retain only the matching Pi native platform
  and architecture and reject foreign native payloads during verification.
  ([#51](https://github.com/kcosr/sedes/pull/51))

Initial release
