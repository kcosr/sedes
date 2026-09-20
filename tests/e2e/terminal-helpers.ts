import type { Page } from "@playwright/test";
import { expect } from "./fixtures.js";

export interface TerminalFixtureState {
  readonly terminalId: string;
  readonly incarnationId: string;
  readonly environmentId: string;
  readonly initialCwd: string;
  readonly shellProfile: string | null;
  readonly initialRows: number;
  readonly initialColumns: number;
  readonly writes: readonly string[];
  readonly resizes: ReadonlyArray<{
    readonly rows: number;
    readonly columns: number;
  }>;
  readonly terminateSignals: readonly string[];
  readonly closed: boolean;
  readonly nextWriteOutcome: "sent" | "not_sent" | "sent_outcome_unknown";
  readonly nextWriteDelayMilliseconds: number;
}

export function terminalPanel(page: Page, name: string) {
  return page.getByRole("region", { name: `${name} terminal`, exact: true });
}

export function terminalContainer(page: Page) {
  return page.locator('[data-panel-instance-id="terminals"]');
}

export async function openTerminalPanelAction(page: Page, action: string) {
  const container = terminalContainer(page);
  await container
    .getByRole("button", { name: "Terminals panel actions" })
    .click();
  await page.getByRole("menuitem", { name: action, exact: true }).click();
}

export async function revealTerminals(page: Page) {
  await page.getByRole("button", { name: "Panels", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Terminals(?: —|$)/ }).click();
  await expect(terminalContainer(page)).toBeVisible();
}

export async function openTerminalMenu(page: Page) {
  await terminalContainer(page).getByRole("button", { name: "Open terminal tab" }).click();
  const menu = page.locator(".thread-terminal-menu");
  await expect(menu).toBeVisible();
  return menu;
}

export async function createTerminal(
  page: Page,
  name: string,
): Promise<string> {
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/api\/threads\/[^/]+\/terminals$/u.test(
        new URL(response.url()).pathname,
      ) &&
      response.status() === 201,
  );
  if (await terminalContainer(page).isVisible()) {
    await openTerminalMenu(page);
    await page.getByRole("menuitem", { name: "New terminal", exact: true }).click();
  } else {
    await revealTerminals(page);
  }
  const response = await created;
  const body = (await response.json()) as {
    readonly terminal: { readonly terminalId: string; readonly displayName: string };
  };
  const initialName = body.terminal.displayName;
  await expect(terminalPanel(page, initialName)).toBeVisible({ timeout: 15_000 });
  // Initial history restoration replaces the emulator input. Let it finish
  // before opening the rename input so initialization cannot blur the editor.
  await expect(
    terminalPanel(page, initialName).locator(
      '.terminal-panel-emulator[data-restored="true"]',
    ),
  ).toBeAttached({ timeout: 15_000 });
  await terminalContainer(page).getByRole("tab", { name: initialName, exact: true }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  const rename = page.getByRole("textbox", { name: `Rename ${initialName}`, exact: true });
  await rename.fill(name);
  await rename.press("Enter");
  await expect(terminalPanel(page, name)).toBeVisible({ timeout: 15_000 });
  await terminalContainer(page).getByRole("tab", { name, exact: true }).click();
  await expect(
    terminalPanel(page, name).locator(
      '.terminal-panel-emulator[data-restored="true"]',
    ),
  ).toBeAttached({ timeout: 15_000 });
  return body.terminal.terminalId;
}

export async function openExistingTerminal(page: Page, name: string) {
  await revealTerminals(page);
  const panel = terminalPanel(page, name);
  if (!(await panel.isVisible())) {
    // The launcher may select a different existing terminal. Keep this client
    // focused on the requested resource without ending that other process.
    const initialTab = terminalContainer(page).getByRole("tab", { selected: true });
    if (await initialTab.isVisible()) {
      const initialName = await initialTab.locator(".terminal-tab-label").innerText();
      await terminalContainer(page).getByRole("button", { name: `Close ${initialName} terminal`, exact: true }).click();
      await page.getByRole("dialog", { name: "Close terminal?" })
        .getByRole("button", { name: "Close tab", exact: true }).click();
    }
    await openTerminalMenu(page);
    await page.locator(".thread-terminal-menu-row").filter({ hasText: name })
      .locator(".thread-terminal-menu-entry").click();
  }
  await expect(panel).toBeVisible({ timeout: 15_000 });
  await expect(
    panel.locator('.terminal-panel-emulator[data-restored="true"]'),
  ).toBeAttached({ timeout: 15_000 });
  return panel;
}

export async function fixtureTerminalState(
  page: Page,
  terminalId: string,
): Promise<TerminalFixtureState> {
  const response = await page.request.get("/__e2e/terminals/state");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as {
    readonly terminals: readonly TerminalFixtureState[];
  };
  const terminal = body.terminals.find(
    (candidate) => candidate.terminalId === terminalId,
  );
  expect(terminal).toBeDefined();
  return terminal!;
}

export async function emitTerminalOutput(
  page: Page,
  terminalId: string,
  text: string,
): Promise<void> {
  const response = await page.request.post(
    `/__e2e/terminals/${terminalId}/output`,
    { data: { text } },
  );
  if (!response.ok()) {
    throw new Error(
      `terminal fixture output failed (${response.status()}): ${await response.text()}`,
    );
  }
}

export async function armTerminalInputOutcome(
  page: Page,
  terminalId: string,
  outcome: "sent" | "not_sent" | "sent_outcome_unknown",
): Promise<void> {
  const response = await page.request.post(
    `/__e2e/terminals/${terminalId}/arm-input-result`,
    { data: { outcome } },
  );
  expect(response.ok()).toBe(true);
}

export async function armTerminalInputDelay(
  page: Page,
  terminalId: string,
  milliseconds: number,
): Promise<void> {
  const response = await page.request.post(
    `/__e2e/terminals/${terminalId}/arm-input-delay`,
    { data: { milliseconds } },
  );
  expect(response.ok()).toBe(true);
}

export async function dropTerminalTransport(
  page: Page,
  terminalId: string,
): Promise<void> {
  const response = await page.request.post(
    `/__e2e/terminals/${terminalId}/drop-transport`,
  );
  expect(response.ok()).toBe(true);
}

export async function writeTerminal(
  page: Page,
  name: string,
  text: string,
): Promise<void> {
  const panel = terminalPanel(page, name);
  const textarea = panel.locator(".terminal-panel-emulator textarea");
  await expect(textarea).toBeAttached();
  await textarea.focus();
  await page.keyboard.type(text);
  await page.keyboard.press("Enter");
}

export async function transcriptText(
  page: Page,
  name: string,
): Promise<string> {
  const panel = terminalPanel(page, name);
  await openTerminalPanelAction(page, "Transcript");
  const transcript = panel.getByRole("complementary", {
    name: "Terminal transcript",
  });
  await expect(transcript).toBeVisible();
  return (await transcript.locator("pre").textContent()) ?? "";
}

/** Exercise the Windows renderer path in Chromium without pretending to measure Windows GPU cost. */
export async function emulateWindowsTerminalClient(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "platform", { configurable: true, get: () => "Win32" });
    Object.defineProperty(navigator, "userAgentData", { configurable: true, get: () => ({ platform: "Windows" }) });
    const original = CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect = function (...args) {
      const count = Number(this.canvas.dataset.paintCount ?? "0");
      this.canvas.dataset.paintCount = String(count + 1);
      return original.apply(this, args);
    };
  });
}

export async function expectIdleTerminalCanvas(canvas: import("@playwright/test").Locator): Promise<void> {
  // Observe ten actual frame opportunities: a continuous Ghostty loop would
  // paint on each. Two initial frames drain pending coalesced output paints.
  const counts = await canvas.evaluate(async (element) => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    await frame(); await frame();
    const before = element.getAttribute("data-paint-count");
    for (let i = 0; i < 10; i++) await frame();
    return { before, after: element.getAttribute("data-paint-count") };
  });
  expect(counts.before).not.toBeNull();
  expect(counts.after).toBe(counts.before);
}
