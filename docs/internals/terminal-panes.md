# Application terminal resources

Sedes terminals are application-owned resources associated with one thread,
workspace, and execution environment. They are not conversation-backend
features and they do not extend the Codex managed-TUI carrier. A browser panel
is only a view of a terminal: closing every view does not stop the shell.

For user-visible controls, see [Terminal panes](../user/terminals.md). For
installation and recovery behavior, see
[Operating terminals](../operator/terminals.md).

## Client rendering

The client-local terminal preference owns cursor blinking for both these terminal
views and the separate Codex TUI renderer. It does not alter server terminal state,
controller leases, or provider contracts. Windows browser and Electron clients
default blinking off; other platforms retain their existing default.

`src/client/terminals/ghostty-render-scheduling.ts` isolates private Ghostty Web
0.4.0 render-loop access. With blinking off on Windows it cancels the idle loop
and coalesces output, selection, scrolling, and link-highlight invalidations.
Ghostty still handles resize and scrollbar animation paints. The adapter preserves
cursor notifications and removes its hooks and pending frame before terminal
reset, theme replacement, or disposal. Blink changes restore or cancel the loop
without reconnecting. Re-audit these private hooks when upgrading Ghostty.

## Ownership and identity

Every terminal repository key, receipt, admission, event, and filesystem path
includes the server-derived tenant and principal scope. The browser supplies a
thread or terminal reference, never tenant, principal, workspace, environment,
or initial-path authority.

The subsystem keeps four identities separate:

- a terminal resource is the principal-owned inventory and history identity;
- an incarnation identifies the one process start represented by that
  resource;
- an attachment identifies one WebSocket viewer; and
- a browser-local terminal tab references a terminal without owning it.

A controller lease grants one attachment input and canonical-resize authority.
Other attachments are observers. Transfer is explicit and increments the
controller epoch; a claim atomically demotes the old controller, so it never
depends on a release from another device. Focus does not steal control. Panel
layout, local viewport, selection, search, and scroll position remain
presentation state.

Each thread's client-local layout may contain one **Terminals** panel. That
container owns a bounded set of nested terminal tabs, each holding only a
terminal resource ID and stable producer ID. Reopening the same resource
activates its existing tab. Only the selected tab attaches; inactive tabs rely
on the server journal when selected again. Closing one tab or the whole
container never mutates the server terminal. This nested tab state is distinct
from the generic workspace tree that docks Chat, Files, and the Terminals
container.

The terminal starts in the thread workspace's canonical project directory.
That path is a launch location, not a confinement boundary. After startup the
shell can change directory and exercise the full authority of the local Sedes
account or remote Sidecar account.

## Runtime architecture

```text
browser terminal panel
       |
       | one-use admission + sedes.terminal.v2 WebSocket
       v
terminal HTTP/WebSocket gateway
       |
       v
serialized terminal actor ---- bounded checkpoint + checksummed journal suffix
             |
             +---------------- live headless xterm
       |
       v
interactive terminal environment provider
       |                                |
       +-- local PTY                    +-- Sidecar SSH PTY
```

The process owner is the sole live-process reader and orders output, resize, input,
attachment, control, termination, and exit events. For local PTYs that owner is the main actor; for remote PTYs it is the
persistent sidecar. It remains active with zero viewers and no upstream carrier. Exited, failed, and interrupted resources reopen
through a read-only sealed-history path without recreating a process.

The normalized browser contract does not contain provider-native IDs or
Sidecar frames. Pi, Codex, Claude, and Grok remain unchanged; terminal
availability is resolved from the thread's execution environment. Unsupported
environments fail before process creation and never fall back to the local
host.

## HTTP and WebSocket contract

The normalized HTTP endpoints are:

```text
GET    /api/threads/:threadId/terminals
POST   /api/threads/:threadId/terminals
GET    /api/terminals/:terminalId
POST   /api/terminals/:terminalId/admissions
POST   /api/terminals/:terminalId/actions/rename
POST   /api/terminals/:terminalId/actions/end
POST   /api/terminals/:terminalId/actions/delete
```

Create accepts a display name, an optional supported shell profile, and initial
geometry; thread, workspace, environment, and initial directory are resolved by
the server. Every mutation carries an idempotency receipt, and rename, end, and
delete also carry the client's expected lifecycle revision. A durable create
receipt contains only the terminal resource representation and never an
admission bearer token, so a first response and a replayed one both require the
client to request a fresh admission separately. Delete is accepted only after a
process-originated exit, failure, or interruption; opening a replacement shell
is an ordinary create that returns a new `terminalId`.

An admission request names the stable producer, the requested controller or
observer role, the pinned emulator family and version, and whether the view
restores from the current checkpoint or resumes after an already applied
sequence. The issued admission is one-use, short-lived, bound to the paired
management client, and returned with `Cache-Control: no-store`.

Terminal inventory also appears in the normalized application and thread
snapshot, so running counts and lifecycle changes reach sidebars without
opening a terminal WebSocket.

The data WebSocket is:

```text
GET /api/terminal
Sec-WebSocket-Protocol: sedes.terminal.v2, <admission-token>
```

The admission travels as the second subprotocol entry rather than a query
parameter, and compression is disabled. Control frames use a versioned binary
envelope; output and input chunks carry raw bytes rather than base64 JSON.
Client frames are `ack_output`, `ack_snapshot`, `input`, `resize`,
`claim_control`, and `release_control`. Server frames are `attached`,
`snapshot_begin`, `snapshot_chunk`, `snapshot_end`, `output`,
`resize_committed`, `input_result`, `control_changed`, `caught_up`,
`terminal_status`, and `resync_required`. Frame and snapshot sizes are bounded,
unknown required fields and protocol versions are rejected, and a malformed or
out-of-order frame closes the socket fail closed. Ending a terminal is only a
receipted mutation, never an unreceipted socket side effect. `terminal_status`
carries the lifecycle revision, the `exited`, `failed`, or `interrupted` state,
and the normalized public exit and failure fields. The actor journals and
broadcasts it before closing a live process stream and the history service
replays it on a sealed stream, so viewers never infer final state from socket
closure alone.

## History and attach reconciliation

SQLite stores scoped terminal metadata. A serialized ANSI checkpoint plus
ordered output, canonical resize, and final-status records in a checksummed
NDJSON suffix live under the application state directory. Input bytes are
deliberately absent because they may contain passwords or other secrets. The
headless emulator retains at most 20,000 scrollback rows; checkpoint
serialization chooses the largest tail that fits 8 MiB.

The actor checkpoints after 4 MiB of output, after 2,048 journal records, and
immediately after applying a `CSI 3 J` erase-scrollback sequence. It writes and
fsyncs the replacement checkpoint before replacing the suffix and advancing
the SQLite history floor. Reads verify both checkpoint and record checksums,
discard a harmless redundant prefix at or below the floor, and require the
remaining record sequence to be contiguous. This order makes each crash window
recoverable without presenting an uncommitted floor.

Actor mailbox ordering registers an attachment and captures journal head `H`
before later PTY output is processed. A fresh view receives checkpoint `S`,
the suffix `(S, H]`, and then live records after `H`. Output at that boundary
therefore appears exactly once. A transient reconnect with the same compatible
emulator can resume after its last applied sequence while that sequence is at
or above the current floor; otherwise it receives the current checkpoint.

`CSI 3 J` advances the same restore floor after the headless emulator has
applied the erasure. Consequently, a future fresh attachment cannot replay
pre-clear bytes. The client creates an incarnation-specific Ghostty host and
keeps it hidden until `caught_up`, preventing an old renderer or an intermediate
restore state from flashing when tabs change.

On a persistent execution host, the attached main server keeps a bounded live
delivery queue across scrollback erasure so it receives the erase and any
preceding resize in order. Consumed records are discarded as its read cursor
advances. Erasure invalidates old snapshot chunks immediately; detach or
controller replacement discards the delivery queue, and a new controller
starts from the current screen. Ordinary TUI clear-and-redraw output therefore
does not force connected browser panels to restore history or lose focus.

Controller input carries an incarnation, controller epoch, stable producer
identity, and contiguous input sequence. The actor keeps the producer's
high-water mark for the incarnation so a reconnect can distinguish a duplicate
from a gap. A provider acknowledgement means only that the local PTY or local
OpenSSH client PTY accepted the bytes; it does not prove a remote shell read or
executed them. An ambiguous write is shown as uncertain and is never retried
automatically. If reattach cannot prove acceptance, the user can explicitly
discard the unconfirmed input and its dependent suffix after acknowledging that
the bytes may already have reached the terminal.

## Persistence and failure truth

Local terminal process continuity ends with main Sedes. Startup marks reserved
local resources `failed/start_not_attempted` and former live local incarnations
`interrupted/server_restarted`; it never silently respawns them. Verified
checkpoint/suffix state remains retained, with only an incomplete final journal
line truncated on read.

Remote terminals belong to the persistent sidecar. Their exact principal,
environment, terminal resource, incarnation, and controller identities survive
main restart or carrier loss. The sidecar consumes output without a subscriber
and retains a bounded checkpoint and ordered output/resize/final-state suffix.
Attach snapshots a consistent head and subscribes to its suffix before input
is re-enabled. Main reconciles remote ownership instead of marking remote
resources interrupted merely because its prior process ended.

An orderly sidecar restart interrupts managed PTYs with confirmed cleanup. An
unexpected sidecar crash records lost continuity and unknown child liveness
unless independently proven. Unknown cleanup fences replacement; no `tmux`
adoption, shell respawn, or new resource identity is inferred from an EOF.

A remote terminal's final retained output is an unsettled result until durable
main handoff is acknowledged. Automatic replacement is blocked by live PTYs,
unacknowledged final state, or unknown cleanup. Runtime incompatibility does
not waive preservation: use an admitted management handoff or report blocked.

New persistent resources use `terminationEffect: end_process`. Explicit End
requires proven process cleanup before deleting state. Existing historical
`disconnect_transport` records preserve their original effect and closure
receipt; they cannot be silently reinterpreted as persistent process ownership.
No raw terminal input bytes are retained as history.

Checkpoint and journal publication are fail closed. The fixed first-release
ceilings are 8 MiB for the serialized checkpoint and 64 MiB for the current raw
journal suffix. A write, checksum, serialization, or quota failure that would
otherwise lose restore state stops the terminal instead of silently dropping
bytes.

## Security boundary

An application terminal is a general interactive shell. Exact Host and Origin
checks, one-use admissions, bounded frames, WebSocket compression
disablement, and tenant/principal scope checks protect the protocol but do not
sandbox the process. Terminal bytes, admissions, credentials, process IDs, and
Sidecar framing do not belong in logs.

Browser terminal integration provides no escape-sequence initiated clipboard
writes, automatic link opening, notifications, file downloads, image
protocols, or host integration. The browser renders with pinned `ghostty-web`.
Any Ghostty input callback emitted synchronously while server output is being
applied is discarded, so an observer renderer cannot return device-query
replies to the shell. The actor's live headless xterm instance is the sole
device-query responder and the source of the bounded ANSI restore checkpoint;
the browser renderer is never checkpoint authority.

Controller input is pipelined rather than stop-and-wait. A client may have at
most 24 frames or 128 KiB in flight and retains at most 256 frames or 256 KiB
including queued input. Cumulative producer high-water acknowledgements retire
the accepted prefix and immediately refill the window. Reattach rebases only a
suffix the server proves it has not accepted. An outcome-unknown write creates
an explicit reconciliation barrier and is never replayed automatically. A user
may clear that barrier only by explicitly discarding the unconfirmed retained
input after reattach; the discarded bytes are not transmitted.

Terminal APIs are not HTTPS-only; they use the same admitted HTTP/HTTPS policy
as other Sedes APIs. Direct trusted-LAN HTTP carries paired credentials and
terminal traffic without transport encryption. Its packaged-client origin
opt-in, wildcard listener, and exact trusted-LAN Host combination still applies.
Terminal admission requires a paired management client; the one-use upgrade
token is bound to that client and must not outlive its authorization. Host,
Origin, Fetch Metadata, and server-derived scope checks remain independent.
Prefer loopback, Tailscale Serve, or another private HTTPS boundary.

## Lifecycle interactions

- Archiving a thread does not terminate its terminals.
- Threads are archived rather than normally deleted. The database's
  `ON DELETE RESTRICT` relationships block removal of a referenced thread or
  workspace while any terminal row remains; there is no implicit terminal
  termination or history-cleanup orchestration for such a removal.
- Execution-environment changes apply through normal restart/configuration
  handling and never retarget an existing terminal to another environment.
- Closing a panel detaches only that client-local view. End is one receipted
  server mutation with separate durable intent and completion-evidence phases.
  Local and persistent remote End require confirmed process cleanup; historical
  Disconnect and remove requires confirmed owned-carrier closure, stored
  independently. Startup cancels
  an intent without its effect's required evidence and retains its resource;
  only an evidenced operation resumes resource and journal deletion. An exit, failure, or
  interruption originating outside that mutation remains retained for
  inspection; the user may explicitly remove it afterward. If the required
  completion cannot be confirmed, the End intent is cancelled and the failed resource remains
  visible with its verified history.
- Entering `stopping` revokes controller authority and is broadcast immediately.
  New attachments are observers, and claim, input, and resize are rejected unless
  the lifecycle is `running`. Successful End notifies and detaches every viewer;
  process-originated terminal states remain attached read-only.

## Backend and environment audit

| Surface | Disposition |
| --- | --- |
| Pi, Codex, Claude, and Grok backends | Unchanged; availability comes from the resolved environment |
| Codex managed TUI | Separate `codex.tui@1` feature and carrier |
| Local execution environment | Local PTY provider |
| Persistent Sidecar SSH environment | Admitted terminal capability, sidecar-owned PTY/incarnation, bounded output retention, and exact reattach |
| SSH UDS without a capable operations Sidecar | Unsupported, with no local fallback |

Persistent remote attachment uses explicit process/resource identity and
recovery evidence. Historical forced-TTY records never become durable merely
because a new sidecar supports persistent terminals.
