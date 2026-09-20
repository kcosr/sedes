# Changelog

## [Unreleased]

### Changed

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
