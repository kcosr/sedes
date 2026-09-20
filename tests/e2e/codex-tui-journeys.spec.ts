import { emulateWindowsTerminalClient, expectIdleTerminalCanvas } from "./terminal-helpers.js";
import type { Page } from "@playwright/test";
import path from "node:path";
import { expect, test } from "./fixtures";
import {
  capture,
  createDraftThread,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openSedesWorkspace,
  openSettingsPage,
  returnFromSettings,
  selectCustomNewThreadTarget,
  selectRadixOption,
  sendCurrentDraft,
} from "./helpers";

const repositoryDisplayName = path.basename(process.cwd());
const importedCodexTitle = `Imported Codex history — ${repositoryDisplayName}`;

async function ensureWorkspace(page: Page): Promise<void> {
  await page.goto("/");
  await openSedesWorkspace(page);
}

async function openImportedCodexThread(page: Page): Promise<string> {
  await ensureWorkspace(page);
  const row = page
    .getByTestId("desktop-sidebar")
    .getByTestId("thread-row-link")
    .filter({ hasText: importedCodexTitle });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
  return new URL(page.url()).pathname;
}

async function refreshTuiFixtureThread(
  page: Page,
  threadPath: string,
): Promise<void> {
  const threadId = threadPath.split("/").at(-1);
  expect(threadId).toBeTruthy();
  const refreshed = await page.request.post(
    `/__e2e/codex-tui/availability/${threadId}/available`,
  );
  expect(refreshed.ok()).toBe(true);
  // The fixture endpoint publishes a current normalized snapshot. Reload
  // against that baseline so mutations do not inherit another spec's cached
  // application revision for the shared imported thread.
  await page.reload();
  await expect(page).toHaveURL(threadPath);
}

async function selectTuiAndWaitUntilRunning(page: Page): Promise<void> {
  const switcher = page.getByRole("group", { name: "Thread view" });
  await expect(switcher).toBeVisible();
  const tui = switcher.getByRole("button", { name: "TUI" });
  await tui.click();
  await expect(tui).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("codex-tui-panel")).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Codex terminal" }),
  ).toBeVisible();
  const stop = page.getByRole("button", { name: "Stop TUI" });
  await expect(stop).toBeVisible({
    timeout: 15_000,
  });
  await expect(stop).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByTestId("codex-tui-terminal")).toBeVisible();
}

async function expectSwitchOmitted(page: Page): Promise<void> {
  await expect(page.getByRole("group", { name: "Thread view" })).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "TUI", exact: true }),
  ).toHaveCount(0);
}

async function readTuiFixtureState(page: Page): Promise<{
  readonly launchCount: number;
  readonly writes: readonly string[];
  readonly resizes: ReadonlyArray<{
    readonly resourceGeneration: number;
    readonly columns: number;
    readonly rows: number;
  }>;
  readonly closeReasons: readonly string[];
}> {
  const response = await page.request.get("/__e2e/codex-tui/state");
  expect(response.ok()).toBe(true);
  return response.json();
}

async function setAppearance(
  page: Page,
  appearance: "Light" | "Dark",
): Promise<void> {
  await openSettingsPage(page, "appearance");
  const dialog = page.getByTestId("settings-view");
  await dialog.getByRole("radio", { name: appearance }).click();
  await returnFromSettings(page);
  await expect(page.locator("html")).toHaveAttribute(
    "data-theme",
    appearance.toLowerCase(),
  );
}

async function expectFloatingViewChip(page: Page): Promise<void> {
  const chip = page.locator(".thread-view-floating-controls");
  const switcher = page.getByRole("group", { name: "Thread view" });
  const presentation = page.locator(".thread-presentation");
  const [chipBox, presentationBox, style] = await Promise.all([
    chip.boundingBox(),
    presentation.boundingBox(),
    chip.evaluate((element) => {
      const computed = getComputedStyle(element);
      return {
        position: computed.position,
        borderRadius: computed.borderRadius,
      };
    }),
  ]);
  expect(chipBox).not.toBeNull();
  expect(presentationBox).not.toBeNull();
  expect(style.position).toBe("absolute");
  expect(Number.parseFloat(style.borderRadius)).toBeGreaterThan(100);
  expect(chipBox!.width).toBeLessThanOrEqual(190);
  expect(chipBox!.height).toBeLessThanOrEqual(40);
  expect(chipBox!.y - presentationBox!.y).toBeLessThanOrEqual(12);
  expect(
    presentationBox!.x + presentationBox!.width - chipBox!.x - chipBox!.width,
  ).toBeLessThanOrEqual(16);
  await expect(switcher).toBeVisible();
  await expect(chip.getByRole("button", { name: "Refit terminal" })).toHaveText(
    "",
  );
  await expect(chip.getByRole("button", { name: "Stop TUI" })).toHaveText("");
  const actionOrder = await chip
    .getByRole("button")
    .evaluateAll((buttons) => buttons.map((button) => button.ariaLabel));
  expect(actionOrder.slice(-2)).toEqual(["Refit terminal", "Stop TUI"]);
}

async function expectTerminalActionContrast(
  page: Page,
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    const button = page.getByRole("button", { name, exact: true });
    await expect(button).toBeVisible();
    const contrast = await button.evaluate((element) => {
      // Canvas normalizes any CSS color the parser understands (color-mix,
      // lab spaces) into hex, rgb(), or color(srgb …), giving one code path
      // for every fill the theme uses.
      const canvas = document.createElement("canvas").getContext("2d")!;
      const parseColor = (
        color: string,
      ): { rgb: [number, number, number]; alpha: number } | undefined => {
        canvas.fillStyle = "#000000";
        canvas.fillStyle = color;
        const normalized = canvas.fillStyle;
        if (normalized.startsWith("#")) {
          const value = Number.parseInt(normalized.slice(1), 16);
          return {
            rgb: [(value >> 16) & 255, (value >> 8) & 255, value & 255],
            alpha: 1,
          };
        }
        const channels = normalized.match(/[\d.]+/g)?.map(Number) ?? [];
        if (channels.length < 3) return undefined;
        if (normalized.startsWith("color(")) {
          return {
            rgb: channels.slice(0, 3).map((v) => v * 255) as [
              number,
              number,
              number,
            ],
            alpha: channels[3] ?? 1,
          };
        }
        if (normalized.startsWith("rgb")) {
          return {
            rgb: channels.slice(0, 3) as [number, number, number],
            alpha: channels[3] ?? 1,
          };
        }
        return undefined;
      };
      const luminance = ([red, green, blue]: [number, number, number]) => {
        const linear = [red, green, blue].map((channel) => {
          const normalized = channel / 255;
          return normalized <= 0.04045
            ? normalized / 12.92
            : ((normalized + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
      };
      const style = getComputedStyle(element);
      const foreground = parseColor(style.color);
      if (!foreground) throw new Error(`Unexpected color: ${style.color}`);
      // Icon buttons are transparent until hover: resolve the effective
      // background from the nearest ancestor with a non-transparent fill.
      let backgroundFill = "#ffffff";
      let background = { rgb: [255, 255, 255] as [number, number, number] };
      for (
        let current: Element | null = element;
        current;
        current = current.parentElement
      ) {
        const fill = getComputedStyle(current).backgroundColor;
        const parsed = parseColor(fill);
        if (!parsed || parsed.alpha <= 0.5) continue;
        backgroundFill = fill;
        background = parsed;
        break;
      }
      const foregroundLuminance = luminance(foreground.rgb);
      const backgroundLuminance = luminance(background.rgb);
      return {
        backgroundFill,
        color: style.color,
        contrast:
          (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
          (Math.min(foregroundLuminance, backgroundLuminance) + 0.05),
      };
    });
    expect(
      contrast.contrast,
      `${name}: color ${contrast.color} on ${contrast.backgroundFill}`,
    ).toBeGreaterThanOrEqual(4.5);
  }
}

async function expectRenderedTerminalTheme(
  page: Page,
  theme: "light" | "dark",
): Promise<void> {
  const image = await page.getByTestId("codex-tui-terminal").screenshot({
    animations: "disabled",
  });
  const luminance = await page.evaluate(
    async (dataUrl) => {
      const response = await fetch(dataUrl);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context)
        throw new Error("Unable to inspect the terminal screenshot.");
      context.drawImage(bitmap, 0, 0);
      const [red, green, blue] = context.getImageData(
        Math.floor(bitmap.width * 0.75),
        Math.floor(bitmap.height * 0.75),
        1,
        1,
      ).data;
      return (0.2126 * red! + 0.7152 * green! + 0.0722 * blue!) / 255;
    },
    `data:image/png;base64,${image.toString("base64")}`,
  );
  if (theme === "light") expect(luminance).toBeGreaterThan(0.8);
  else expect(luminance).toBeLessThan(0.2);
}

async function expectRenderedAnsiColor(page: Page): Promise<void> {
  const image = await page.getByTestId("codex-tui-terminal").screenshot({
    animations: "disabled",
  });
  const coloredPixels = await page.evaluate(
    async (dataUrl) => {
      const response = await fetch(dataUrl);
      const bitmap = await createImageBitmap(await response.blob());
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context)
        throw new Error("Unable to inspect the terminal screenshot.");
      context.drawImage(bitmap, 0, 0);
      const pixels = context.getImageData(
        0,
        0,
        bitmap.width,
        bitmap.height,
      ).data;
      let count = 0;
      for (let index = 0; index < pixels.length; index += 4) {
        const red = pixels[index]!;
        const green = pixels[index + 1]!;
        const blue = pixels[index + 2]!;
        if (Math.max(red, green, blue) - Math.min(red, green, blue) > 50) {
          count += 1;
        }
      }
      return count;
    },
    `data:image/png;base64,${image.toString("base64")}`,
  );
  expect(coloredPixels).toBeGreaterThan(20);
}

test.describe.serial("managed Codex TUI browser journeys", () => {
  let codexThreadPath = "";

  test("desktop retains one Chat presentation while the managed TUI runs", async ({
    page,
  }, testInfo) => {
    await emulateWindowsTerminalClient(page);
    codexThreadPath = await openImportedCodexThread(page);
    await refreshTuiFixtureThread(page, codexThreadPath);
    const chatPanel = page.getByTestId("chat-thread-panel");
    const transcriptViewport = page.getByRole("region", {
      name: "Messages",
      exact: true,
    });
    await expect(chatPanel).toBeVisible();
    await expect(transcriptViewport).toBeVisible();
    await transcriptViewport.evaluate((element) => {
      (
        window as typeof window & { __e2eChatViewport?: Element }
      ).__e2eChatViewport = element;
    });

    await setAppearance(page, "Light");
    await selectTuiAndWaitUntilRunning(page);
    expect((await readTuiFixtureState(page)).launchCount).toBe(1);
    await expect(chatPanel).toBeHidden();
    await expect(chatPanel).toHaveAttribute("hidden", "");
    await expect(transcriptViewport).toBeHidden();
    expect(
      await page
        .getByTestId("codex-tui-terminal")
        .evaluate(
          (terminal) =>
            terminal === document.activeElement ||
            terminal.contains(document.activeElement),
        ),
    ).toBe(true);
    await expectFloatingViewChip(page);
    await expect(page.getByTestId("codex-tui-terminal")).toHaveCSS(
      "background-color",
      "rgb(247, 247, 248)",
    );
    await expectRenderedTerminalTheme(page, "light");
    await expectRenderedAnsiColor(page);
    await expectTerminalActionContrast(page, ["Refit terminal", "Stop TUI"]);
    await expect(page.getByTestId("composer")).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Send to TUI" }),
    ).toBeVisible();
    await capture(page, testInfo, "codex-tui-light-desktop.png");

    await expectIdleTerminalCanvas(page.getByTestId("codex-tui-terminal").locator("canvas"));
    const beforePreferences = await readTuiFixtureState(page);
    await openSettingsPage(page, "terminal");
    const settings = page.getByTestId("settings-view");
    const blink = settings.getByTestId("terminal-cursor-blink-toggle");
    await expect(blink).not.toBeChecked();
    const canvas = page.getByTestId("codex-tui-terminal").locator("canvas");
    const handle = await canvas.elementHandle();
    await blink.click();
    const paints = await canvas.getAttribute("data-paint-count");
    await expect.poll(() => canvas.getAttribute("data-paint-count")).not.toBe(paints);
    await blink.click();
    await expectIdleTerminalCanvas(canvas);
    expect(await canvas.evaluate((node, previous) => node === previous, handle)).toBe(true);
    await settings.getByTestId("terminal-font-size-setting").selectOption("18");
    await settings
      .getByTestId("terminal-scrollback-setting")
      .selectOption("12000");
    await returnFromSettings(page);
    await expect
      .poll(async () => (await readTuiFixtureState(page)).resizes.length)
      .toBeGreaterThan(beforePreferences.resizes.length);
    const afterPreferences = await readTuiFixtureState(page);
    expect(afterPreferences.resizes.at(-1)!.columns).toBeLessThan(
      beforePreferences.resizes.at(-1)!.columns,
    );
    await expect(
      page
        .getByTestId("codex-tui-panel")
        .getByText("Font size", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page
        .getByTestId("codex-tui-panel")
        .getByText("Scrollback", { exact: true }),
    ).toHaveCount(0);

    await setAppearance(page, "Dark");
    await expect(page.getByTestId("codex-tui-terminal")).toHaveCSS(
      "background-color",
      "rgb(17, 19, 24)",
    );
    await expectRenderedTerminalTheme(page, "dark");
    await expectRenderedAnsiColor(page);
    await expectTerminalActionContrast(page, ["Refit terminal", "Stop TUI"]);
    await capture(page, testInfo, "codex-tui-dark-desktop.png");

    const chat = page
      .getByRole("group", { name: "Thread view" })
      .getByRole("button", { name: "Chat" });
    await chat.click();
    await expect(chat).toHaveAttribute("aria-pressed", "true");
    await expect(chatPanel).toBeVisible();
    expect(
      await transcriptViewport.evaluate(
        (element) =>
          (window as typeof window & { __e2eChatViewport?: Element })
            .__e2eChatViewport === element,
      ),
    ).toBe(true);
    await expect(page.getByTestId("codex-tui-panel")).toBeHidden();

    await page
      .getByRole("group", { name: "Thread view" })
      .getByRole("button", { name: "TUI" })
      .click();
    await expect(page.getByRole("button", { name: "Stop TUI" })).toBeVisible();
    await page.reload();
    await expect(
      page
        .getByRole("group", { name: "Thread view" })
        .getByRole("button", { name: "TUI" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("button", { name: "Stop TUI" })).toBeVisible({
      timeout: 15_000,
    });
    await openSettingsPage(page, "terminal");
    await expect(page.getByTestId("terminal-font-size-setting")).toHaveValue(
      "18",
    );
    await expect(page.getByTestId("terminal-scrollback-setting")).toHaveValue(
      "12000",
    );
    await returnFromSettings(page);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  });

  test("viewers share one TUI generation and active work survives Start and Stop", async ({
    browser,
    page,
  }, testInfo) => {
    expect(codexThreadPath).toMatch(/^\/threads\/[0-9a-f-]+$/);
    await page.goto(codexThreadPath);
    await selectTuiAndWaitUntilRunning(page);

    const otherContext = await browser.newContext({
      baseURL: testInfo.project.use.baseURL as string,
      viewport: { width: 1000, height: 720 },
    });
    const otherPage = await otherContext.newPage();
    await otherPage.goto(codexThreadPath);
    await selectTuiAndWaitUntilRunning(otherPage);
    await expect(
      otherPage.getByRole("region", { name: "Codex terminal" }),
    ).toBeVisible();
    await expect(otherPage.getByText("Terminal connected")).toHaveCount(0);
    expect((await readTuiFixtureState(page)).launchCount).toBe(1);
    await capture(otherPage, testInfo, "codex-tui-late-viewer-desktop.png");

    const sharedBaseline = await readTuiFixtureState(page);
    await page.getByTestId("codex-tui-terminal").pressSequentially("viewer-a");
    await otherPage
      .getByTestId("codex-tui-terminal")
      .pressSequentially("viewer-b");
    await expect
      .poll(async () => (await readTuiFixtureState(page)).writes.join(""))
      .toContain("viewer-aviewer-b");

    await otherPage.getByRole("button", { name: "Refit terminal" }).click();
    await expect
      .poll(async () => (await readTuiFixtureState(page)).resizes.length)
      .toBeGreaterThan(sharedBaseline.resizes.length);

    await page
      .getByRole("group", { name: "Thread view" })
      .getByRole("button", { name: "Chat" })
      .click();
    await expect(otherPage.getByTestId("codex-tui-terminal")).toBeVisible();
    await otherPage
      .getByTestId("codex-tui-terminal")
      .pressSequentially("-still-live");
    await expect
      .poll(async () => (await readTuiFixtureState(page)).writes.join(""))
      .toContain("viewer-b-still-live");
    expect((await readTuiFixtureState(page)).closeReasons).toEqual(
      sharedBaseline.closeReasons,
    );

    const model = page
      .getByTestId("composer")
      .getByRole("combobox", { name: "Model" });
    await selectRadixOption(page, model, "GPT-5.6 Codex");
    await expect(model).toContainText("GPT-5.6 Codex");
    await expect(otherPage.getByTestId("codex-tui-terminal")).toBeVisible();

    await otherPage.getByRole("button", { name: "Stop TUI" }).click();
    await expect(page.getByRole("button", { name: "Stop TUI" })).toBeHidden({
      timeout: 10_000,
    });
    await expect(otherPage.getByText("TUI is stopped")).toBeVisible();
    await otherPage
      .getByRole("group", { name: "Thread view" })
      .getByRole("button", { name: "Chat" })
      .click();

    await fillAndPersistDraft(
      page,
      "Keep this turn running while the managed TUI starts and stops",
      "Message Codex TCP",
    );
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toBeEnabled();
    const completedAssistantMessages = page.locator(
      '[data-item-kind="assistant_message"][data-item-status="completed"]',
    );
    const completedBeforeTurn = await completedAssistantMessages.count();
    expect(
      (await page.request.post("/__e2e/codex/turn-completion/arm")).ok(),
    ).toBe(true);
    await sendCurrentDraft(page);
    await expect(
      page.locator(
        '[data-testid="activity-group"][data-activity-status="working"]',
      ),
    ).toBeVisible();
    await expect(
      otherPage.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    const launchesBeforeActiveStart = (await readTuiFixtureState(page))
      .launchCount;
    await otherPage
      .getByRole("group", { name: "Thread view" })
      .getByRole("button", { name: "TUI" })
      .click();
    await expect(otherPage.getByTestId("codex-tui-terminal")).toBeVisible({
      timeout: 15_000,
    });
    await expect(
      otherPage.getByRole("button", { name: "Stop TUI" }),
    ).toBeVisible();
    await expect
      .poll(async () => (await readTuiFixtureState(page)).launchCount)
      .toBe(launchesBeforeActiveStart + 1);
    await capture(otherPage, testInfo, "codex-tui-in-flight-desktop.png");
    await otherPage.setViewportSize({ width: 412, height: 915 });
    await capture(otherPage, testInfo, "codex-tui-in-flight-android.png");

    await otherPage.getByRole("button", { name: "Stop TUI" }).click();
    await expect(page.getByRole("button", { name: "Stop TUI" })).toBeHidden({
      timeout: 10_000,
    });
    await expect(
      page.locator(
        '[data-testid="activity-group"][data-activity-status="working"]',
      ),
    ).toBeVisible();
    expect(
      (await page.request.post("/__e2e/codex/turn-completion/release")).ok(),
    ).toBe(true);
    await expect
      .poll(() => completedAssistantMessages.count(), { timeout: 15_000 })
      .toBeGreaterThan(completedBeforeTurn);
    await expect(otherPage.getByRole("button", { name: "Retry" })).toHaveCount(
      0,
    );
    await otherContext.close();
  });

  test("historical focus and unsupported backends omit the whole switch", async ({
    page,
  }) => {
    expect(codexThreadPath).toMatch(/^\/threads\/[0-9a-f-]+$/);
    await page.goto(codexThreadPath);
    await selectTuiAndWaitUntilRunning(page);
    const turnId = await page
      .locator("[data-turn-id]")
      .first()
      .getAttribute("data-turn-id");
    expect(turnId).toBeTruthy();
    await page.goto(`${codexThreadPath}#turn=${encodeURIComponent(turnId!)}`);
    await expect(page.locator(".source-turn-highlight")).toBeVisible();
    await expectSwitchOmitted(page);
    await page.goto(codexThreadPath);
    await expect(
      page
        .getByRole("group", { name: "Thread view" })
        .getByRole("button", { name: "TUI" }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByTestId("codex-tui-panel")).toBeVisible();

    const threadId = codexThreadPath.split("/").at(-1);
    expect(threadId).toBeTruthy();
    const beforeAvailabilityLoss = await readTuiFixtureState(page);
    const unavailable = await page.request.post(
      `/__e2e/codex-tui/availability/${threadId}/unavailable`,
    );
    expect(unavailable.ok()).toBe(true);
    await expectSwitchOmitted(page);
    await expect(page.getByTestId("chat-thread-panel")).toBeVisible();
    expect((await readTuiFixtureState(page)).launchCount).toBe(
      beforeAvailabilityLoss.launchCount,
    );
    expect((await readTuiFixtureState(page)).closeReasons).toEqual(
      beforeAvailabilityLoss.closeReasons,
    );
    const available = await page.request.post(
      `/__e2e/codex-tui/availability/${threadId}/available`,
    );
    expect(available.ok()).toBe(true);
    await expect(
      page.getByRole("group", { name: "Thread view" }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("group", { name: "Thread view" })
        .getByRole("button", { name: "Chat" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect((await readTuiFixtureState(page)).launchCount).toBe(
      beforeAvailabilityLoss.launchCount,
    );

    await ensureWorkspace(page);
    const piThreadPath = await createDraftThread(page);
    await page.goto(piThreadPath);
    await expectSwitchOmitted(page);

    await page
      .getByTestId("desktop-sidebar")
      .getByTestId("new-thread-trigger")
      .click();
    await selectCustomNewThreadTarget(page, "Codex stdio owned · Codex stdio");
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/threads") &&
        response.status() === 201,
    );
    await page.getByRole("button", { name: "Create thread" }).click();
    await created;
    await fillAndPersistDraft(
      page,
      "Bind the owned stdio Codex fixture before checking TUI availability",
      "Message Codex stdio",
    );
    await sendCurrentDraft(page);
    await expect(
      page.locator(
        '[data-item-kind="assistant_message"][data-item-status="completed"]',
      ),
    ).toBeVisible({ timeout: 15_000 });
    await expectSwitchOmitted(page);
  });

  test("mobile and wide coarse-pointer layouts expose the same running TUI", async ({
    browser,
  }, testInfo) => {
    expect(codexThreadPath).toMatch(/^\/threads\/[0-9a-f-]+$/);
    const mobile = await browser.newContext({
      baseURL: testInfo.project.use.baseURL as string,
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
    });
    const mobilePage = await mobile.newPage();
    await mobilePage.goto(codexThreadPath);
    await selectTuiAndWaitUntilRunning(mobilePage);
    await expectFloatingViewChip(mobilePage);
    await expectTerminalActionContrast(mobilePage, [
      "Refit terminal",
      "Stop TUI",
    ]);
    const mobileComposer = mobilePage.getByRole("textbox", {
      name: "Send to TUI",
    });
    await expect(mobileComposer).toBeVisible();
    await expect(
      mobilePage.getByRole("textbox", { name: /^Message / }),
    ).toHaveCount(0);
    const keyBar = mobilePage.getByTestId("terminal-key-bar");
    await expect(keyBar.getByRole("button", { name: "Esc" })).toBeVisible();
    await expect(keyBar.getByRole("button", { name: "Tab" })).toBeVisible();
    await expect(
      keyBar.getByRole("button", { name: "Send Ctrl+C to terminal" }),
    ).toBeVisible();
    await expect(
      keyBar.getByRole("button", { name: "Send enter to terminal" }),
    ).toHaveCount(0);
    await expect(
      keyBar.getByRole("button", { name: "Stage draft in terminal" }),
    ).toBeVisible();
    const terminalFocus = keyBar.getByRole("button", {
      name: "Focus terminal keyboard",
    });
    await expect(terminalFocus).toHaveClass(/terminal-key-focus/);
    await expect
      .poll(() =>
        keyBar.evaluate((element) =>
          element.lastElementChild?.getAttribute("aria-label"),
        ),
      )
      .toBe("Stage draft in terminal");
    await expect(
      mobilePage.getByRole("button", { name: "Send draft to TUI" }),
    ).toBeVisible();
    const beforeStage = await readTuiFixtureState(mobilePage);
    await mobileComposer.fill("staged mobile TUI draft");
    await keyBar
      .getByRole("button", { name: "Stage draft in terminal" })
      .click();
    await expect
      .poll(async () =>
        (await readTuiFixtureState(mobilePage)).writes.slice(
          beforeStage.writes.length,
        ),
      )
      .toEqual(["\u001b[200~staged mobile TUI draft\u001b[201~"]);
    await expect(mobileComposer).toHaveValue("");

    const beforeComposerSend = await readTuiFixtureState(mobilePage);
    await mobileComposer.fill("submitted mobile TUI draft");
    await mobilePage.getByRole("button", { name: "Send draft to TUI" }).click();
    await expect
      .poll(async () =>
        (await readTuiFixtureState(mobilePage)).writes.slice(
          beforeComposerSend.writes.length,
        ),
      )
      .toEqual([
        "\u001b[200~submitted mobile TUI draft\u001b[201~\r",
      ]);
    await expect(mobileComposer).toHaveValue("");
    await expectNoPageOverflow(mobilePage);
    await capture(mobilePage, testInfo, "codex-tui-running-mobile.png");
    await mobile.close();

    const coarse = await browser.newContext({
      baseURL: testInfo.project.use.baseURL as string,
      viewport: { width: 1024, height: 768 },
      hasTouch: true,
      isMobile: true,
    });
    const coarsePage = await coarse.newPage();
    await coarsePage.goto(codexThreadPath);
    await selectTuiAndWaitUntilRunning(coarsePage);
    await expectFloatingViewChip(coarsePage);
    await expectTerminalActionContrast(coarsePage, [
      "Refit terminal",
      "Stop TUI",
    ]);
    await expect(
      coarsePage.getByRole("textbox", { name: "Send to TUI" }),
    ).toBeVisible();
    await expect(
      coarsePage.getByRole("textbox", { name: /^Message / }),
    ).toHaveCount(0);
    await expectNoPageOverflow(coarsePage);
    await capture(coarsePage, testInfo, "codex-tui-running-wide-coarse.png");
    await coarse.close();
  });
});
