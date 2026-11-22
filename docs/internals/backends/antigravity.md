# Antigravity backend internals

The implementation is private to `src/server/backends/antigravity`. The browser
uses normalized backend contracts and the Antigravity brand, never ACP methods,
native database paths, protobuf records, or session identifiers.

## Ownership

Installation configuration selects executable/runtime compatibility. Principal
configuration selects the backend, connection, environment, model policy, and
defaults. A thread owns its desired model/reasoning/mode settings and opaque binding.
Native credentials, provider configuration, and transcript files belong to the
execution host. Bindings and submission signatures include tenant, principal,
backend, connection, execution environment, native namespace, workspace and
session identity. No browser-selected scope supplies authority.

Native namespaces identify the execution host and configured native store.
Two independent backend instances cannot claim the same native namespace.
Startup and execution environment overrides have explicit precedence; secrets
are resolved where the provider runs.

The native ownership claim reserves the entire execution environment for one
enabled Antigravity backend, regardless of configured profile path. Multiple
targets of that backend share the owner. This prevents default/explicit/symlink
profile aliases from bypassing duplicate-owner checks without filesystem I/O
during preparation. The signed binding namespace separately includes the
configured profile, so changing native stores cannot make an old binding valid
against a different profile. Distinct execution environments remain separate
execution authorities.

The versioned `antigravity.mode@1` feature saves exact next-turn native mode
preferences through principal-scoped, revision-checked application receipts.
Its closed actions expose only qualified values advertised in ACP's native
mode selector; submission rechecks that exact live selector before applying the
preference. Clearing the preference leaves the current native mode unchanged.
The feature deliberately reports desired state only, with no inferred effective
permission classification. Other backends do not advertise this feature.

## Transport and recovery

The reviewed shared ACP v1 binding owns framing, SDK validation and request
settlement. Antigravity owns negotiation and native interpretation. The same
host implementation runs locally and within the persistent SSH/outbound
sidecar. Remote adapters borrow exact runtime/owner generations and retain
operation outcomes and pending interactions independently of carrier lifetime.

Creation uses provider-assigned identity and never blind-replays an uncertain
create. Submission evidence authenticates exact input bytes and normalized
presentation against the complete scoped binding. Identical text is not an
idempotency key. Uncertainty remains unresolved until exact evidence exists.

An acknowledged event is not an acknowledged permission response. Attachments
carry the live pending-permission inventory independently of event replay.
Acknowledged mutation outcomes remain readable while the host is retained,
without keeping it busy solely for an already-applied receipt.

Native permission decisions opt into a lifetime-cancellable human wait rather
than the shared ACP binding's ordinary 30-second reverse-request deadline.
Authorization and response writes remain finite, reverse-request inventory is
bounded, and session authority is checked again before publishing a decision.
Taking longer to decide does not itself close the provider or its background
work. Stop, request cancellation, and owned shutdown still cancel pending waits.

## Native history

`native-projection.json` is the reviewed field projection of protobuf
descriptors embedded in official `agy` 1.5.14. Its descriptor provenance is
recorded separately from runtime version admission; runtime compatibility is not
an executable digest allowlist. The decoder bounds bytes, nesting, fields and
integers and rejects changed wire types for known fields.

Verify a qualification artifact with `agy --version`, then run
`node scripts/antigravity/check-native-projection.mjs /absolute/path/to/agy`.
This checks projected fields and complete descriptor hashes, including protobuf
edition metadata, without executing the provider. The explicit
`--refresh-provenance` option updates descriptor provenance only after reviewing
the selected artifact; it never expands the reviewed field projection.

The SQLite reader validates native `trajectory_meta.cascade_id` against the
session, exact workspace metadata against the binding, and file ownership and
path before reading a consistent read-only snapshot. `trajectory_id` and
`root_conversation_id` are not aliases for the current session ID. Unsupported
native formats fail closed. A history read never uses `session/load` or launches
a provider to reconstruct a transcript.

The portable sidecar uses Node's built-in SQLite reader, with a read-only
connection and an explicit read transaction. Its source-ownership audit admits
`node:sqlite` only from this provider-private reader. Application repositories,
other database importers, and native SQLite addons remain forbidden in the
sidecar bundle.

Native step indices provide stable timeline identities. Antigravity writes
incremental output to SQLite during streaming, so live and historical views
share one projection. Prompt completion requires terminal native response or
error evidence. A token-usage update, quiet interval, completed tool, or empty
activity inventory does not prove turn completion.

Typed system-message receipts can begin autonomous continuation turns without
an application submission. They never consume a pending user operation merely
because text or timing is similar. Native child linkage and terminal receipts
govern background quiescence; finishing a child-launch tool is insufficient.

Conversation-scoped steering uses concurrent ACP prompt requests. A native user
row can be staged without consumption. Sedes requires native execution/start
evidence before publishing it, and carries each signed operation correlation
when several consumed inputs share one response. Stop fences new admission and
drains its captured prompt set with repeated native cancellation until native
quiescence is proved. Only then can a retained cancelled outcome plus a fresh
native read return an unconsumed input as not sent. ACP callback ordering and
usage fields never substitute for that evidence.

## Cross-backend audit

Antigravity adds a compiled module, scoped persistence migrations, execution
configuration, normalized brand, Saved Agent and automation adapters. Existing
Pi SDK, native Pi, Codex, Claude, Grok and OpenCode retain their native protocols
and capabilities. No other backend parses Antigravity data. Unsupported
Antigravity operations return explicit errors and are absent from capabilities.

The [operator guide](../../operator/backends/antigravity.md) documents current
capabilities and upgrade requirements. Qualification uses fixture ACP peers,
native database fixtures, scoped persistence tests, transport disconnection
tests, and explicitly authorized disposable live conversations. Live tests must
never adopt an existing user session or expose cached authentication material.

Run the authenticated, opt-in stock-runtime suite only with explicit live
authorization. It selects an absolute executable and model, creates temporary
workspaces and fresh native sessions, references existing native authentication
without copying credentials, and deletes only its verified new session records
after proving owned process cleanup:

```sh
env -u NODE_ENV SEDES_RUN_LIVE_ANTIGRAVITY=1 \
  SEDES_LIVE_ANTIGRAVITY_EXECUTABLE=/absolute/path/to/agy \
  SEDES_LIVE_ANTIGRAVITY_MODEL=gemini-3.8-flash \
  SEDES_LIVE_ANTIGRAVITY_THINKING_LEVEL=low \
  npm run test:live-antigravity
```

Set `SEDES_LIVE_ANTIGRAVITY_GEMINI_DIRECTORY` only when the authorized execution
account uses a different absolute native profile directory. The separate
`SEDES_LIVE_ANTIGRAVITY_SSH=1` gate adds an actual loopback OpenSSH server with
new pinned host/client keys and a private temporary account home. It builds the
release sidecar, verifies background work and retained history after SSH loss,
and restores normal admission after controller replacement. This qualifies
the real SSH carrier and persistent service on one host; authentication and
executable availability on another machine remain that machine's responsibility.
The suite never changes the operator's SSH config or known-hosts file.
