import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  TOOL_POLICY_PAGE_MAX_ITEMS, TOOL_POLICY_SELECTION_MAX_ITEMS, TOOL_POLICY_CURSOR_MAX_CHARACTERS, toolPolicyDefinitionSchema, toolPolicySetSchema, toolPolicySetListSchema, toolPolicySelectionSchema, toolPolicySelectionListSchema,
  type ToolPolicyDefinition, type ToolPolicySet, type ToolPolicySelection,
  type ToolPolicySelectionSetting, type ToolPolicySelectionTarget,
} from "../../../shared/protocol/tool-policies.js";
import { MAXIMUM_BROWSER_ENTITY_BYTES, serializedUtf8Bytes } from "../../../shared/protocol/payload.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";

type PolicyRow = { id: string; name: string; enabledToolIds: string; resourceScope: string; revision: number; createdAt: number; updatedAt: number; normalizedName?: string };
const columns = "id,name,enabled_tool_ids_json AS enabledToolIds,resource_scope_json AS resourceScope,revision,created_at AS createdAt,updated_at AS updatedAt";
const targetId = (target: ToolPolicySelectionTarget): string => target.kind === "account" ? "" : target.kind === "environment" ? target.executionEnvironmentId : target.backendId;
const targetFromRow = (row: {targetKind: string; targetId: string}): ToolPolicySelectionTarget => {
  if (row.targetKind === "account") return { kind: "account" };
  if (row.targetKind === "environment") return { kind: "environment", executionEnvironmentId: row.targetId };
  if (row.targetKind === "backend") return { kind: "backend", backendId: row.targetId };
  throw new Error("tool_policy_selection_target_invalid");
};
function fromRow(row: PolicyRow): ToolPolicySet {
  const {normalizedName: _normalizedName, ...policy} = row;
  return toolPolicySetSchema.parse({ ...policy, enabledToolIds: JSON.parse(row.enabledToolIds), resourceScope: JSON.parse(row.resourceScope), createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() });
}

export class ToolPolicyRepository {
  constructor(readonly database: Database.Database) {}

  listPage(scope: RequestScope, input: {cursor?: string; pageSize?: number} = {}): {
    items: ToolPolicySet[];
    nextCursor?: string;
  } {
    const pageSize = input.pageSize ?? 50;
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > TOOL_POLICY_PAGE_MAX_ITEMS) {
      throw new DomainError("bad_request", "The tool policy page size is invalid.");
    }
    const fingerprint = createHash("sha256").update(JSON.stringify([scope.tenantId,scope.principalId])).digest("hex");
    let after: {normalizedName:string;name:string;id:string} | undefined;
    if (input.cursor) {
      try {
        if (input.cursor.length > TOOL_POLICY_CURSOR_MAX_CHARACTERS) throw new Error("cursor_too_long");
        const parsed = JSON.parse(Buffer.from(input.cursor,"base64url").toString("utf8"));
        if (Object.keys(parsed).length !== 4 || parsed.fingerprint !== fingerprint ||
          typeof parsed.normalizedName !== "string" || parsed.normalizedName.length > 160 ||
          typeof parsed.name !== "string" || parsed.name.length > 160 ||
          typeof parsed.id !== "string" || parsed.id.length !== 36) throw new Error("cursor_invalid");
        after = {normalizedName:parsed.normalizedName,name:parsed.name,id:parsed.id};
      } catch (cause) {
        throw new DomainError("cursor_invalid", "The tool policy cursor is invalid.",false,{cause});
      }
    }
    const rows = this.database.prepare(`SELECT ${columns},lower(name) AS normalizedName FROM tool_policy_sets
      WHERE tenant_id=? AND owner_principal_id=? ${after ? "AND (lower(name)>? OR (lower(name)=? AND (name>? OR (name=? AND id>?))))" : ""}
      ORDER BY lower(name),name,id LIMIT ?`).all(scope.tenantId,scope.principalId,
        ...(after ? [after.normalizedName,after.normalizedName,after.name,after.name,after.id] : []),pageSize+1) as PolicyRow[];
    const cursorFor = (row:PolicyRow) => Buffer.from(JSON.stringify({fingerprint,normalizedName:row.normalizedName,name:row.name,id:row.id}),"utf8").toString("base64url");
    const items: ToolPolicySet[] = [];
    for (const row of rows.slice(0,pageSize)) {
      const item = fromRow(row);
      // Include continuation overhead when choosing a page's final item.
      if (serializedUtf8Bytes({items:[...items,item],nextCursor:cursorFor(row)}) > MAXIMUM_BROWSER_ENTITY_BYTES) break;
      items.push(item);
    }
    if (rows.length && !items.length) throw new Error("tool_policy_exceeds_page_budget");
    const last = rows[items.length-1];
    return toolPolicySetListSchema.parse({items,...(rows.length > items.length && last ? {nextCursor:cursorFor(last)} : {})});
  }

  get(scope: RequestScope, id: string): ToolPolicySet {
    const row = this.database.prepare(`SELECT ${columns} FROM tool_policy_sets WHERE tenant_id=? AND owner_principal_id=? AND id=?`).get(scope.tenantId, scope.principalId, id) as PolicyRow | undefined;
    if (!row) throw new DomainError("not_found", "The tool policy set was not found.");
    return fromRow(row);
  }

  create(scope: RequestScope, definition: ToolPolicyDefinition, now = Date.now()): ToolPolicySet {
    return this.database.transaction(() => {
      definition = toolPolicyDefinitionSchema.parse(definition);
      const id = randomUUID();
      toolPolicySetSchema.parse({...definition,id,revision:0,createdAt:new Date(now).toISOString(),updatedAt:new Date(now).toISOString()});
      this.database.prepare(`INSERT INTO tool_policy_sets(tenant_id,owner_principal_id,id,name,enabled_tool_ids_json,resource_scope_json,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,0,?,?)`)
        .run(scope.tenantId, scope.principalId, id, definition.name, JSON.stringify([...definition.enabledToolIds].sort()), JSON.stringify(definition.resourceScope), now, now);
      return this.get(scope, id);
    })();
  }

  update(scope: RequestScope, id: string, definition: ToolPolicyDefinition, expectedRevision: number, now = Date.now()): ToolPolicySet {
    return this.database.transaction(() => {
      definition = toolPolicyDefinitionSchema.parse(definition);
      const current = this.assertRevision(scope, id, expectedRevision);
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw new DomainError("conflict", "The tool policy set revision can no longer be advanced.");
      toolPolicySetSchema.parse({...current,...definition,revision:current.revision+1,updatedAt:new Date(Math.max(Date.parse(current.updatedAt),now)).toISOString()});
      this.database.prepare(`UPDATE tool_policy_sets SET name=?,enabled_tool_ids_json=?,resource_scope_json=?,revision=revision+1,updated_at=max(updated_at,?) WHERE tenant_id=? AND owner_principal_id=? AND id=?`)
        .run(definition.name, JSON.stringify([...definition.enabledToolIds].sort()), JSON.stringify(definition.resourceScope), now, scope.tenantId, scope.principalId, id);
      return this.get(scope, id);
    })();
  }

  delete(scope: RequestScope, id: string, expectedRevision: number): void {
    this.database.transaction(() => {
      this.assertRevision(scope, id, expectedRevision);
      // Keep explicit selections unchanged: their missing policy must remain visible
      // and fail resolution, never silently inherit broader defaults.
      this.database.prepare("DELETE FROM tool_policy_sets WHERE tenant_id=? AND owner_principal_id=? AND id=?").run(scope.tenantId, scope.principalId, id);
    })();
  }

  assertRevision(scope: RequestScope, id: string, expectedRevision: number): ToolPolicySet {
    const policy = this.get(scope, id);
    if (policy.revision !== expectedRevision) throw new DomainError("conflict", "The tool policy set changed in another client.");
    return policy;
  }

  listSelections(scope: RequestScope): ToolPolicySelectionSetting[] {
    const rows = this.database.prepare(`SELECT target_kind AS targetKind,target_id AS targetId,selection_json AS selection,revision FROM tool_policy_selections WHERE tenant_id=? AND owner_principal_id=? ORDER BY target_kind,target_id LIMIT ?`)
      .all(scope.tenantId, scope.principalId, TOOL_POLICY_SELECTION_MAX_ITEMS+1) as {targetKind:string;targetId:string;selection:string;revision:number}[];
    return toolPolicySelectionListSchema.parse({items:rows.map(row => ({target:targetFromRow(row),selection:toolPolicySelectionSchema.parse(JSON.parse(row.selection)),revision:row.revision}))}).items;
  }

  getSelection(scope: RequestScope, target: ToolPolicySelectionTarget): ToolPolicySelectionSetting {
    const row = this.database.prepare(`SELECT selection_json AS selection,revision FROM tool_policy_selections WHERE tenant_id=? AND owner_principal_id=? AND target_kind=? AND target_id=?`)
      .get(scope.tenantId, scope.principalId, target.kind, targetId(target)) as {selection:string;revision:number} | undefined;
    return { target, selection: row ? toolPolicySelectionSchema.parse(JSON.parse(row.selection)) : {kind:"inherit"}, revision: row?.revision ?? 0 };
  }

  updateSelection(scope: RequestScope, target: ToolPolicySelectionTarget, selection: ToolPolicySelection, expectedRevision: number): ToolPolicySelectionSetting {
    return this.database.transaction(() => {
      selection = toolPolicySelectionSchema.parse(selection);
      this.assertSelection(scope, selection);
      const current = this.getSelection(scope, target);
      if (current.revision !== expectedRevision || current.revision >= Number.MAX_SAFE_INTEGER) throw new DomainError("conflict", "The tool policy selection changed in another client.");
      const otherSettings = this.listSelections(scope).filter(setting =>
        setting.target.kind !== target.kind || targetId(setting.target) !== targetId(target));
      toolPolicySelectionListSchema.parse({items:[...otherSettings,{target,selection,revision:current.revision+1}]});
      this.database.prepare(`INSERT INTO tool_policy_selections(tenant_id,owner_principal_id,target_kind,target_id,selection_json,revision) VALUES(?,?,?,?,?,1) ON CONFLICT(tenant_id,owner_principal_id,target_kind,target_id) DO UPDATE SET selection_json=excluded.selection_json,revision=tool_policy_selections.revision+1`)
        .run(scope.tenantId, scope.principalId, target.kind, targetId(target), JSON.stringify(selection));
      return this.getSelection(scope, target);
    })();
  }

  assertSelection(scope: RequestScope, selection: ToolPolicySelection): void {
    if (selection.kind === "policy_set") this.get(scope, selection.policySetId);
  }
}
