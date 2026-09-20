---
name: sedes-cli-individual-tools
description: >-
  Discover and invoke Sedes operations through human-readable CLI help and
  individually named typed commands. Use only in CLI-individual presentation
  mode; never use generic JSON discovery or native Sedes tools from this skill.
---

# Sedes CLI Individual Tools

Use only the generated CLI's live help hierarchy and named application
commands.

## Confirm the presentation

- Continue only when Sedes has configured CLI-individual presentation, Bash
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

1. Inspect the live caller-filtered command hierarchy:

   ```sh
   sedes --help
   ```

2. Inspect the relevant live group:

   ```sh
   sedes task --help
   ```

3. Inspect the exact command immediately before constructing input:

   ```sh
   sedes task create --help
   ```

4. Invoke that named command with only options advertised by its current help:

   ```sh
   sedes task create \
     --title "Make agent-access CLI environment variables override config values" \
     --details-file /tmp/task-details.md \
     --scope-kind workspace
   ```

Property names become kebab-case options, nested properties are flattened,
primitive arrays repeat the option, and Booleans require explicit `true` or
`false` when the live help advertises those forms. For a complete complex
canonical value, use the named command's advertised `--input-file` option.

Never guess a group, command, option, or schema from memory. In this mode, do
not use the generic `tool` command family. Successful stdout is the canonical
JSON operation payload described by the current command, with no invocation or
`output` wrapper. Treat a nonzero exit as failure.

## Preserve literal text

Do not place multiline Markdown, backticks, `$()`, quotes, or other shell
syntax in an interpolated command string. When help advertises it, append
`-file` to a string option and pass a reviewed UTF-8 path, or pass `-` to read
that exact string from stdin. File and stdin input remain subject to the live
schema and byte limit.

Never retry a write whose transport outcome is uncertain. Reconcile it with a
currently advertised named read using the exact stable identifier, or ask the
user how to proceed.

## Task workflow

### Quick current-scope creation

Nearly every task created by a thread agent belongs to its current workspace
or current thread. Unless the user explicitly names a different target, use
one of these short forms directly and do not run help or try to discover an ID:

```sh
# Current workspace (the usual choice)
sedes task create --title "Investigate the reported issue" --scope-kind workspace

# Current thread
sedes task create --title "Follow up in this thread" --scope-kind thread

# Principal-global, only when global scope is actually intended
sedes task create --title "Review shared maintenance" --scope-kind global
```

For `workspace` and `thread`, omitting the target ID deliberately asks Sedes to
resolve the authenticated agent's current workspace or thread. Do not call
agent context, workspace list, or thread list merely to recover that ID. Use
`--scope-workspace-id` or `--scope-thread-id` only when the user explicitly
requests another known workspace or thread; never guess a target ID.

Use the normal help workflow when adding other fields, targeting another
scope, or after the quick command reports an option/schema mismatch. The
task-list command requires both scope and its canonical `scopeMode` when
current help advertises them. `exact` selects direct assignments; `subtree`
also traverses descendants. Preserve the identical scope, scope mode, filters,
projection, page size, and opaque cursor across continuation pages.

Create once and preserve the complete returned record, especially its exact
`id` and `revision`. Verify with the named exact-record read when independent
confirmation is warranted. Before an update, read the current record and pass
its returned revision through the advertised expected-revision option with
only the intended fields. A revision conflict is authoritative: read again
before deciding whether another update remains appropriate. Never create again
to correct or verify an uncertain creation.

## Policy and source authority

- Re-run root help once after a denial or disappearance. Do not retry through
  raw HTTP, native tools, generic discovery, or a guessed alias.
- Re-run exact command help after a schema/version mismatch.
- Treat displayed effects and approval behavior as authoritative. Do not
  broaden the user's action.
- Wait for an **Allow once** cross-environment decision. A denial is
  authoritative; never change presentation to avoid it.
- Never invent tenant, principal, source-thread, execution, environment, run,
  client, credential-generation, capability, or token authority.
