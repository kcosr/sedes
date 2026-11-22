import { test, expect } from "./fixtures";
import { capture, fillAndPersistDraft, sendCurrentDraft, selectDeliveryMode, selectRadixOption } from "./helpers";
import { normalizedThreadSnapshotSchema } from "../../src/shared/protocol/conversation.js";

test("Antigravity production connection streams, stops, requests permission and reloads native history", async ({ page, request }, testInfo) => {
  const started = await request.post("/__e2e/antigravity");
  expect(started.ok(), await started.text()).toBe(true);
  const fixture = await started.json() as { origin: string; workspaceId: string; targetId: string };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(fixture.origin);
  await expect(page.getByTestId("desktop-sidebar")).toBeVisible();
  await page.getByTestId("desktop-sidebar").getByTestId("new-thread-trigger").click();
  await expect(page.getByRole("textbox", { name: "Thread name" })).toBeVisible();
  await page.getByRole("textbox", { name: "Thread name" }).fill("Antigravity native journey");
  const created = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/api/threads") && response.status() === 201);
  await page.getByRole("button", { name: "Create thread" }).click();
  const creation = await (await created).json() as { threadId: string };
  await expect(page).toHaveURL(new RegExp(`/threads/${creation.threadId}$`));
  const composer = page.getByRole("textbox", { name: "Message Antigravity" });
  await expect(composer).toBeVisible();
  const controls = page.getByTestId("composer").getByTestId("thread-configuration");
  await selectRadixOption(page, controls.getByRole("combobox", { name: "Model", exact: true }), "Fixture Alternate");
  await selectRadixOption(page, controls.locator('[data-setting-id="thinking_level"] [role="combobox"]'), "high");
  await expect(controls.getByRole("combobox", { name: "Model", exact: true })).toContainText("Fixture Alternate");
  await page.getByRole("button", { name: "Thread actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Antigravity mode", exact: true }).click();
  const modes = page.getByRole("menu", { name: "Antigravity mode" });
  await expect(modes.getByRole("menuitemradio", { name: "Auto", exact: true })).toBeDisabled();
  const modeSaved = page.waitForResponse(response => response.request().method() === "POST" && response.url().endsWith("/operations") && response.ok());
  await modes.getByRole("menuitemradio", { name: "Plan", exact: true }).click();
  await modeSaved;
  await page.reload();
  await expect(composer).toBeVisible();
  await page.getByRole("button", { name: "Thread actions", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Antigravity mode", exact: true })).toContainText("Plan");
  await page.keyboard.press("Escape");
  await fillAndPersistDraft(page, "wait", "Message Antigravity");
  await sendCurrentDraft(page);
  await expect(page.getByText("Streaming fixture-alt at high effort in plan mode.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await capture(page, testInfo, "antigravity-native-streaming.png");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
  await expect.poll(async () => {
    const stopped = normalizedThreadSnapshotSchema.parse(await (await page.request.get(`${fixture.origin}/api/threads/${creation.threadId}?activityDetail=full`)).json());
    return { runState: stopped.runState, recovery: stopped.recovery ?? null };
  }).toEqual({ runState: "idle", recovery: null });
  await expect(composer).toBeEnabled();

  await fillAndPersistDraft(page, "permission", "Message Antigravity");
  await sendCurrentDraft(page);
  const permission = page.getByRole("dialog", { name: "Read file", exact: true });
  await expect(permission).toBeVisible();
  await page.reload();
  await expect(permission).toHaveCount(1);
  await expect(permission).toBeVisible();
  await capture(page, testInfo, "antigravity-native-permission.png");
  await permission.getByRole("button", { name: "Allow", exact: true }).click();
  await expect(permission).toBeHidden();
  await expect(page.getByText("Permission allowed.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
  await capture(page, testInfo, "antigravity-native-completed.png");
  const settled = normalizedThreadSnapshotSchema.parse(await (await page.request.get(`${fixture.origin}/api/threads/${creation.threadId}?activityDetail=full`)).json());
  expect(settled.capabilities.backend.brand).toBe("antigravity");
  expect(settled.orderedTurnIds).toHaveLength(2);
  expect(settled.orderedTurnIds.map(id => settled.turnsById[id]!.status)).toEqual(["interrupted", "completed"]);
  await page.reload();
  await expect(page.getByText("Streaming fixture-alt at high effort in plan mode.", { exact: true })).toBeVisible();
  await expect(page.getByText("Permission allowed.", { exact: true })).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();

  // A steer can be dispatched while the provider is about to ask permission,
  // without reaching native history until that permission is answered.
  await fillAndPersistDraft(page, "permission after steer", "Message Antigravity");
  await sendCurrentDraft(page);
  await expect(page.getByText("Waiting for a steer before requesting permission.", { exact: true })).toBeVisible();
  await fillAndPersistDraft(page, "steer into permission", "Message Antigravity");
  await selectDeliveryMode(page, "Steer");
  await page.getByRole("button", { name: "Steer", exact: true }).click();
  await expect(permission).toBeVisible();
  const snapshot = async () => normalizedThreadSnapshotSchema.parse(
    await (await page.request.get(`${fixture.origin}/api/threads/${creation.threadId}?activityDetail=full`)).json());
  await expect.poll(async () => (await snapshot()).recovery?.kind).toBe("operation_uncertain");
  await expect(composer).toBeDisabled();
  await expect(permission.getByRole("button", { name: "Reject", exact: true })).toBeEnabled();
  await capture(page, testInfo, "antigravity-uncertain-steer-permission.png");
  await permission.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(permission).toBeHidden();
  await expect.poll(async () => {
    const value = await snapshot();
    return { runState: value.runState, lastTurn: value.turnsById[value.orderedTurnIds.at(-1)!]?.status,
      recovery: value.recovery?.kind, pendingPermissions: value.interactions.length };
  }).toEqual({ runState: "idle", lastTurn: "interrupted", recovery: "operation_uncertain", pendingPermissions: 0 });
  await expect(composer).toBeDisabled();
  await page.getByRole("button", { name: "Thread actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Force reset…", exact: true }).click();
  const reset = page.getByRole("dialog", { name: "Force reset Sedes state?", exact: true });
  await expect(reset.getByRole("button", { name: "Force reset", exact: true })).toBeEnabled();
  await reset.getByRole("button", { name: "Force reset", exact: true }).click();
  await expect(reset).toBeHidden();
  await expect.poll(async () => {
    const value = await snapshot();
    return { runState: value.runState, recovery: value.recovery ?? null };
  }).toEqual({ runState: "idle", recovery: null });
  await expect(composer).toBeEnabled();
  await fillAndPersistDraft(page, "continue after reset", "Message Antigravity");
  await sendCurrentDraft(page);
  await expect(page.getByText("Fixture response.", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const value = await snapshot();
    return value.orderedTurnIds.map(id => value.turnsById[id]!.status);
  }).toEqual(["interrupted", "completed", "interrupted", "completed"]);
  await page.reload();
  await expect(composer).toBeEnabled();
  await expect(page.getByText("Fixture response.", { exact: true })).toBeVisible();
  await capture(page, testInfo, "antigravity-reset-recovered.png");
});
