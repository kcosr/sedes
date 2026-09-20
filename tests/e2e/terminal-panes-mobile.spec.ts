import { expect, test } from "./fixtures.js";
import {
  capture,
  createDraftThread,
  expectNoPageOverflow,
  openSedesWorkspace,
} from "./helpers.js";
import {
  createTerminal,
  emitTerminalOutput,
  fixtureTerminalState,
  openTerminalMenu,
  revealTerminals,
  terminalContainer,
  terminalPanel,
  transcriptText,
} from "./terminal-helpers.js";

test("mobile empty terminal panel lists detached tabs and touch scrolling never types", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSedesWorkspace(page);
  const threadPath = await createDraftThread(page);
  const origin = new URL(page.url()).origin;
  const terminalId = await createTerminal(page, "Mobile shell");
  const resizesBeforeMobile = (await fixtureTerminalState(page, terminalId))
    .resizes.length;
  await page
    .getByRole("button", { name: "Close Terminals panel" })
    .first()
    .click();
  await expect(terminalPanel(page, "Mobile shell")).toHaveCount(0);

  const mobileContext = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  const mobile = await mobileContext.newPage();
  let terminalSockets = 0;
  let outputAcknowledgements = 0;
  mobile.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname === "/api/terminal") {
      terminalSockets += 1;
      socket.on("framesent", ({ payload }) => {
        if (typeof payload === "string" && payload.includes('"type":"ack_output"')) {
          outputAcknowledgements += 1;
        }
      });
    }
  });
  await mobile.goto(`${origin}${threadPath}`);
  await revealTerminals(mobile);
  const panel = terminalPanel(mobile, "Mobile shell");
  await expect(panel.locator('.terminal-panel-emulator[data-restored="true"]')).toBeAttached({ timeout: 15_000 });
  await expect.poll(() => terminalSockets).toBe(1);
  await terminalContainer(mobile).getByRole("button", { name: "Terminal actions for Mobile shell" }).click();
  await mobile.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const rename = mobile.getByRole("textbox", { name: "Rename Mobile shell", exact: true });
  await expect(rename).toBeFocused();
  await rename.fill("Canceled rename");
  await rename.press("Escape");
  await expect(terminalContainer(mobile).getByRole("tab", { name: "Mobile shell", exact: true })).toBeVisible();

  await terminalContainer(mobile).getByRole("button", { name: "Close Mobile shell terminal" }).click();
  await mobile.getByRole("dialog", { name: "Close terminal?" })
    .getByRole("button", { name: "Close tab", exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(terminalContainer(mobile)).toBeVisible();
  await expect(terminalContainer(mobile).getByRole("button", { name: "New terminal", exact: true })).toBeVisible();
  expect((await fixtureTerminalState(page, terminalId)).closed).toBe(false);
  await capture(mobile, testInfo, "terminal-empty-mobile.png");
  await revealTerminals(mobile);
  await expect(panel).toHaveCount(0);
  const socketsBeforeMenu = terminalSockets;
  const menu = await openTerminalMenu(mobile);
  await expect(menu.locator(".thread-terminal-menu-row").filter({ hasText: "Mobile shell" })).toContainText("Running");
  await expectNoPageOverflow(mobile);
  expect(terminalSockets).toBe(socketsBeforeMenu);
  await capture(mobile, testInfo, "terminal-menu-mobile.png");
  await menu.locator(".thread-terminal-menu-row").filter({ hasText: "Mobile shell" })
    .locator(".thread-terminal-menu-entry").click();
  await expect(panel.locator('.terminal-panel-emulator[data-restored="true"]')).toBeAttached({ timeout: 15_000 });
  await expect.poll(() => terminalSockets).toBe(socketsBeforeMenu + 1);
  const mobilePanelRoot = mobile.locator('[data-mobile-terminal-panel="true"]');
  await expect(mobilePanelRoot).toHaveAttribute("role", "dialog");
  await expect(mobilePanelRoot).toHaveAttribute("data-state", "open");
  await expect(
    mobile.getByRole("dialog", { name: "Terminals panel" }),
  ).toBeVisible();
  await expect(
    terminalContainer(mobile).getByRole("tab", { name: "Mobile shell" }),
  ).toBeVisible();
  await expect(
    terminalContainer(mobile).getByRole("button", {
      name: "Open terminal tab",
    }),
  ).toBeVisible();
  await expect(panel).toHaveAttribute("data-terminal-role", "controller");
  await expect(panel.locator(".terminal-panel-emulator")).not.toHaveAttribute(
    "aria-live",
    /.+/u,
  );

  await expect(
    panel.getByRole("button", { name: "Send Ctrl+C to terminal" }),
  ).toBeEnabled();
  await expect(
    panel.getByText("You have control", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(async () => (await fixtureTerminalState(page, terminalId)).resizes.length)
    .toBeGreaterThan(resizesBeforeMobile);
  await terminalContainer(mobile)
    .getByRole("button", { name: "Terminals panel actions" })
    .click();
  await expect(
    mobile.getByRole("menuitem", { name: "Release control" }),
  ).toHaveCount(0);
  await expect(
    mobile.getByRole("menuitem", { name: "Take control" }),
  ).toHaveCount(0);
  await mobile.keyboard.press("Escape");

  const lines = Array.from(
    { length: 140 },
    (_, index) => `mobile-scroll-${String(index).padStart(3, "0")}\r\n`,
  ).join("");
  await emitTerminalOutput(page, terminalId, lines);
  await expect(
    panel.locator(
      '.terminal-panel-emulator .live-region[aria-live], .terminal-panel-emulator [aria-live="assertive"], .terminal-panel-emulator [aria-live="polite"]',
    ),
  ).toHaveCount(0);
  const canvas = panel.locator(".terminal-panel-emulator canvas");
  await expect(canvas).toBeVisible();
  const beforeScroll = await canvas.evaluate((element) =>
    (element as HTMLCanvasElement).toDataURL(),
  );
  const viewportBox = await canvas.boundingBox();
  expect(viewportBox).not.toBeNull();
  const touchX = viewportBox!.x + viewportBox!.width / 2;
  const touchStartY = viewportBox!.y + 45;
  const touchEndY = viewportBox!.y + viewportBox!.height - 45;
  const writesBeforeTouch = (await fixtureTerminalState(page, terminalId))
    .writes.length;
  const cdp = await mobileContext.newCDPSession(mobile);
  const commandInput = panel.getByRole("textbox", {
    name: "Terminal command",
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: touchX, y: touchStartY }],
  });
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(commandInput).toBeFocused();
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: touchX, y: touchStartY }],
  });
  for (let step = 1; step <= 10; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: touchX,
          y: touchStartY + ((touchEndY - touchStartY) * step) / 10,
        },
      ],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect
    .poll(async () =>
      canvas.evaluate((element) => (element as HTMLCanvasElement).toDataURL()),
    )
    .not.toBe(beforeScroll);
  expect((await fixtureTerminalState(page, terminalId)).writes.length).toBe(
    writesBeforeTouch,
  );

  // Compare only history text: exclude the changing scrollbar and cursor.
  const visibleHistory = () => canvas.evaluate((element) => {
    const source = element as HTMLCanvasElement;
    const crop = document.createElement("canvas");
    crop.width = Math.floor(source.width * 0.8);
    crop.height = Math.floor(source.height * 0.5);
    crop.getContext("2d")!.drawImage(source, 0, 0);
    return crop.toDataURL();
  });
  const scrolledHistory = await visibleHistory();
  const acknowledgementsBeforeOutput = outputAcknowledgements;
  await emitTerminalOutput(page, terminalId, "output-while-reading-history\r\n".repeat(5));
  await expect.poll(() => outputAcknowledgements).toBeGreaterThan(acknowledgementsBeforeOutput);
  await mobile.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  expect(await visibleHistory()).toBe(scrolledHistory);
  await canvas.hover();
  await mobile.mouse.wheel(0, 100_000);
  await expect.poll(visibleHistory).not.toBe(scrolledHistory);
  const liveHistory = await visibleHistory();
  await emitTerminalOutput(page, terminalId, "following-new-output\r\n".repeat(30));
  await expect.poll(visibleHistory).not.toBe(liveHistory);

  // A full-screen TUI must retain its connection and input through the
  // viewport contraction caused by opening a mobile keyboard.
  // This fixture covers normal-timing focus and connection retention; the
  // carrier unit test exercises queue overflow with blocked remote dispatch.
  const socketsBeforeKeyboard = terminalSockets;
  const rowsBeforeKeyboard = (await fixtureTerminalState(page, terminalId)).resizes.at(-1)!.rows;
  await emitTerminalOutput(page, terminalId, "\u001b[?1049h\u001b[2J\u001b[HKeyboard resize TUI");
  await commandInput.tap();
  for (const height of [760, 680, 600, 520, 440]) {
    await mobile.setViewportSize({ width: 390, height });
  }
  await expect.poll(async () =>
    (await fixtureTerminalState(page, terminalId)).resizes.at(-1)!.rows,
  ).toBeLessThan(rowsBeforeKeyboard);
  await expect(commandInput).toBeFocused();
  await expect(panel.locator('.terminal-panel-emulator[data-restored="true"]')).toBeAttached();
  expect(terminalSockets).toBe(socketsBeforeKeyboard);
  await capture(mobile, testInfo, "terminal-mobile-keyboard.png");

  await expect(commandInput).toBeEnabled();
  await commandInput.fill("printf mobile-input");
  await panel
    .getByRole("button", { name: "Send command to terminal" })
    .click();
  await expect
    .poll(async () => (await fixtureTerminalState(page, terminalId)).writes.at(-1))
    .toBe("printf mobile-input\r");
  await expect(commandInput).toHaveValue("");
  expect(terminalSockets).toBe(socketsBeforeKeyboard);
  await emitTerminalOutput(page, terminalId, "\u001b[?1049l");
  await mobile.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () =>
    (await fixtureTerminalState(page, terminalId)).resizes.at(-1)!.rows,
  ).toBe(rowsBeforeKeyboard);

  for (const key of ["Esc", "Tab", "Send Ctrl+C to terminal"] as const) {
    const button = panel.getByRole("button", { name: key });
    const bounds = await button.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.height).toBeGreaterThanOrEqual(29);
    expect(bounds!.height).toBeLessThanOrEqual(31);
    await button.click();
  }
  await expect
    .poll(async () =>
      (await fixtureTerminalState(page, terminalId)).writes.slice(-3),
    )
    .toEqual(["\u001b", "\t", "\u0003"]);
  const terminalGeometry = await panel
    .locator(".terminal-panel-emulator")
    .evaluate((host) => {
      const canvas = host.querySelector("canvas");
      if (!canvas) throw new Error("Terminal canvas is missing.");
      const hostBox = host.getBoundingClientRect();
      const canvasBox = canvas.getBoundingClientRect();
      return { hostBottom: hostBox.bottom, canvasBottom: canvasBox.bottom };
    });
  expect(terminalGeometry.canvasBottom).toBeLessThanOrEqual(
    terminalGeometry.hostBottom + 1,
  );
  await expectNoPageOverflow(mobile);
  await capture(mobile, testInfo, "terminal-mobile.png");

  const secondCreated = mobile.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/threads\/[^/]+\/terminals$/u.test(
        new URL(response.url()).pathname,
      ) &&
      response.status() === 201,
  );
  await terminalContainer(mobile)
    .getByRole("button", { name: "Open terminal tab" })
    .click();
  await mobile.getByRole("menuitem", { name: "New terminal" }).click();
  const secondTerminalBody = (await (await secondCreated).json()) as {
    readonly terminal: { readonly terminalId: string };
  };
  const secondTerminalId = secondTerminalBody.terminal.terminalId;
  const secondPanel = terminalPanel(mobile, "Terminal");
  await expect(secondPanel).toBeVisible({ timeout: 15_000 });
  await expect(
    secondPanel.locator('.terminal-panel-emulator[data-restored="true"]'),
  ).toBeAttached({ timeout: 15_000 });
  await expect(panel).toHaveCount(0);
  await expect(
    secondPanel.locator(".terminal-panel-emulator canvas"),
  ).toHaveCount(1);
  expect(await transcriptText(mobile, "Terminal")).not.toContain(
    "mobile-scroll-",
  );
  await secondPanel
    .getByRole("button", { name: "Close transcript" })
    .click();
  await capture(mobile, testInfo, "terminal-mobile-second-clean.png");

  await terminalContainer(mobile)
    .getByRole("button", {
      name: "Close Terminal terminal",
    })
    .click();
  const closeDialog = mobile.getByRole("dialog", { name: "Close terminal?" });
  await expect(closeDialog).toBeVisible();
  await capture(mobile, testInfo, "terminal-mobile-close-confirmation.png");
  await closeDialog.getByRole("button", { name: "Close tab", exact: true }).click();
  const restoredFirstPanel = terminalPanel(mobile, "Mobile shell");
  await expect(
    restoredFirstPanel.locator(
      '.terminal-panel-emulator[data-restored="true"]',
    ),
  ).toBeAttached({ timeout: 15_000 });
  const restoredFirstTranscript = await transcriptText(mobile, "Mobile shell");
  expect(restoredFirstTranscript).toContain("mobile-scroll-139");
  expect(restoredFirstTranscript.split("\n").filter((line) => line === "output-while-reading-history")).toHaveLength(5);
  expect(restoredFirstTranscript.split("\n").filter((line) => line === "following-new-output")).toHaveLength(30);
  expect(
    restoredFirstTranscript
      .split("\n")
      .filter(
        (line) =>
          line.length > 0 &&
          !/^mobile-scroll-\d{3}$/u.test(line) &&
          line !== "output-while-reading-history" &&
          line !== "following-new-output" &&
          line !== "input:printf mobile-input" &&
          line !== "$",
      ),
  ).toEqual([]);
  await capture(mobile, testInfo, "terminal-mobile-first-restored.png");
  await restoredFirstPanel
    .getByRole("button", { name: "Close transcript" })
    .click();

  await mobile.goBack();
  await expect(mobilePanelRoot).toHaveCount(0);
  await expect(panel).toHaveCount(0);
  await expect(mobile.getByTestId("thread-view")).toBeVisible();
  await expect(
    mobile.getByText(
      "Terminals panel closed. Its process was not terminated.",
      {
        exact: true,
      },
    ),
  ).toBeAttached();
  expect((await fixtureTerminalState(page, terminalId)).closed).toBe(false);
  expect((await fixtureTerminalState(page, secondTerminalId)).closed).toBe(false);
  await mobileContext.close();
});
