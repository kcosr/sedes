# Sedes documentation

This documentation is organized by the job you are trying to do. Start with
one audience guide, then follow focused links instead of reading the repository
from top to bottom.

## Start here

| You want to… | Start with |
| --- | --- |
| Install Sedes and create a first thread | [Getting started](user/getting-started.md) |
| Learn the product and its daily workflows | [User guide](user/index.md) |
| Configure, deploy, back up, or upgrade a server | [Operator guide](operator/index.md) |
| Set up a provider | [Backend setup and support](operator/backends/index.md) |
| Build an Android or Electron client | [Preview client guides](operator/clients/index.md) |
| Understand and change the repository | [Developer overview](developer/overview.md) |
| Understand system authority and lifecycle | [Architecture](internals/architecture.md) |
| Understand transcript ownership and its performance tradeoffs | [Provider-owned conversation state](internals/provider-owned-conversation-state.md) |
| Add or change a backend-facing contract | [Backend development](developer/backend-development.md) |

## Find a user concept

| Concept or task | Documentation |
| --- | --- |
| Project, environment, target, Agent, template, thread | [Core concepts](user/concepts.md) |
| Drafts, Send, Steer, Queue, Stop, stashes, search, bookmarks, forks, recovery | [Conversations](user/conversations.md) |
| Groups, pins, sidebar views, snooze, settle, archive, prompts, Agents, templates | [Organize and reuse work](user/organize-work.md) |
| Files, Git Compare, context excerpts, links, attachments, output images | [Files and context](user/files-and-context.md) |
| Local and Sidecar SSH shells, panels, control transfer, and retained output | [Terminal panes](user/terminals.md) |
| Tasks and scheduled or manual automations | [Tasks and automations](user/tasks-and-automations.md) |
| Shared working documents, drafts, attribution, and revisions | [Workpads](user/workpads.md) |
| Tokens and estimated spend by time, model, effort, backend, and project | [Usage and spend](user/usage.md) |
| Models, settings, provider-specific controls, interactions, agent tools, TUI | [Provider features](user/provider-features.md) |
| Browser and application preferences | [Settings](user/settings.md) |
| Load failures, uncertain operations, unavailable targets, and recovery | [Troubleshooting](user/troubleshooting.md) |

## User documentation

- [User guide](user/index.md) — product map and recommended learning path.
- [Getting started](user/getting-started.md) — clean-host prerequisites, source
  installation, provider selection, and first successful thread.
- [Core concepts](user/concepts.md) — the small vocabulary needed to understand
  projects, targets, Agents, templates, and provider conversations.
- [Conversations](user/conversations.md) — composer lifecycle, active input,
  history, search, bookmarks, forks, and recovery.
- [Organize and reuse work](user/organize-work.md) — sidebar projections,
  inventory states, groups, prompts, Agents, and templates.
- [Files and context](user/files-and-context.md) — workspace Files, edits,
  Compare, excerpts, attachments, and output images.
- [Terminal panes](user/terminals.md) — local and Sidecar SSH shells,
  detachable panels, controller transfer, history, and interruption behavior.
- [Tasks and automations](user/tasks-and-automations.md) — task scopes, file
  references, scheduling, prechecks, and run history.
- [Workpads](user/workpads.md) — shared notes, synchronized drafts, attribution,
  and document history.
- [Usage and spend](user/usage.md) — the Usage page, its filters and views, and
  how to read recorded totals.
- [Provider features](user/provider-features.md) — model controls, approvals,
  questions, agent tools, skills, and Codex-specific features.
- [Settings](user/settings.md) — browser-local and principal-owned preferences.
- [Troubleshooting](user/troubleshooting.md) — safe responses to common visible
  failures and uncertain outcomes.

## Operator documentation

- [Operator guide](operator/index.md) — deployment choices, operating model,
  and the operator reading path.
- [Configuration](operator/configuration.md) — environment variables, strict
  installation bootstrap, principal Settings, offline import, and runtime lifecycle.
- [Connection model](operator/connections.md) — the client, provider-runtime,
  and execution-environment layers, their supported routes, and recipes.
- [Operations and security](operator/operations.md) — production lifecycle,
  state, backups, upgrades, private access, recovery, and troubleshooting.
- [Outbound hosts](operator/outbound-hosts.md) — connector download, HTTP/HTTPS
  pairing, host prerequisites, remote capabilities, and lifecycle.
- [Operating terminal resources](operator/terminals.md) — shell authority,
  Sidecar requirements, quotas, history, recovery, and network policy.
- [Automation CLI](operator/automation-cli.md) — inspect and manage thread
  automations from a source checkout or built CLI.
- [Backend setup and support](operator/backends/index.md) — provider selection,
  compatibility, authentication, and capability matrix.
  - [Pi](operator/backends/pi.md)
  - [Codex](operator/backends/codex.md)
  - [Claude](operator/backends/claude.md)
  - [Grok](operator/backends/grok.md)
- [Preview clients](operator/clients/index.md) — shared connection and release
  status for the source-build clients.
  - [Android](operator/clients/android.md)
  - [Electron](operator/clients/electron.md)

## Developer documentation

- [Developer guide](developer/index.md) — contributor reading paths and the
  complete developer documentation map.
- [Developer overview](developer/overview.md) — repository map, one request and
  thread lifecycle, ownership boundaries, and common change recipes.
- [Development and testing](developer/development.md) — dependency discipline,
  deterministic checks, generated artifacts, platform gates, and opt-in live
  suites.
- [Sidecar native builds](developer/sidecar-native-build.md) — Linux PTY assets,
  runtime ABI/glibc admission, and reproducible portable build procedure.
- [Backend development](developer/backend-development.md) — concise backend
  module anatomy and workflow before entering the normative contract.
- [E2E testing](developer/e2e-testing.md) — isolated coordinator scheduling,
  artifacts, timing baselines, and authoring rules.
- [Debug diagnostics](developer/diagnostics.md) — implemented, bounded server
  and browser diagnostics and the troubleshooting playbook.
- [Release process](developer/release-process.md) — source-release preparation,
  versioning, verification, artifacts, and handoff checklist.

Repository-level entry points include [Contributing](../CONTRIBUTING.md), the
[Security policy](../SECURITY.md), and the [Changelog](../CHANGELOG.md).

## System design and internal contracts

- [Internal documentation index](internals/index.md) — map of authoritative
  system and subsystem contracts.
- [Architecture](internals/architecture.md) — scopes, identities, composition,
  normalized boundaries, persistence, recovery, and security.
- [Provider-owned conversation state](internals/provider-owned-conversation-state.md)
  — why provider transcripts are not mirrored into SQL, how the live
  projection works, and the interoperability and performance consequences.
- [Materialized application projection](internals/application-projection.md)
  — per-scope projection, fold and epoch model, replay window, catch-up
  checkpoints, and idle eviction bounds.
- [Backend integration contract rules](internals/backend-integration-contract-rules.md)
  — normative cross-backend design and audit requirements.
- [Backend internals](internals/backends/index.md) — provider-private runtime,
  history, protocol, mutation, recovery, and authority contracts.
- [Agent tools](internals/agent-tools.md)
- [Workpads](internals/workpads.md)
- [Application terminal resources](internals/terminal-panes.md)
- [Blocking interactions](internals/blocking-interactions.md)
- [Composer attachments](internals/composer-attachments.md)
- [Workspace Files](internals/workspace-files.md)
- [Provider output artifacts](internals/output-artifacts.md)
- [Native fork lineage](internals/native-fork-lineage.md)
- [Thread templates](internals/thread-templates.md)
- [Pi isolated workspace sandbox](internals/pi-workspace-sandbox.md)
- [Pi SSH workspace tools](internals/pi-remote-workspace-tools.md)
- [Codex execution settings](internals/codex-thread-execution-settings.md)
- [Managed Codex TUI](internals/codex-managed-tui.md)

Version-pinned provider protocol evidence remains beside the generated or
captured artifact under `protocol/`. Code-local binding notes remain beside
their implementation. They are maintenance evidence, not user documentation,
and are intentionally absent from the ordinary user navigation.

## Documentation policy

- User and operator guides use present tense and describe implemented behavior.
- Developer guides explain repository workflows without replacing executable
  scripts, schemas, tests, or repository policy.
- Internal documents record durable ownership, authority, lifecycle,
  persistence, recovery, security, and protocol invariants.
- Plans, milestone notes, branch handoffs, review run IDs, test counts, and
  transient screenshots belong in Git history or private planning context.
- A detail should have one authoritative home. Other documents summarize it
  only enough to route the reader to that authority.

Code, strict schemas, checked-in configuration examples, and tests remain the
final authority when a documentation claim is ambiguous. Run
`npm run check:docs` after changing Markdown paths or headings.
