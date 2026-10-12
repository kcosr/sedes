import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, errors, type BrowserServer, type BrowserType } from "playwright";
import { parse } from "parse5";
import { PAGE_MEASUREMENT_EXPRESSION, PAGE_MEASUREMENT_INSTALL_SOURCE, PAGE_SETTLE_EXPRESSION, stabilizePageHeight, type PageSizingState } from "../../shared/page-sizing.js";
import { PAGE_RENDER_MAX_BYTES } from "../../shared/protocol/pages.js";
import { PAGE_CONTENT_SECURITY_POLICY, capturePageDocument, renderPageDocument } from "./html-policy.js";

export const PAGE_PREVIEW_PLAYWRIGHT_VERSION = "1.62.0";
export const PAGE_PREVIEW_DEFAULT_WIDTH = 768;
export const PAGE_PREVIEW_DEFAULT_HEIGHT = 600;
const MAX_WIDTH = 4096;
const MAX_HEIGHT = 8192;
const MAX_IMAGE_DIMENSION = 2000;
const MAX_SCREENSHOT_BYTES = 2 * 1024 * 1024;
const MAX_CONSOLE_ENTRIES = 100;
const MAX_CONSOLE_ENTRY_LENGTH = 2000;

export interface PagePreviewInput {
  /** Already imported, self-contained HTML with the normal page CSP. */
  html: string;
  width?: number;
  height?: number;
  signal?: AbortSignal;
}

export interface PagePreviewResult {
  png: Buffer;
  imageWidth: number;
  imageHeight: number;
  width: number;
  height: number;
  contentWidth: number;
  contentHeight: number;
  console: Array<{ level: string; text: string }>;
}

export interface PagePreviewBrowserStatus {
  installed: boolean;
  ready: boolean;
  playwrightVersion: string;
  directory: string;
  error?: string;
}

export class PagePreviewError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PagePreviewError";
  }
}

/** Installation-owned browser cache; never shares the provider's workspace. */
export function pagePreviewBrowserDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = os.homedir(),
): string {
  const pathModule = platform === "win32" ? path.win32 : path.posix;
  const configured = environment.SEDES_PAGE_PREVIEW_BROWSER_DIRECTORY;
  if (configured !== undefined) {
    if (!configured || !pathModule.isAbsolute(configured)) {
      throw new PagePreviewError("page_preview_cache_invalid", "SEDES_PAGE_PREVIEW_BROWSER_DIRECTORY must be an absolute path.");
    }
    return configured;
  }
  if (platform === "win32") {
    return path.win32.join(environment.LOCALAPPDATA ?? path.win32.join(homeDirectory, "AppData", "Local"), "Sedes", "page-preview-browser");
  }
  if (platform === "darwin") return path.join(homeDirectory, "Library", "Caches", "Sedes", "page-preview-browser");
  return path.join(environment.XDG_CACHE_HOME ?? path.join(homeDirectory, ".cache"), "sedes", "page-preview-browser");
}

/**
 * Playwright computes its registry root when imported. Keep our private cache
 * without changing process-wide environment or the test runner's browser cache.
 * The pinned public executablePath identifies the exact platform/revision tail.
 */
export function pagePreviewExecutablePath(defaultExecutable: string, directory: string): string {
  const components = defaultExecutable.split(path.sep);
  const index = components.findLastIndex((component) => /^chromium-\d+$/u.test(component));
  if (index < 0 || index === components.length - 1) {
    throw new PagePreviewError("page_preview_browser_layout_invalid", "The pinned preview browser layout is unsupported.");
  }
  return path.join(directory, ...components.slice(index));
}

export function pagePreviewDimensions(input: Pick<PagePreviewInput, "width" | "height">): { width: number; height: number } {
  const width = input.width ?? PAGE_PREVIEW_DEFAULT_WIDTH;
  const height = input.height ?? PAGE_PREVIEW_DEFAULT_HEIGHT;
  if (!Number.isInteger(width) || width < 1 || width > MAX_WIDTH || !Number.isInteger(height) || height < 1 || height > MAX_HEIGHT) {
    throw new PagePreviewError("page_preview_viewport_invalid", "Preview dimensions must be whole pixels: width 1–4096 and height 1–8192.");
  }
  return { width, height };
}

const browserEnvironment = (environment: NodeJS.ProcessEnv): Record<string, string> => {
  const result: Record<string, string> = {};
  // Chromium needs OS/cache/temp locations, not the server's credentials,
  // provider tokens, proxy credentials, or Node preload options.
  for (const key of ["PATH", "HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemRoot", "SYSTEMROOT", "WINDIR", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR", "DISPLAY", "WAYLAND_DISPLAY"]) {
    if (environment[key] !== undefined) result[key] = environment[key]!;
  }
  return result;
};

async function settleWithin<T>(promise: Promise<T>, milliseconds: number): Promise<{ settled: true; value: T } | { settled: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ settled: true as const, value })),
      new Promise<{ settled: false }>((resolve) => { timer = setTimeout(() => resolve({ settled: false }), milliseconds); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function closePreviewBrowser(server: BrowserServer): Promise<void> {
  const closed = await settleWithin(server.close().catch(() => undefined), 1500);
  if (closed.settled && (server.process().exitCode !== null || server.process().signalCode !== null)) return;
  // BrowserServer.kill uses Playwright's owned process-tree cleanup on Windows
  // and process-group cleanup on POSIX, including an unresponsive renderer.
  const killed = await settleWithin(server.kill(), 5000).catch(() => {
    throw new PagePreviewError("page_preview_cleanup_failed", "The preview browser could not be terminated.");
  });
  if (!killed.settled) throw new PagePreviewError("page_preview_cleanup_failed", "The preview browser did not confirm shutdown.");
}

function normalizePreviewError(error: unknown): Error {
  if (error instanceof PagePreviewError) return error;
  if (error instanceof errors.TimeoutError) {
    return new PagePreviewError("page_preview_timeout", "The preview timed out while loading or rendering. Simplify the page and retry.");
  }
  if (error instanceof Error && (error.name === "TargetClosedError" || /(?:Target page, context or browser|Browser|Page|Context) (?:has been |is )closed/iu.test(error.message))) {
    return new PagePreviewError("page_preview_closed", "The preview browser closed before the screenshot completed. Retry the preview.");
  }
  return new PagePreviewError("page_preview_render_failed", "The preview could not be rendered. Check the HTML and the preview browser's status before retrying.");
}

/** Optional server capability. Publishing and client display do not depend on it. */
export class PagePreviewBrowser {
  readonly #browserType: Pick<BrowserType, "executablePath" | "launchServer" | "connect">;
  readonly #directory: string;
  readonly #environment: NodeJS.ProcessEnv;
  readonly #renderTimeout: number;
  readonly #active = new Map<AbortController, Promise<void>>();
  #cleanupFailed = false;
  #closed = false;
  #closePromise?: Promise<void>;

  constructor(options: {
    directory?: string;
    environment?: NodeJS.ProcessEnv;
    browserType?: Pick<BrowserType, "executablePath" | "launchServer" | "connect">;
    renderTimeoutMilliseconds?: number;
  } = {}) {
    this.#environment = options.environment ?? process.env;
    this.#directory = options.directory ?? pagePreviewBrowserDirectory(this.#environment);
    this.#browserType = options.browserType ?? chromium;
    this.#renderTimeout = options.renderTimeoutMilliseconds ?? 15_000;
  }

  async status(): Promise<PagePreviewBrowserStatus> {
    const base = { directory: this.#directory, playwrightVersion: PAGE_PREVIEW_PLAYWRIGHT_VERSION };
    try {
      await this.#assertInstalled();
    } catch (error) {
      return { ...base, installed: false, ready: false, error: error instanceof Error ? error.message : "Preview browser unavailable." };
    }
    try {
      const html = renderPageDocument(capturePageDocument(parse("<!doctype html><html><body>Preview ready</body></html>")));
      await this.render({ html, width: 100, height: 100 });
      return { ...base, installed: true, ready: true };
    } catch (error) {
      return { ...base, installed: true, ready: false, error: error instanceof Error ? error.message : "Preview browser unavailable." };
    }
  }

  async #assertInstalled(): Promise<string> {
    const executable = pagePreviewExecutablePath(this.#browserType.executablePath(), this.#directory);
    try {
      await access(executable, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    } catch {
      throw new PagePreviewError("page_preview_browser_missing", "Preview browser is not installed. Run sedes page-preview-browser install on the Sedes server.");
    }
    return executable;
  }

  async render(input: PagePreviewInput): Promise<PagePreviewResult> {
    const viewport = pagePreviewDimensions(input);
    if (Buffer.byteLength(input.html, "utf8") > PAGE_RENDER_MAX_BYTES) throw new PagePreviewError("page_preview_html_too_large", "Preview HTML exceeds the 32 MiB escaped payload and 64 KiB rendering overhead limit.");
    input.signal?.throwIfAborted();
    if (this.#closed) throw new PagePreviewError("page_preview_closed", "The preview browser service is shutting down.");
    if (this.#cleanupFailed) throw new PagePreviewError("page_preview_cleanup_failed", "Preview is disabled until the server restarts because a browser did not confirm shutdown.");
    if (this.#active.size >= 2) throw new PagePreviewError("page_preview_busy", "Two previews are already running; retry when one completes.");
    const controller = new AbortController();
    const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
    let complete!: () => void;
    this.#active.set(controller, new Promise<void>((resolve) => { complete = resolve; }));
    try {
      return await this.#renderRequest({ ...input, signal }, viewport);
    } catch (error) {
      if (input.signal?.aborted) throw input.signal.reason;
      if (signal.aborted) throw signal.reason;
      throw normalizePreviewError(error);
    } finally {
      this.#active.delete(controller);
      complete();
    }
  }

  /** Stop admission synchronously, cancel work, and await owned browser cleanup. */
  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = Promise.all([...this.#active.values()]).then(() => {
      if (this.#cleanupFailed) throw new PagePreviewError("page_preview_cleanup_failed", "A preview browser did not confirm shutdown.");
    });
    for (const controller of this.#active.keys()) {
      controller.abort(new PagePreviewError("page_preview_closed", "The preview was cancelled because the server is shutting down."));
    }
    return this.#closePromise;
  }

  async #renderRequest(input: PagePreviewInput, viewport: { width: number; height: number }): Promise<PagePreviewResult> {
    let server: BrowserServer | undefined;
    try {
      const executablePath = await this.#assertInstalled();
      input.signal?.throwIfAborted();
      try {
        server = await this.#browserType.launchServer({
          executablePath,
          headless: true,
          chromiumSandbox: true,
          host: "127.0.0.1",
          port: 0,
          timeout: 10_000,
          handleSIGINT: false,
          handleSIGTERM: false,
          handleSIGHUP: false,
          env: browserEnvironment(this.#environment),
          // No direct network transport, including WebRTC UDP or loopback
          // proxy bypass. BrowserContext also blocks requests and sockets.
          proxy: { server: "http://127.0.0.1:9", bypass: "<-loopback>" },
          args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
        });
      } catch (error) {
        if (error instanceof errors.TimeoutError) throw error;
        throw new PagePreviewError("page_preview_browser_unavailable", "The preview browser could not start with its sandbox enabled. Check host support and Chromium system dependencies.");
      }
      input.signal?.throwIfAborted();
      let deadline: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      const interrupted = new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => reject(new PagePreviewError("page_preview_timeout", "The preview exceeded its rendering time limit.")), this.#renderTimeout);
        abort = () => reject(input.signal?.reason ?? new PagePreviewError("page_preview_cancelled", "The preview was cancelled."));
        input.signal?.addEventListener("abort", abort, { once: true });
      });
      try {
        return await Promise.race([this.#render(server, input, viewport), interrupted]);
      } finally {
        clearTimeout(deadline);
        if (abort) input.signal?.removeEventListener("abort", abort);
      }
    } finally {
      try {
        if (server) await closePreviewBrowser(server);
      } catch (error) {
        this.#cleanupFailed = true;
        throw error;
      }
    }
  }

  async #render(server: BrowserServer, input: PagePreviewInput, viewport: { width: number; height: number }): Promise<PagePreviewResult> {
    const browser = await this.#browserType.connect(server.wsEndpoint(), { timeout: 5000 });
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      offline: true,
      acceptDownloads: false,
      permissions: [],
      // The opaque sandbox origin and worker-src 'none' already disallow
      // service workers. Playwright's "block" shim accesses the forbidden
      // navigator.serviceWorker getter and emits a spurious page error.
      colorScheme: "light",
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    await context.addInitScript(`(${PAGE_MEASUREMENT_INSTALL_SOURCE})(globalThis);`);
    await context.addInitScript(`for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "WebTransport"]) {
      Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
    }`);
    const page = await context.newPage();
    const documentUrl = "https://sedes-preview.invalid/document";
    let documentServed = false;
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (!documentServed && request.url() === documentUrl && request.isNavigationRequest() && request.frame() === page.mainFrame()) {
        documentServed = true;
        await route.fulfill({
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": PAGE_CONTENT_SECURITY_POLICY },
          body: input.html,
        });
      } else await route.abort("blockedbyclient");
    });
    const consoleEntries: PagePreviewResult["console"] = [];
    const report = (level: string, text: string) => {
      if (consoleEntries.length < MAX_CONSOLE_ENTRIES) consoleEntries.push({ level, text: text.slice(0, MAX_CONSOLE_ENTRY_LENGTH) });
    };
    page.on("console", (message) => report(message.type(), message.text()));
    page.on("pageerror", (error) => report("error", error.message));
    context.on("page", (popup) => { if (popup !== page) void popup.close().catch(() => undefined); });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame() && !["about:blank", documentUrl].includes(frame.url())) void page.close().catch(() => undefined);
    });
    await page.goto(documentUrl, { waitUntil: "load", timeout: 10_000 });
    const frameElement = await page.waitForSelector("iframe[data-page-document]", { state: "attached", timeout: 10_000 });
    if (!frameElement) throw new PagePreviewError("page_preview_document_missing", "The preview document did not load.");
    const documentFrame = await frameElement.contentFrame();
    if (!documentFrame) throw new PagePreviewError("page_preview_document_missing", "The preview document did not load.");
    await documentFrame.waitForLoadState("load", { timeout: 10_000 });
    // Two animation frames let synchronous layout and initial visual effects
    // settle without waiting for arbitrary page timers or network idleness.
    type Measurement = Parameters<typeof stabilizePageHeight>[1];
    const measure = async (): Promise<Measurement> => {
      await documentFrame.evaluate(PAGE_SETTLE_EXPRESSION);
      const value = await documentFrame.evaluate<Measurement>(PAGE_MEASUREMENT_EXPRESSION);
      if (![value.width, value.viewportHeight, value.naturalHeight, value.contentWidth].every((dimension) => Number.isSafeInteger(dimension) && dimension >= 0 && dimension <= 1_000_000)) {
        throw new PagePreviewError("page_preview_measurement_invalid", "The page returned invalid or excessive layout dimensions.");
      }
      return value;
    };
    let measured = await measure();
    let height = viewport.height;
    if (input.height === undefined) {
      let sizing: PageSizingState | undefined;
      // The shared stabilizer freezes viewport-relative feedback. This bound
      // also covers a document whose scripts continuously change its layout.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        sizing = stabilizePageHeight(sizing, measured);
        if (sizing.acceptedHeight === height) break;
        height = sizing.acceptedHeight;
        await page.setViewportSize({ width: viewport.width, height });
        measured = await measure();
      }
    }
    const session = await context.newCDPSession(page);
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / Math.max(viewport.width, height));
    // CDP scales capture pixels without changing CSS layout, media queries,
    // devicePixelRatio, or the viewport the authored document observed.
    const image = await session.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false,
      clip: { x: 0, y: 0, width: viewport.width, height, scale },
    });
    const png = Buffer.from(image.data, "base64");
    if (png.byteLength > MAX_SCREENSHOT_BYTES) throw new PagePreviewError("page_preview_image_too_large", "Preview screenshot exceeds 2 MiB; use a smaller viewport.");
    if (png.byteLength < 24 || png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
      throw new PagePreviewError("page_preview_image_invalid", "The preview browser returned an invalid PNG.");
    }
    const imageWidth = png.readUInt32BE(16);
    const imageHeight = png.readUInt32BE(20);
    if (imageWidth < 1 || imageHeight < 1 || imageWidth > MAX_IMAGE_DIMENSION || imageHeight > MAX_IMAGE_DIMENSION) {
      throw new PagePreviewError("page_preview_image_invalid", "The preview browser returned unsupported image dimensions.");
    }
    return {
      png,
      imageWidth,
      imageHeight,
      width: viewport.width,
      height,
      contentWidth: measured.contentWidth,
      contentHeight: measured.naturalHeight,
      console: consoleEntries,
    };
  }
}

/** Explicit operator action; never called by publish, preview, or startup. */
export async function installPagePreviewBrowser(options: {
  environment?: NodeJS.ProcessEnv;
  directory?: string;
  stdout?: { write(data: string): unknown };
  stderr?: { write(data: string): unknown };
} = {}): Promise<void> {
  const environment = options.environment ?? process.env;
  const directory = options.directory ?? pagePreviewBrowserDirectory(environment);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const packageFile = fileURLToPath(import.meta.resolve("playwright/package.json"));
  const installer = path.join(path.dirname(packageFile), "cli.js");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [installer, "install", "chromium", "--no-shell"], {
      env: { ...environment, PLAYWRIGHT_BROWSERS_PATH: directory, PLAYWRIGHT_SKIP_BROWSER_GC: "1" },
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (data: Buffer) => options.stdout?.write(data.toString("utf8")));
    child.stderr?.on("data", (data: Buffer) => options.stderr?.write(data.toString("utf8")));
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new PagePreviewError("page_preview_install_failed", "Preview browser installation failed; check the installer output.")));
  });
}
