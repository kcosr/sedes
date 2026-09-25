---
name: sedes-native-progressive-tools
description: >-
  Discover and invoke Sedes operations through the native progressive
  `sedes_catalog`, `sedes_read`, and `sedes_act` gateways. Use only in
  native-progressive presentation mode; never use Bash or the generated CLI.
---

# Sedes Native Progressive Tools

Use only the progressive native Sedes gateways. When they come from the Sedes
MCP server, the client prefixes each name with its server namespace, for
example `mcp__sedes__sedes_catalog`.

## Confirm the presentation

- Continue only when `sedes_catalog` is visible. The current policy may expose
  only `sedes_read`, only `sedes_act`, or both lanes. Neither lane is visible
  only when the effective catalog is empty.
- An absent lane does not authorize another path to an operation.
- If the visible presentation does not match this skill, stop and report the
  mismatch. Do not switch presentation families.
- Never invoke Bash, the generated `sedes` executable, or raw Sedes HTTP.

## Discover and invoke

1. Call `sedes_catalog` with `{ "action": "list" }`.
2. Select only operation IDs returned by that current compact snapshot.
3. Call `sedes_catalog` with
   `{ "action": "describe", "toolIds": [...] }` for every operation needed
   in the immediate plan. Describe 1-16 unique IDs; the call is all-or-nothing.
4. Construct input from the exact returned schema and invoke exactly one
   operation through the matching lane:

   ```text
   {
     "toolId": "<exact returned operation ID>",
     "schemaVersion": <exact returned schema-version integer>,
     "input": <object valid under the returned input schema>
   }
   ```

Use `sedes_read` only when the operation declares application read, external
none, and model usage none. Use `sedes_act` for every other effect. If the
required lane is absent, stop. Never move an action to the read lane.

## Task workflow

### Quick current-scope creation

Nearly every task created by a thread agent belongs to its current workspace
or current thread. Unless the user explicitly names a different target, skip
the catalog list, describe only `task.create`, and invoke it with the returned
schema version and one of these basic inputs:

```json
{"title":"Investigate the reported issue","scope":{"kind":"workspace"}}
```

```json
{"title":"Follow up in this thread","scope":{"kind":"thread"}}
```

```json
{"title":"Review shared maintenance","scope":{"kind":"global"}}
```

For `workspace` and `thread`, omit `workspaceId` or `threadId`. Sedes resolves
the authenticated agent's current scope. Do not describe or invoke agent
context, workspace list, or thread list merely to recover those IDs. Supply an
explicit target ID only when the user requests another known workspace or
thread; never guess one. Global scope is explicit and should be used only when
actually intended.

Freshly list and describe task list/get/update as needed. Never build other
input from this skill or a remembered shape. The current task list requires
both `scope` and `scopeMode`; `exact` selects direct assignments and `subtree`
also traverses descendants. Preserve identical scope, scope mode, filters,
projection, page size, and opaque cursor across continuation pages.

Create once. Preserve the returned exact `id` and `revision`, and independently
verify through the described exact read when warranted. Read immediately before
an update, pass that current revision as the expected revision, and change only
the intended fields. A revision conflict requires a fresh read. Never retry an
uncertain write or create again to verify it.

## Policy and source authority

- Re-list once after denial or disappearance; never use Bash, CLI, raw HTTP,
  individual native tools, or a guessed alias.
- Re-list and re-describe after a schema/version mismatch.
- Wait for **Allow once** when cross-environment access asks. A denial is
  authoritative; never switch lanes or presentation to avoid it.
- Treat declared effects exactly and never broaden the requested action.
- Never invent tenant, principal, source-thread, environment, run, capability,
  or token authority.
