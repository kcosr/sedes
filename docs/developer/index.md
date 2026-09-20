# Developer documentation

This section is for contributors changing Sedes. Start with the overview, then
use the focused references for the part of the repository you are changing.

| Document | Use it when |
| --- | --- |
| [Developer overview](overview.md) | You are new to the codebase, deciding where a change belongs, or choosing tests. |
| [Development and testing](development.md) | You need installation, build, generated-contract, packaging, or live-provider commands. |
| [E2E testing](e2e-testing.md) | You are writing, running, scheduling, or reviewing Playwright coverage. |
| [Debug diagnostics](diagnostics.md) | You are investigating delivery, thread loading, seeking, or streaming performance. |
| [Backend development](backend-development.md) | You are changing a backend or a cross-backend feature. |
| [Sidecar native builds](sidecar-native-build.md) | You are rebuilding the portable Linux PTY assets or changing runtime admission for sidecar hosts. |
| [Release process](release-process.md) | You are preparing a source release or reviewing release readiness. |

## Normative design references

The developer guides explain how to work in the repository. They do not replace
the system contracts under [Internals](../internals/). In particular:

- read [Architecture](../internals/architecture.md) before changing authority,
  identity, persistence, projection, or execution-environment behavior;
- read [Backend integration rules](../internals/backend-integration-contract-rules.md)
  before any backend-facing or cross-cutting provider change;
- use the subsystem references under [Internals](../internals/) when changing
  attachments, agent tools, blocking interactions, forks, output artifacts,
  workspace files, remote workspace tools, or managed Codex TUI behavior; and
- use [Operations](../operator/operations.md) and
  [Configuration](../operator/configuration.md) for operator-visible runtime
  behavior.

Repository instructions in `AGENTS.md` are authoritative for every change.
The documentation here describes the current source tree; it is not a roadmap
or a compatibility promise for unimplemented behavior.
