# Backend development

This is the entry point for adding a provider backend or changing behavior that
touches a provider boundary. The normative contract is
[Backend integration contract rules](../internals/backend-integration-contract-rules.md).
Read that document completely before implementation; this page is a navigation
and workflow summary, not a replacement for it.

## The boundary

Sedes compiles Pi, Codex, Claude, and Grok behind normalized contracts. A
backend owns its SDK/protocol types, native IDs, history interpretation,
correlation, settings conversion, transports, and provider process topology.
The browser consumes only normalized shared protocol types or a closed,
versioned provider-feature envelope.

Provider modules live under `src/server/backends/<backend>/`. Shared production
registration is in `src/server/backends/compiled-module-catalog.ts`;
principal-scoped module runtime initialization and shutdown are composed from
`src/server/production-application.ts`. Shared conversation code must not
import a provider SDK or parse a provider event.

## Before implementation

1. Define the provider's durable identity scope. Native conversation IDs are
   unique only inside the backend instance and execution-environment boundary.
2. Define supported execution environments and transport ownership. A backend
   cannot turn an unadmitted path or arbitrary connection string into
   authority.
3. Map each required normalized capability to implemented, intentionally
   unsupported, or unavailable behavior.
4. Decide how create/bind, attach, history, gap-free live observation,
   submission, cancellation, recovery, discovery, and shutdown work.
5. Decide how provider settings, items, interactions, usage, errors, and output
   artifacts normalize without exposing native identifiers or raw frames.
6. Identify configuration schema, checked-in example, startup preparation,
   model policy, health, advisories, and operator documentation changes.

Unknown discriminants and unsupported operations fail closed. Capabilities
describe what works now; client code must not infer support from provider name,
model ID, transport, or transcript wording.

## Classify the change

| Change class | Required scope |
| --- | --- |
| Private provider correction | Keep the code and fixtures inside that backend; confirm normalized output is unchanged or deliberately updated. |
| Normalized contract change | Update the shared contract and audit all four compiled backends plus every browser/server consumer. |
| Provider-feature envelope change | Update the registered server envelope, strict version/schema, client renderer, unknown-version behavior, and only the backend that owns it. |
| Execution-environment or transport change | Audit local and SSH authority, target compatibility, lifecycle ownership, unavailable behavior, and sidecar implications. |
| History, projection, or event change | Audit baseline/live handoff, ordering, identity, pagination, replay, resnapshot, cancellation, restart, and byte/count bounds. |
| Attachments, tools, forks, interactions, or artifacts | Read the matching internals contract and give every backend a tested supported/unsupported disposition. |
| Configuration or model-policy change | Update strict parsing, examples, startup validation, fingerprint/persistence behavior, advisories, and operator docs. |

## Module anatomy

Names vary by provider, but a complete module typically has these concerns:

| Concern | Expected home |
| --- | --- |
| Backend/module registration and normalized contracts | `src/server/backends/module.ts`, compiled catalog, and shared backend contracts |
| Provider SDK, RPC, ACP, CLI, or transport | Private backend directory |
| Native persistence keys and binding adapter | Private backend persistence/adapter code plus scoped Sedes repository contract |
| History and live-event interpretation | Private driver/projector code producing normalized turns and items |
| Provider-specific settings/features | Private adapter plus registered server/client provider-feature envelope when browser-visible |
| Configuration and model policy | Strict server configuration schema and a checked-in `config/*.example.json` |
| Deterministic evidence | Unit/integration fixtures shaped like the pinned provider protocol |
| Operator-facing setup and limits | `docs/operator/backends/<backend>.md` and backend index matrix |

Reuse normalized semantics when they are genuinely the same. Do not broaden a
shared type to carry one provider's raw payload. Do not add a provider-feature
envelope for behavior that can remain private or already has a semantic shared
representation.

## Cross-backend audit

A change to shared backend contracts, conversation lifecycle, settings,
attachments, artifacts, forks, interactions, agent tools, or browser feature
selection requires an explicit audit of every compiled backend. For Pi, Codex,
Claude, and Grok, record:

- implemented behavior and capability;
- intentionally unsupported behavior and its fail-closed result;
- unavailable behavior caused by current target/environment configuration;
- deterministic tests for each disposition; and
- operator/user documentation impact.

Silence is not an unsupported disposition. A provider that cannot implement a
feature must advertise that truthfully and reject direct attempts rather than
falling through to another backend's behavior.

## Verification

During development, run the focused backend, lifecycle, projection, persistence,
and configuration tests. Before handoff, run the normal deterministic sequence:

```sh
env -u NODE_ENV npm run typecheck
env -u NODE_ENV npm test
env -u NODE_ENV npm run build
env -u NODE_ENV npm run test:e2e
```

Backend protocol, streaming, history, lifecycle, tool, interaction, or provider
integration changes also make the relevant real-provider suite useful. Those
suites consume provider capacity or touch authenticated external state and
require explicit authorization. If it is not run, state that clearly and
recommend the exact relevant gate. See
[Development and testing](development.md#live-provider-suites).

### Backend test matrix

| Surface | Deterministic evidence |
| --- | --- |
| Configuration/startup | Valid example, malformed/unknown fields, unavailable executable/endpoint, model policy, and clean resource disposal. |
| Create and bind | New native identity, immutable target/scope binding, receipt/retry behavior, and failure before durable binding. |
| Attach and history | Empty, bounded recent, older-page, targeted-turn, malformed native history, and restart reconstruction. |
| Live projection | Gap-free baseline/live establishment, ordering, duplicate revision handling, replacement/resnapshot, and terminal provider failure. |
| Input lifecycle | Submit, correlation, cancellation/stop, active-turn behavior, ambiguous delivery recovery, and unsupported input forms. |
| Settings/interactions | Round-trip supported settings, stale revision, invalid option, blocking response, and truthful unsupported capability. |
| Files/tools/attachments/artifacts | Correct environment and root, bounded staging/projection, wrong-scope denial, cleanup, and unsupported backend behavior. |
| Shutdown/recovery | Owned versus external process behavior, resource ordering, runtime eviction/rebuild, and unaffected-target isolation. |
| Browser exposure | Normalized capability-driven controls, strict provider-feature envelope parsing, and no native payload leakage. |

Fixture-backed tests should use provider-shaped evidence at the private boundary
and normalized assertions outside it. Live tests add confidence in the pinned
real provider; they do not replace deterministic error, race, and unsupported
coverage.

## Review checklist

- No provider SDK types, native IDs, frames, or event parsing crossed into the
  browser/shared protocol.
- Production composition and shutdown ownership include the module exactly
  once.
- Scope keys include tenant, principal, backend instance, and execution
  environment wherever native identity requires them.
- Projection establishment cannot lose events between baseline history and
  live observation.
- Pagination, replay, frame, payload, and whole-turn bounds remain enforced.
- Create, attach, submit, cancel, recovery, discovery, and unavailable-target
  behavior are explicit.
- Capabilities and provider-feature registration are truthful.
- Every compiled backend has an implemented or intentionally unsupported
  disposition for cross-cutting changes.
- Configuration examples and operator/user documentation match the code.
- Deterministic verification is recorded; live verification is described only
  when an authorized live suite actually ran.
