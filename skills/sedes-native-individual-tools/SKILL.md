---
name: sedes-native-individual-tools
description: >-
  Invoke individually exposed Sedes application tools through their native
  schemas. Use only in native-individual presentation mode; never use native
  progressive gateways, Bash, or the generated CLI.
---

# Sedes Native Individual Tools

Use only the individually exposed native Sedes application tools. Their names,
descriptions, and schemas are the current discovery surface.

## Confirm the presentation

- Continue only when individual Sedes application tools are visible and
  `sedes_catalog` is absent.
- If the visible presentation does not match this skill, stop and report the
  mismatch. Do not switch presentation families.
- Never invoke progressive gateways, Bash, the generated `sedes` executable,
  raw Sedes HTTP, or a guessed tool.

## Select and invoke

1. Inspect the currently visible native Sedes tools.
2. Select only a visible operation whose description and schema match the
   immediate task.
3. Construct input directly from that current schema and invoke it once.
4. Reinspect the visible set on a later turn or after denial/unavailability.

Native individual mode needs no separate catalog or describe call because each
visible operation already carries its exact schema.

## Task workflow

### Quick current-scope creation

Nearly every task created by a thread agent belongs to its current workspace
or current thread. Unless the user explicitly names a different target, invoke
the visible `sedes_task_create` tool directly with its current schema and one
of these basic inputs:

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
the authenticated agent's current scope. Do not invoke agent context, workspace
list, or thread list merely to recover those IDs. Supply an explicit target ID
only when the user requests another known workspace or thread; never guess one.
Global scope is explicit and should be used only when actually intended.

Reinspect visible task list/get/update schemas immediately before other task
operations. Never build other input from this skill or a remembered shape. The
current task list requires both `scope` and `scopeMode`; `exact` selects direct
assignments and `subtree` also traverses descendants. Preserve identical scope,
scope mode, filters, projection, page size, and opaque cursor across
continuation pages.

Create once. Preserve the returned exact `id` and `revision`, and independently
verify through the visible exact read when warranted. Read immediately before
an update, pass its current revision as the expected revision, and change only
the intended fields. A revision conflict requires a fresh read. Never retry an
uncertain write or create again to verify it.

## Policy and source authority

- If an operation is missing or denied, stop rather than using a progressive
  gateway, Bash, CLI, raw HTTP, or a guessed alias.
- Wait for **Allow once** when cross-environment access asks. A denial is
  authoritative; never change presentation to avoid it.
- Treat visible effects and approval behavior exactly. Do not broaden the
  requested action.
- Never invent tenant, principal, source-thread, execution, environment, run,
  capability, or token authority.
