# Debug diagnostics

Sedes includes opt-in diagnostics for delivery, initial thread loading, seek
behavior, uneven streaming, and expensive client deltas. They are
observational, off by default, and do not change identity, conversation
authority, normalized events, or recovery.

Server logs can contain Sedes thread IDs, RPC methods, lifecycle reasons, and
raw provider error messages. Review and redact them before sharing. The bounded
client diagnostics buffer is content-free by construction, but still includes
browser/device metadata and operational timing.

Use this page after reproducing a problem with normal deterministic tests. For
the broader development workflow see [Development and testing](development.md).

## Attachment failure logs

Ordinary main-server error logs retain failed manual and automatic sidecar
attachment attempts without enabling a debug flag. Look for
`Execution environment <environment-id> attachment (connect)` (or `start`,
`restart`, `upgrade`, or `automatic`). The failure line is followed by bounded
`cause` lines through nested `Error.cause` and `AggregateError` wrappers, so
`sidecar_unavailable` does not hide the underlying handshake or transport error.
These logs preserve the existing failure classification and retry behavior.
Automatic maintenance does not repeatedly log the expected
`sidecar_transport_unavailable` condition while an outbound connector is offline;
Settings continues to show the host as unreachable. Manual attachment attempts
and other automatic attachment failures still log their causes.
Each report is limited to 16 entries with messages capped at 2,048 characters, with control
characters flattened and cyclic causes ignored. Configuration, request bodies,
and arbitrary exception properties are not serialized. Remote errors already
sanitized by the connector or daemon cannot reveal more detail than that peer
sent. Collect both main and connector logs when the reported cause is remote.

## Server delivery diagnostics

Set `SEDES_DEBUG_DELIVERY` to any nonempty value before starting Sedes:

```sh
SEDES_DEBUG_DELIVERY=1 \
SEDES_CONFIG_FILE="$PWD/config/server.example.json" npm start
```

Remove the variable and restart when the investigation is done. The markers
are:

- `[delivery]` — mutation admission, runtime acquisition, enqueue/dispatch,
  and lightweight publication;
- `[delivery-dispatch]` — queue dispatch, retry-anchor capture, submit,
  completion replay, and totals;
- `[delivery-capture]` — cache-only application state merged with the current
  normalized generation;
- `[delivery-thread-load]` — correlated bound-thread runtime acquisition start,
  success, and failure with request ID, Sedes thread ID, and duration;
- `[delivery-thread-handshake]` — when the client also requests thread-load
  diagnostics, one content-free record with the server-generated request UUID and
  pre-header route/runtime/total timings for every successful stream attempt,
  including caught-up resumes with no snapshot or replayed events;
- `[delivery-stream]` — thread SSE stream lifecycle: open with handshake
  class, duration, and snapshot frame bytes; pending-buffer overflow and
  write-drain waits with bounded pending event/byte counts; and close with a
  bounded reason (`drain_timeout`, `initial_drain_timeout`, `drain_overflow`,
  `frame_byte_limit_exceeded`, `stream_error`, `overflow`, `client_closed`,
  `load_error`, or `unexpected_error`) plus live state and pending counts;
- `[delivery-rpc]` — Codex RPC method, duration, and outcome;
- `[delivery-lifecycle]` — Codex client-generation transitions and bounded
  machine closure classifications for an unexpectedly closed shared
  generation; and
- `[delivery-attachment]` — content-free JSON records for main-side persistent
  Codex attachment/recovery stages, receipt processing and acknowledgment
  failures, and sidecar session/byte-stream closure. Correlation fields include
  environment/backend IDs, generation/controller epoch, and local attachment
  IDs where available; attachment IDs are not authentication nonces. Errors
  retain only bounded recognized classes and machine codes, never stacks,
  arbitrary messages, payloads, native thread IDs, or credentials. Sidecar
  records distinguish a requested close from a byte-stream exit (including
  process exit code/signal when the carrier provides them), frame/protocol
  closure, and heartbeat failure. Heartbeat failures and slow successful
  heartbeats include duration, pending operation counts, and time since inbound
  and outbound activity. Runtime event failures distinguish body decoding,
  schema validation, and listener processing before requesting carrier closure.
  Command failures and stages taking at least one second distinguish body
  encoding, the RPC wait, and response-body decoding. The RPC wait includes
  remote work and response transfer; it is not a native-provider-only timing.
  Successful receipt/acknowledgment timing records are emitted only for stages
  taking at least one second. Logging failures cannot change recovery behavior;
- `[delivery-event-loop]` — a startup confirmation and process-local lag samples
  from main or the persistent sidecar daemon. An unreferenced one-second timer
  samples a 20 ms event-loop histogram and reports only when maximum delay or
  timer drift reaches 100 ms. Samples contain PID, role, timestamp, sample
  interval, maximum/mean delay, interval user/system CPU milliseconds, RSS bytes,
  and the bounded file sink's dropped-record count. CPU is for the whole process,
  not a particular provider; no stacks or application content are collected;
- `[delivery-grok]` — content-free Grok provider-update ingestion, history
  publication, prompt-correlation and tool-projection dispositions,
  prompt-failure classification, resnapshot requests, normalized snapshot
  rebuilds, and handle event sequencing.

Current sites are `thread-mutation-gateway.ts`,
`queued-input-dispatcher.ts`, `thread-runtime-coordinator.ts`,
`thread-sse.ts`,
`codex-client-facade.ts` and `codex-daemon-supervisor.ts`, plus the bound-thread event route in
`normalized-app.ts`. Grok-specific sites are `grok-session-lifecycle.ts` and
`grok-conversation-driver.ts`. A failed `[delivery-thread-load]` record contains only
bounded error class, normalized backend category/code, and machine-like
internal codes. It never records exception messages, provider content, paths,
or native thread identifiers. There is no `SEDES_DEBUG_PROJECTION` flag in
this source tree.

### Persistent-sidecar capture and bounded files

Main enables these diagnostics through `SEDES_DEBUG_DELIVERY`. Its normal stderr
output is retained by systemd when installed as a service. An optional
`SEDES_DEBUG_DELIVERY_FILE` also copies the content-free `[delivery-attachment]`
and `[delivery-event-loop]` records to a private file; it does not intercept
ordinary logs or copy provider exception messages. Use an absolute file path
under an existing directory owned by the current account with mode `0700`.
The literal `{pid}` in this operator-selected path expands to the current PID;
use it when child processes might inherit the same environment. A file path must
have only one writer.

Persistent SSH/outbound sidecar daemons use a separate, remote operator opt-in
because their launch environment is sanitized and stderr may be `/dev/null`.
In the exact service directory on the remote host:

```text
~/.local/state/sedes/sidecar/services/<service-key>/diagnostics.json
```

create an account-owned, non-symlink file with mode `0600` containing exactly:

```json
{"delivery":true}
```

The service directory must remain private (`0700`). The next daemon startup
reads this file and creates a private `diagnostics/` directory, then writes to
`diagnostics/delivery-<pid>.jsonl`. Configuration is not read dynamically. Use
the supported daemon restart procedure when retained work permits it; replacing
an SSH carrier alone does not restart the persistent daemon. Remove the opt-in
file and restart the daemon to disable capture. Do not edit `service.json`,
reset retained work, or replay an uncertain operation to enable diagnostics.
Absent, malformed, oversized, or insecure opt-in files leave diagnostics off.
The remote opt-in and file capture currently support Linux and macOS; Windows
does not enable this POSIX file path. Main's stderr lag monitor remains portable.

Each file is mode `0600`, capped at 1 MiB, with one replacement `.1` rotation.
Existing insecure files, symlinks, hard links, and non-private parent directories
are refused. The asynchronous pending-write buffer is capped at 64 KiB and each
record at 8 KiB; overload drops diagnostic records instead of delaying provider
work. Graceful shutdown allows up to 500 ms to flush optional logging. Each PID
has its own bounded files; remove old PID files after collecting the incident
because the sink does not delete other processes' captures. File-output failure
does not affect application startup or recovery.

### Bounded main CPU capture

If lag samples identify main as the stalled process, an operator can capture one
CPU profile at the next main startup without opening a debug TCP listener:

```sh
install -d -m 0700 "$HOME/.local/state/sedes/cpu-profiles"
SEDES_DEBUG_DELIVERY=1 \
SEDES_DEBUG_CPU_PROFILE_DIRECTORY="$HOME/.local/state/sedes/cpu-profiles" \
SEDES_DEBUG_CPU_PROFILE_SECONDS=90 \
SEDES_CONFIG_FILE="$PWD/config/server.example.json" npm start
```

Both `SEDES_DEBUG_DELIVERY` and the profile-directory variable are required. The
directory must already exist, be an account-owned non-symlink directory, and
have private permissions. The requested window defaults to 90 seconds and must
be an integer from 1 through 120; invalid settings disable this capture. The
main-only implementation uses an in-process `node:inspector` session at a 10 ms
sampling interval. It does not open an inspector listener, evaluate JavaScript,
or collect a heap or request bodies. Neither its capture timer nor the session
keeps an otherwise idle process alive.

The deadline requests a stop on main's event loop; a stall that prevents that
callback from running can extend the actual capture duration. The completion
record reports the measured duration. Graceful main shutdown also stops the
profile and disconnects the session. Shutdown waits at most 500 ms for optional
capture cleanup; on timeout it disconnects inspector and cancels any delayed
capture startup or pending profile write. Startup, completion, and failure records
use `[delivery-cpu-profile]` on stderr with only normalized codes, PID, timing,
and byte counts; they do not contain profile contents, paths, or raw errors.
Failures do not prevent startup or make application shutdown fail.

Completed profiles are written to
`main-<pid>-<timestamp>.cpuprofile` in the chosen directory, with mode `0600`,
exclusive creation, and no symlink/hard-link reuse. Output above 8 MiB is
discarded. Unlike the content-free timing records, a CPU profile includes
sampled function names and source locations, including local paths. Keep the
artifact private and inspect those fields before sharing it. This POSIX capture
supports Linux/macOS main processes only; it is not included in the sidecar
artifact. Remove the profile opt-in from the service environment after capture
so subsequent restarts do not generate additional files. Existing captures are
preserved rather than automatically deleted.

## Bounded client buffer

Thread loading distinguishes `current_checkpoint` and `overflow_checkpoint`
from small retained replays. A checkpoint sends the current in-memory thread
at a captured event watermark; it does not reload provider history or reset
other viewers. Snapshot timing/byte fields also describe these checkpoint
frames. For a resumed connection, the existing `snapshot_fallback` replay
outcome means a checkpoint replaced the suffix, either because the cursor was
unavailable or because projected checkpoint bytes were cheaper.

Reproduce cumulative-output replay costs without a provider:

```sh
env -u NODE_ENV node --import tsx scripts/performance/thread-catchup.ts
```

This benchmark compares actual SSE bytes and five-trial encode/apply medians
for 640 cumulative updates to one message against a current checkpoint, checking exact final
state and retained older history. Its timings exclude publication, network,
the SSE byte parser, and rendering; use live diagnostics for those costs.

Settings → Diagnostics exposes independent **Thread loading diagnostics**, **Seek
diagnostics**, **Streaming diagnostics**, and **Composer input diagnostics**
toggles. Enable only the relevant category, clear the buffer, reproduce once, and choose **Copy log**. The
browser-local buffer holds at most 1,200 entries and is useful in the packaged
Android client where developer tools are inconvenient.

### Composer input

Composer input diagnostics records native focus/blur, beforeinput/input and
composition events, send pointer-down/click, draft capture, synchronous clear,
and refocus requests. Entries contain event timing, state/DOM text lengths,
textarea focus status, input type, composing status, and the effective refocus
setting at capture. They never copy input/composition data or message text.
This category uses only the bounded copy buffer, without Android console output.

Enable it in Settings → Diagnostics, clear the buffer, dictate a message, and tap
Send with your usual refocus setting. Copy the log promptly after text
reappears; a successful send is also useful as a comparison. Compare blur/focus
ordering and native input events against `send_captured`, `send_cleared`, and
`send_refocus`. A refocus entry records a request, not proof of a focus change.
The trace itself observes events without changing submission.
After a Chat Send/Steer/Queue, the composer discards composition updates for
250 ms, restoring the accepted draft immediately without blurring. Ordinary
non-composing input and paste remain accepted. `composition_update_discarded`
records each discarded update before restoration. Starting fresh dictation
within that window can also have its initial updates discarded. There is no
delayed clear; updates after the deadline are accepted normally.
Disable the category after collecting evidence.

### Thread loading

The trace starts at the first accepted in-app navigation, before route
publication, store retention, and React work. It records navigation source,
store start or reuse, EventSource creation, response headers, snapshot receipt
and JSON parsing, server runtime/snapshot/encode/write timings, normalized
store apply, React commit, two animation frames, and stream-live state.

An opted-in EventSource adds `diagnostics=thread_load`. Every successful stream
attempt may emit one `thread-handshake-diagnostic` event immediately after the
server flushes SSE headers, before replay or checkpoint delivery. The client
records it as `server_handshake_timing_received` with:

- `requestId`: the server-generated request UUID, matching `X-Request-Id` and
  `[delivery-thread-load]` / `[delivery-thread-handshake]` records; `null` if no
  valid UUID is available;
- `routeSetupMilliseconds`: route work before runtime acquisition;
- `runtimeAcquireMilliseconds`: time awaiting the shared runtime (zero for an
  unbound thread); and
- `requestToHeadersMilliseconds`: total monotonic time from entry into the thread
  event route through the server's header-flush call. This is a server write
  boundary, not proof that the browser received headers.

This closes the timing gap for `caught_up` / `replayed` resumes. It is a separate
observational event, not a normalized conversation envelope, and requires no
snapshot recapture. It shares the optional frame headroom/drop behavior below.
Malformed diagnostic frames, invalid UUIDs and observer failures cannot alter
streaming or recovery. Client opt-in belongs to the browser's existing diagnostic
settings; server stderr output additionally requires the operator-owned
`SEDES_DEBUG_DELIVERY` flag. No conversation authority or persisted state changes.
Pi, Codex (local and persistent sidecar), Claude and Grok all use this implemented
outer timing boundary. It does not expose provider identities or claim to split
backend/sidecar acquisition into RPC phases.

After an initial or
replacement snapshot written during that handshake, the server may emit one
separate `thread-load-diagnostic` event. It contains closed timings, counts,
and byte sizes; it is never part of the normalized snapshot and cannot select
scope or behavior. Later live replacements remain ordinary events, and clients
without the query receive no diagnostic event. Optional telemetry is dropped
when the response lacks write-buffer headroom.

`runtimeAcquireMilliseconds` is the shared backend/runtime bucket and can
include a cold provider history read. A large gap after snapshot receipt instead
points toward JSON/schema/store/render work. The trace also records aggregate
inactive-store caching and eviction information, not content.

A classified bootstrap failure adds one `thread_load_failed` entry for that
attempt with the normalized error code, retryability, and server request ID.
It contains no thread content, path, provider code, or exception. Terminal
failures do not produce repeated entries because their EventSource is closed;
retryable failures produce at most one entry per attempt and no more than three
automatic retry attempts before explicit user action.

### Seek on send

Seek diagnostics records bounded viewport, content, target, spacer, animation,
resize, and lifecycle measurements. High-frequency scroll samples record only
scroll position and animation state, avoiding extra layout measurements on the
animation path. Seek entries stay in the copy buffer and are not forwarded to
the console. It can remain off while thread loading is investigated.

### Streaming

Streaming diagnostics records each content-free thread item-upsert arrival,
including its safe item kind/status, encoded character count, and gap from the
previous arrival on that EventSource. It separately records the intended and
actual running-turn batch delay, batch size and apply/derive duration, streamed
text commits by character count, and animation-frame gaps of 50 ms or more.
It never records response text, event IDs, thread IDs, tool details, or replay
cursors.
High-frequency streaming entries stay in the bounded copy buffer and are not
forwarded to the Android console, so console bridging does not distort the
timings under investigation.

For a desktop/mobile comparison, enable the category on one client at a time,
clear the buffer, watch one short response, and copy the log immediately.
Near-zero SSE arrival gaps after a long pause indicate transport/WebView
delivery batching. Timely arrivals followed by a late batch timer or expensive
apply indicate main-thread scheduling/store work. Timely commits followed by
`animation_frame_delayed` entries indicate delayed main-thread animation
callbacks. Browser-managed smooth scrolling can continue while those callbacks
are blocked, so these entries alone do not prove visible scroll stutter.

Copied entries omit prompts, conversation text, tool inputs/results, thread
IDs, paths, cursors, configuration, credentials, and raw errors. Thread loading
may include a server-generated per-request UUID for correlation. They include
an ephemeral attempt number, durations, counts, byte sizes, browser user agent,
viewport metadata, and device pixel ratio.

## Console-only client delta warnings

For older per-delta performance warnings, enable one browser profile without a
rebuild:

```js
localStorage.setItem("sedes.debug.client", "1");
```

Disable it with:

```js
localStorage.removeItem("sedes.debug.client");
```

`[client-delta]` warnings report work above 8 ms: store batch size/applied
count/resnapshot state and transcript layout cost/item count. Current sites are
`ThreadClientStore.ts` and `Transcript.tsx`.

## Investigation loop

For recurring **Reconciling thread** or **Backend disconnected** banners with a
persistent sidecar, enable `SEDES_DEBUG_DELIVERY` on main and capture one full
occurrence. Find the first `[delivery-attachment]` failure for the affected
environment before the lifecycle changes. A receipt/acknowledgment failure or
heartbeat timeout can make main discard an attachment while SSH and the native
provider process remain alive. A later byte-stream exit can be the consequence
of that discard rather than its cause. Compare the local attachment IDs,
generations, timestamps and close-request records before interpreting an exit
as an external transport failure. Reconnect admission/handshake failures are
separate from the event that lost the original attachment. Main-side RPC
durations include remote processing and transfer; they do not alone locate a
stall in the native provider. Main-only attachment diagnostics require no remote
restart or operation replay. The additional remote heartbeat and event-loop
evidence requires the private daemon opt-in above and one supported daemon
restart to activate it.

For heartbeat investigation, correlate the same request UUID on the sending
and receiving peers. Compare request admission/frame queue/write stages,
receiver request/handler/response queue/write stages, and sender response parse
with byte/frame backlog and `[delivery-event-loop]` samples on both processes.
A delay before a frame write points to local queuing/backpressure; a delay after
the receiver observes the request can be compared with that daemon's loop lag;
a written response followed by late parsing can be compared with main's loop
lag. These are observations, not proof of a physical network failure. Durations
use each process's monotonic clock; wall-clock timestamps across hosts can be
skewed, so do not subtract remote and main timestamps as a precise transit time.

The transport/session observations apply to SSH and outbound environments,
including Pi remote workspace operations and Claude sidecars. The persistent
runtime stage/receipt observations are Codex-specific. Local Pi, local Claude,
and Grok do not gain a new persistent-runtime diagnostic path.

1. For initial-load or mobile latency, enable Thread loading diagnostics,
   clear the buffer, open one thread, wait for paint/live state, and copy the
   log. Classify time as runtime, transfer/parse, store, or render/paint.
2. For uneven live text, enable Streaming diagnostics, clear the client
   buffer, reproduce one response, and compare SSE arrival gaps with batch,
   commit, and delayed-frame entries.
3. For mutation latency, enable `SEDES_DEBUG_DELIVERY`, restart, reproduce
   once, and compare the `[delivery]` total with its runtime, queue, capture,
   and RPC steps.
4. If events arrive promptly but draw slowly, use the console delta warnings
   and browser long-task reports.
5. For a slow switch with no replay, compare the client interval from
   `event_source_created` to `response_headers_received` with
   `server_handshake_timing_received.requestToHeadersMilliseconds` from the same
   attempt. A large runtime bucket directs investigation to the existing
   `[delivery-thread-load]` and backend/RPC records; a large route bucket points
   to main-server setup. A short server duration with a long client interval
   places the unexplained time outside the measured route: browser connection
   queuing, pre-route server scheduling/middleware, transport/proxy delay, or
   delayed main-thread event dispatch. It does not establish which one.

   Match the server-generated request UUID in server logs and the browser Network
   panel. Inspect the request's Queueing/Stalled, connection/TLS, and Waiting/TTFB
   phases without exporting cookies or authorization headers. Compare several
   read-only measurements through the usual proxy and directly to the loopback
   server; do not expose a new public listener. A consistently slow proxy path
   with a fast direct path points outside Sedes; slow direct requests with a
   large runtime bucket point inside acquisition. Keep client/server wall-clock
   skew in mind; compare durations, not unsynchronized absolute timestamps.
   The export cannot retroactively recover missing server timings for an older
   attempt. A disconnect-to-reconnect pause is a separate interval from request
   latency and should be measured separately.

6. Measure repeated initial attachment separately when runtime establishment
   is suspect:

   ```sh
   npm run measure:thread -- THREAD_ID --repeats=3 \
     --url=http://127.0.0.1:4784
   ```

   Restart Sedes immediately beforehand only when the first sample must be a
   guaranteed cold runtime attach.

7. Remove every flag after collecting bounded evidence.

`measure:thread` is read-only. The separate live streaming smoke mutates the
selected installation and leaves its created provider conversation behind; see
[Operations](../operator/operations.md#live-smoke-and-measurement-commands).

## Adding diagnostics

New diagnostics require:

- an explicit environment, localStorage, or settings gate;
- bounded, reviewable fields and stderr/console or bounded-buffer output;
- no behavior, persistence, API-authority, or event-semantic change; and
- a matching update to this document.

Do not document a flag before its implementation lands. Keep host service
names, database surgery, incident measurements, and provider-state anecdotes
in supplemental operational context rather than this portable reference.


## Repeatable browser performance measurements

Run the opt-in Playwright workload through the normal disposable-server
coordinator:

```sh
env -u NODE_ENV npm run measure:browser -- --repeat-each=3
```

With a known-current build, add `--prebuilt`. Do not rebuild assets or run other
CPU-heavy checks while collecting samples. The benchmark is separate from the
default E2E suite and uses synthetic provider-shaped Codex history; it does not
start a live provider or read personal sessions. Desktop and narrow-screen
Chromium profiles exercise initial loading, expanded history, streaming, and
composer/scroll interaction. The narrow-screen profile uses CPU throttling as
a reproducible stress case, not a claim about any particular phone.

Each invocation prints its isolated `test-results/e2e-runs/run-*` directory.
Summarize repeated trials, or compare two runs, with:

```sh
node scripts/performance/summarize-browser.mjs RUN_DIRECTORY [AFTER_RUN_DIRECTORY]
```

The browser report attachments contain content-free timing/count JSON and
screenshots of synthetic data. Compare the same workload, build mode, Node and
Chromium versions, and CPU profile on an otherwise idle host. Use repeated-run
medians; the benchmark checks behavior and reports timings without imposing
machine-specific latency gates. Setup opens the app before timing, so the thread
reload uses warmed frontend assets and a seeded runtime; this is not a cold
provider-history benchmark. Initial loading retains the normal 10-turn window,
then the workload explicitly loads all 100 turns. Screenshots and diagnostic
export run outside timed phases. Heap samples are not taken after forced GC
and must not be interpreted as leak evidence. Browser task/script/layout time, long tasks,
frame gaps, DOM counts and heap usage help distinguish CPU improvements from
transport or rendering delays.

Two offline CPU benchmarks isolate narrower costs:

```sh
env -u NODE_ENV node --import tsx scripts/performance/normalized-turn-upsert.ts
env -u NODE_ENV node --import tsx scripts/performance/event-hub-replay.ts
```

The first applies turn revisions to a large retained normalized history. The
second exercises eviction after the bounded replay buffer fills. Both print
numeric JSON and use synthetic data. Their timings exclude provider/network
work and must not be presented as end-to-end page latency improvements.

For separate CPU attribution, run one profiled trial:

```sh
SEDES_BROWSER_PROFILE=1 env -u NODE_ENV npm run measure:browser -- --prebuilt --grep 'browser performance desktop'
```

This writes DevTools `.cpuprofile` files and aggregate event/history byte counts.
Compare ordinary timing runs with profiling disabled. Automatic Playwright
trace/video recording is disabled for the benchmark because recording large
transcripts adds significant work; the default E2E suite keeps its existing
failure diagnostics.

Measure seek-on-send separately with diagnostics and Chat Atmosphere disabled:

```sh
env -u NODE_ENV npm run measure:browser -- --prebuilt --grep 'seek performance' --repeat-each=3
```

This workload sends through the composer with the initial history window and
then all 100 synthetic turns loaded, checking final message alignment. It writes
`seek-performance.json` with frame positions, frame gaps, scroll requests and
long tasks. The mobile profile uses a narrow viewport and CPU throttling; a
separate mobile-resize case expands the viewport during native scrolling to
exercise keyboard-like geometry changes. Neither uses an actual mobile
keyboard. With `SEDES_BROWSER_PROFILE=1`, it also records CPU/DevTools timeline
profiles, target geometry and scroll writes for attribution. Those additional
measurements perturb frame timings; use unprofiled repetitions for comparisons.
Frame gaps measure main-thread availability, not compositor scroll smoothness:
seek reserves space and asks the browser to animate to the destination, without
per-frame JavaScript scroll writes. Compare actual rendered frames when
investigating motion during a main-thread stall.
The native completion event normally releases scroll ownership immediately.
While a seek remains active, a once-per-second destination check also releases
ownership and focuses the source turn if the browser omits that event; it does not
drive the animation or scan history before arrival.
The reservation also uses the scrollport's CSS container height so viewport
growth cannot temporarily shrink the scroll range before observer callbacks
catch up. The resize case checks for backward movement as well as final alignment.

Inline transcript images and diagrams use the message scrollport's CSS
container height. Avoid restoring a resize-updated inherited media-height
property: even a small composer-height change can then restyle every loaded
message during a seek, including conversations without inline media.
