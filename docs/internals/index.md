# Internals

These documents describe Sedes system design, authority boundaries, and
implementation contracts. They are written for maintainers and contributors;
for installation and everyday use, start with the
[operator](../operator/index.md) or [user](../user/index.md) documentation.

## Start here

| Document | Use it when |
| --- | --- |
| [Architecture](architecture.md) | You need the system map, authority model, lifecycle, persistence, or security boundary. |
| [Materialized application projection](application-projection.md) | You are debugging application-stream catch-up, checkpoints, folds, or projection eviction. |
| [Provider-owned conversation state](provider-owned-conversation-state.md) | You need the transcript-storage rationale, projection lifecycle, concurrency limits, or performance methodology. |
| [Backend integration contract rules](backend-integration-contract-rules.md) | You are adding a backend or changing a contract that reaches any compiled backend. |
| [Application terminal resources](terminal-panes.md) | You are changing terminal identity, actors, history, attachment, Sidecar, control, or panel ownership. |
| [Developer overview](../developer/overview.md) | You need the repository map, development workflow, or guidance on where a change belongs. |

## Backend designs

The cross-backend rules remain authoritative for shared contracts. These pages
describe how each compiled provider implements those contracts and where its
native authority begins and ends.

| Document | Scope |
| --- | --- |
| [Backend internals overview](backends/index.md) | Shared reading order and comparison of the four compiled backends. |
| [Pi internals](backends/pi.md) | SDK runtime, session storage, projection, delivery, tools, and local/SSH workspace behavior. |
| [Codex internals](backends/codex.md) | App-server transport, thread history, mutations, provider features, and supported topologies. |
| [Claude internals](backends/claude.md) | Managed Agent SDK worker lifecycle, session/history acquisition, permissions, delivery, and local/persistent SSH execution boundaries. |
| [Grok internals](backends/grok.md) | ACP process/session lifecycle, native history, permissions, artifacts, and owned-local boundary. |

## Conversation and provider contracts

| Document | Scope |
| --- | --- |
| [Provider-owned conversation state](provider-owned-conversation-state.md) | Canonical transcript authority, Sedes overlay state, attach/projection lifecycle, interoperability, and performance tradeoffs. |
| [Native fork lineage](native-fork-lineage.md) | Durable child publication, ancestry, fork boundaries, and recovery. |
| [Blocking interactions](blocking-interactions.md) | Questions, approvals, permission prompts, and other turn-blocking responses. |
| [Codex thread execution settings](codex-thread-execution-settings.md) | Codex desired/effective execution settings and policy. |
| [Managed Codex TUI](codex-managed-tui.md) | TUI eligibility, admission, transport, lifecycle, and terminal security. |
| [Provider output artifacts](output-artifacts.md) | Durable provider-generated images, byte authority, storage, and retrieval. |
| [Thread templates](thread-templates.md) | Template ownership, persistence, drift, repair, and thread-origin capture. |
| [Usage accounting](usage-accounting.md) | Recorded tokens and cost: evidence capture, selection, reports, backend dispositions, the analytics timeline, recovery, and limitations. |

## Context, files, and tools

| Document | Scope |
| --- | --- |
| [Workspace Files](workspace-files.md) | File-root authority, browsing, edits, Compare, and remote behavior. |
| [Composer attachments](composer-attachments.md) | Immutable input blobs, staging, delivery snapshots, and provider projection. |
| [Agent tools](agent-tools.md) | Thread-agent and principal-client callers, policy, invocation, and provenance. |
| [Workpads](workpads.md) | Shared documents, attributed revisions, scope authority, and synchronized human drafts. |
| [Pi remote workspace tools](pi-remote-workspace-tools.md) | Host-owned Pi with managed SSH workspace operations and context. |
| [Pi isolated workspace sandbox](pi-workspace-sandbox.md) | Allocation ownership, Bubblewrap boundary, workspace access, lifecycle, and handoff. |

## Reading conventions

- **Normative contract** means new code must preserve the stated invariant or
  deliberately update the contract and every affected implementation.
- **Capability** means support proven at the exact backend, target, topology,
  and runtime generation—not a guess based on provider name.
- **Application state** is Sedes-owned overlay data. Provider transcripts and
  native conversation identity remain provider-owned.
- Historical specifications and milestone evidence are not current behavior;
  production code, typed contracts, tests, and these maintained documents are
  the sources of truth.

When a change crosses subsystem boundaries, update every applicable focused
document instead of expanding the architecture map into a second copy of the
subsystem specification.
