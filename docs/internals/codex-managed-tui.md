# Managed Codex TUI

Sedes can run an interactive Codex terminal for an existing Codex thread
through the provider feature `codex.tui@1`. The terminal is another client and
presentation of the same native conversation. It is not a general-purpose
shell, a second backend, or a copied thread.

The Codex backend owns the native command, endpoint, credentials, thread ID,
terminal process, and repaint interpretation. The browser receives only a
normalized lifecycle projection and an authenticated, bounded byte carrier.

For the user-visible Chat/TUI workflow, composer behavior, and mobile controls,
see [Provider features for users](../user/provider-features.md#managed-tui).
For target topology and runtime setup, see the [Codex operator
guide](../operator/backends/codex.md#managed-tui).

## Eligibility and capability gating

The Chat/TUI switch is projected only when the exact thread, target, runtime,
and execution environment can prove all launch requirements:

- the thread is durably bound and its first submission established a resumable
  native Codex thread;
- the shared app-server is ready on a positive runtime generation;
- the target uses an externally operated UDS or authenticated WS/WSS
  connection; a Sedes-owned stdio connection never qualifies;
- the host that owns the app-server client can prepare the operator-installed
  Codex command, process-visible endpoint, and an owned PTY in the same
  namespace as that endpoint. For a local target this is main Sedes through its
  execution-environment channel. For an SSH or outbound target it is the
  persistent sidecar, whose runtime channel must have negotiated the
  `codex_managed_tui@1` `tui.control` and `tui.execute` operations; the sidecar
  advertises that capability only when its optional native PTY binding loaded;
- the command reports a stable release at or above the supported `0.153.0`
  floor; and
- the desired seven-axis execution tuple is complete, currently allowed, and
  exactly representable by the CLI.

The backend model policy must be `catalog`. Allowlist and denylist policies
disable managed TUI because the interactive client can select and invoke a
model before Sedes has a per-turn authorization hook. Immediately before every
launch, Sedes checks the selected model and reasoning effort against an
uncached live daemon catalog.

The TUI is intentionally unavailable for empty drafts, owned-stdio targets on
every topology, runtimes whose sidecar did not negotiate the managed-TUI
capability, missing or incompatible CLI artifacts on the hosting environment,
custom or unresolved settings, and non-Codex backends. PTY support alone never
implies eligibility, and Sedes never reuses host paths across an execution-
environment boundary.

The persistent sidecar satisfies the executable, endpoint, secret, PTY, and
cleanup contract inside the remote namespace, so a remote external target is
supported by hosting the terminal there rather than by reaching across the
boundary from main. An environment that cannot supply that contract stays
unsupported rather than partially enabled.

Every deployment uses the same backend rule. Sedes uses `tuiExecutablePath`
when the operator configures one; otherwise it resolves the first executable
`codex` on the execution environment account's `PATH`. Electron Local does not package a
provider executable. A missing or incompatible command leaves managed TUI
unavailable while the server and ordinary backend connections remain available.

## Lifecycle state machine

The normalized lifecycle is closed:

| State      | Stream                          | Available operation |
| ---------- | ------------------------------- | ------------------- |
| `stopped`  | No                              | Start               |
| `starting` | No                              | Stop                |
| `running`  | Yes                             | Stop                |
| `stopping` | No                              | None                |
| `exited`   | No; exit status retained        | Start               |
| `failed`   | No; bounded diagnostic retained | Start               |

Start and Stop are durable provider-feature mutations with request
fingerprints, thread/feature revision checks, and receipts. Replaying an
accepted receipt never repeats the process side effect. An outcome that cannot
be confirmed remains recovery-required instead of being guessed or retried.

Active native work and queued Sedes input do not by themselves prevent Start
or Stop. Start resumes the same native thread; Stop closes only the managed
CLI/PTY. Neither interrupts an app-server turn nor consumes queued Sedes input.
Archival, binding transitions, uncertain operations, disconnected authority,
or other application gates can make controls read-only.

Launching has a ten-second deadline. Timed-out environment work is aborted,
and a PTY that arrives after the deadline is immediately closed. Failure is
projected explicitly; an empty terminal is never treated as success.

## Launch authority and process isolation

Every Start resolves and revalidates:

- server-derived tenant and principal scope;
- application thread, backend instance, target, execution environment,
  workspace, native binding, and runtime lease;
- the current positive app-server generation;
- the configured or PATH-resolved canonical executable and bounded version
  evidence;
- the desired execution tuple and live model admission; and
- the current TCP capability-secret generation, when applicable.

The backend launches `codex resume` for the exact native thread in the
canonical workspace and points it at the externally operated app-server. For a
sidecar-hosted runtime, main contributes only launch intent—revalidated
authority, settings, and any configured executable path—and the sidecar runs
the ordinary local launcher inside the remote namespace. Model,
reasoning, service tier, sandbox, network, approval policy, and reviewer are
passed as process-local overrides under strict configuration. Sedes does not
write global `config.toml`.

The same process-local profile disables automatic recaps, binds composer
submission to Enter, starts outside Vim mode, keeps alternate-screen support
enabled for Codex's full-screen overlays, and disables raw-output mode. Codex's
main surface remains an inline viewport by design. The profile also sets
`tui.disable_paste_burst=false`, which keeps Codex's burst detector enabled for
unframed rapid terminal input; Sedes Stage and Send use native bracketed-paste
boundaries and send the submission Enter outside those boundaries. These
overrides take precedence over account-owned Codex configuration because
terminal synchronization and the durable composer contract depend on them.

For authenticated TCP, the environment provider resolves a short-lived secret
capability. Its current value is copied into a dedicated child environment
variable immediately before spawn, referenced by the CLI's token-environment
argument, then discarded and removed from the launch environment. The secret
never enters browser state or the normalized protocol, and for a sidecar-hosted
terminal it is resolved and consumed entirely inside the sidecar; main never
receives endpoint secrets.

The PTY starts at 120 columns by 40 rows with `xterm-256color` and true-color
advertisement. Process cleanup is environment-owned and bounded: one second for
graceful close, two seconds for terminate, then two seconds for kill. A
sidecar-hosted terminal is registered as a sidecar service resource, so a live
terminal blocks sidecar stop and upgrade admission until its processes are
positively closed; a close that cannot be proven is reported as an unproven
cleanup blocker instead of being assumed complete.

The operator-installed command is trusted under the server operating-system
account. Sedes canonicalizes it, requires a regular executable, and repeats the
bounded version probe on every Start, but does not hash or pin user-owned bytes.
Command replacement by that account remains inside the same trust boundary.

## Shared resource ownership

There is at most one managed TUI resource for a scoped Sedes thread. Its
binding fingerprint covers tenant, principal, thread, backend instance, target,
execution environment, workspace, native binding, app-server generation, and
opaque runtime lease.

Each Start allocates a monotonically increasing resource generation. A binding,
runtime lease, or app-server generation change fences and closes the prior
resource. Admission to an old generation never authorizes a replacement.
Stale runtime handles likewise cannot stop a newer resource. The host that owns
the processes performs that fencing, so a main-side lifecycle projection taken
while the sidecar attachment is down never terminates a surviving PTY.

One PTY reader fans output to all admitted viewers. Each viewer may send input
and resize the shared terminal; I/O is serialized at the resource. For a
sidecar-hosted resource that reader lives in the sidecar and reaches main as
bounded runtime events under a controller epoch; stale-epoch commands are
rejected. Closing the last browser socket detaches viewers but does not stop
the CLI.

Stop, binding replacement, or runtime retirement closes the shared process and
detaches all viewers; a host stops its terminals before retiring the
app-server. Main's own attachment is not process ownership. Losing or
rebinding the sidecar attachment, and a Sedes restart, rebind only presentation
and epoch: the sidecar keeps the native processes, geometry, and resource
generations, and main reconstructs viewer surfaces through the ordinary repaint
handshake rather than mirroring output history. A local resource has no
separate host, so application shutdown ends it with the server.

Output chunks, input, geometry, viewer queues, and replay work are bounded. A
slow or invalid viewer is detached without terminating the resource for other
viewers.

## Browser admission and WebSocket security

Terminal attachment is a two-step capability exchange. The browser first uses
a normal CSRF-protected request:

```text
POST /api/threads/:threadId/provider-features/codex.tui/terminal-admission
```

The server derives identity, resolves the bound running resource, and issues a
15-second, single-use random token tied to thread, viewer, and resource
generation. Only its digest is retained.

The browser then upgrades `/api/provider-feature-terminal` and offers:

```text
sedes.codex-tui.v1, <admission-token>
```

The server selects only `sedes.codex-tui.v1`. The second offered subprotocol is
admission material, not an application protocol. Upgrade handling repeats
Host, Origin, Fetch Metadata, installation ingress policy, and server-derived
identity checks, including the authenticated client bound to the admission.
The documented Android and private-network boundaries still apply; terminal
admission supplements paired-client authentication.

Token replay, expiry, wrong scope, wrong thread, wrong viewer, wrong resource
generation, malformed subprotocol offers, or a resource that stopped before
attachment all fail closed.

## Terminal carrier protocol

PTY output is carried in binary WebSocket messages. Browser-to-server control
frames are strict version-1 JSON:

| Control         | Contract                                            |
| --------------- | --------------------------------------------------- |
| `input`         | Base64url raw bytes, at most 64 KiB after decoding. |
| `resize`        | 2–512 columns and 1–256 rows.                       |
| `request_sync`  | Repaint at the resource's canonical geometry.       |
| `request_refit` | Install bounded viewer geometry, then repaint.      |

Server controls are `sync_started`, `ready`, `exit`, `resync_required`, and
`error`. Unknown keys, invalid types, unsupported versions, oversized frames,
invalid base64url, or out-of-range geometry are rejected. Backpressure and
buffer ceilings prevent an individual viewer from creating unbounded memory
growth.

A viewer is not input-ready merely because the socket opened. It must publish
dimensions, request a synchronized repaint, observe the terminal's repaint-end
marker, and receive `ready` for that geometry. A synchronization deadline is a
viewer-local failure. Reconnect obtains a new admission and full repaint; an
output tail is never treated as a complete screen.

`request_refit` changes the shared PTY geometry, so other viewers may need a
resync. Ordinary resize and repaint work is serialized with input against the
same resource generation.

## Browser presentation and composer contract

Chat and TUI use one floating view selector. Chat remains mounted while TUI is
visible so transcript state and scroll position survive switching. Returning
to Chat does not stop the resource. A historical `#turn=` focus is Chat-only
and temporarily suppresses the selector. View preference is browser-session
state, not thread authority.

The terminal is rendered locally with `ghostty-web`; theme, font size, and
scrollback come from Sedes settings. Keyboard input remains disabled until the
first complete synchronized repaint. Refit requests a new complete repaint,
and exit or failure remains visible with recovery controls.

Chat and TUI share the same durable composer draft. TUI selection changes only
the Send destination:

- **Stage** emits one explicit bracketed-paste frame with no submit Enter;
- **Send** emits one explicit bracketed-paste frame followed by exactly one
  carriage-return Enter; and
- an empty Send emits only that Enter for text already staged in the terminal.

Embedded bracketed-paste boundary sequences are neutralized before encoding.
The explicit boundary prevents Codex's rapid-input detector from interpreting
the final Enter as another pasted newline. TUI composer delivery never invokes
the normalized Chat delivery API.

Plain text and one resolved skill reference can be serialized. Attachments,
context excerpts, unresolved skill references, and Task references remain
durable draft data but cannot become terminal keystrokes, so TUI Stage and Send
fail closed while they are present. The complete atomic input—including paste
framing and final Enter—must fit 64 KiB. Oversized content remains intact and
can still use Chat's ordinary 256 KiB composer path.

After the terminal accepts a nonempty Stage or Send, the client clears only the
captured draft contribution through the revision-fenced draft API. Edits made
while the clear is in flight survive. A rejected terminal write keeps the
draft. If the terminal accepted input but durable clear fails, the captured
contribution is restored and the UI warns against blind resubmission.

On touch layouts, the key bar exposes Esc, Tab, Ctrl+C, arrows, terminal-focus,
and Stage. Terminal-focus owns IME routing to the PTY; the ordinary composer
remains the reliable draft entry surface. Rotation, backgrounding, and
connection loss require a fresh admission and synchronized repaint.

## Settings convergence

The desired tuple is documented in [Codex execution settings, Fast mode, and
Goal](codex-thread-execution-settings.md). The durable binding supplies the
workspace; neither the browser nor terminal selects an alternate root.

An accepted settings mutation commits desired state before Sedes sends the
strictly decoded experimental `thread/settings/update` request. No SQLite
transaction spans that RPC. The reviewed experimental allowlist contains the
single settings-update shape needed here; enabling experimental protocol
bindings is not permission to accept arbitrary methods or payloads.

If a running resource cannot converge after the durable change, the desired
tuple remains accepted and the TUI is failed with bounded guidance to start a
new generation. Sedes never leaves a terminal running with known-stale
authority or invents an alternate request shape.

## Security and ownership summary

- Installation scope owns backend topology, endpoint policy, executable
  registration, model policy, execution-policy ceilings, and ingress opt-ins.
- Tenant/principal scope owns isolation, receipts, admissions, resource keys,
  and browser authority. Browser-selected identity is never trusted.
- Thread scope owns the durable native binding, desired settings, feature
  projection, and resource generation.
- Execution-environment scope owns path meaning, executable preparation,
  endpoint translation, PTY topology, process identity, secrets, and cleanup.
- Provider-native IDs, credentials, notification shapes, PIDs, and process
  topology remain private to the Codex backend.

The managed TUI deliberately expands interactive authority: every admitted
viewer can type into and resize the one shared Codex process. The short-lived
admission proves access to the existing scoped resource; it does not create
per-viewer terminal permissions.

## Change checklist and verification

Changes must cover:

- every supported and intentionally unsupported topology;
- first-bind, catalog-policy, settings-completeness, and runtime-generation
  eligibility;
- executable path/version and endpoint/secret assurance;
- launch timeout, late-process disposal, exit, failure, Stop, runtime release,
  and shutdown cleanup;
- durable receipts, replay, conflicts, and recovery-required outcomes;
- binding and resource-generation fencing, multiple viewers, and stale
  admissions;
- strict WebSocket admission, frame validation, byte/geometry bounds, and
  backpressure;
- repaint, refit, reconnect, timeout, rotation, and background recovery;
- settings/Fast convergence and failure fencing;
- composer paste framing, boundary neutralization, draft preservation,
  structured-input refusal, and 64 KiB enforcement; and
- desktop, touch, coarse-pointer, theme, focus, and screen-reader behavior.

Use the deterministic unit, integration, client, and coordinated E2E commands
in [Development and testing](../developer/development.md). The real Codex and
real managed-TUI suites use authenticated external services and require
explicit user authorization; deterministic TUI fixtures do not constitute live
provider verification.
