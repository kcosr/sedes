import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { errors, type BrowserType } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pagePreviewBrowserDirectory,
  pagePreviewDimensions,
  pagePreviewExecutablePath,
  PagePreviewBrowser,
} from "../../src/server/pages/preview-browser.js";
import { runPagePreviewBrowserCli } from "../../src/cli/page-preview-browser-cli.js";
import { PAGE_MEASUREMENT_EXPRESSION } from "../../src/shared/page-sizing.js";
import { PAGE_DOCUMENT_MAX_BYTES, PAGE_RENDER_MAX_BYTES } from "../../src/shared/protocol/pages.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function fixture(options: { hangs?: boolean; closeHangs?: boolean; naturalHeight?: number | ((height: number) => number) } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-preview-browser-"));
  directories.push(directory);
  const executable = path.join(directory, "chromium-999", "chrome-platform", "chrome");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "test fixture");
  await chmod(executable, 0o700);
  let handler: ((route: unknown) => Promise<void>) | undefined;
  const mainFrame = {};
  let viewport = { width: 768, height: 600 };
  const documentFrame = {
    waitForLoadState: vi.fn(async () => undefined),
    evaluate: vi.fn(async (expression: string) => {
      if (options.hangs) return await new Promise(() => undefined);
      if (expression !== PAGE_MEASUREMENT_EXPRESSION) return undefined;
      return {
        width: viewport.width, viewportHeight: viewport.height, contentWidth: viewport.width,
        naturalHeight: typeof options.naturalHeight === "function" ? options.naturalHeight(viewport.height) : options.naturalHeight ?? 216,
      };
    }),
  };
  const page = {
    on: vi.fn(),
    mainFrame: () => mainFrame,
    goto: vi.fn(async () => undefined),
    waitForSelector: vi.fn(async () => ({ contentFrame: async () => documentFrame })),
    setViewportSize: vi.fn(async (value: typeof viewport) => { viewport = value; }),
    close: vi.fn(async () => undefined),
  };
  const session = {
    send: vi.fn(async (_method: string, params: { clip: { width: number; height: number; scale: number } }) => {
      const png = Buffer.alloc(24);
      Buffer.from("89504e470d0a1a0a", "hex").copy(png);
      png.writeUInt32BE(Math.max(1, Math.round(params.clip.width * params.clip.scale)), 16);
      png.writeUInt32BE(Math.max(1, Math.round(params.clip.height * params.clip.scale)), 20);
      return { data: png.toString("base64") };
    }),
  };
  const context = {
    route: vi.fn(async (_pattern: string, callback: (route: unknown) => Promise<void>) => { handler = callback; }),
    routeWebSocket: vi.fn(async () => undefined),
    addInitScript: vi.fn(async () => undefined),
    newPage: vi.fn(async () => page),
    newCDPSession: vi.fn(async () => session),
    on: vi.fn(),
  };
  const process = { exitCode: null as number | null, signalCode: null as string | null };
  const server = {
    wsEndpoint: () => "ws://127.0.0.1:12345/private-unpredictable-path",
    process: () => process,
    close: vi.fn(() => {
      if (options.closeHangs) return new Promise<void>(() => undefined);
      process.exitCode = 0;
      return Promise.resolve();
    }),
    kill: vi.fn(async () => { process.signalCode = "SIGKILL"; }),
  };
  const browserType = {
    executablePath: () => path.join(os.tmpdir(), "default-cache", "chromium-999", "chrome-platform", "chrome"),
    launchServer: vi.fn(async () => server),
    connect: vi.fn(async () => ({ newContext: vi.fn(async (options: { viewport: typeof viewport }) => { viewport = options.viewport; return context; }) })),
  };
  const browser = new PagePreviewBrowser({
    directory,
    environment: { PATH: "/bin", HOME: "/fake", SECRET_TOKEN: "must-not-reach-chromium" },
    browserType: browserType as unknown as BrowserType,
    renderTimeoutMilliseconds: 50,
  });
  return { browser, browserType, server, context, page, documentFrame, session, mainFrame, route: () => handler! };
}

describe("optional page preview browser", () => {
  it("uses platform caches, explicit absolute overrides, and the pinned browser revision", () => {
    expect(pagePreviewBrowserDirectory({}, "linux", "/users/a")).toBe("/users/a/.cache/sedes/page-preview-browser");
    expect(pagePreviewBrowserDirectory({}, "darwin", "/Users/a")).toBe("/Users/a/Library/Caches/Sedes/page-preview-browser");
    expect(pagePreviewBrowserDirectory({ LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local" }, "win32", "C:\\Users\\a")).toBe("C:\\Users\\a\\AppData\\Local\\Sedes\\page-preview-browser");
    expect(() => pagePreviewBrowserDirectory({ SEDES_PAGE_PREVIEW_BROWSER_DIRECTORY: "relative" })).toThrow("absolute");
    expect(pagePreviewExecutablePath(path.join("/cache", "chromium-123", "platform", "chrome"), "/private")).toBe(path.join("/private", "chromium-123", "platform", "chrome"));
    expect(() => pagePreviewExecutablePath("/usr/bin/google-chrome", "/private")).toThrow("layout");
    expect(pagePreviewDimensions({ width: 390, height: 844 })).toEqual({ width: 390, height: 844 });
    expect(() => pagePreviewDimensions({ width: 4097 })).toThrow("4096");
  });

  it("captures a component at its content height and blocks every non-document request", async () => {
    const f = await fixture();
    const result = await f.browser.render({ html: "<p>Component</p>" });
    expect(result).toMatchObject({ width: 768, height: 216, contentHeight: 216 });
    expect(result).toMatchObject({ imageWidth: 768, imageHeight: 216 });
    expect(f.browserType.launchServer).toHaveBeenCalledWith(expect.objectContaining({
      chromiumSandbox: true, headless: true, host: "127.0.0.1", port: 0,
      handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
      env: { PATH: "/bin", HOME: "/fake" },
      proxy: { server: "http://127.0.0.1:9", bypass: "<-loopback>" },
    }));
    expect(f.context.routeWebSocket).toHaveBeenCalled();
    const external = { request: () => ({ url: () => "http://127.0.0.1/private", isNavigationRequest: () => false }), abort: vi.fn(async () => undefined) };
    await f.route()(external);
    expect(external.abort).toHaveBeenCalledWith("blockedbyclient");
    const document = {
      request: () => ({ url: () => "https://sedes-preview.invalid/document", isNavigationRequest: () => true, frame: () => f.mainFrame }),
      fulfill: vi.fn(async () => undefined), abort: vi.fn(async () => undefined),
    };
    await f.route()(document);
    expect(document.fulfill).toHaveBeenCalledWith(expect.objectContaining({ headers: expect.objectContaining({ "Content-Security-Policy": expect.stringContaining("sandbox allow-scripts") }) }));
    await f.route()(document);
    expect(document.abort).toHaveBeenCalled();
    expect(f.server.close).toHaveBeenCalledOnce();
  });

  it("preserves a fixed viewport instead of fitting its content", async () => {
    const f = await fixture();
    const result = await f.browser.render({ html: "<p>Phone</p>", width: 390, height: 844 });
    expect(result).toMatchObject({ width: 390, height: 844 });
    expect(f.page.setViewportSize).not.toHaveBeenCalled();
  });

  it("stops a hung renderer and escalates a hung close to owned process termination", async () => {
    const f = await fixture({ hangs: true, closeHangs: true });
    await expect(f.browser.render({ html: "<script>for (;;) {}</script>" })).rejects.toMatchObject({ code: "page_preview_timeout" });
    expect(f.server.kill).toHaveBeenCalledOnce();
  }, 5000);

  it("closes the owned browser on cancellation", async () => {
    const f = await fixture({ hangs: true });
    const controller = new AbortController();
    const reason = new Error("cancelled by caller");
    f.page.goto.mockImplementation(async () => { controller.abort(reason); });
    await expect(f.browser.render({ html: "<p>Hi</p>", signal: controller.signal })).rejects.toBe(reason);
    expect(f.server.close).toHaveBeenCalledOnce();
  });

  it("stops new admission and drains an in-flight browser launch before close settles", async () => {
    const f = await fixture();
    let finishLaunch!: (server: typeof f.server) => void;
    f.browserType.launchServer.mockImplementationOnce(() => new Promise<typeof f.server>((resolve) => { finishLaunch = resolve; }));
    const render = f.browser.render({ html: "<p>Hi</p>" });
    const renderRejected = expect(render).rejects.toMatchObject({ code: "page_preview_closed" });
    await vi.waitFor(() => expect(f.browserType.launchServer).toHaveBeenCalledOnce());
    const closed = f.browser.close();
    expect(f.browser.close()).toBe(closed);
    await expect(f.browser.render({ html: "<p>Late</p>" })).rejects.toMatchObject({ code: "page_preview_closed" });
    let settled = false;
    void closed.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    finishLaunch(f.server);
    await renderRejected;
    await closed;
    expect(f.browserType.connect).not.toHaveBeenCalled();
    expect(f.server.close).toHaveBeenCalledOnce();
  });

  it("drains an active renderer during application shutdown", async () => {
    const f = await fixture({ hangs: true });
    const render = f.browser.render({ html: "<p>Hi</p>" });
    const renderRejected = expect(render).rejects.toMatchObject({ code: "page_preview_closed" });
    await vi.waitFor(() => expect(f.documentFrame.evaluate).toHaveBeenCalled());
    await f.browser.close();
    await renderRejected;
    expect(f.server.close).toHaveBeenCalledOnce();
  });

  it("fails closed after unconfirmed process cleanup and reports it during shutdown", async () => {
    const f = await fixture();
    f.server.close.mockRejectedValueOnce(new Error("close transport failed"));
    f.server.kill.mockRejectedValueOnce(new Error("owned process termination failed"));
    await expect(f.browser.render({ html: "<p>Hi</p>" })).rejects.toMatchObject({ code: "page_preview_cleanup_failed" });
    await expect(f.browser.render({ html: "<p>Retry</p>" })).rejects.toMatchObject({ code: "page_preview_cleanup_failed" });
    const closed = f.browser.close();
    expect(f.browser.close()).toBe(closed);
    await expect(closed).rejects.toMatchObject({ code: "page_preview_cleanup_failed" });
  });

  it.each(["connect", "navigation", "capture"])("reports actionable %s timeouts after cleaning up", async (stage) => {
    const f = await fixture();
    const failure = new errors.TimeoutError("private browser transport details");
    if (stage === "connect") f.browserType.connect.mockRejectedValueOnce(failure);
    else if (stage === "navigation") f.page.goto.mockRejectedValueOnce(failure);
    else f.session.send.mockRejectedValueOnce(failure);
    await expect(f.browser.render({ html: "<p>Hi</p>" })).rejects.toMatchObject({ code: "page_preview_timeout", message: expect.stringContaining("retry") });
    expect(f.server.close).toHaveBeenCalledOnce();
  });

  it("reports closed-target failures without exposing browser transport details", async () => {
    const f = await fixture();
    f.page.goto.mockRejectedValueOnce(new Error("page.goto: Target page, context or browser has been closed\nprivate transport details"));
    await expect(f.browser.render({ html: "<p>Hi</p>" })).rejects.toMatchObject({ code: "page_preview_closed", message: "The preview browser closed before the screenshot completed. Retry the preview." });
    expect(f.server.close).toHaveBeenCalledOnce();
  });

  it("keeps a long document's layout while delivering a provider-safe PNG", async () => {
    const f = await fixture({ naturalHeight: 8192 });
    const result = await f.browser.render({ html: "<main>Long page</main>" });
    expect(result).toMatchObject({ width: 768, height: 8192, contentHeight: 8192, imageWidth: 188, imageHeight: 2000 });
    expect(f.session.send).toHaveBeenCalledWith("Page.captureScreenshot", expect.objectContaining({ clip: { x: 0, y: 0, width: 768, height: 8192, scale: 2000 / 8192 } }));
  });

  it("freezes viewport-relative body growth instead of expanding to the height ceiling", async () => {
    const f = await fixture({ naturalHeight: (height) => height + 16 });
    const result = await f.browser.render({ html: "<main>Viewport body</main>" });
    expect(result).toMatchObject({ height: 616, contentHeight: 632 });
    expect(f.page.setViewportSize).toHaveBeenCalledTimes(1);
  });

  it("accepts composed payload overhead above the authored limit and rejects the composed ceiling", async () => {
    const f = await fixture();
    const html = "x".repeat(PAGE_DOCUMENT_MAX_BYTES + 1);
    await expect(f.browser.render({ html })).resolves.toMatchObject({ height: 216 });
    await expect(f.browser.render({ html: "x".repeat(PAGE_RENDER_MAX_BYTES + 1) })).rejects.toMatchObject({ code: "page_preview_html_too_large" });
    expect(f.browserType.launchServer).toHaveBeenCalledTimes(1);
  });

  it("does not download or launch a missing browser during readiness checks", async () => {
    const browserType = { executablePath: () => path.join("/missing", "chromium-123", "chrome"), launchServer: vi.fn(), connect: vi.fn() };
    const browser = new PagePreviewBrowser({ directory: "/missing/sedes", browserType: browserType as unknown as BrowserType });
    expect(await browser.status()).toMatchObject({ installed: false, ready: false, error: expect.stringContaining("install") });
    expect(browserType.launchServer).not.toHaveBeenCalled();
  });
});

describe("page preview browser operator command", () => {
  it("keeps status read-only and installation explicit", async () => {
    const output: string[] = [];
    const io = { stdout: { write: (text: string) => output.push(text) }, stderr: { write: (text: string) => output.push(text) } };
    const install = vi.fn(async () => undefined);
    const status = vi.fn(async () => ({ installed: true, ready: true, directory: "/browser", playwrightVersion: "1.62.0" }));
    expect(await runPagePreviewBrowserCli(["status"], { io, status, install })).toBe(0);
    expect(install).not.toHaveBeenCalled();
    expect(await runPagePreviewBrowserCli(["install"], { io, status, install })).toBe(0);
    expect(install).toHaveBeenCalledOnce();
    expect(await runPagePreviewBrowserCli(["install", "--disable-sandbox"], { io, status, install })).toBe(2);
    expect(install).toHaveBeenCalledOnce();
  });
});
