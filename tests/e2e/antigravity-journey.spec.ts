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
  const effort = controls.locator('[data-setting-id="thinking_level"] [role="combobox"]');
  await selectRadixOption(page, effort, "Extra High");
  await expect(effort).toContainText("Extra High");
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
  await expect(page.getByText("Streaming fixture-alt at xhigh effort in plan mode.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Antigravity native journey", exact: true }).click();
  const title = page.getByRole("textbox", { name: "Thread title", exact: true });
  await title.fill("My Antigravity thread");
  const renamed = page.waitForResponse(response => response.request().method() === "POST" &&
    response.url().endsWith("/operations") && response.request().postDataJSON().operation?.action === "rename");
  await title.press("Enter");
  const renameResponse = await renamed;
  expect(renameResponse.ok(), await renameResponse.text()).toBe(true);
  const renameInput = renameResponse.request().postDataJSON();
  const operationUrl = `${fixture.origin}/api/threads/${creation.threadId}/operations`;
  const headers = { "X-CSRF-Token": (await renameResponse.request().headerValue("X-CSRF-Token"))! };
  const replay = await page.request.post(operationUrl, { data: renameInput, headers });
  expect(replay.ok(), await replay.text()).toBe(true);
  expect(await replay.json()).toEqual(await renameResponse.json());
  const collision = await page.request.post(operationUrl, {
    headers,
    data: { ...renameInput, operation: { action: "rename", title: "Conflicting replay" } },
  });
  expect(collision.status()).toBe(409);
  await expect(page.getByRole("heading", { name: "My Antigravity thread", exact: true })).toBeVisible();
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
  await expect(page.getByText("Streaming fixture-alt at xhigh effort in plan mode.", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "My Antigravity thread", exact: true })).toBeVisible();
  await expect(page.getByText("Permission allowed.", { exact: true })).toBeVisible();
  await expect(composer).toBeEnabled();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();

  // A steer can be dispatched while the provider is about to ask permission,
  // without reaching native history until that permission is answered.
  await fillAndPersistDraft(page, "permission after steer", "Message Antigravity");
  await sendCurrentDraft(page);
  await expect(page.getByText("Waiting for a steer before requesting permission.", { exact: true })).toBeVisible();
  const steerText = "steer into permission";
  await fillAndPersistDraft(page, steerText, "Message Antigravity");
  await selectDeliveryMode(page, "Steer");
  await page.getByRole("button", { name: "Steer", exact: true }).click();
  await expect(permission).toBeVisible();
  const snapshot = async () => normalizedThreadSnapshotSchema.parse(
    await (await page.request.get(`${fixture.origin}/api/threads/${creation.threadId}?activityDetail=full`)).json());
  await expect.poll(async () => {
    const value = await snapshot();
    return {
      recovery: value.recovery?.kind,
      canInterrupt: value.capabilities.operations.find(({ id }) => id === "interrupt")?.available,
    };
  }).toEqual({ recovery: "operation_uncertain", canInterrupt: true });
  await expect(composer).toBeDisabled();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  await expect(permission.getByRole("button", { name: "Reject", exact: true })).toBeEnabled();
  await capture(page, testInfo, "antigravity-uncertain-steer-permission.png");

  const [queuedSteer] = (await snapshot()).queue;
  expect(queuedSteer).toMatchObject({ state: "uncertain", resolvedDeliveryMode: "steer", preview: { text: steerText } });
  const reconcile = page.getByRole("button", { name: "Reconcile operation", exact: true });
  const reconciled = page.waitForResponse(response =>
    response.url().endsWith(`/api/threads/${creation.threadId}/operations`) &&
    response.request().method() === "POST" &&
    response.request().postDataJSON().kind === "recover_uncertain");
  await expect(reconcile).toBeEnabled();
  await reconcile.click();
  const recoveryResponse = await reconciled;
  expect(recoveryResponse.ok()).toBe(true);
  expect(await recoveryResponse.json()).toMatchObject({
    status: "queue_steer_recovery_required",
    queuedInputId: queuedSteer!.id,
    operationId: queuedSteer!.deliveryOperationId,
  });
  await expect(composer).toBeDisabled();
  await permission.getByRole("button", { name: "Reject", exact: true }).click();
  await expect(permission).toBeHidden();

  await expect.poll(async () => {
    const value = await snapshot();
    return {
      runState: value.runState,
      recovery: value.recovery ?? null,
      pendingPermissions: value.interactions.length,
      turnStatuses: value.orderedTurnIds.map(id => value.turnsById[id]!.status),
      queue: value.queue.map(({ id, deliveryOperationId, state, preview }) => ({
        id, deliveryOperationId, state, text: preview.text,
      })),
    };
  }).toEqual({
    runState: "idle",
    recovery: null,
    pendingPermissions: 0,
    turnStatuses: ["interrupted", "completed", "interrupted"],
    queue: [{
      id: queuedSteer!.id,
      deliveryOperationId: queuedSteer!.deliveryOperationId,
      state: "failed",
      text: steerText,
    }],
  });
  await expect(reconcile).toBeHidden();
  const pendingSteer = page.getByRole("region", { name: "Pending inputs" })
    .getByRole("listitem").filter({ hasText: steerText });
  await expect(pendingSteer).toContainText("Not sent");
  await expect(pendingSteer).toContainText("Antigravity withdrew this input when the execution was cancelled.");
  await pendingSteer.getByRole("button", { name: `Restore queued input to composer: ${steerText}` }).click();
  await expect(pendingSteer).toBeHidden();
  await expect(page.getByText("Steer unconfirmed", { exact: true })).toBeHidden();
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue(steerText);
  await sendCurrentDraft(page);
  await expect(page.getByText("Fixture response.", { exact: true })).toBeVisible();
  await expect.poll(async () => {
    const value = await snapshot();
    return value.orderedTurnIds.map(id => value.turnsById[id]!.status);
  }).toEqual(["interrupted", "completed", "interrupted", "completed"]);
  await page.reload();
  await expect(composer).toBeEnabled();
  await expect(page.getByText("Fixture response.", { exact: true })).toBeVisible();
  await expect(page.getByText(steerText, { exact: true })).toHaveCount(1);
  await capture(page, testInfo, "antigravity-reconciled.png");
});
