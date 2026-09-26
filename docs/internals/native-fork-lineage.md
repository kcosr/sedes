# Native fork lineage

Every explicit fork is a durable child thread with immutable Sedes lineage.
Sedes does not create an ephemeral side-conversation mode or delete the child
when the user switches threads.

Fork creation copies only the provider-persisted history selected by the
backend's native branch operation. Sedes does not append a hidden prompt,
synthetic user message, or other model-visible reset instruction. The child is
published after its durable provider identity and opaque binding detail are
recorded and the lineage transaction commits.

This document defines the durable fork and ancestry contract. The broader
thread lifecycle is mapped in [Architecture](architecture.md), and backend
implementations must follow the
[fork requirements](backend-integration-contract-rules.md#creation-binding-and-forks).

## Creation and recovery

The creation attempt records the child-identity and provider recovery contract,
the creation correlation, and any known provider identity and binding detail.
A response-known child can be finalized directly after restart. A request whose
provider outcome is unknown follows the backend's declared recovery policy:
idempotent creation may retry the same identity, exactly reconcilable creation
requires authenticated provider evidence, and potentially unknown creation
remains fail closed.

An uncertain completed-turn fork may be adopted later only when authenticated
provider ancestry proves the exact parent and copied turn. A
`provider_snapshot_at_acceptance` fork has no exact application or provider
turn anchor, so a lost native-fork response is deliberately nonrecoverable:
discovery may identify and quarantine the correlated native child, but it does
not adopt that child or import it as an unrelated thread, and it never repeats
the fork RPC. The user can abandon the unresolved Sedes child.

Startup recovery runs after the server begins listening and logs each outcome.
It finalizes, locally and without a provider call, every fork whose provider
child was already returned: an identified attempt, or one awaiting recovery
that recorded the child's identity and binding detail. It retries only the
attempts a crash interrupted before a response, those still `prepared` or
whose provider call had started. It never aborts a fork: a definite failure it
finds becomes a visible recovery. Other attempts awaiting recovery wait for the
user.

An explicit recovery aborts the reservation only on a definite failure, one
that did not cross the provider submission boundary. On an attempt already
awaiting recovery, a retryable definite failure keeps the recovery instead,
because an earlier call may already have created the child. Every failure is
logged with its backend code and cause. The aborted result carries the
backend's diagnostic and a `restartable` flag. The flag is false when the
backend marked the failure futile (`forkRestart: "futile"`), because another
fork of the same boundary would fail the same way, and the UI then does not
offer **Start a new fork**.

**Discard this fork** abandons an unfinished fork explicitly without repeating
its provider call. It is offered while no provider child identity has been
returned and the creation is not in flight. It removes the reserved child thread
and publishes the replacement snapshot. An aborted or discarded fork keeps its
application-reserved native child identity, and discovery never imports a
provider conversation with that identity, so an orphaned provider child cannot
reappear under the source's title.

Provider markers and native IDs stay private. The browser sees normalized
lineage and transcript history but cannot supply or edit provider ancestry.

## Historical boundary carriers

Older Sedes releases wrote authenticated model-visible boundary carriers to
Pi, Codex, and Claude children. New forks never write them. Read projectors
continue to authenticate and hide exact historical carriers so existing
threads do not expose internal prompts in the transcript. Malformed, forged,
mixed, or duplicate reserved markers remain fail closed. This is historical
data interpretation, not an active fork contract or compatibility write path.

## Fork boundaries

Manual transcript forks use `selected_completed_turn`, including the selected
turn ID and expected revision. Pi and Codex can copy that exact completed turn
while later source work is active; Claude requires an idle source. The
provider-level `latest_completed` selector remains idle-only because it could
select a newer turn if the source settles during provider I/O.

Codex additionally advertises `latest_provider_snapshot`. Its native
`thread/fork` call atomically chooses the latest provider-persisted history at
acceptance. This boundary is recorded as `provider_snapshot_at_acceptance` with
a nullable application `sourceTurnId`; Sedes does not mislabel it as one exact
completed normalized turn. Pi and Claude do not advertise snapshot semantics,
so their generic fork action resolves the newest completed turn. A backend may
mark individual completed turns unforkable with a user-facing
`forkUnavailableReason`. The turn's fork button and fork capability show the
reason, and a fork that selects such a turn, including a latest-completed fork
whose newest completed turn is marked, fails with it rather than falling back
to an older turn. The agent
`thread.fork` tool remains an exact completed-turn operation. Grok does not
advertise fork capability, so both browser and agent-tool fork requests fail
closed before any native operation.

| Backend | Current native-fork disposition |
| --- | --- |
| Pi | Exact selected completed turn; idle-only latest-completed selection. |
| Codex | Exact selected completed turn and atomic latest-provider snapshot. |
| Claude | Exact selected completed turn while idle with no background work; idle-only latest-completed selection that fails on an unforkable newest turn. |
| Grok | Intentionally unsupported. |

Cross-backend review requirements are defined in
[Backend integration contract rules](backend-integration-contract-rules.md).
