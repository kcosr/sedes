import type { CDPSession, Locator } from "@playwright/test";
import { normalizedApplicationSessionSchema, normalizedApplicationSnapshotSchema, savedAgentMutationResultSchema, savedAgentOptionsResultSchema } from "../../src/shared/index.js";
import { test, expect } from "./fixtures";
import { capture, openSedesWorkspace, repositoryLabel } from "./helpers";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

async function swipeUp(cdp: CDPSession, list: Locator): Promise<void> {
  const box = await list.boundingBox();
  if (!box) throw new Error("Picker list is not visible");
  const x = box.x + box.width / 2;
  const start = box.y + box.height - 12;
  const end = box.y + 12;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y: start }] });
  for (let step = 1; step <= 12; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove", touchPoints: [{ x, y: start + (end - start) * step / 12 }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

test("mobile search choices open without typing and scroll inside a modal above the keyboard", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSedesWorkspace(page);
  const session = normalizedApplicationSessionSchema.parse(await (await page.request.get("/api/application/session")).json());
  const snapshot = normalizedApplicationSnapshotSchema.parse(await (await page.request.get("/api/application/snapshot")).json());
  const workspace = snapshot.workspaces.find(entry => entry.available && entry.label.text === repositoryLabel)!;
  const target = snapshot.executionTargets.find(entry => entry.available && entry.backend.brand === "pi" && entry.environmentId === workspace.environmentId)!;
  const headers = { "X-CSRF-Token": session.csrfToken };
  const optionsResponse = await page.request.post("/api/agents/options", {
    headers, data: { workspaceId: workspace.id, targetId: target.id },
  });
  expect(optionsResponse.ok()).toBe(true);
  const options = savedAgentOptionsResultSchema.parse(await optionsResponse.json());
  if (options.kind !== "configuration") throw new Error("Agent configuration unavailable");
  const model = options.configuration.fields.find(field => field.id === "model")!.options.find(option => option.available)!;
  const agentResponse = await page.request.post("/api/agents", {
    headers,
    data: { name: "Mobile browsing", authoringContext: { workspaceId: workspace.id, targetId: target.id }, backendOverrides: [{ id: "model", value: model.value }, { id: "thinking_level", value: "high" }, { id: "tool_access", value: "ask" }] },
  });
  expect(agentResponse.status(), await agentResponse.text()).toBe(201);
  const { agent } = savedAgentMutationResultSchema.parse(await agentResponse.json());
  // A modest catalog that actually overflows the mobile list, using real saved templates.
  for (let index = 0; index < 16; index++) {
    const response = await page.request.post("/api/thread-templates", {
      headers,
      data: { name: `Mobile template ${String(index).padStart(2, "0")}`, workspaceId: workspace.id, targetId: target.id, executionWorkspace: { kind: "direct" }, agentId: agent.id },
    });
    expect(response.status(), await response.text()).toBe(201);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "New thread", exact: true }).last().tap();
  const sheet = page.getByRole("dialog", { name: "New thread", exact: true });
  const trigger = sheet.getByRole("combobox", { name: "Template", exact: true });
  await expect(trigger).toBeEnabled();
  await trigger.tap();
  const search = page.getByRole("combobox", { name: "Search templates", exact: true });
  const list = page.getByRole("listbox", { name: "Template options" });
  await expect(search).not.toBeFocused();
  await expect(sheet.getByRole("listbox", { name: "Template options" })).toBeVisible();
  await expect.poll(() => list.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  const cdp = await page.context().newCDPSession(page);
  await swipeUp(cdp, list);
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(20);
  await capture(page, testInfo, "mobile-template-browsing.png");
  await search.tap();
  await expect(search).toBeFocused();
  // Desktop Chromium cannot show a soft keyboard; simulate its visual-only viewport shrink.
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, "height", { configurable: true, value: window.innerHeight - 300 });
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await expect.poll(async () => {
    const box = await sheet.boundingBox();
    return box ? Math.round(box.y + box.height) : 0;
  }).toBe(544);
  await search.fill("Mobile template");
  await expect(page.getByRole("option", { name: /Mobile template 00/ })).toBeInViewport();
  await expect.poll(async () => {
    const box = await list.boundingBox();
    return box ? box.y + box.height : Infinity;
  }).toBeLessThanOrEqual(544);
  const beforeKeyboardSwipe = await list.evaluate(element => element.scrollTop);
  await swipeUp(cdp, list);
  await expect.poll(() => list.evaluate(element => element.scrollTop)).toBeGreaterThan(beforeKeyboardSwipe + 20);
  await capture(page, testInfo, "mobile-template-search-keyboard-space.png");
  await search.press("Escape");
  await expect(trigger).toBeFocused();
  await expect(sheet).toBeVisible();
  await page.evaluate(() => {
    Reflect.deleteProperty(window.visualViewport!, "height");
    window.visualViewport!.dispatchEvent(new Event("resize"));
  });
  await trigger.press("ArrowDown");
  await expect(search).toBeFocused();
  await search.fill("Mobile template 15");
  await page.getByRole("option", { name: /Mobile template 15/ }).tap();
  await expect(trigger).toContainText("Mobile template 15");
  await expect(sheet.getByRole("combobox", { name: "Agent", exact: true })).toContainText("Mobile browsing");
});
