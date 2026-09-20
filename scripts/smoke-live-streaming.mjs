import { mkdir } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright";

const baseUrl = process.env.SEDES_SMOKE_URL ?? "http://127.0.0.1:4784";
const pairingCode = process.env.SEDES_SMOKE_PAIRING_CODE;
// Keep the enrollment secret out of browser subprocess environments.
delete process.env.SEDES_SMOKE_PAIRING_CODE;
const screenshotDirectory =
  process.env.SEDES_SMOKE_SCREENSHOTS ??
  path.resolve("test-results/live-streaming-smoke");
const prompt =
  process.env.SEDES_SMOKE_PROMPT ??
  "Run exactly this shell command, then briefly confirm completion: for i in $(seq 1 10); do date; sleep 1; done";
const environmentLabel = process.env.SEDES_SMOKE_ENVIRONMENT;
const targetLabel = process.env.SEDES_SMOKE_TARGET;
const projectLabel = process.env.SEDES_SMOKE_PROJECT;
assert.ok(environmentLabel, "SEDES_SMOKE_ENVIRONMENT is required");
assert.ok(targetLabel, "SEDES_SMOKE_TARGET is required");
assert.ok(projectLabel, "SEDES_SMOKE_PROJECT is required");
const operationKinds = new Set([
  "command",
  "file_change",
  "file_read",
  "mcp",
  "tool",
  "web_search",
]);

const statusResponse = await fetch(new URL("/api/auth/status", baseUrl), {
  signal: AbortSignal.timeout(5_000),
  redirect: "error",
});
assert.ok(statusResponse.ok, "Cannot read this server's authentication status");
const authenticationStatus = await statusResponse.json();
assert.ok(
  typeof authenticationStatus?.required === "boolean",
  "The server returned an invalid authentication requirement",
);
if (authenticationStatus.required) {
  assert.ok(
    typeof pairingCode === "string" && /^[BCDFGHJKLMNPQRSTVWXZ]{4}-?[BCDFGHJKLMNPQRSTVWXZ]{4}$/i.test(pairingCode.trim()),
    "SEDES_SMOKE_PAIRING_CODE must contain a fresh management pairing code",
  );
}

await mkdir(screenshotDirectory, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
try {
  await page.goto(baseUrl);
  if (authenticationStatus.required) {
    try {
      await page.getByLabel("Client name", { exact: true }).fill("Live streaming smoke");
      await page.getByLabel("Pairing URL or code", { exact: true }).fill(pairingCode);
      await page.getByRole("button", { name: "Pair connection", exact: true }).click();
      await page.locator(".desktop-sidebar").waitFor({ state: "visible" });
    } catch {
      // Playwright diagnostics may include fill arguments. Never expose the code.
      throw new Error("Smoke browser pairing failed. Generate a fresh management code for this server and try again.");
    }
  }
  await page
    .locator(".desktop-sidebar")
    .getByRole("button", { name: "New thread", exact: true })
    .click();
  const creation = page.getByRole("dialog", { name: "New thread" });
  const selectOption = async (name, option) => {
    await creation.getByRole("combobox", { name, exact: true }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
  };
  await selectOption("Environment", environmentLabel);
  await selectOption("Target", targetLabel);
  await selectOption("Project", projectLabel);
  await creation.getByRole("combobox", { name: "Agent" }).click();
  await page.getByRole("option", { name: /^Custom/ }).click();
  await creation.getByRole("button", { name: "Create thread" }).click();
  await page.waitForURL(/\/threads\/[0-9a-f-]+$/);
  const composer = page.getByRole("textbox", { name: /^Message / });
  await composer.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();

  const startedAt = Date.now();
  let screenshotIndex = 0;
  let lastSerialized = "";
  let stableCompletedPolls = 0;
  let sawStreamingAssistant = false;
  while (Date.now() - startedAt < 90_000) {
    const allowOnce = page.getByRole("button", { name: "Allow once" });
    if (await allowOnce.isVisible().catch(() => false)) {
      await allowOnce.click();
    }
    const state = await page.locator("body").evaluate((root) =>
      [...root.querySelectorAll("[data-item-id]")].map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          id: element.getAttribute("data-item-id"),
          kind: element.getAttribute("data-item-kind"),
          status: element.getAttribute("data-item-status"),
          top: Math.round(bounds.top),
          text: element.textContent?.replace(/\s+/g, " ").trim().slice(0, 4000),
        };
      }),
    );
    const userIndex = state.findIndex(({ kind }) => kind === "user_message");
    const operations = state.filter(({ kind }) => operationKinds.has(kind));
    assert.ok(operations.length <= 1, "the live tool split into multiple cards");
    if (operations.length > 0) {
      assert.ok(userIndex >= 0, "the tool appeared without its user message");
      assert.ok(
        state.indexOf(operations[0]) > userIndex,
        "the tool appeared before its user message",
      );
    }
    for (const item of operations) {
      assert.ok(item.status, "the command operation had no status");
    }
    if (
      state.some(
        ({ kind, status }) =>
          kind === "assistant_message" && status === "streaming",
      )
    ) {
      sawStreamingAssistant = true;
    }

    const serialized = JSON.stringify(state);
    if (serialized !== lastSerialized) {
      process.stdout.write(
        `${String(Date.now() - startedAt).padStart(5)}ms ${serialized}\n`,
      );
      lastSerialized = serialized;
      await page.screenshot({
        path: path.join(
          screenshotDirectory,
          `${String(screenshotIndex).padStart(3, "0")}.png`,
        ),
      });
      screenshotIndex += 1;
    }
    const stopVisible = await page
      .getByRole("button", { name: "Stop" })
      .isVisible()
      .catch(() => false);
    const completed =
      !stopVisible &&
      state.some(
        ({ kind, status }) =>
          kind === "assistant_message" && status === "completed",
      );
    stableCompletedPolls = completed ? stableCompletedPolls + 1 : 0;
    if (stableCompletedPolls >= 5) {
      break;
    }
    await page.waitForTimeout(150);
  }

  assert.ok(
    sawStreamingAssistant,
    "the assistant response never entered streaming state",
  );
  await page.reload();
  await page.locator("[data-item-kind='assistant_message']").last().waitFor();
  await page.getByRole("button", { name: /^Activity .*tool call/ }).click();
  await page
    .locator(
      [...operationKinds]
        .map((kind) => `[data-item-kind='${kind}']`)
        .join(", "),
    )
    .last()
    .waitFor({ state: "attached" });
  const finalState = await page.locator("body").evaluate((root) =>
    [...root.querySelectorAll("[data-item-id]")].map((element) => ({
      kind: element.getAttribute("data-item-kind"),
      status: element.getAttribute("data-item-status"),
    })),
  );
  const finalOperations = finalState.filter(({ kind }) =>
    operationKinds.has(kind),
  );
  assert.equal(finalOperations.length, 1, "expected one final tool card");
  assert.equal(finalOperations[0].status, "completed");
  assert.ok(
    finalState.some(
      ({ kind, status }) =>
        kind === "assistant_message" && status === "completed",
    ),
    "the assistant response did not complete",
  );
  process.stdout.write(`Thread: ${page.url()}\n`);
  process.stdout.write(`Screenshots: ${screenshotDirectory}\n`);
  process.stdout.write("Passed: streamed response with one retained command card\n");
} finally {
  await browser.close();
}
