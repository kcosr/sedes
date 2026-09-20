import { expect, test } from "./fixtures.js";
import { capture, createDraftThread, openSedesWorkspace } from "./helpers.js";
import {
  armTerminalInputDelay,
  armTerminalInputOutcome,
  createTerminal,
  dropTerminalTransport,
  emitTerminalOutput,
  fixtureTerminalState,
  openTerminalPanelAction,
  terminalContainer,
  terminalPanel,
  transcriptText,
  writeTerminal,
} from "./terminal-helpers.js";

test("terminal reconnect resumes output once and preserves interrupted history", async ({
  browserDiagnostics,
  context,
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1360, height: 840 });
  await page.addInitScript(() => {
    const NativeWebSocket = window.WebSocket;
    const terminalSockets = new Set<WebSocket>();
    class E2eWebSocket extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols ?? []);
        if (
          new URL(String(url), window.location.href).pathname ===
          "/api/terminal"
        ) {
          terminalSockets.add(this);
          this.addEventListener("close", () => terminalSockets.delete(this));
        }
      }
    }
    Object.defineProperty(window, "WebSocket", { value: E2eWebSocket });
    Object.defineProperty(window, "__e2eCloseTerminalSockets", {
      value: () => {
        for (const socket of terminalSockets)
          socket.close(4001, "e2e_reconnect");
      },
    });
  });
  await openSedesWorkspace(page);
  await createDraftThread(page);
  const terminalId = await createTerminal(page, "Reconnect shell");
  const panel = terminalPanel(page, "Reconnect shell");

  await emitTerminalOutput(page, terminalId, "before-disconnect\r\n");
  await expect
    .poll(
      async () =>
        await transcriptContains(page, "Reconnect shell", "before-disconnect"),
    )
    .toBe(true);

  browserDiagnostics.allowNetworkFailures = true;
  await context.setOffline(true);
  await page.evaluate(() => {
    (
      window as unknown as Window & {
        __e2eCloseTerminalSockets(): void;
      }
    ).__e2eCloseTerminalSockets();
  });
  await expect(
    terminalContainer(page).getByRole("img", {
      name: "Terminal reconnecting",
    }),
  ).toBeVisible({ timeout: 10_000 });
  await capture(page, testInfo, "terminal-reconnecting.png");

  await emitTerminalOutput(page, terminalId, "during-disconnect\r\n");
  await context.setOffline(false);
  await expect(
    panel.locator('.terminal-panel-emulator[data-restored="true"]'),
  ).toBeAttached({ timeout: 15_000 });
  browserDiagnostics.allowNetworkFailures = false;
  await emitTerminalOutput(page, terminalId, "after-reconnect\r\n");
  await expect
    .poll(
      async () =>
        await transcriptContains(page, "Reconnect shell", "after-reconnect"),
    )
    .toBe(true);

  const transcript = await transcriptText(page, "Reconnect shell");
  expect(occurrences(transcript, "before-disconnect")).toBe(1);
  expect(occurrences(transcript, "during-disconnect")).toBe(1);
  expect(occurrences(transcript, "after-reconnect")).toBe(1);
  await panel.getByRole("button", { name: "Close transcript" }).click();

  await armTerminalInputDelay(page, terminalId, 350);
  await writeTerminal(page, "Reconnect shell", "rapid-input");
  await expect
    .poll(async () =>
      (await fixtureTerminalState(page, terminalId)).writes.join(""),
    )
    .toContain("rapid-input\r");

  await armTerminalInputOutcome(page, terminalId, "sent_outcome_unknown");
  await panel.locator(".terminal-panel-emulator textarea").focus();
  await page.keyboard.press("Control+C");
  await expect(
    panel.getByRole("button", { name: "Discard unconfirmed input" }),
  ).toBeVisible();
  await expect
    .poll(
      async () =>
        (await fixtureTerminalState(page, terminalId)).writes.filter(
          (write) => write === "\u0003",
        ).length,
    )
    .toBe(1);

  await dropTerminalTransport(page, terminalId);
  await expect(panel.getByText("interrupted", { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await capture(page, testInfo, "terminal-interrupted.png");

  await page.reload();
  const restored = terminalPanel(page, "Reconnect shell");
  await expect(restored).toBeVisible({ timeout: 15_000 });
  await expect(restored.getByText("interrupted", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(restored.getByText("Read only", { exact: true })).toBeVisible();
  const restoredTranscript = await transcriptText(page, "Reconnect shell");
  expect(occurrences(restoredTranscript, "during-disconnect")).toBe(1);
  expect(occurrences(restoredTranscript, "after-reconnect")).toBe(1);
  expect((await fixtureTerminalState(page, terminalId)).closed).toBe(true);
});

async function transcriptContains(
  page: Parameters<typeof terminalPanel>[0],
  name: string,
  expected: string,
): Promise<boolean> {
  const panel = terminalPanel(page, name);
  const transcript = panel.getByRole("complementary", {
    name: "Terminal transcript",
  });
  if (!(await transcript.isVisible().catch(() => false))) {
    await openTerminalPanelAction(page, "Transcript");
  }
  const text = (await transcript.locator("pre").textContent()) ?? "";
  await panel.getByRole("button", { name: "Close transcript" }).click();
  return text.includes(expected);
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
