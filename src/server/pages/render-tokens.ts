import { randomBytes } from "node:crypto";
import type { RequestScope } from "../identity/identity-provider.js";

export const PAGE_RENDER_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
export const PAGE_RENDER_TOKEN_LIFETIME_MS = 120_000;
const MAXIMUM_RENDER_TOKENS = 2_048;

export interface PageRenderAuthority {
  readonly scope: RequestScope;
  readonly threadId: string;
  readonly pageId: string;
  readonly revision: number;
}

interface TokenEntry extends PageRenderAuthority {
  readonly expiresAt: number;
}

/**
 * Short-lived, process-local authority for exactly one immutable revision.
 * Tokens never carry pairing credentials and cannot select another resource.
 * Reads still consult the scoped repository, so deletion revokes access.
 */
export class PageRenderTokens {
  readonly #entries = new Map<string, TokenEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  mint(authority: PageRenderAuthority): { readonly url: string; readonly expiresAt: string } {
    const now = this.now();
    this.#prune(now);
    while (this.#entries.size >= MAXIMUM_RENDER_TOKENS) {
      const oldest = this.#entries.keys().next().value;
      if (oldest === undefined) break;
      this.#entries.delete(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + PAGE_RENDER_TOKEN_LIFETIME_MS;
    this.#entries.set(token, {
      scope: Object.freeze({ ...authority.scope }),
      threadId: authority.threadId,
      pageId: authority.pageId,
      revision: authority.revision,
      expiresAt,
    });
    return { url: `/page-render/${token}`, expiresAt: new Date(expiresAt).toISOString() };
  }

  resolve(token: string): PageRenderAuthority | undefined {
    if (!PAGE_RENDER_TOKEN_PATTERN.test(token)) return undefined;
    const entry = this.#entries.get(token);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.#entries.delete(token);
      return undefined;
    }
    return entry;
  }

  #prune(now: number): void {
    for (const [token, entry] of this.#entries) {
      if (entry.expiresAt <= now) this.#entries.delete(token);
    }
  }
}
