# Contributing to Sedes

Sedes is maintained primarily for its maintainer's own agent-development
workflow and is shared in case it is useful to others. It does not accept pull
requests. Please do not spend time or tokens preparing one; it will be closed
without review.

## Reporting problems and requesting features

- Report reproducible defects as
  [GitHub Issues](https://github.com/kcosr/sedes/issues). Include the commit
  or version, deployment shape, provider and version, steps to reproduce, and
  what you expected. Do not include credentials, provider transcripts, private
  paths, or security details in a public report.
- Use [GitHub Discussions](https://github.com/kcosr/sedes/discussions) for
  questions, feature requests, and to ask whether a change you would like to
  make fits the project. A discussion is not a commitment to accept or build
  the work.
- Report potential vulnerabilities privately. Follow [SECURITY.md](SECURITY.md)
  and never open a public issue or discussion for a security finding.

Support is best-effort; there is no response-time or compatibility SLA.

## How the repository is maintained

The rest of this page records the engineering and documentation policy the
repository is worked on under. It is reference for anyone reading or building
from the source, not an invitation to contribute code.

### Before changing anything

- Read the repository's `AGENTS.md` for project-specific engineering and test
  policy.
- Read the [Developer overview](docs/developer/overview.md) for the repository
  map and common change paths.
- Install Node.js 24.18 or newer and npm 11 or another lockfile-compatible npm.
- Install dependencies with `NODE_ENV` unset:

  ```sh
  env -u NODE_ENV npm ci
  ```

- Do not commit local state, credentials, provider sessions, generated build
  directories, packaged binaries, or test-result directories.

### Choose the right documentation

| Change | Required starting point |
| --- | --- |
| Client-only presentation | [Developer overview](docs/developer/overview.md) and relevant user guide |
| Shared API or browser protocol | [Architecture](docs/internals/architecture.md) and shared protocol guidance in the developer overview |
| Database or durable state | [Architecture: Persistence](docs/internals/architecture.md#persistence) and [Developer overview: Persistence and migrations](docs/developer/overview.md#persistence-and-migrations) |
| Provider transcript ownership or load performance | [Provider-owned conversation state](docs/internals/provider-owned-conversation-state.md) |
| Backend-specific behavior | Relevant [backend guide](docs/operator/backends/index.md) and [backend contribution guide](docs/developer/backend-development.md) |
| Cross-backend contract | [Backend integration contract rules](docs/internals/backend-integration-contract-rules.md) |
| Android or Electron | Relevant [client guide](docs/operator/clients/index.md) |
| E2E coverage | [E2E testing](docs/developer/e2e-testing.md) |
| Diagnostics | [Debug diagnostics](docs/developer/diagnostics.md) |

Provider SDK types, event parsing, native identifiers, and history
interpretation must remain private to their backend. Browser-visible contracts
must stay normalized and versioned. Do not introduce fallback parsers, alias
fields, bridge routes, or dual old/new contracts unless an explicit migration
requires them.

### Development workflow

1. Create a focused branch or linked worktree from current `main`.
2. Confirm the checkout is clean before starting and preserve unrelated
   changes.
3. Make the smallest coherent end-state change, including documentation and
   every affected backend disposition.
4. Run the proportionate focused tests during development.
5. Finish with the standard verification sequence when the change warrants it:

   ```sh
   env -u NODE_ENV npm run typecheck
   env -u NODE_ENV npm test
   env -u NODE_ENV npm run build
   env -u NODE_ENV npm run test:e2e
   ```

6. Inspect changed browser screenshots, including an in-flight streaming state
   when the UI changed.
7. Review the complete diff for generated files, secrets, local paths, and
   documentation drift.

Use the npm E2E coordinator rather than raw Playwright. Android and Electron
changes have additional verification commands documented in their client
guides.

### Live-provider tests

Commands matching `test:real-pi*`, `test:real-codex*`, `test:real-claude*`, or
`test:real-grok*` use authenticated provider installations or capacity. They
are not part of routine verification and require explicit authorization for
the relevant integration change. A handoff must say when relevant live
verification was not run.

### Documentation expectations

The repository contains only as-built documentation:

- User documentation describes visible tasks and limits in plain language.
- Operator documentation owns installation, configuration, deployment,
  backup, security, and provider prerequisites.
- Developer documentation explains how to navigate and change the repository.
- Internal documentation records durable authority, lifecycle, persistence,
  protocol, and recovery contracts—not branch history or implementation plans.
- Design proposals, plans, review evidence, screenshots from transient runs,
  test counts, and commit-specific handoffs are kept outside the repository.
  Landing a feature includes updating the as-built documentation; a design
  document is not a substitute for that.
- User- and operator-visible changes are recorded under `[Unreleased]` in
  [CHANGELOG.md](CHANGELOG.md) in the same change that lands them.

Run the link and anchor check after documentation changes:

```sh
env -u NODE_ENV npm run check:docs
```

## License

Sedes is distributed under the [MIT License](LICENSE).
