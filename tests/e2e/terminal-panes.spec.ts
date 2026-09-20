import { expect, test } from "./fixtures.js";
import { capture, createDraftThread, openSedesWorkspace, openSettingsPage, returnFromSettings } from "./helpers.js";
import {
  createTerminal,
  emulateWindowsTerminalClient,
  expectIdleTerminalCanvas,
  emitTerminalOutput,
  fixtureTerminalState,
  openExistingTerminal,
  openTerminalMenu,
  revealTerminals,
  terminalContainer,
  terminalPanel,
  transcriptText,
  writeTerminal,
} from "./terminal-helpers.js";

test("terminal resources outlive panels and transfer control across three clients", async ({
  browser,
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSedesWorkspace(page);
  const threadPath = await createDraftThread(page);
  const origin = new URL(page.url()).origin;

  let terminalSockets = 0;
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname === "/api/terminal")
      terminalSockets += 1;
  });
  expect(terminalSockets).toBe(0);

  const terminalId = await createTerminal(page, "E2E shell");
  await emitTerminalOutput(
    page,
    terminalId,
    "\u001b[38;2;37;99;235mSedes terminal fixture\u001b[0m\r\n$ ",
  );
  await expect.poll(() => terminalSockets).toBe(1);
  const launched = await fixtureTerminalState(page, terminalId);
  expect(launched.initialCwd).toBe(process.cwd());
  expect(launched.initialRows).toBe(24);
  expect(launched.initialColumns).toBe(80);

  // Rename is a deliberate interaction that cancels opening autofocus. Reopen
  // the named terminal to exercise delayed input readiness without intervening
  // keyboard or pointer events consuming the new focus request.
  await terminalContainer(page).getByRole("button", { name: "Close Terminals panel" }).click();
  await expect(terminalPanel(page, "E2E shell")).toHaveCount(0);
  const delayedInputVisibility = await page.addStyleTag({
    content: ".terminal-panel-emulator textarea { visibility: hidden !important; }",
  });
  await revealTerminals(page);
  await expect(terminalPanel(page, "E2E shell").locator('.terminal-panel-emulator[data-restored="true"]')).toBeAttached();
  await expect.poll(() => terminalSockets).toBe(2);
  await expect(terminalPanel(page, "E2E shell").locator(".terminal-panel-emulator textarea")).not.toBeFocused();
  await delayedInputVisibility.evaluate((element) => element.parentNode?.removeChild(element));
  await expect(terminalPanel(page, "E2E shell").locator(".terminal-panel-emulator textarea")).toBeFocused();
  await terminalContainer(page).getByRole("button", { name: "Close E2E shell terminal" }).click();
  const closeConfirmation = page.getByRole("dialog", { name: "Close terminal?" });
  await expect(closeConfirmation.getByRole("button", { name: "Close tab", exact: true })).toBeFocused();
  await capture(page, testInfo, "terminal-close-confirmation-desktop.png");
  await closeConfirmation.getByRole("button", { name: "Cancel", exact: true }).click();
  await writeTerminal(page, "E2E shell", "pwd");
  await expect
    .poll(async () =>
      (await fixtureTerminalState(page, terminalId)).writes.join(""),
    )
    .toContain("pwd\r");
  expect(await transcriptText(page, "E2E shell")).toContain(process.cwd());
  await terminalPanel(page, "E2E shell")
    .getByRole("button", { name: "Close transcript" })
    .click();
  await writeTerminal(page, "E2E shell", "cd /tmp && pwd");
  await expect
    .poll(async () =>
      (await fixtureTerminalState(page, terminalId)).writes.join(""),
    )
    .toContain("cd /tmp && pwd\r");
  expect(await transcriptText(page, "E2E shell")).toContain("/tmp");
  await terminalPanel(page, "E2E shell")
    .getByRole("button", { name: "Close transcript" })
    .click();
  const logsTerminalId = await createTerminal(page, "Build logs");
  const terminalTabs = terminalContainer(page).getByRole("tablist", {
    name: "Terminal tabs",
  });
  await expect(terminalPanel(page, "Build logs").locator(".terminal-panel-emulator textarea")).toBeFocused();
  await expect(terminalTabs.getByRole("tab")).toHaveCount(2);
  await expect(
    terminalTabs.getByRole("tab", { name: "Build logs" }),
  ).toHaveAttribute("aria-selected", "true");
  await terminalTabs.getByRole("tab", { name: "E2E shell" }).click();
  await expect(terminalPanel(page, "E2E shell")).toBeVisible();
  await expect(terminalPanel(page, "E2E shell").locator(".terminal-panel-emulator textarea")).toBeFocused();

  await terminalContainer(page)
    .getByRole("button", { name: "Open terminal tab" })
    .click();
  await expect(
    page.getByRole("menuitem", { name: /E2E shell.*Running · Open/u }),
  ).toHaveAttribute("aria-disabled", "true");
  await expect(
    page.getByRole("menuitem", { name: /Build logs.*Running · Open/u }),
  ).toHaveAttribute("aria-disabled", "true");
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1024, height: 900 });
  const desktopMenu = await openTerminalMenu(page);
  expect(await desktopMenu.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await capture(page, testInfo, "terminal-menu-desktop.png");
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1440, height: 900 });
  await capture(page, testInfo, "terminal-running-desktop.png");

  const resizeCountBeforePhone = (
    await fixtureTerminalState(page, terminalId)
  ).resizes.length;
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(async () =>
    (await fixtureTerminalState(page, terminalId)).resizes.length,
  ).toBeGreaterThan(resizeCountBeforePhone);
  const phoneResize = (
    await fixtureTerminalState(page, terminalId)
  ).resizes.at(-1)!;

  const secondContext = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const second = await secondContext.newPage();
  await second.goto(`${origin}${threadPath}`);
  const secondPanel = await openExistingTerminal(second, "E2E shell");
  await expect(
    secondPanel.getByText("You have control", { exact: true }),
  ).toBeVisible();
  await expect.poll(async () =>
    (await fixtureTerminalState(second, terminalId)).resizes.at(-1)?.columns,
  ).toBeGreaterThan(phoneResize.columns);
  await page.setViewportSize({ width: 1440, height: 900 });

  const thirdContext = await browser.newContext({
    viewport: { width: 1180, height: 760 },
  });
  const third = await thirdContext.newPage();
  await third.goto(`${origin}${threadPath}`);
  const thirdPanel = await openExistingTerminal(third, "E2E shell");
  await expect(
    thirdPanel.getByText("You have control", { exact: true }),
  ).toBeVisible();
  await expect(
    secondPanel.getByText("Read only", { exact: true }),
  ).toBeVisible();

  await expect(
    terminalContainer(second).getByRole("img", {
      name: "Read only — controlled by another client",
    }),
  ).toBeVisible();
  await capture(second, testInfo, "terminal-read-only-lock-desktop.png");
  await terminalContainer(second)
    .getByRole("button", { name: "Terminals panel actions" })
    .click();
  await second.getByRole("menuitem", { name: "Take control" }).click();
  await expect(
    secondPanel.getByText("You have control", { exact: true }),
  ).toBeVisible();
  await expect(
    terminalPanel(page, "E2E shell").getByText("Read only", { exact: true }),
  ).toBeVisible();
  await expect(
    thirdPanel.getByText("Read only", { exact: true }),
  ).toBeVisible();
  await capture(second, testInfo, "terminal-observer-desktop.png");

  await writeTerminal(second, "E2E shell", "controller-two");
  await expect
    .poll(async () =>
      (await fixtureTerminalState(page, terminalId)).writes.join(""),
    )
    .toContain("controller-two\r");
  const writesAfterController = (await fixtureTerminalState(page, terminalId))
    .writes.length;
  const firstTextarea = terminalPanel(page, "E2E shell").locator(
    ".terminal-panel-emulator textarea",
  );
  await firstTextarea.focus();
  await page.keyboard.type("observer-cannot-type");
  await page.keyboard.press("Enter");
  await expect
    .poll(
      async () => (await fixtureTerminalState(page, terminalId)).writes.length,
    )
    .toBe(writesAfterController);

  await page
    .getByRole("button", { name: "Close Terminals panel" })
    .first()
    .click();
  await expect(terminalPanel(page, "E2E shell")).toHaveCount(0);
  const afterClose = await fixtureTerminalState(page, terminalId);
  expect(afterClose.closed).toBe(false);
  const secondMenu = await openTerminalMenu(second);
  await secondMenu.getByRole("menuitem", { name: "Tear down and remove E2E shell" }).click();
  const endConfirmation = second.getByRole("dialog", {
    name: "End terminal?",
  });
  await expect(endConfirmation).toContainText(
    "End E2E shell and permanently remove its retained history?",
  );
  await endConfirmation
    .getByRole("button", { name: "End terminal", exact: true })
    .click();
  await expect
    .poll(async () => (await fixtureTerminalState(page, terminalId)).closed)
    .toBe(true);
  await expect(secondPanel).toHaveCount(0);
  await expect(thirdPanel).toHaveCount(0);
  await expect(terminalContainer(second)).toBeVisible();
  await expect(terminalContainer(second).getByRole("button", { name: "New terminal", exact: true })).toBeVisible();
  const remainingMenu = await openTerminalMenu(second);
  await expect(remainingMenu.locator(".thread-terminal-menu-row").filter({ hasText: "E2E shell" })).toHaveCount(0);
  await second.keyboard.press("Escape");

  await second.reload();
  await expect(terminalContainer(second)).toBeVisible();
  const newTerminalButton = terminalContainer(second).getByRole("button", { name: "New terminal", exact: true });
  await expect(newTerminalButton).toBeVisible();
  const createdFromEmpty = second.waitForResponse((response) =>
    response.request().method() === "POST" &&
    /\/api\/threads\/[^/]+\/terminals$/u.test(new URL(response.url()).pathname) &&
    response.status() === 201,
  );
  await newTerminalButton.click();
  await createdFromEmpty;
  await expect(terminalPanel(second, "Terminal")).toBeVisible();
  await expect(terminalContainer(second).getByRole("tab")).toHaveCount(1);
  await capture(second, testInfo, "terminal-created-from-empty.png");

  expect((await fixtureTerminalState(page, logsTerminalId)).closed).toBe(false);

  await thirdContext.close();
  await secondContext.close();
});

test("Windows terminals stop idle painting and toggle blink without reconnecting", async ({ page }) => {
  await emulateWindowsTerminalClient(page);
  await openSedesWorkspace(page);
  await createDraftThread(page);
  let sockets = 0;
  page.on("websocket", (socket) => { if (new URL(socket.url()).pathname === "/api/terminal") sockets++; });
  const id = await createTerminal(page, "Windows terminal");
  await emitTerminalOutput(page, id, "Windows terminal output\r\n$ ");
  // Settings keeps the thread mounted but hidden; retain its canvas and socket.
  const canvas = page.locator(".terminal-panel-emulator canvas");
  await expect(canvas).toBeVisible();
  await expectIdleTerminalCanvas(canvas);
  const before = await canvas.evaluate((node) => (node as HTMLCanvasElement).toDataURL());
  await emitTerminalOutput(page, id, "updated output\r\n");
  await expect.poll(() => canvas.evaluate((node) => (node as HTMLCanvasElement).toDataURL())).not.toBe(before);
  await expectIdleTerminalCanvas(canvas);
  const connections = sockets;
  const canvasHandle = await canvas.elementHandle();
  const dialog = await openSettingsPage(page, "terminal");
  const toggle = dialog.getByTestId("terminal-cursor-blink-toggle");
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  const paints = await canvas.getAttribute("data-paint-count");
  await expect.poll(() => canvas.getAttribute("data-paint-count")).not.toBe(paints);
  await toggle.click();
  await returnFromSettings(page);
  await expect(canvas).toBeVisible();
  expect(await canvas.evaluate((node, previous) => node === previous, canvasHandle)).toBe(true);
  await expectIdleTerminalCanvas(canvas);
  expect(sockets).toBe(connections);
});
