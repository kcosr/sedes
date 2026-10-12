import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { AppConfig } from "../config/config.js";
import type { IdentityProvider, RequestScope } from "../identity/identity-provider.js";
import { PAGE_CONTENT_SECURITY_POLICY, renderPageDocument, type CapturedPageDocument } from "./html-policy.js";
import { PageRenderTokens } from "./render-tokens.js";

const parameters = z.object({
  threadId: z.string().uuid(),
  pageId: z.string().uuid(),
  revision: z.coerce.number().int().positive().safe(),
});

interface PageContentReader {
  get(scope: RequestScope, threadId: string, pageId: string, revision: number): unknown;
  content(scope: RequestScope, threadId: string, pageId: string, revision: number): CapturedPageDocument | Promise<CapturedPageDocument>;
}

export type PageRenderHandler = (request: Request, response: Response, next?: NextFunction) => Promise<void>;

/** Mount publicRouter after host checks, before authentication. Mount
 * authenticatedRouter only after normal authentication and CSRF checks. */
export function createPageRenderRoutes(dependencies: {
  readonly pages: PageContentReader;
  readonly identity: IdentityProvider<Request>;
  readonly config: Pick<AppConfig, "packagedClientOrigins">;
  readonly tokens?: PageRenderTokens;
}): {
  readonly publicRouter: Router;
  readonly authenticatedRouter: Router;
  readonly renderHandler: PageRenderHandler;
  readonly mintHandler: PageRenderHandler;
} {
  const tokens = dependencies.tokens ?? new PageRenderTokens();
  const publicRouter = Router();
  const authenticatedRouter = Router();

  const mintHandler: PageRenderHandler = async (request, response) => {
    const { threadId, pageId, revision } = parameters.parse(request.params);
    const scope = await dependencies.identity.resolve(request);
    // Validate current ownership/existence before issuing the capability.
    await dependencies.pages.get(scope, threadId, pageId, revision);
    response.setHeader("Cache-Control", "no-store");
    response.json(tokens.mint({ scope, threadId, pageId, revision }));
  };

  const renderHandler: PageRenderHandler = async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    response.setHeader("X-DNS-Prefetch-Control", "off");
    response.removeHeader("X-Frame-Options");
    const ancestors = ["'self'", ...dependencies.config.packagedClientOrigins].join(" ");
    response.setHeader("Content-Security-Policy", `${PAGE_CONTENT_SECURITY_POLICY}; frame-ancestors ${ancestors}`);
    response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), display-capture=(), clipboard-read=(), clipboard-write=(), payment=(), usb=(), serial=(), hid=(), fullscreen=()");
    const token = typeof request.params.token === "string" ? request.params.token : "";
    const authority = tokens.resolve(token);
    if (!authority) {
      response.status(404).type("text/plain").send("Preview unavailable. Reopen it to request a new preview URL.");
      return;
    }
    const document = await dependencies.pages.content(authority.scope, authority.threadId, authority.pageId, authority.revision);
    if (!tokens.resolve(token)) {
      response.status(404).type("text/plain").send("Preview unavailable. Reopen it to request a new preview URL.");
      return;
    }
    response.type("html").send(renderPageDocument(document));
  };
  authenticatedRouter.post("/api/threads/:threadId/pages/:pageId/revisions/:revision/render-token", mintHandler);
  publicRouter.get("/page-render/:token", renderHandler);
  return { publicRouter, authenticatedRouter, mintHandler, renderHandler };
}
