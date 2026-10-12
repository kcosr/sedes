import { z } from "zod";
import { pageIdSchema, pageRevisionNumberSchema, pageSourceSchema, pageViewportSchema, publishPageRequestSchema,
  type PagePublicationAnchor } from "../../../shared/protocol/pages.js";
import { DomainError } from "../../domain/errors.js";
import type { RequestScope } from "../../identity/identity-provider.js";
import type { PageService } from "../../pages/page-service.js";
import { AgentToolOutput, type TrustedToolInvocationContext } from "../contracts/agent-tool-contracts.js";
import { renderPageDocument } from "../../pages/html-policy.js";

const paginationSchema = z.strictObject({ limit: z.number().int().min(1).max(100).optional(), cursor: z.string().max(256).optional() });
const getSchema = z.strictObject({ pageId: pageIdSchema, revision: pageRevisionNumberSchema.optional() });
const revisionsSchema = paginationSchema.extend({ pageId: pageIdSchema });
const previewSchema = pageSourceSchema.safeExtend({ viewport: pageViewportSchema.optional() });
export interface PagePreviewResult {
  readonly width: number; readonly height: number; readonly contentWidth: number; readonly contentHeight: number;
  readonly console: readonly { level: string; text: string }[];
  readonly screenshot: { mimeType: "image/png"; data: string; width: number; height: number };
}

/** File paths are interpreted only by the common Files service on the source environment. */
export class PageAgentToolService {
  constructor(readonly dependencies: {
    pages: PageService;
    capturePublication: (scope: RequestScope, threadId: string) => { anchor: PagePublicationAnchor; assertCurrent: () => void };
    preview?: (input: { html: string; width?: number; height?: number; signal?: AbortSignal }) => Promise<PagePreviewResult>;
  }) {}

  async execute(operation: "publish" | "preview" | "list" | "get" | "revisions", raw: unknown, context: TrustedToolInvocationContext): Promise<unknown> {
    if (context.subject.kind !== "thread_agent") throw new DomainError("bad_request", "HTML page tools require a source thread.");
    const scope = { tenantId: context.tenantId, principalId: context.principalId };
    const threadId = context.subject.sourceThreadId;
    if (operation === "publish") {
      const input = publishPageRequestSchema.parse(raw);
      const publication = this.dependencies.capturePublication(scope, threadId);
      return this.dependencies.pages.publish(scope, threadId, input, { invocationId: context.invocationId, ...publication }, context.abortSignal);
    }
    if (operation === "preview") {
      const input = previewSchema.parse(raw);
      if (!this.dependencies.preview) throw new DomainError("runtime_unavailable", "The optional HTML preview browser is unavailable.");
      const prepared = await this.dependencies.pages.prepare(scope, threadId, {
        ...(input.path === undefined ? {} : { path: input.path }), ...(input.html === undefined ? {} : { html: input.html }),
      }, context.abortSignal);
      const result = await this.dependencies.preview({ html: renderPageDocument(prepared), ...input.viewport, signal: context.abortSignal });
      const { screenshot, ...metadata } = result;
      return new AgentToolOutput({ ...metadata, screenshot: { mimeType: screenshot.mimeType, width: screenshot.width, height: screenshot.height,
        byteSize: Buffer.byteLength(screenshot.data, "base64") } }, [{ type: "image", mimeType: screenshot.mimeType, data: screenshot.data }]);
    }
    if (operation === "list") return this.dependencies.pages.list(scope, threadId, paginationSchema.parse(raw));
    if (operation === "revisions") {
      const { pageId, ...options } = revisionsSchema.parse(raw);
      return this.dependencies.pages.revisions(scope, threadId, pageId, options);
    }
    const input = getSchema.parse(raw);
    const page = this.dependencies.pages.get(scope, threadId, input.pageId, input.revision);
    const source = this.dependencies.pages.source(scope, threadId, input.pageId, input.revision);
    return { page, ...(source.path === undefined ? { html: source.html } : { sourcePath: source.path }) };
  }
}
