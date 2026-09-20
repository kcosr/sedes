import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import type {
  AppConfig,
  PackagedClientOrigin,
} from "../config/config.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CORS_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
]);
const CORS_HEADERS = new Set(["content-type", "last-event-id", "x-csrf-token", "authorization"]);

function isLoopbackAddress(value: string | undefined): boolean {
  return (
    value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1"
  );
}

interface ParsedAuthority {
  readonly hostname: string;
  readonly port: string;
}

function parseAuthority(value: string): ParsedAuthority | undefined {
  try {
    const url = new URL(`http://${value}`);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    const hostname = url.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
    return hostname ? { hostname, port: url.port } : undefined;
  } catch {
    return undefined;
  }
}

function normalizedPort(protocol: "http" | "https", port: string): string {
  return port || (protocol === "https" ? "443" : "80");
}

function originMatches(
  origin: URL,
  authority: ParsedAuthority,
  protocol: "http" | "https",
): boolean {
  const hostname = origin.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  return (
    !origin.username &&
    !origin.password &&
    origin.pathname === "/" &&
    !origin.search &&
    !origin.hash &&
    origin.protocol === `${protocol}:` &&
    hostname === authority.hostname &&
    normalizedPort(protocol, origin.port) ===
      normalizedPort(protocol, authority.port)
  );
}

function sameToken(actual: string | undefined, expected: string): boolean {
  if (!actual) {
    return false;
  }
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function isApiRequest(request: Request): boolean {
  return request.path === "/api" || request.path.startsWith("/api/");
}

function packagedClientApiOrigin(
  request: Request,
  config: AppConfig,
): PackagedClientOrigin | undefined {
  if (!isApiRequest(request)) return undefined;
  return config.packagedClientOrigins.find(
    (origin) => origin === request.headers.origin,
  );
}

function requestedCorsHeaders(
  value: string | undefined,
): readonly string[] | undefined {
  if (value === undefined || value.trim() === "") return [];
  const headers = value.split(",").map((header) => header.trim().toLowerCase());
  if (headers.some((header) => header === "")) return undefined;
  return headers;
}

export function createCsrfToken(): string {
  return randomBytes(32).toString("base64url");
}

export type WebSocketSecurityRejection =
  "host_not_allowed" | "forwarded_origin_not_allowed" | "origin_not_allowed";

type HostOriginValidation =
  | { readonly allowed: true; readonly packagedClientOrigin: boolean }
  | { readonly allowed: false; readonly reason: WebSocketSecurityRejection };

function validateHostOriginAuthority(input: {
  readonly config: AppConfig;
  readonly host: string | undefined;
  readonly forwardedHost: string | undefined;
  readonly forwardedProtocol: string | undefined;
  readonly origin: string | undefined;
  readonly remoteAddress: string | undefined;
  readonly packagedClientOrigin: PackagedClientOrigin | undefined;
  readonly requireOrigin: boolean;
}): HostOriginValidation {
  const allowedHosts = new Set([
    "127.0.0.1",
    "localhost",
    "::1",
    ...(input.config.trustedLanHost ? [input.config.trustedLanHost] : []),
    ...input.config.allowedTailscaleHosts,
  ]);
  const host = parseAuthority(input.host ?? "");
  if (!host || !allowedHosts.has(host.hostname)) {
    return { allowed: false, reason: "host_not_allowed" };
  }

  let effectiveAuthority = host;
  let effectiveProtocol: "http" | "https" = "http";
  if (input.forwardedHost || input.forwardedProtocol) {
    const forwardedHost = input.forwardedHost
      ? parseAuthority(input.forwardedHost)
      : undefined;
    if (
      !input.forwardedHost ||
      !input.forwardedProtocol ||
      !isLoopbackAddress(input.remoteAddress) ||
      !forwardedHost ||
      !allowedHosts.has(forwardedHost.hostname) ||
      (input.forwardedProtocol !== "http" &&
        input.forwardedProtocol !== "https")
    ) {
      return { allowed: false, reason: "forwarded_origin_not_allowed" };
    }
    effectiveAuthority = forwardedHost;
    effectiveProtocol = input.forwardedProtocol;
  }

  const packagedClientOrigin =
    input.packagedClientOrigin !== undefined &&
    input.origin === input.packagedClientOrigin;
  if (!input.origin) {
    return input.requireOrigin
      ? { allowed: false, reason: "origin_not_allowed" }
      : { allowed: true, packagedClientOrigin: false };
  }
  if (packagedClientOrigin) {
    return { allowed: true, packagedClientOrigin: true };
  }
  try {
    const originUrl = new URL(input.origin);
    const originHost = originUrl.hostname
      .toLowerCase()
      .replace(/^\[|\]$/g, "")
      .replace(/\.$/, "");
    if (
      !allowedHosts.has(originHost) ||
      !["http:", "https:"].includes(originUrl.protocol) ||
      (!["127.0.0.1", "localhost", "::1"].includes(originHost) &&
        originUrl.protocol !== "https:") ||
      !originMatches(originUrl, effectiveAuthority, effectiveProtocol)
    ) {
      return { allowed: false, reason: "origin_not_allowed" };
    }
  } catch {
    return { allowed: false, reason: "origin_not_allowed" };
  }
  return { allowed: true, packagedClientOrigin: false };
}

/**
 * Upgrade requests bypass Express middleware. This validator mirrors its exact
 * Host/Origin authority. Browsers may omit Fetch Metadata on WebSocket
 * handshakes; when either metadata header is present, both must match the
 * admitted browser origin. It returns only a bounded reason; callers own the
 * raw rejection.
 */
export function validateWebSocketHostOrigin(
  request: IncomingMessage,
  config: AppConfig,
): WebSocketSecurityRejection | undefined {
  const header = (name: string): string | undefined => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const authority = validateHostOriginAuthority({
    config,
    host: header("host"),
    forwardedHost: header("x-forwarded-host"),
    forwardedProtocol: header("x-forwarded-proto"),
    origin: header("origin"),
    remoteAddress: request.socket.remoteAddress,
    packagedClientOrigin: config.packagedClientOrigins.find(
      (origin) => origin === header("origin"),
    ),
    requireOrigin: true,
  });
  if (!authority.allowed) return authority.reason;

  const fetchMode = header("sec-fetch-mode");
  const fetchSite = header("sec-fetch-site");
  const fetchMetadataAbsent =
    fetchMode === undefined && fetchSite === undefined;
  if (
    !fetchMetadataAbsent &&
    (fetchMode !== "websocket" ||
      (!authority.packagedClientOrigin &&
        fetchSite !== "same-origin" &&
        fetchSite !== "same-site") ||
      (authority.packagedClientOrigin && fetchSite !== "cross-site"))
  ) {
    return "origin_not_allowed";
  }
  return undefined;
}

/** Native connector upgrades have no browser origin. Preserve exact Host and
 * loopback-proxy admission, and reject browser-originated agent connections. */
export function validateNativeWebSocketHost(
  request: IncomingMessage,
  config: AppConfig,
): WebSocketSecurityRejection | undefined {
  if (request.headers.origin !== undefined || request.headers["sec-fetch-mode"] !== undefined || request.headers["sec-fetch-site"] !== undefined) {
    return "origin_not_allowed";
  }
  const header = (name: string): string | undefined => {
    const value = request.headers[name];
    return Array.isArray(value) ? undefined : value;
  };
  const authority = validateHostOriginAuthority({
    config,
    host: header("host"),
    forwardedHost: header("x-forwarded-host"),
    forwardedProtocol: header("x-forwarded-proto"),
    origin: undefined,
    remoteAddress: request.socket.remoteAddress,
    packagedClientOrigin: undefined,
    requireOrigin: false,
  });
  return authority.allowed ? undefined : authority.reason;
}

export function requestIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const requestId = randomUUID();
  response.locals.requestId = requestId;
  response.setHeader("X-Request-Id", requestId);
  next();
}

export function securityHeaders(
  _request: Request,
  response: Response,
  next: NextFunction,
): void {
  // style-src permits inline <style> elements because Radix positioning and
  // scroll-lock (react-remove-scroll) inject them with dynamic content that
  // cannot be hash-pinned. ghostty-web fetches its package-owned inline WASM
  // data URL; data: is therefore admitted only for connect-src and images.
  // Composer image uploads use revocable object URLs for immediate local
  // thumbnails, so blob: is admitted only by img-src.
  // JavaScript remains 'self'-only; wasm-unsafe-eval permits only the
  // WebAssembly compiler required by ghostty-web, not string-to-JavaScript
  // evaluation.
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  next();
}

export function hostOriginGuard(config: AppConfig) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const packagedClientOrigin = packagedClientApiOrigin(request, config);
    const authority = validateHostOriginAuthority({
      config,
      host: request.headers.host,
      forwardedHost: request.header("X-Forwarded-Host"),
      forwardedProtocol: request.header("X-Forwarded-Proto"),
      origin: request.headers.origin,
      remoteAddress: request.socket.remoteAddress,
      packagedClientOrigin,
      requireOrigin: false,
    });
    if (!authority.allowed) {
      rejectHostOrigin(response, authority.reason);
      return;
    }
    const crossSiteTopLevelNavigation =
      request.method === "GET" &&
      request.header("Sec-Fetch-Mode") === "navigate" &&
      request.header("Sec-Fetch-Dest") === "document";
    if (
      request.header("Sec-Fetch-Site") === "cross-site" &&
      !crossSiteTopLevelNavigation &&
      !packagedClientOrigin
    ) {
      response.status(403).json({
        error: {
          code: "origin_not_allowed",
          message: "Cross-site requests are not allowed.",
          retryable: false,
        },
      });
      return;
    }
    next();
  };
}

function rejectHostOrigin(
  response: Response,
  reason: WebSocketSecurityRejection,
): void {
  const message =
    reason === "host_not_allowed"
      ? "This host is not allowed."
      : reason === "forwarded_origin_not_allowed"
        ? "These forwarded origin headers are not allowed."
        : "This origin is not allowed.";
  response.status(403).json({
    error: { code: reason, message, retryable: false },
  });
}

/**
 * Enables each explicitly admitted bundled client's exact cross-origin API
 * boundary.
 * Host and Origin validation must run before this middleware. The opt-in is
 * not authentication; it only grants browser access to the normalized API.
 */
export function packagedClientCors(config: AppConfig) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const packagedClientOrigin = packagedClientApiOrigin(request, config);
    if (!packagedClientOrigin) {
      next();
      return;
    }

    response.setHeader("Access-Control-Allow-Origin", packagedClientOrigin);
    response.setHeader(
      "Access-Control-Expose-Headers",
      "Content-Disposition, Content-Length, X-Sedes-Workspace-File-Revision",
    );
    response.vary("Origin");

    if (request.method !== "OPTIONS") {
      next();
      return;
    }

    const requestedMethod = request
      .header("Access-Control-Request-Method")
      ?.toUpperCase();
    const requestedHeaders = requestedCorsHeaders(
      request.header("Access-Control-Request-Headers"),
    );
    if (
      !requestedMethod ||
      !CORS_METHODS.has(requestedMethod) ||
      requestedHeaders === undefined ||
      requestedHeaders.some((header) => !CORS_HEADERS.has(header))
    ) {
      response.status(403).json({
        error: {
          code: "origin_not_allowed",
          message: "This cross-origin request is not allowed.",
          retryable: false,
        },
      });
      return;
    }

    response.setHeader(
      "Access-Control-Allow-Methods",
      "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
    );
    response.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Last-Event-ID, X-CSRF-Token, Authorization",
    );
    response.setHeader("Access-Control-Max-Age", "600");
    response.status(204).end();
  };
}

export function csrfGuard(
  csrfToken: string,
  csrfExemptReadPosts: ReadonlySet<string> = new Set(),
) {
  return (request: Request, response: Response, next: NextFunction): void => {
    if (
      SAFE_METHODS.has(request.method) ||
      (request.method === "POST" && csrfExemptReadPosts.has(request.path)) ||
      sameToken(request.header("X-CSRF-Token"), csrfToken)
    ) {
      next();
      return;
    }
    response.status(403).json({
      error: {
        code: "csrf_token_invalid",
        message: "Refresh the application and try again.",
        retryable: true,
      },
    });
  };
}
