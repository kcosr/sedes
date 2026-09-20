import type { Request, RequestHandler } from "express";
import { z } from "zod";
import {
  commitWorkpadDraftRequestSchema,
  createWorkpadRequestSchema,
  listWorkpadsRequestSchema,
  saveWorkpadDraftRequestSchema,
  updateWorkpadRequestSchema,
  workpadDraftSchema,
  workpadIdSchema,
  workpadListPageSchema,
  workpadRevisionPageSchema,
  workpadRevisionSchema,
  workpadSchema,
} from "../../shared/protocol/workpads.js";
import type { WorkpadService } from "../domain/workpad-service.js";
import type { RequestScope } from "../identity/identity-provider.js";

interface WorkpadRoutes {
  get(path: string, ...handlers: RequestHandler[]): void;
  post(path: string, ...handlers: RequestHandler[]): void;
  put(path: string, ...handlers: RequestHandler[]): void;
  patch(path: string, ...handlers: RequestHandler[]): void;
  delete(path: string, ...handlers: RequestHandler[]): void;
}

const revisionNumber = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const pathSchema = z.strictObject({ workpadId: workpadIdSchema });
const pageQuerySchema = z.strictObject({
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)).optional(),
  cursor: z.string().min(1).max(256).optional(),
});
const listQuerySchema = pageQuerySchema.extend({
  scopeKind: z.enum(["global", "workspace", "thread"]),
  workspaceId: z.string().optional(),
  threadId: z.string().optional(),
  scopeMode: z.enum(["exact", "subtree"]).optional(),
  query: z.string().optional(),
  archived: z.enum(["true", "false"]).transform(value => value === "true").optional(),
}).superRefine((query, context) => {
  if ((query.scopeKind !== "workspace" && query.workspaceId !== undefined) ||
      (query.scopeKind !== "thread" && query.threadId !== undefined)) {
    context.addIssue({ code: "custom", message: "Scope identifiers must match the selected scope." });
  }
});

/** Uses the application's ordinary request-ownership and identity boundary. */
export function registerWorkpadRoutes(
  routes: WorkpadRoutes,
  scope: (request: Request) => Promise<RequestScope>,
  service: WorkpadService,
): void {
  routes.get("/api/workpads", async (request, response) => {
    const owner = await scope(request);
    const query = listQuerySchema.parse(request.query);
    const selectedScope = query.scopeKind === "global"
      ? { kind: "global" as const }
      : query.scopeKind === "workspace"
        ? { kind: "workspace" as const, workspaceId: query.workspaceId }
        : { kind: "thread" as const, threadId: query.threadId };
    const input = listWorkpadsRequestSchema.parse({
      scope: selectedScope, scopeMode: query.scopeMode, query: query.query,
      archived: query.archived, limit: query.limit, cursor: query.cursor,
    });
    response.json(workpadListPageSchema.parse(await service.list(owner, input)));
  });
  routes.post("/api/workpads", async (request, response) => {
    const owner = await scope(request);
    const workpad = await service.create(owner, createWorkpadRequestSchema.parse(request.body));
    response.status(201).json({ workpad: workpadSchema.parse(workpad) });
  });
  routes.get("/api/workpads/:workpadId", async (request, response) => {
    const owner = await scope(request);
    const { workpadId } = pathSchema.parse(request.params);
    response.json({ workpad: workpadSchema.parse(await service.get(owner, workpadId)) });
  });
  routes.patch("/api/workpads/:workpadId", async (request, response) => {
    const owner = await scope(request);
    const { workpadId } = pathSchema.parse(request.params);
    const workpad = await service.update(owner, workpadId, updateWorkpadRequestSchema.parse(request.body));
    response.json({ workpad: workpadSchema.parse(workpad) });
  });
  routes.get("/api/workpads/:workpadId/revisions", async (request, response) => {
    const owner = await scope(request);
    const { workpadId } = pathSchema.parse(request.params);
    response.json(workpadRevisionPageSchema.parse(await service.revisions(owner, workpadId, pageQuerySchema.parse(request.query))));
  });
  routes.get("/api/workpads/:workpadId/revisions/:revision", async (request, response) => {
    const owner = await scope(request);
    const params = pathSchema.extend({ revision: z.string().regex(/^\d+$/).transform(Number).pipe(revisionNumber) }).parse(request.params);
    response.json({ revision: workpadRevisionSchema.parse(await service.revision(owner, params.workpadId, params.revision)) });
  });
  routes.get("/api/workpads/:workpadId/draft", async (request, response) => {
    const owner = await scope(request);
    const { workpadId } = pathSchema.parse(request.params);
    response.json({ draft: workpadDraftSchema.parse(await service.getDraft(owner, workpadId)) });
  });
  routes.put("/api/workpads/:workpadId/draft", async (request, response) => {
    const owner = await scope(request);
    const { workpadId } = pathSchema.parse(request.params);
    response.json({ draft: workpadDraftSchema.parse(await service.saveDraft(owner, workpadId, saveWorkpadDraftRequestSchema.parse(request.body))) });
  });
  routes.delete("/api/workpads/:workpadId/draft", async (request, response) => {
    const owner = await scope(request);
    const { workpadId } = pathSchema.parse(request.params);
    const input = z.strictObject({ expectedRevision: revisionNumber }).parse(request.body);
    response.json({ draft: workpadDraftSchema.parse(await service.discardDraft(owner, workpadId, input.expectedRevision)) });
  });
  routes.post("/api/workpads/:workpadId/draft/commit", async (request, response) => {
    const owner = await scope(request);
    const { workpadId } = pathSchema.parse(request.params);
    const workpad = await service.commitDraft(owner, workpadId, commitWorkpadDraftRequestSchema.parse(request.body));
    response.json({ workpad: workpadSchema.parse(workpad), draft: workpadDraftSchema.parse(await service.getDraft(owner, workpadId)) });
  });
}
