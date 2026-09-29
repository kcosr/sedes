# Additive item metadata review

This is a bounded correction for histories and events from Codex 0.156.1 and
0.159.0. It does not qualify those releases in full, alter executable admission,
or replace the pinned 0.153.0 generated binding.

## Artifact provenance

Official schemas were exported from the exact published npm runtime packages
on Linux x64, in disposable directories, with no model requests:

```sh
npm exec --yes --package=@openai/codex@0.156.1 -- codex app-server generate-json-schema --out /tmp/codex-schema-0.156.1
npm exec --yes --package=@openai/codex@0.159.0 -- codex app-server generate-json-schema --out /tmp/codex-schema-0.159.0
sha256sum /tmp/codex-schema-*/v2/ThreadItemsListResponse.json
```

The complete exported `v2/ThreadItemsListResponse.json` files have these SHA-256
digests. Re-export and compare them to detect upstream artifact drift:

| Runtime | Schema SHA-256 |
| --- | --- |
| 0.156.1 | `ffe80a17f536ce7ff1b0940103be93f77c439df02d3dff314747368b6e6b45d6` |
| 0.159.0 | `bc8a8dcb9a48d9ca38b0a5faa89b80ec2fd57398cd3a8dcc15097776153f6c74` |

## Reviewed fields and handling

- `ThreadItemEntry.startedAtMs` and `completedAtMs` appear in 0.159.0.
  Both are optional nullable int64 Unix millisecond timestamps. Sedes accepts
  null or safe integers and discards them after validation; they do not replace
  turn timestamps, change history ordering, or supply accounting evidence.
- `ThreadItem.mcpToolCall.mcpAppUi` appears in both reviewed releases.
  It is optional and nullable. A non-null object requires string
  `resourceUri` and `preferredModelDisplayMode` equal to `inline` or
  `fullscreen`. Sedes closes and bounds that object, then discards it.
  It neither opens the URI nor advertises an MCP app UI feature.
- All other item/entry metadata remains subject to existing exact-key checks.
  Missing fields required by the pinned contract remain invalid. The generated
  artifacts remain unchanged; their open-property schemas are followed by
  one explicit semantic refinement, with no alternate parser or fallback.

The item projection is shared by paginated and legacy history, resume replies,
and live item/turn notifications. Regression coverage in
`tests/unit/codex-history-projector.test.ts` exercises absent, null, and non-null
metadata, malformed values, unknown keys, and projection without mutating the
caller's input.

Private copies of the two failing rollout histories were resumed under isolated
homes with their matching Codex versions, without starting turns. Their actual
item-page responses reproduced both failures. Those transcripts and generated
responses are not repository fixtures.

This is Codex-private metadata handling. Pi, Claude, and Grok are intentionally
unaffected: none consumes this wire format. No normalized browser contract,
database schema, runtime protocol version, or ownership boundary changes.
Server and sidecar bundles must be rebuilt and updated to use the correction.
