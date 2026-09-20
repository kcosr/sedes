# Operating terminal resources

Application terminal resources run interactive shells for Sedes threads.
They are stronger authority than passive transcript access: a local terminal
has the Sedes service account's process and filesystem permissions, and a
Sidecar SSH terminal has the remote SSH account's permissions. The project
workspace is only the initial CWD and is not confinement.

User controls are documented in [Terminal panes](../user/terminals.md); the
internal ownership and reconciliation contract is in
[Application terminal resources](../internals/terminal-panes.md).

## Supported environments

Local execution environments provide a PTY directly. A managed SSH operations
Sidecar provides a remote PTY only when its exact versioned
`interactive_terminal` capability is configured, advertised, and admitted.
An SSH UDS target without a capable operations Sidecar is unsupported, and
Sedes never falls back to a local shell for a remote workspace.

The persistent sidecar owns each remote PTY, process incarnation, input
controller epoch, and bounded output state. Its SSH connection carries commands
and output; it does not own the shell lifetime. Closing main Sedes or breaking
SSH does not end an admitted terminal. Reattach reconciles the same terminal and
process incarnation before allowing input.

OpenSSH configuration still owns account, key, host trust, port, ProxyJump, and
routing authority. The service launches the account login shell in the canonical
thread workspace. Missing or incompatible sidecar support fails closed without
a local shell or a dedicated forced-TTY fallback.

## First-release limits

This release has fixed, code-owned terminal limits rather than operator
configuration fields. The sidecar additionally enforces its own bounded runtime
and retained-state capacity while main is disconnected:

| Limit | Value |
| --- | --- |
| Active terminals | 8 per thread |
| Simultaneous viewers | 16 per terminal |
| Retained input-producer high-water marks | 64 per incarnation |
| Retained raw journal suffix | 64 MiB per terminal |
| Server emulator scrollback | Up to 20,000 rows |
| Serialized restore checkpoint | 8 MiB |
| Automatic checkpoint cadence | After 4 MiB or 2,048 journal records, and after `CSI 3 J` |
| One input message | 64 KiB |
| Client input in-flight window | 24 frames or 128 KiB |
| Client retained input | 256 frames or 256 KiB, including the in-flight window |
| Inbound WebSocket frame | 96 KiB |
| WebSocket buffered-output slow-viewer cutoff | 512 KiB |
| Per-viewer live replay queue | 2 MiB or 2,048 records |
| Per-viewer acknowledgement window | 256 KiB or 64 records, with a 15-second timeout |
| Provider pending-output failure threshold | 2 MiB; reads pause at 512 KiB and resume below 128 KiB |
| Geometry | 2–512 columns and 1–256 rows |
| One-use admission | 15-second lifetime |
| Termination ladder | HUP immediately, TERM after 2 seconds, KILL after 7 seconds, cleanup-unconfirmed failure after 9 seconds |

The only shell profile is the account's default login shell. Local startup uses
an absolute `SHELL` when present and otherwise `/bin/bash`; remote startup uses
the SSH account's login shell. Sedes supplies `TERM=xterm-256color` and
`COLORTERM=truecolor`, does not accept arbitrary browser-selected environment
variables, and does not log the process environment.

There is no automatic exited-history retention timer or terminal-specific
configuration environment variable in this release. Sedes periodically writes
a bounded emulator checkpoint and replaces the raw prefix with an ordered
journal suffix. If the 64 MiB suffix ceiling, checkpoint ceiling, or a storage
write fails, Sedes stops the shell and records a terminal failure instead of
silently discarding output.

## History, backup, and deletion

Terminal metadata is stored in `overlay.sqlite`. A checksummed serialized
checkpoint and checksummed NDJSON journal suffix are stored for each terminal
under `$APP_STATE_DIR/terminals` for main-owned retained state. Persistent remote
terminals also retain bounded state on their sidecar while main is absent. Back
up the entire main state directory and the relevant remote state under confirmed
quiescence; a main database-only backup cannot restore terminal history.

The headless server emulator retains at most 20,000 scrollback rows. After
4 MiB of output, 2,048 journal records, or an output `CSI 3 J`
erase-scrollback sequence, Sedes serializes the newest state that fits the
8 MiB checkpoint ceiling, atomically replaces `checkpoint.json`, and replaces
`journal.ndjson` with the suffix after that checkpoint. Checkpoint publication
precedes suffix replacement, so a crash can leave a redundant old prefix but
cannot require an uncommitted checkpoint. Reads verify the checkpoint checksum,
discard records at or below its sequence, and require a contiguous suffix.

`CSI 3 J` is significant because it expresses terminal scrollback erasure.
Sedes applies the sequence to the server emulator before checkpointing, so a
later fresh viewer cannot recover the erased prefix. Sedes does not parse the
shell command line; a `clear` implementation has this effect only when its
terminal output includes the erase-scrollback sequence.

Treat terminal history as sensitive. Output can contain source, filenames,
command results, and credentials printed by programs. Terminal input is not
retained by default, but shell programs can echo it into output. Preserve file
modes and ownership on backup and restore, and protect archives to the same
standard as provider credentials and workspace data.

**End terminal** is one receipted operation: Sedes marks deletion pending,
signals the process through its bounded ladder, waits for a terminal lifecycle,
then removes its checkpoint, journal, and metadata. The request waits at most
10 seconds; a pending response leaves the End operation active, with history
retained until real exit and cleanup evidence arrive. Retrying the same mutation
joins that operation. Restarting main while cleanup is unconfirmed cancels the
pending deletion and retains recovered history for explicit removal. Cleanup-unconfirmed failure
cancels deletion and retains the resource for inspection. A shell exit,
provider failure, or confirmed service interruption that happens outside an
End operation also remains as read-only retained history. Main or SSH loss alone
does not establish a remote process exit. **Remove terminal**
is the separate receipted deletion available for those already-terminal
resources. Do not manually edit or delete checkpoint or journal files; a
checksum failure or missing valid suffix is corruption, not supported
retention.

## Restart and transport recovery

Browser and panel disconnects do not affect process lifetime. Local terminal
processes remain main-owned: main restart marks their former live incarnations
interrupted and never silently adopts or respawns them. Their verified checkpoint
and contiguous journal suffix remain available read-only.

Persistent remote terminals survive main restart and SSH loss. The sidecar
continues consuming output with no viewer or upstream connection and retains
bounded screen/scrollback state. Reattach captures one consistent output head
and ordered suffix, including resizes, before granting a new input-controller
epoch. Stale input, control, or resize generations are rejected. Uncertain
keystrokes are never blindly replayed.

A sidecar service restart interrupts its managed PTYs after confirmed cleanup.
An unexpected crash records lost continuity and unknown child liveness until
recovery proves otherwise. Do not start overlapping replacement ownership based
only on transport closure. An unreachable Stop is not confirmed termination.

Final output from a terminal that exits while main is disconnected remains
unsettled until main acknowledges durable handoff or an explicit retention
policy permits removal. A safe upgrade cannot discard it, even when the runtime
protocol is incompatible. Preserve the handoff through the supported management
path or leave upgrade visibly blocked. An idle shell is still a live terminal
and blocks automatic replacement.

New remote resources use **End terminal**, requiring confirmed sidecar process
cleanup before history deletion. Historical transport-only resources retain
their original **Disconnect and remove** effect; that proves closure of their
old owned connection, not cleanup of all remote descendants. Their retained
identity is never silently adopted as a new persistent terminal.

## Network policy

Terminal admissions require paired management-client authentication and use
short-lived one-use tokens for the WebSocket upgrade, with compression
disabled. A paired client can obtain a shell only through the configured
terminal capability and execution grants; mere listener reachability does not
grant access.

Keep terminal-capable deployments on loopback or behind Tailscale Serve or
another private HTTPS boundary. Direct trusted-LAN HTTP sends pairing
credentials and terminal traffic without encryption. Its explicit
packaged-client origin, wildcard listener, and exact trusted-LAN Host
combination also admits terminal WebSockets, so a stolen credential can carry
shell authority. Restrict this mode to its documented trusted network.

Escape-sequence host integrations remain denied: no silent clipboard writes,
automatic link opening, notifications, file downloads, or image protocols.
Do not add terminal bytes, admissions, credentials, native process IDs, or
Sidecar frames to diagnostics or application logs.

## Operational checklist

Before enabling terminals:

1. Review the service account and every Sidecar SSH account's filesystem,
   process, credential, and network authority.
2. Configure only the execution environments and Sidecar capabilities that
   should offer shells.
3. Confirm the fixed 8-process-per-thread and 64-MiB-per-terminal limits are
   appropriate for the host; they are not configurable in this release.
4. Keep `$APP_STATE_DIR` owner-only and include its terminal hierarchy in
   quiescent backup and restore tests.
5. Prefer loopback or an admitted private HTTPS boundary. If direct trusted-LAN
   HTTP is deliberately enabled, verify the exact Host, packaged origin, and
   firewall boundary and treat every reachable client as shell-authorized.
6. Verify create, close-without-ending, reconnect, cross-device Take control
   without a release step, `CSI 3 J` clear and no pre-clear restore flash,
   explicit End deletion, natural-exit retention, server restart, and
   Sidecar-loss behavior.
