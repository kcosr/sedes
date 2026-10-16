# Automation CLI

`sedes-automation` manages named automations through the authenticated Sedes
management API. Each automation attaches to an existing source thread, including
an unstarted draft. Create and configure the thread through the normal thread
interface first. Several automations can share it.

The agent-facing `sedes` tools use their own source or Tool-client credentials
and admitted environment boundary. This operator CLI instead uses a paired
device credential. Do not interchange those credential types.

## On this page

- [Quick start](#quick-start)
- [Input document](#input-document)
- [Command reference](#command-reference)
- [Server selection](#server-selection)
- [Install the compiled executable](#install-the-compiled-executable)
- [Safe scripting practices](#safe-scripting-practices)

## Quick start

Set `SEDES_AUTH_TOKEN` to a paired device credential for the selected server.
Then prepare a definition file and attach it to an existing thread:

```sh
npm run automation -- validate ./daily-update.json
npm run automation -- create THREAD_ID ./daily-update.json
npm run automation -- list --thread THREAD_ID
npm run automation -- get AUTOMATION_ID
```

Create returns the automation's own ID. Use it for subsequent get, edit, state,
run, history, and removal commands. Thread IDs select a source for creation or
filter a collection; they never implicitly select one sibling automation.

## Input document

```json
{
  "automation": {
    "name": "Daily update",
    "prompt": "Summarize today's outstanding work.",
    "runMode": "same_thread",
    "schedule": {
      "kind": "cron",
      "expression": "0 9 * * *",
      "timeZone": "Europe/London"
    },
    "misfirePolicy": "coalesce",
    "precheck": null,
    "initialState": "enabled"
  },
  "checks": {
    "previewCount": 3,
    "testPrecheck": false
  }
}
```

Input is strict JSON, at most 256 KiB. Unknown fields are rejected. The former
`thread` creation block and `state` field are removed. Model, reasoning, tool,
workspace, and environment choices belong to the source thread.

### Thread selection

`create THREAD_ID FILE` takes an existing source thread ID. It does not create a
thread. `preview` and `precheck` also take a source thread ID so authorization and
execution context remain explicit. All other item commands take automation IDs.

### Automation definition

| Field | Meaning |
| --- | --- |
| `name` | Required nonempty display name, at most 160 characters; duplicates are allowed |
| `prompt` | Required prompt submitted on every invocation |
| `runMode` | `same_thread` for **This thread**, or `clone` for **Fork** |
| `schedule` | One-time, fixed interval, or cron schedule |
| `misfirePolicy` | `null` for one-time; `skip` or `coalesce` for recurring |
| `precheck` | Command definition or `null`; defaults to `null` |
| `initialState` | Create only: `enabled` or `paused`; omitted means paused |

Creation and initial enabling are atomic. `update` replaces the definition and
requires all definition fields; it rejects `initialState`. Use `enable` or
`pause` to change state independently. A concurrent revision change causes a
conflict rather than silently overwriting another editor.

**Fork** always creates a separate result from the original source. For a draft,
it copies saved settings using normal thread creation; for a started source, it
uses native fork support. It never reuses an earlier result or copies schedules.
To continue a result on a schedule, attach another automation to that thread.
Native fork restrictions still apply after a source is started.

### Schedule shapes

A one-time reminder:

```json
{"kind":"date_time","runAt":"2028-01-20T15:00:00.000Z"}
```

A fixed interval:

```json
{"kind":"interval","everySeconds":3600,"anchorAt":"2028-01-20T09:00:00.000Z"}
```

A cron schedule:

```json
{"kind":"cron","expression":"0 9 * * 1-5","timeZone":"America/New_York"}
```

Use the preview command to validate the exact schedule. Recurring schedules must
not run more often than every five minutes. The missed-run policy applies to
downtime and suppression, not to ordinary delivery waiting behind a busy source.
One-time reminders wait through snooze. Once their scheduled agent turn succeeds
and the user dismisses its result notice, they leave the collection and their
item/history endpoints return not found. Conversations and internal provenance
records remain. Dismissal before completion waits for success; failed,
interrupted, and uncertain work remains available. `run-now` does not rearm a
consumed schedule; scheduling another occurrence before removal requires a
distinct future `runAt` and enabling the edited schedule.

### Prechecks

```json
{
  "command": "test -f package.json",
  "timeoutSeconds": 10,
  "includeStdout": false
}
```

Prechecks use the source's authorized workspace. Exit 0 permits delivery; nonzero
skips it. Timeout is 1–60 seconds. Explicit `precheck` and `testPrecheck` execute
the shell command, so they can have effects even though they send no prompt.
Completed per-run checks are retained across deferred delivery instead of being
rerun. Interrupted checks fail rather than replaying unknown shell effects.

### Optional checks

`checks.previewCount` is 0–10, default 0. `checks.testPrecheck` defaults false.
Create and update perform requested checks before mutation. An explicit preview
uses five occurrences if the requested count is zero. Repeating the CLI with
checks enabled repeats those explicit diagnostic checks.

## Command reference

| Command | Effect |
| --- | --- |
| `validate FILE` | Validate strict input locally |
| `create THREAD_ID FILE` | Add an independent automation to the source |
| `update AUTOMATION_ID FILE` | Replace that automation's definition |
| `preview THREAD_ID FILE` | Preview schedule occurrences |
| `precheck THREAD_ID FILE` | Execute the diagnostic precheck |
| `get AUTOMATION_ID` | Read one definition and summary |
| `enable AUTOMATION_ID` | Enable its eligible schedule |
| `pause AUTOMATION_ID` | Pause scheduling and cancel deferred unsent intent |
| `run-now AUTOMATION_ID` | Create a separate manual invocation |
| `runs AUTOMATION_ID [--filter all\|problems\|skipped]` | Read recent run history |
| `resolve AUTOMATION_ID RUN_ID [--resume]` | Mark uncertain delivery failed, optionally resume eligible scheduling |
| `list [QUERY] [--thread THREAD_ID]` | Read all collection pages, optionally filter source/name/title |
| `remove AUTOMATION_ID` | Remove one automation; preserve its threads |

The collection is independent of sidebar loading and includes automations on
unloaded fork threads. Actions use explicit identities, never display-name
matching. The HTTP contract uses `GET/POST /api/automations` and
`/api/automations/:automationId` item routes. The old singular per-thread item
routes are removed. Thread capability, preview, and precheck routes are under
`/api/threads/:threadId/automations/`.

## Server selection

The default origin is `SEDES_URL` or `http://127.0.0.1:4784`. Override it with
`--server URL`. The URL must be an HTTP(S) origin without credentials, path,
query, or fragment. A non-loopback origin requires `--allow-remote`:

```sh
npm run automation -- list --server https://sedes.example.test --allow-remote
```

The CLI sends the paired credential only to that origin and refuses redirects.
It fetches a CSRF token before mutations and preserves the request body if an
expired CSRF token requires one retry. Authentication failure requires pairing
or replacing the credential; it does not fall back to another identity.

## Install the compiled executable

Build with the repository's normal build, then invoke:

```sh
node dist/cli/automation-cli.js --help
node dist/cli/automation-cli.js create THREAD_ID ./daily-update.json
```

`sedes-automation` is the package executable for `dist/cli/automation-cli.js`.
The working directory affects relative input paths only.

## Safe scripting practices

Create and run-now require a mutation ID on the wire. The CLI generates one per
invocation and prints it to standard error before sending; successful JSON output
also includes it. Supply `--mutation-id UUID` to retry an uncertain request with
the same identity and unchanged input:

```sh
npm run automation -- create THREAD_ID ./daily-update.json --mutation-id REQUEST_UUID
npm run automation -- run-now AUTOMATION_ID --mutation-id REQUEST_UUID
```

A new key means new work. Reusing a key with a different source, automation, or
request content conflicts. Do not generate a new key merely because a response
was lost. Use distinct keys for independent operations. A retry recovers the
original invocation and any reserved result thread; it must not create another
copy or fork.

Check the exit status and parse JSON output rather than human labels. Preserve
unknown delivery outcomes for reconciliation. Do not store credentials in the
input file, prompts, or precheck output.
