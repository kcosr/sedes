// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { afterEach, describe, expect, it, vi } from "vitest";

const STYLES = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "styles.css",
);

type FakeFontSet = { readonly load: ReturnType<typeof vi.fn> };

/** A fresh module (its load is per document) over a stubbed `document.fonts`. */
async function codeFontModule(fonts: FakeFontSet | undefined) {
  vi.resetModules();
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: fonts,
  });
  return import("./code-font.js");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

const loadedFace = [{ status: "loaded" }];

afterEach(() => {
  Reflect.deleteProperty(document, "fonts");
  vi.useRealTimers();
});

describe("code font", () => {
  it("gives canvases the same family list as the --font-mono token", async () => {
    const { CODE_FONT_FAMILY } = await codeFontModule(undefined);
    let token: string | undefined;
    postcss.parse(readFileSync(STYLES, "utf8")).walkDecls("--font-mono", (declaration) => {
      if (!declaration.value.startsWith("var(")) token = declaration.value;
    });

    expect(token?.replace(/\s+/gu, " ")).toBe(CODE_FONT_FAMILY);
    expect(CODE_FONT_FAMILY.startsWith('"JetBrains Mono Variable", ')).toBe(true);
  });

  it("does not wait where the document has no font loading API", async () => {
    vi.useFakeTimers();
    const { onCodeFontLoaded, waitForCodeFont } = await codeFontModule(undefined);
    const late = vi.fn();
    onCodeFontLoaded(late);

    await expect(waitForCodeFont()).resolves.toBe(false);
    expect(late).not.toHaveBeenCalled();
  });

  it("loads the bundled face once and resolves when it is ready", async () => {
    const fonts = { load: vi.fn(async () => loadedFace) };
    const { waitForCodeFont } = await codeFontModule(fonts);

    await expect(waitForCodeFont()).resolves.toBe(true);
    await expect(waitForCodeFont()).resolves.toBe(true);
    expect(fonts.load).toHaveBeenCalledExactlyOnceWith('16px "JetBrains Mono Variable"');
  });

  it("stops waiting after the timeout and reports a late load", async () => {
    vi.useFakeTimers();
    const load = deferred<readonly { status: string }[]>();
    const { onCodeFontLoaded, waitForCodeFont } = await codeFontModule({
      load: vi.fn(() => load.promise),
    });
    const waiting = waitForCodeFont(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(waiting).resolves.toBe(false);

    const late = vi.fn();
    const cancelled = vi.fn();
    onCodeFontLoaded(late);
    onCodeFontLoaded(cancelled)();
    load.resolve(loadedFace);
    await vi.advanceTimersByTimeAsync(0);

    expect(late).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
  });

  it("treats a failed load as unavailable and retries it next time", async () => {
    const fonts = {
      load: vi
        .fn()
        .mockRejectedValueOnce(new DOMException("failed", "NetworkError"))
        .mockResolvedValue(loadedFace),
    };
    const { onCodeFontLoaded, waitForCodeFont } = await codeFontModule(fonts);
    const late = vi.fn();

    await expect(waitForCodeFont()).resolves.toBe(false);
    onCodeFontLoaded(late);
    await expect(waitForCodeFont()).resolves.toBe(true);
    expect(fonts.load).toHaveBeenCalledTimes(2);
    expect(late).toHaveBeenCalledOnce();
  });

  it("does not wait for a family the document never registered", async () => {
    const fonts = { load: vi.fn(async () => []) };
    const { waitForCodeFont } = await codeFontModule(fonts);

    await expect(waitForCodeFont()).resolves.toBe(false);
  });
});
