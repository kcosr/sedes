---
name: sedes-cli-progressive-tools
description: >-
  Discover and invoke Sedes operations through the progressive JSON interface
  of the generated `sedes` CLI. Use only in CLI-progressive presentation mode;
  never use named application commands or native Sedes tools from this skill.
---

# Sedes CLI Progressive Tools

Use only the generated CLI's generic JSON discovery and invocation family.

## Confirm the presentation

- Continue only when Sedes has configured CLI-progressive presentation, Bash
  and the `sedes` executable are available, and no native Sedes tools are
  visible.
- Require `SEDES_AGENT_TOOL_ENDPOINT` and exactly one already-configured caller
  credential: `SEDES_AGENT_TOOL_SOURCE_CAPABILITY` for a provider thread or
  `SEDES_AGENT_TOOL_CLIENT_TOKEN` for a principal Tool client.
- Never inspect, print, translate, or move a bearer value. Never put one in a
  command argument, URL, prompt, log, or ordinary output.
- If the configured presentation does not match this skill, stop and report
  the mismatch. Do not switch presentation families.

## Discover and invoke

1. List the operations currently exposed to this caller:

   ```sh
   sedes tool list --json
   ```

2. Select only IDs in that response. Labels and descriptions are discovery
   metadata, not authorization.
3. Describe every operation needed for the immediate plan in one bounded call:

   ```sh
   sedes tool describe TOOL_ID [TOOL_ID ...] --json
   ```

   Describe at most 16 unique IDs. The request is all-or-nothing.

4. Construct the complete canonical input from the returned schema, write it to
   a reviewed UTF-8 JSON file, and invoke exactly that described operation:

   ```sh
   sedes tool invoke TOOL_ID --input-file INPUT.json --json
   ```

Copy the exact current tool ID and schema version represented by discovery.
Never use a remembered catalog, field, version, route, or command alias. In
this mode, do not use root help, group help, application-command help, or named
application commands.

On exit code 0, stdout is exactly the operation payload described by the
tool's `outputSchema`; there is no invocation or `output` wrapper. Treat a
nonzero exit as failure.

## Literal input and uncertain writes

Keep multiline Markdown, backticks, `$()`, quotes, and other shell syntax in
the reviewed JSON input file, never in an interpolated shell command. Input is
still checked against the live schema and transport byte limit.

Never retry a write whose transport outcome is uncertain. Reconcile it with a
currently advertised read using the exact returned or previously known stable
identifier, or ask the user how to proceed.

## Task workflow

### Quick current-scope creation

Nearly every task created by a thread agent belongs to its current workspace
or current thread. Unless the user explicitly names a different target, go
straight to describing `task.create` without listing the catalog, then use one
of these basic inputs from its current schema:

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

Freshly describe other task operations needed. The current task list requires
both `scope` and `scopeMode`; construct them only from its live schema. `exact`
selects tasks directly assigned to the scope, while `subtree` also traverses
descendants. Preserve identical scope, scope mode, filters, projection, page
size, and opaque cursor across continuation pages.

Create a task once. Preserve the complete returned record, especially its
exact `id` and `revision`. Verify through the advertised exact-record read when
independent confirmation is warranted. Before an update, read the current
record and send its returned revision as the expected revision with only the
intended fields. A revision conflict is authoritative: read again before
deciding whether another update is appropriate. Never create again to correct
or verify an uncertain creation.

## Policy and source authority

- Re-list once after a denial or disappearance. Do not retry through raw HTTP,
  native tools, named commands, or a guessed alias.
- Re-describe after a schema/version mismatch before rebuilding input.
- Treat write, destructive, external-side-effect, and model-execution effects
  exactly as described. Do not broaden the user's action.
- Wait for an **Allow once** cross-environment decision. A denial is
  authoritative; never change presentation to avoid it.
- Never invent tenant, principal, source-thread, execution, environment, run,
  client, credential-generation, capability, or token authority.
