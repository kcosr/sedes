import { z } from "zod";
import { WORKSPACE_COMPARE_FILTER_MAX_LENGTH, type WorkspaceCompareNavigation } from "./workspace-compare-navigation.js";

const path = z.string().max(4096);
const endpoint = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("working_tree") }),
  z.strictObject({ kind: z.literal("index") }),
  z.strictObject({ kind: z.literal("commit"), commitHash: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u) }),
  z.strictObject({ kind: z.literal("ref"), refKind: z.enum(["local_branch", "remote_branch", "tag"]), label: path }),
]);
const fileAnchorSchema = z.strictObject({ oldPath: path.optional(), newPath: path.optional(),
    changeKind: z.enum(["added", "deleted", "modified", "renamed", "copied", "type_changed", "unmerged"]),
    line: z.number().int().min(1).optional(), side: z.enum(["deletions", "additions"]).optional(),
    offset: z.number().finite().min(-10000).max(10000).optional(),
  });

const navigationSchema = z.strictObject({
  repository: z.strictObject({ displayName: path, pathPrefix: path.optional(), repositoryKey: path }),
  base: endpoint, head: endpoint, mode: z.enum(["direct", "merge_base"]),
  fingerprint: z.string().max(128).optional(),
  file: fileAnchorSchema.optional(),
  returnLocations: z.array(fileAnchorSchema).max(32).optional(),
  filter: z.string().max(WORKSPACE_COMPARE_FILTER_MAX_LENGTH), navigatorWidth: z.number().min(160).max(600),
  collapsedDirectories: z.array(path).max(2000),
  preferences: z.strictObject({ diffStyle: z.enum(["split", "unified"]), overflow: z.enum(["scroll", "wrap"]) }),
});
const entrySchema = z.strictObject({ workspaceId: z.string().max(128), rootId: z.string().max(128),
  mode: z.enum(["browse", "compare"]), navigation: navigationSchema.optional(), selectedReviewId: z.string().max(128).optional(),
});
const schema = z.strictObject({ version: z.literal(1), entries: z.array(entrySchema).max(32) });
export interface WorkspaceCompareStoredState {
  readonly mode: "browse" | "compare";
  readonly navigation?: WorkspaceCompareNavigation;
  readonly selectedReviewId?: string;
}
/** Only server-derived principal scope is accepted here. The key contains no credential.
 * Errors retain bounded in-memory state; no alternate identity or legacy parser is used. */
export function createWorkspaceCompareStorage(storage?: Pick<Storage, "getItem" | "setItem">) {
  const memory = new Map<string, z.infer<typeof schema>>();
  const key = (scope: string) => `sedes.files-navigation.v1:${scope}`;
  const read = (scope: string): z.infer<typeof schema> => {
    const cached = memory.get(scope);
    if (cached) return cached;
    let state: z.infer<typeof schema> = { version: 1, entries: [] };
    try {
      const raw = storage?.getItem(key(scope));
      if (raw && raw.length <= 1_000_000) {
        const parsed = schema.safeParse(JSON.parse(raw));
        if (parsed.success) state = parsed.data;
      }
    } catch { /* Navigation still works with storage denied. */ }
    memory.set(scope, state);
    while (memory.size > 8) memory.delete(memory.keys().next().value!);
    return state;
  };
  return {
    latest(scope: string | undefined, workspaceId: string | undefined): string | undefined {
      if (!scope || !workspaceId) return undefined;
      return read(scope).entries.findLast(e => e.workspaceId === workspaceId)?.rootId;
    },
    get(scope: string | undefined, workspaceId: string | undefined, rootId: string): WorkspaceCompareStoredState | undefined {
      if (!scope || !workspaceId) return undefined;
      const entry = read(scope).entries.find(e => e.workspaceId === workspaceId && e.rootId === rootId);
      if (!entry) return undefined;
      return { mode: entry.mode, ...(entry.navigation ? { navigation: entry.navigation as WorkspaceCompareNavigation } : {}), ...(entry.selectedReviewId ? { selectedReviewId: entry.selectedReviewId } : {}) };
    },
    set(scope: string | undefined, workspaceId: string | undefined, rootId: string, state: WorkspaceCompareStoredState): void {
      if (!scope || !workspaceId) return;
      const entry = entrySchema.safeParse({ workspaceId, rootId, ...state });
      if (!entry.success) return;
      const current = read(scope);
      const entries = [...current.entries.filter(e => e.workspaceId !== workspaceId || e.rootId !== rootId), entry.data].slice(-32);
      const next = { version: 1 as const, entries };
      let encoded = JSON.stringify(next);
      while (encoded.length > 1_000_000 && next.entries.length > 1) {
        next.entries.shift();
        encoded = JSON.stringify(next);
      }
      // A single oversized record must not erase the last usable navigation.
      if (encoded.length > 1_000_000) return;
      memory.set(scope, next);
      try { storage?.setItem(key(scope), encoded); } catch { /* In-memory record remains authoritative for this client. */ }
    },
  };
}
function browserStorage(): Storage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}
export const workspaceCompareStorage = createWorkspaceCompareStorage(browserStorage());
