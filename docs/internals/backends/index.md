# Backend maintainer references

These documents define provider-private implementation contracts for the four
compiled backends. They cover wire/profile admission, runtime ownership,
history and live projection, mutation recovery, native identity, and
fail-closed behavior. They are maintainer references, not setup guides.

For installation, authentication, configuration examples, operator-visible
capabilities, troubleshooting, and live-suite safety, start with the
[backend operator guide](../../operator/backends/index.md).

## On this page

- [Backend references](#backend-references)
- [Contract map](#contract-map)
- [Required reading before a backend change](#required-reading-before-a-backend-change)
- [Shared internal references](#shared-internal-references)
- [Documentation boundary](#documentation-boundary)

## Backend references

| Backend | Maintainer contract | Operator guide | Native authority |
| --- | --- | --- | --- |
| Pi | [Pi internals](pi.md) | [Operate Pi](../../operator/backends/pi.md) | In-process pinned Pi SDK and native JSONL store |
| Codex | [Codex internals](codex.md) | [Operate Codex](../../operator/backends/codex.md) | Codex app-server protocol and provider rollout/store |
| Claude | [Claude internals](claude.md) | [Operate Claude](../../operator/backends/claude.md) | Pinned Agent SDK and Claude Code session/history APIs |
| Grok | [Grok internals](grok.md) | [Operate Grok](../../operator/backends/grok.md) | Reviewed Grok ACP dialect and native update journal |

## Contract map

This map records which internal contract each backend satisfies, not what the
product advertises. The
[operator capability matrix](../../operator/backends/index.md#capability-differences)
remains the authority for capabilities; never restate a capability here in
terms that could disagree with it.

| Concern | Pi | Codex | Claude | Grok |
| --- | --- | --- | --- | --- |
| Runtime ownership | SDK embedded in Sedes | Shared owned/external client generation | Local worker or persistent SSH/outbound SDK-query runtime on Linux/macOS | One owned process per resident session |
| History acquisition | Authoritative native branch | Closed legacy or paginated adapter | One SDK-owned authoritative acquisition per handle | Bounded native update pages and resident window |
| Mutation proof | Authenticated native markers | Method-specific protocol/history evidence | Reserved application identity plus SDK correlation/result | ACP prompt IDs plus native-history correlation |
| Native fork | Exact completed boundary; no isolated workspace | Exact completed boundary or provider snapshot | Idle exact completed boundary | Unsupported |
| Native output image | Unsupported | Completed in-band PNG `imageGeneration` | Unsupported | Completed local `ImageGen`/`ImageEdit` JPEG |
| Steer target | Exact active turn | Exact active turn | Conversation, via native next-priority delivery | Unsupported |

This table is a routing aid, not a substitute for each contract. Browser and
shared protocol code must never branch on these provider-native details.

## Required reading before a backend change

1. Read the repository's
   [backend integration contract](../backend-integration-contract-rules.md).
2. Read the relevant provider contract in this directory completely.
3. Identify every cross-cutting subsystem affected by the change: normalized
   protocol, capabilities, history, interactions, attachments, output
   artifacts, agent tools, execution environments, persistence, recovery, and
   diagnostics.
4. Audit all four compiled backends and record an implemented or intentionally
   unsupported disposition for each.
5. Update the operator guide only when installation, security, topology,
   capabilities, limits, or troubleshooting changes. Keep provider-private
   shapes and lifecycle algorithms here.

## Shared internal references

- [Architecture](../architecture.md)
- [Blocking interactions](../blocking-interactions.md)
- [Composer attachments](../composer-attachments.md)
- [Provider output artifacts](../output-artifacts.md)
- [Agent tools](../agent-tools.md)
- [Native fork lineage](../native-fork-lineage.md)
- [Workspace Files](../workspace-files.md)

## Documentation boundary

An operator page should answer: “What must I install, what is safe and
supported, how do I configure it, and what do I inspect when it fails?” A
maintainer page should answer: “Which native evidence is authoritative, how is
it normalized, what survives failure/restart, and where must the backend fail
closed?”

Do not copy long lifecycle or protocol blocks into both audiences. Link across
the boundary and keep the single normative statement in the maintainer page.
