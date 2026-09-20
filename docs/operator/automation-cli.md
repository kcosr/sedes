# Automation CLI

`sedes-automation` is the repository-supplied command-line client for creating
and managing thread automations through the normalized Sedes HTTP API. It is
useful for reviewed JSON definitions, shell scripts, and repeatable operator
workflows. It does not read SQLite or provider stores, configure a backend, or
start and stop the server.

The CLI authenticates as the local principal using the paired device credential
in `SEDES_AUTH_TOKEN`. Its CSRF token is a separate request-integrity mechanism.
Create and store a credential using
[Credentials for operator scripts](operations.md#credentials-for-operator-scripts),
and supply it through the environment rather than command arguments or URLs.
Run it only against a Sedes
listener protected by the trusted boundary in
[Operations and security](operations.md).

Sedes also builds a separate, credentialed `sedes` Tool client. That generic
client invokes tools such as `automation.create`, `automation.update`, and
`automation.runs` under a configured principal Tool client policy. It can
attach an automation to an already-bound thread, supports partial updates, and
has cursor pagination; it is not interchangeable with `sedes-automation`,
`SEDES_URL`, or management-API CSRF. See
[Principal Tool clients](../internals/agent-tools.md#principal-tool-clients) for
endpoint, one-time credential, environment allowlist, and invocation setup.

The two executables are intentional, not aliases:

| Need | Use |
| --- | --- |
| Operate the complete thread-automation definition from a trusted local script or reviewed JSON file | `sedes-automation`; it uses the management API, creates a new draft for `create`, and replaces the complete definition on `update`. |
| Let an agent or external tool invoke a policy-limited set of Sedes operations | `sedes`; it uses a revocable principal Tool-client credential, can attach to an eligible existing thread, and supports the general agent-tool contract. |

A paired `sedes-automation` credential carries management authority. Prefer
`sedes` with a principal Tool-client credential when the caller needs a
least-authority tool policy.

## On this page

- [Quick start](#quick-start)
- [Input document and schedules](#input-document)
- [Precheck safety](#prechecks)
- [Command reference](#command-reference)
- [Server selection](#server-selection)
- [Compiled executable](#install-the-compiled-executable)
- [Safe scripting](#safe-scripting-practices)

## Quick start

The CLI defaults to the same loopback origin as a production-shaped Sedes
source run. Set `SEDES_URL` when the selected installation uses another port:

```sh
export SEDES_URL=http://127.0.0.1:4784
npm run automation -- list
```

Create a JSON file, validate it locally, create a paused automation, inspect
it, and then enable it deliberately:

```sh
npm run automation -- validate nightly-review.json
npm run automation -- create nightly-review.json
npm run automation -- get THREAD_ID
npm run automation -- enable THREAD_ID
```

Successful commands print formatted JSON to stdout. Validation, transport,
protocol, and server errors print a diagnostic to stderr and exit nonzero.

## Input document

`create`, `update`, `preview`, and `precheck` read one strict JSON document.
Unknown properties are rejected and the file may be at most 256 KiB.
For `update`, the definition is a full replacement: `prompt`, `runMode`,
`schedule`, and `misfirePolicy` are always required. The JSON returned by `get`
cannot be passed back as input because it contains presentation fields and uses
`status` where input uses optional `state`.

This complete create example uses the checked-in Pi target ID. Replace the
workspace and target IDs with values from the selected installation:

```json
{
  "thread": {
    "workspaceId": "10000000-0000-4000-8000-000000000001",
    "title": "Nightly repository review",
    "executionWorkspace": { "kind": "direct" },
    "configuration": {
      "kind": "custom",
      "targetId": "pi-sdk-local"
    }
  },
  "automation": {
    "prompt": "Review the repository and summarize outstanding issues.",
    "runMode": "same_thread",
    "schedule": {
      "kind": "cron",
      "expression": "0 2 * * *",
      "timeZone": "Europe/London"
    },
    "misfirePolicy": "skip",
    "precheck": {
      "command": "test -f package.json",
      "timeoutSeconds": 10,
      "includeStdout": false
    },
    "state": "paused"
  },
  "checks": {
    "previewCount": 5,
    "testPrecheck": true
  }
}
```

Only `create` accepts `thread`. Commands that take `THREAD_ID` on the command
line require the block to be omitted:

```json
{
  "automation": {
    "prompt": "Review the repository and summarize outstanding issues.",
    "runMode": "same_thread",
    "schedule": {
      "kind": "interval",
      "anchorAt": "2026-09-01T14:00:00.000Z",
      "everySeconds": 86400
    },
    "misfirePolicy": "coalesce",
    "precheck": null
  },
  "checks": { "previewCount": 3, "testPrecheck": false }
}
```

### Thread selection

A create request uses the same strict thread-creation contract as the UI:

| Field | Meaning |
| --- | --- |
| `workspaceId` | Existing Sedes project/workspace UUID. It must be available and belong to the target's execution environment. |
| `title` | New anchor-thread title. Blank input normalizes to `New thread`; nonblank titles are limited to 240 characters. |
| `executionWorkspace` | `{ "kind": "direct" }`, or an admitted isolated workspace selection with `workspaceAccess` and `networkProfile`. |
| `configuration` | A `custom` target plus optional overrides/tool policy, or a `saved_agent` ID with an optional compatible target. |

The CLI requires an explicit resolved `targetId`, including when the
configuration uses a Saved Agent. It verifies the workspace/target environment
relationship and target availability before creating the thread. Creation is
imperative: running `create` twice creates two draft threads.

### Automation definition

| Field | Values and effect |
| --- | --- |
| `prompt` | Nonempty prompt, at most 65,536 UTF-8 bytes. |
| `runMode` | `same_thread` sends work to the anchor thread; `clone` creates a separate result thread for each run and requires a bound, forkable anchor. |
| `schedule` | One `date_time`, `interval`, or `cron` shape described below. |
| `misfirePolicy` | `coalesce` represents missed interval/cron occurrences with one newest due run and its count; `skip` records an occurrence more than 60 seconds late as skipped. |
| `precheck` | `null`, omitted, or a bounded local command gate. Omission normalizes to `null`. |
| `state` | Optional `paused` or `enabled`. Create defaults to `paused`; update preserves the current state when omitted. |

Choose `same_thread` when periodic work should accumulate in one conversation.
It obeys normal thread activity and queueing rules. Choose `clone` when each run
should have an independent result derived from the anchor's latest snapshot.

The CLI's `create` command always creates a new, unbound draft and therefore
cannot create a clone-mode automation directly. Create it in `same_thread`
mode, bind the thread by completing its first provider turn, then use `update`
to select `clone` if that bound thread advertises clone-on-run capability. The
CLI has no command that attaches a new definition to an arbitrary existing
thread.

Enabling or manually running an automation can schedule provider work and
consume provider capacity. Creating a paused definition, previewing a schedule,
and testing a precheck do not themselves send the automation prompt to a model.
Attach, enable, and dispatch recheck current backend, model, reasoning, thread,
and environment capabilities. A paused definition is not a promise that later
policy or availability will permit a run. Grok targets currently do not support
thread automations.

### Schedule shapes

A one-time schedule uses an ISO 8601 timestamp:

```json
{ "kind": "date_time", "runAt": "2026-09-15T16:30:00.000Z" }
```

An interval has an ISO anchor and an integer period from 300 through 31,536,000
seconds:

```json
{
  "kind": "interval",
  "anchorAt": "2026-09-01T14:00:00.000Z",
  "everySeconds": 21600
}
```

A cron schedule has exactly five fields and a supported IANA timezone:

```json
{
  "kind": "cron",
  "expression": "30 8 * * 1-5",
  "timeZone": "America/Chicago"
}
```

Cron macros such as `@daily` and hashed fields are unsupported. Schedules that
can occur more often than every five minutes are rejected, including around
daylight-saving transitions. Use `preview` before enabling a definition to
verify the actual upcoming instants.

### Prechecks

A precheck runs a POSIX shell command in the anchor thread's server-authorized
workspace immediately before model dispatch:

```json
{
  "command": "git diff --quiet -- .",
  "timeoutSeconds": 15,
  "includeStdout": false
}
```

The command is at most 4,096 UTF-8 bytes and the timeout is an integer from 1
through 60 seconds. Exit status zero permits the run; nonzero skips it. A
timeout, signal, unavailable execution runtime, invalid output, or other
execution failure fails the run rather than treating the condition as false.

When `includeStdout` is true, successful UTF-8 stdout is trimmed and appended
to the model prompt inside an explicit untrusted-data envelope. Output over 16
KiB, a NUL byte, invalid UTF-8, or an effective prompt over 65,536 bytes fails
the precheck. Treat both the command and its output as sensitive: the command
runs with the service account's local workspace authority and output can become
model-visible input.

The standalone precheck test returns bounded stdout and stderr previews
regardless of `includeStdout`; that flag controls only whether successful
stdout joins the later model prompt. A test command can mutate the workspace
and expose secrets in terminal output, logs, or captured JSON.

Precheck command execution is currently local-only. An SSH thread reports
`ssh_command_execution_unsupported`; it does not silently run the command on
the Sedes host or managed sidecar.

### Optional checks

`checks.previewCount` is an integer from 0 through 10. A positive value makes
`create` or `update` preview that many occurrences before mutating the
automation. Zero, or omitting `checks`, performs no preview. The standalone
`preview` command uses five when the value is zero or omitted.

`checks.testPrecheck: true` runs the proposed precheck before create/update and
requires `automation.precheck` to be non-null. Because it executes the command,
this is not a validation-only operation. Both checks occur after thread
creation in `create`; if a check or later automation mutation fails, the new
draft thread is retained and its ID is printed to stderr.

The standalone `preview` and `precheck` commands also require the complete
`automation` input shape, although preview uses its schedule and precheck uses
its prompt plus precheck. They require an existing thread but do not require an
automation already attached to that thread. Local `validate` checks the API
shape only; server-backed preview/create/update additionally validates cron
syntax, timezone, cadence, and future occurrences.

## Command reference

| Command | Effect |
| --- | --- |
| `validate FILE` | Parse and normalize an input locally. Does not contact Sedes. |
| `create FILE` | Create a draft thread, run requested checks, attach the definition, and apply the requested/default state. Not idempotent. |
| `update THREAD_ID FILE` | Replace the existing definition fields using the current server revision, run requested checks first, and optionally change state. |
| `preview THREAD_ID FILE` | Validate the proposed schedule against the existing thread and return upcoming occurrences. |
| `precheck THREAD_ID FILE` | Execute the proposed precheck and return its decision and bounded output previews. |
| `get THREAD_ID` | Return the current automation definition, state, revision, schedule, and summary. |
| `enable THREAD_ID` | Enable future scheduled runs using the current revision. |
| `pause THREAD_ID` | Stop admission of future scheduled runs using the current revision. |
| `run-now THREAD_ID` | Create a manual run even while paused. It rejects snoozed anchors and can queue on a busy bound thread. This can execute a precheck and schedule provider work. |
| `runs THREAD_ID` | Return the newest run-history page, currently up to 50 items. The response may include `nextCursor`, but this helper has no continuation option. |
| `list [TITLE_QUERY]` | Filter automation-bearing threads in one bounded point-in-time application snapshot by case-insensitive title substring. |
| `remove THREAD_ID` | Delete the automation definition using its current revision; it does not delete the thread. |

Repository invocations are:

```sh
npm run automation -- validate automation.json
npm run automation -- create automation.json
npm run automation -- update THREAD_ID automation.json
npm run automation -- preview THREAD_ID automation.json
npm run automation -- precheck THREAD_ID automation.json
npm run automation -- get THREAD_ID
npm run automation -- enable THREAD_ID
npm run automation -- pause THREAD_ID
npm run automation -- run-now THREAD_ID
npm run automation -- runs THREAD_ID
npm run automation -- list [TITLE_QUERY]
npm run automation -- remove THREAD_ID
```

`list` is not an exhaustive server-side search. Its result includes
`boundedToSnapshot: true` and the number of loaded threads so scripts do not
mistake it for a complete inventory.

## Server selection

Use `SEDES_URL` or `--server` with an HTTP(S) origin. URLs containing
credentials, a path, query, or fragment are rejected:

```sh
npm run automation -- get THREAD_ID \
  --server http://127.0.0.1:4784
```

Loopback hostnames `127.0.0.1`, `localhost`, and `::1` are admitted by default.
A non-loopback origin additionally requires `--allow-remote`:

```sh
sedes-automation list \
  --server https://sedes.example.ts.net \
  --allow-remote
```

`--allow-remote` only acknowledges the destination. It adds no TLS trust,
login, or API authentication. Use it only for a private HTTPS endpoint whose
clients are already trusted.

## Install the compiled executable

`npm run automation -- ...` executes TypeScript from the current checkout. To
link both compiled Sedes CLIs into the current npm prefix, build and link this
checkout:

```sh
env -u NODE_ENV npm run build
npm link
```

Then run the automation executable from any directory:

```sh
sedes-automation list
sedes-automation create ./automation.json
sedes-automation pause THREAD_ID
```

Rebuild after changing source; the linked executable runs
`dist/cli/automation-cli.js`. The working directory affects only relative input
file paths, not server-side workspace selection or command execution.

## Safe scripting practices

- Start definitions paused, validate and preview them, test any precheck, then
  enable them in a separate reviewed step.
- Capture the `threadId` returned by `create`; do not discover an authoritative
  thread with the bounded `list` command when titles can collide.
- Treat `create` and `run-now` as non-idempotent. A lost client response can
  leave accepted work; inspect server state before retrying.
- Reconcile partial failures explicitly. `create` can retain a draft or a
  paused automation when a later check/enable step fails; `update` can retain
  the new definition when its final state change fails. Use the reported
  thread ID with `get`, and use `list` only as a bounded fallback.
- Expect revision conflicts when another operator or browser edits the same
  definition. Re-read it and reapply the intended change instead of forcing a
  stale update.
- Remember that `pause` prevents future scheduler admissions; it is not a stop
  button for work already admitted or running.
- Review run records in `runs` and the UI. An `uncertain` result requires
  recovery review, not an automatic replay.
- A successful `run-now` response records queue/provider acceptance, not final
  agent-turn settlement. Follow the result thread or run history to completion.

For UI workflows and lifecycle concepts, see
[Tasks and automations](../user/tasks-and-automations.md#schedule-work-with-an-automation).
For deployment, listener, state, and recovery policy, return to the
[operator guide](index.md).
