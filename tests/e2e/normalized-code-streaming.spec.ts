import { test, expect } from "./fixtures";
import {
  capture,
  createDraftThread,
  fillAndPersistDraft,
  openSedesWorkspace,
  sendCurrentDraft,
} from "./helpers";

const codeSource = 'function render(): string {\n  const html = "<tag>&amp;</tag>";\n\treturn html + "\\n";\n}\n';

test("streaming code fades literally before a closed fence gains syntax colors", async ({
  page,
  context,
}, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openSedesWorkspace(page);
  await createDraftThread(page);
  await fillAndPersistDraft(page, "Stream a TypeScript code fence progressively");
  await page.evaluate(() => {
    const state = {
      sawFadingCode: false,
      keptFadingCodeInLayout: true,
      sawColoredFadingCode: false,
    };
    const sample = () => {
      const code = document.querySelector(
        '[data-item-kind="assistant_message"][data-item-status="streaming"] pre code',
      );
      if (!code) return;
      const graphemes = [...code.querySelectorAll<HTMLElement>(
        ".progressive-markdown-grapheme",
      )];
      const fading = graphemes.filter((span) => {
        const opacity = Number(getComputedStyle(span).opacity);
        return opacity > 0 && opacity < 1;
      });
      state.sawFadingCode ||= fading.length > 0;
      state.sawColoredFadingCode ||= fading.length > 0 &&
        code.querySelector(".markdown-syntax-token") !== null;
      state.keptFadingCodeInLayout &&= graphemes.every((span) =>
        Number(getComputedStyle(span).opacity) > 0 &&
        getComputedStyle(span).display === "inline",
      );
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["style"],
    });
    Object.assign(window, { __sedesCodeFadeProbe: { state, observer } });
  });
  expect((await page.request.post("/__e2e/pi/code/arm")).status()).toBe(204);
  try {
    await sendCurrentDraft(page);
    const assistant = page.locator('[data-item-kind="assistant_message"]');
    const code = assistant.locator("pre code");
    await expect(code).toBeVisible();
    await expect.poll(() => page.evaluate(() => {
      const target = window as typeof window & {
        __sedesCodeFadeProbe: { state: { sawFadingCode: boolean } };
      };
      return target.__sedesCodeFadeProbe.state.sawFadingCode;
    })).toBe(true);
    await capture(page, testInfo, "normalized-code-streaming-open.png", {
      animations: "allow",
    });
    // textContent preserves tabs/newlines and literal entity/backslash spelling;
    // Playwright's toHaveText normalizes whitespace and would miss regressions.
    await expect.poll(() => code.textContent()).toBe(codeSource);
    await expect(assistant).toHaveAttribute("data-item-status", "streaming");
    await expect(code.locator(".markdown-syntax-token")).toHaveCount(0);
    await expect.poll(() => code.evaluate((element) =>
      [...element.querySelectorAll(".progressive-markdown-grapheme")].every(
        (span) => Number(getComputedStyle(span).opacity) === 1,
      ),
    )).toBe(true);
    // An open fence remains plain even after its incoming text has settled.
    await expect(code.locator(".markdown-syntax-token")).toHaveCount(0);
    await assistant.locator(".markdown-code-block").hover();
    await expect(assistant.getByRole("button", { name: "Copy code", exact: true }))
      .toHaveCSS("pointer-events", "auto");
    await assistant.getByRole("button", { name: "Copy code", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(codeSource.replace(/\n$/u, ""));

    expect((await page.request.post("/__e2e/pi/code/release/closed")).status()).toBe(204);
    await expect(code.locator(".markdown-syntax-token").first()).toBeVisible();
    await expect(assistant).toHaveAttribute("data-item-status", "streaming");
    await expect.poll(() => code.textContent()).toBe(codeSource);
    await expect.poll(() => code.evaluate((element) => new Set(
      [...element.querySelectorAll(".markdown-syntax-token")].map(
        (token) => getComputedStyle(token).color,
      ),
    ).size)).toBeGreaterThan(1);
    await capture(page, testInfo, "normalized-code-streaming-closed.png");
    expect((await page.request.post("/__e2e/pi/code/release/settled")).status()).toBe(204);
    await expect(assistant).toHaveAttribute("data-item-status", "completed");
    await expect.poll(() => code.textContent()).toBe(codeSource);
    await expect(code.locator(".markdown-syntax-token").first()).toBeVisible();
    await expect(assistant.getByRole("button", { name: "Copy code", exact: true }))
      .toBeVisible();
    await assistant.locator(".markdown-code-block").hover();
    await expect(assistant.getByRole("button", { name: "Copy code", exact: true }))
      .toHaveCSS("pointer-events", "auto");
    await assistant.getByRole("button", { name: "Copy code", exact: true }).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(codeSource.replace(/\n$/u, ""));
    const probe = await page.evaluate(() => {
      const target = window as typeof window & {
        __sedesCodeFadeProbe: {
          state: {
            sawFadingCode: boolean;
            keptFadingCodeInLayout: boolean;
            sawColoredFadingCode: boolean;
          };
        };
      };
      return target.__sedesCodeFadeProbe.state;
    });
    expect(probe).toEqual({
      sawFadingCode: true,
      keptFadingCodeInLayout: true,
      sawColoredFadingCode: false,
    });
  } finally {
    await page.request.post("/__e2e/pi/code/release/closed");
    await page.request.post("/__e2e/pi/code/release/settled");
    await page.evaluate(() => {
      const target = window as typeof window & {
        __sedesCodeFadeProbe?: { observer: MutationObserver };
      };
      target.__sedesCodeFadeProbe?.observer.disconnect();
      delete target.__sedesCodeFadeProbe;
    });
  }
});
