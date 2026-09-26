# Blocking-interaction subsystem contract

Sedes presents provider approvals, application-owned decisions, and
structured questions through one backend-neutral blocking-interaction
contract. A provider still owns its native request and response protocol;
Sedes owns browser-safe identity, single-resolution authority, durable
mutation recovery where applicable, and the conversation-pane interaction
panel.

For the user-facing workflow, see
[Provider features](../user/provider-features.md). For backend implementation requirements,
see the [backend integration contract](backend-integration-contract-rules.md).
[Agent-tool environment decisions](agent-tools.md#access-boundary)
reuse this presentation but have different ownership and recovery semantics.

## Contents

- [Normalized interaction kinds](#normalized-contract)
- [Identity and response authority](#identity-and-response-authority)
- [Lifetime and application decisions](#interaction-lifetime-and-questionnaire-resolution)
- [Secrets and client presentation](#secrets)
- [Backend dispositions](#compiled-backend-audit)
- [Verification](#verification-surfaces)

## Normalized contract

The client presents pending input at the bottom of the active Chat or TUI view
without unmounting the transcript or composer. Questionnaires have no Sedes
timeout. Escape may invoke the separately authorized active-turn interrupt; it
never fabricates a response. Secret answers are masked and ephemeral. Pending
presentation survives navigation and reconnect while its owning runtime
generation remains alive.

This contract has three structured interaction kinds:

- `decision` is one selection from a bounded set of actions. Each action has an
  explicit `primary`, `alternative`, or `reject` role. The role is provider
  input, not a label or ordering heuristic.
- `questionnaire` is one to three ordered questions. A question is either a
  single choice with one to eight provider options, an optional synthetic
  Other option, and an optional note, or bounded text input. Multi-select and
  arbitrary JSON Schema forms are not part of questionnaires.
- `form` contains up to 32 labeled fields with normalized text, numeric,
  boolean, single-choice, or multiple-choice inputs. Choices have at most 64
  options. Required fields, defaults, bounds, and supported string formats are
  validated before submission and again by the server. Optional omitted values
  remain distinct from explicit empty strings, zero, and false. Provider schema
  and property names stay private; field and option identities are replaced by
  request-scoped browser IDs.

The primitive `choice`, `confirmation`, `text_input`, and `editor` kinds remain
available for provider extension UI that does not have these semantics. In
particular, a generic Pi selection does not become an approval because of its
wording, and Codex MCP form elicitation does not become a questionnaire merely
because it carries a schema.

Codex MCP form requests with no properties use `confirmation` with **Allow**
and **Cancel**, keeping the accepted empty object private to the adapter.
Nonempty supported schemas use `form`; they never fall back to an unstructured
JSON editor. Unsupported or oversized schemas fail closed. Invocation
parameters remain read-only alongside these controls.

The optional `invocation.arguments` field carries bounded, redacted tool-call
parameters for read-only display alongside any interaction kind. It is distinct
from editor `initialValue` and is never copied into the interaction response.
Context is owned by the exact pending request in its thread and runtime scope;
absence means the backend has not supplied it.

## Identity and response authority

Provider request, action, question, and option identities remain private to the
backend. The interaction broker replaces every nested identity with a random,
request-local browser ID and retains the reverse maps only in the current
server generation. Codex options, which have no native IDs, first receive
private positional IDs in the Codex adapter. Labels and positions are never
mutation authority.

Every response is resolved from the server-derived tenant, principal,
application thread, current interaction, and runtime generation. The broker
rejects a stale or cross-request ID, a duplicate nested ID, an action or option
belonging to another request or question, and a response kind that does not
match the open interaction. A decision contains exactly one selected action.
An explicit questionnaire response contains every question exactly once;
`unanswered` is an intentional answer state rather than an omitted array entry.

Interaction responses use the same operation gateway and, when their contents
are safe to persist, the same durable receipt and reconciliation path as other
conversation mutations. The browser disables the active surface after local
submission, but it does not dismiss it before authoritative provider
resolution. A proven-not-applied response can be tried again; an unknown
outcome remains fenced by the existing recovery contract. Multiple open
interactions retain broker order and are shown one at a time.

## Interaction lifetime and questionnaire resolution

An approval or questionnaire remains pending without a Sedes deadline until
the user responds, the active turn is interrupted or cancelled, a
[force reset](#force-reset-cancellation) abandons it, or the provider resolves
or withdraws the request. A provider's blocking hint may
describe its native turn behavior, but it does not authorize Sedes to expire
the request or submit unanswered questions after elapsed time. Sedes does not
publish countdowns, schedule interaction timers, or synthesize a questionnaire
response on the user's behalf.

Pending requests belong to the current backend runtime generation. They remain
available across browser navigation, reconnect, and arbitrary elapsed time
while that generation is alive. Sedes does not persist provider-native
callbacks across a server or provider restart; the provider must present an
outstanding request again in the new generation, at which point the broker
publishes it as a new pending interaction.

### Force reset cancellation

Force reset is the only path on which Sedes answers a provider interaction the
user did not answer. After the durable reset commits, the broker removes each
exact pending interaction the reset listed and sends every provider-owned one
the backend-neutral `cancel` response through the runtime that owns it. Sedes
waits at most 10 seconds in total for these cancellations and then replaces
the runtime, so a replaced or reattached runtime does not leave the provider
waiting on a prompt nobody can answer.

The cancellation is not a user response. It records no receipt, is never
reported as provider success, and never blocks or undoes the committed reset.
Sedes ignores a cancellation that the backend rejects, that fails, or that is
still unconfirmed at the bound. The request stays abandoned, a replay of it in
the same generation is dropped, and replacing the runtime releases whatever the
backend could not cancel. Application-owned decisions are rejected locally and
reach no provider. Each backend's disposition is listed in the
[compiled backend audit](#compiled-backend-audit).

### Application-owned environment decisions

A Sedes agent tool that reaches another execution environment under **Ask
before access** uses the same normalized decision panel, but the decision is
application-owned rather than a provider-native request. **Allow once** admits
only the exact resolved invocation and **Deny** rejects it; no provider identity
or durable interaction receipt is created. Sedes revalidates the application
approval runtime, source authority, policy, tool contract, input, resources,
and effects after approval.

The application decision waits indefinitely for the user. It is cancelled only
when the exact invoking request is aborted, its application approval runtime is
replaced, or Sedes shuts that runtime down. Browser navigation, disconnect,
or absence does not cancel it, and Sedes does not poll client connectivity.
Provider-native turn identity and origin are not authorization inputs.
Delegated agent-control work uses the destination thread's own environment
policy.

Submitting explicit `unanswered` answers lets the provider continue. Escape in
an ordinary questionnaire invokes the normalized active-turn interrupt when
available; it never fabricates an empty questionnaire response. A local note or
Other editor consumes Escape first when its visible behavior says it will close
or clear that editor.

## Secrets

Questionnaire secrecy is per question. Secret text and notes are masked while
editing and are not included in accessibility announcements, logs, notices,
diagnostics, or durable response payloads. A response is ephemeral only when it
actually answers a secret question. A questionnaire containing an unanswered
secret question may still use the durable operation path.
Accepted receipts discard the backend-targeted response according to the
existing interaction recovery contract.

## Conversation-pane panel

An open interaction appears in a compact panel at the bottom of the selected
Chat or managed TUI presentation. It has no full-pane scrim or blur. The
underlying presentation and composer remain mounted, visible, accessible, and
interactive outside the panel's own footprint, so draft and TUI state survive
and the user can still inspect or control the running turn.

The panel is a pane-scoped non-modal dialog with an accessible title and
description. Focus enters once per interaction ID but is not trapped, and it
returns to the prior meaningful control after the final interaction resolves
when that control still exists. Queue position, pending state, and bounded
errors are visible in the panel.
Desktop uses a compact panel; narrow displays use a bounded, safe-area-aware
bottom panel with touch-sized controls. Reduced-motion preferences apply.

Decision controls submit immediately: the primary action is the main split-
button action, alternatives are accessible menu items, and rejection is a
separate control or menu when several rejection actions exist. Enter and Escape
work when a truthful primary or sole rejection action makes the shortcut
unambiguous, but the UI does not label those keys. Decision prose uses ordinary
text and only an explicit normalized `code` payload is preformatted.
Questionnaires preserve each question's local draft, show one question at a
time, confirm intentional unanswered submission, mask secret input, and retain
ordinary Tab-operable controls alongside arrow and number-key shortcuts.

The runtime publishes a request as soon as the provider opens it during the
active turn. If that event races the runtime's first authoritative snapshot,
the interaction broker replays its current pending requests immediately after
the snapshot is established. A later run-state transition, interruption, or
turn stop is never required to make the panel appear.

## Compiled backend audit

### Codex app-server

- **Decisions:** implemented for command, file-change, and permission approvals.
- **Questionnaires:** implemented for `item/tool/requestUserInput`.
- **Forms:** implemented for supported MCP form elicitation schemas; empty
  schemas use confirmation. The `openaiForm` extension remains unsupported.
- **Invocation context:** implemented for MCP tool approvals with explicit
  `codex_approval_kind: mcp_tool_call` metadata and `tool_params`. The adapter
  normalizes those parameters without matching transcript items or prompt text.
- **Force-reset cancellation:** implemented where the native request can be
  cancelled or declined. Command and file-change approvals that offer Codex's
  `cancel` decision receive it, which also cancels the turn. Legacy approvals
  receive `abort`, permission requests an empty turn grant, and MCP
  elicitations `cancel`. A delivered cancellation completes on Codex's
  `serverRequest/resolved` confirmation. Questionnaires, and command
  approvals whose native choices omit `cancel`, have no native cancellation:
  the adapter rejects it, and the request fails when the replaced runtime
  releases it.
- **Private boundary:** strict app-server codecs, native request IDs, decision
  unions, positional option mapping, Other and `user_note: ` encoding, native
  `isBlocking`, server-request confirmation, and generation ownership remain
  under `src/server/backends/codex`.

### Pi SDK

- **Decisions:** implemented for the Sedes-owned mutating-tool approval
  extension.
- **Questionnaires:** intentionally unsupported.
- **Forms:** intentionally unsupported; Pi retains its existing primitive UI.
- **Invocation context:** intentionally omitted; existing approval details and
  primitive UI contracts remain unchanged.
- **Force-reset cancellation:** implemented. The request settles with the value
  Pi gives a dismissed prompt: the managed approval is not granted, so the tool
  is blocked; a confirmation returns false; and a selection or text input
  returns no value. Pi's durable response markers record it like any other
  response.
- **Private boundary:** the managed approval extension uses a dedicated bridge
  for approve-once or deny. Generic Pi UI methods retain primitive interaction
  kinds. Pi advertises no questionnaire capability and has no JSON or
  chained-dialog imitation.

### Claude Agent SDK

- **Decisions:** implemented for provider permission decisions, including
  bounded session grants.
- **Questionnaires:** implemented for supported `AskUserQuestion` shapes.
- **Forms:** intentionally unsupported; Claude does not advertise this kind.
- **Invocation context:** intentionally omitted; bounded tool input remains in
  the existing decision details.
- **Force-reset cancellation:** implemented. A permission request is denied
  ("User denied permission.") and an `AskUserQuestion` request is denied as
  cancelled, without interrupting the turn. Delivery completes when the direct
  SDK callback, the runtime worker, or the persistent host accepts the answer.
- **Private boundary:** SDK request/tool identities, permission updates,
  positional mappings, response encoding, and callback lifetime remain under
  `src/server/backends/claude`. Unsupported or oversized native shapes fail
  closed.

### Grok ACP

- **Decisions and questionnaires:** intentionally unsupported.
- **Forms:** intentionally unsupported.
- **Invocation context:** intentionally unsupported with provider interactions.
- **Force-reset cancellation:** intentionally unsupported. Grok opens no
  provider interactions, so force reset has nothing to cancel, and its
  `respond` rejects every response.
- **Private boundary:** Grok advertises an empty `interactionKinds` set. Sedes
  does not infer ACP permission or elicitation shapes, emulate them with
  messages, or expose a response route.

### In-memory conformance backend

- **Decisions and questionnaires:** intentionally unsupported by the backend.
- **Test boundary:** it advertises no kinds, so force reset has nothing to
  cancel. Fixture-only interaction journeys enter through the normalized test
  seam and create no provider contract.

Every compiled backend with an implemented interaction kind uses the normalized
broker, operation gateway, snapshots/events, interaction panel, and fail-closed
response validation. A backend with no advertised kinds does not enter this
runtime path.
Configuration, discovery, conversation identity, history projection,
pagination, usage, provider features, and runtime topology gain no
blocking-interaction-specific shape. Agent-tool environment decisions use the
shared application-owned path described above rather than a backend-specific
shape. Response receipts already store the backend-neutral provider-interaction
operation envelope, and secret-bearing responses already have an ephemeral
path.

## Verification surfaces

A backend or contract change in this area must cover:

- strict shared schemas, count/size bounds, unique nested IDs, opaque ID
  mapping, wrong-question and wrong-option denial, complete unanswered
  responses, secret-dependent persistence, and mixed open queues;
- response receipts, reconciliation, duplicate submission, stale generation,
  arbitrary elapsed-time durability, explicit cancellation, and
  user/provider-resolution races;
- force-reset cancellation of exactly the abandoned provider interactions, its
  bound, and tolerance of rejected or unconfirmed cancellations;
- each compiled backend's implemented and intentionally unsupported paths,
  including exact native decision/answer encoding and provider resolution
  confirmation;
- panel placement above Chat, TUI, and composer; non-modal visibility and
  interactivity, focus entry/return, shortcut scoping, menu keys, question
  navigation and drafts, pending and error recovery, mobile layout, reduced
  motion, and accessibility names;
  and
- the strict client protocol version, browser E2E journeys and changed desktop/
  mobile screenshots. Provider live suites are separate gated evidence and
  require explicit authorization.

Future backends may implement either high-level kind independently. They must
advertise only the kinds they can present, resolve, reconcile, and interrupt or
cancel truthfully; absence must remain capability-gated and fail closed.

## Related contracts

[Back to Internals](index.md) · [Agent tools](agent-tools.md) ·
[Backend integration](backend-integration-contract-rules.md)
