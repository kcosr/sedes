import { test, expect } from "./fixtures";
import { capture, fillAndPersistDraft, sendCurrentDraft, selectDeliveryMode, selectRadixOption, expectNoPageOverflow } from "./helpers";
import { configurationLifecycleResultSchema, configurationSnapshotSchema } from "../../src/shared/protocol/configuration-admin.js";
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
  await expect(composer).toHaveText(steerText);
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


test("Settings records verified retirement for one disabled local Antigravity candidate", async ({ page }, testInfo) => {
  const { AntigravityProductionFixture } = await import("../support/antigravity-production-fixture.js");
  const fixture = await AntigravityProductionFixture.create({ emptyLocalEnvironment: true });
  try {
    const { environmentId, environmentLabel, candidates } = await fixture.seedLocalRetirementCandidates();
    const first = candidates[0]!;
    const second = candidates[1]!;
    const origin = fixture.url;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${origin}/settings/backends/${first.id}`);
    const detail = page.getByRole("region", { name: `${first.label} details`, exact: true });
    const action = detail.getByRole("button", { name: "Confirm retirement", exact: true });
    const dialog = page.getByRole("dialog", { name: `Confirm retirement of ${first.label}?`, exact: true });
    await action.click();
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
    await expect(dialog).toContainText(environmentLabel);
    await expect(dialog).toContainText(environmentId);
    await expect(dialog).toContainText(first.id);
    await expect(dialog).not.toContainText(second.id);
    await expect(dialog.getByRole("button", { name: "I verified the processes have stopped" })).toBeInViewport();
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "antigravity-confirm-local-retirement-mobile.png");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    const read = async () => configurationSnapshotSchema.parse(await (await page.request.get(origin + "/api/configuration")).json());
    expect((await read()).runtimes.find(r => r.resourceId === first.id)?.supportedActions).toEqual(["confirm_retirement"]);
    await action.click();
    const response = page.waitForResponse(value => value.url() === origin + "/api/configuration/lifecycle" && value.request().method() === "POST");
    await dialog.getByRole("button", { name: "I verified the processes have stopped" }).click();
    const executed = await response;
    expect(executed.request().postDataJSON()).toMatchObject({ resourceId: first.id, action: "confirm_retirement", impactToken: expect.any(String) });
    expect(configurationLifecycleResultSchema.parse(await executed.json()).state).toBe("applied");
    await expect(action).toHaveCount(0);
    const after = await read();
    for (const candidate of candidates) expect(after.configuration.backends.find(b => b.id === candidate.id)?.enabled).toBe(false);
    expect(after.runtimes.find(r => r.resourceId === first.id)?.supportedActions).not.toContain("confirm_retirement");
    expect(after.runtimes.find(r => r.resourceId === second.id)?.supportedActions).toEqual(["confirm_retirement"]);
  } finally {
    try { await page.goto("about:blank"); }
    finally { await fixture.close(); }
  }
});

test("desktop and mobile sidebar actions preserve the running thread while updating an unopened thread", async ({ page, browserDiagnostics }, testInfo) => {
  test.slow();
  const { AntigravityProductionFixture } = await import("../support/antigravity-production-fixture.js");
  const fixture = await AntigravityProductionFixture.create();
  try {
    const selected = await fixture.createThread({ title: "Still running" });
    await fixture.send(selected, "wait");
    const selectedUrl = `${fixture.url}/threads/${selected}`;
    await page.goto(selectedUrl);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    const navigated: string[] = [];
    page.on("framenavigated", frame => {
      if (frame === page.mainFrame()) navigated.push(frame.url());
    });

    for (const mobile of [false, true]) {
      const surface = mobile ? "mobile" : "desktop";
      const initialTitle = `Unopened ${surface}`;
      const desiredTitle = `Renamed from ${surface}`;
      const target = await fixture.createThread({ title: initialTitle });
      if (!mobile) {
        await fixture.send(target, "hello");
        await expect.poll(async () => (await fixture.thread(target)).orderedTurnIds.length).toBe(1);
        await expect.poll(async () => (await fixture.thread(target)).runState).toBe("idle");
      }
      await page.setViewportSize(mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 });
      const drawer = page.getByRole("dialog", { name: "Thread navigation" });
      if (mobile) await page.getByRole("button", { name: "Open thread navigation" }).click();
      const sidebar = mobile ? drawer : page.getByTestId("desktop-sidebar");
      const row = sidebar.locator(`[data-thread-id="${target}"]`).getByTestId(/^(flat-thread-row|thread-row)$/).first();
      await expect(row).toContainText(initialTitle);
      const touch = mobile ? await page.context().newCDPSession(page) : undefined;
      if (touch) await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true });
      const openMenu = async () => {
        if (!touch) {
          await row.click({ button: "right" });
          return page.getByTestId("thread-context-menu");
        }
        const bounds = await row.boundingBox();
        if (!bounds) throw new Error("Sidebar target is outside the drawer.");
        const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
        await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
        const menu = page.getByTestId("thread-actions-sheet");
        await expect(menu).toBeVisible();
        await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await expect(menu).toBeVisible();
        return menu;
      };

      const requests: unknown[] = [];
      const acknowledgements: string[] = [];
      page.on("request", request => {
        if (request.url() === `${fixture.url}/api/threads/${target}/attention/dismiss`) {
          acknowledgements.push(request.postDataJSON().kind);
        }
      });
      const renameUrl = `${fixture.url}/api/threads/${target}/operations`;
      await page.route(renameUrl, async route => {
        requests.push(route.request().postDataJSON());
        if (mobile && requests.length === 1) {
          // The server commits and sends its receipt before the browser loses it.
          const response = await route.fetch();
          expect(response.ok(), await response.text()).toBe(true);
          browserDiagnostics.allowNetworkFailures = true;
          await route.abort("failed");
        } else await route.continue();
      });
      const menu = await openMenu();
      if (!mobile) await capture(page, testInfo, "background-thread-actions-desktop.png");
      await menu.getByRole("menuitem", { name: "Rename", exact: true }).click();
      const editor = sidebar.getByRole("textbox", { name: "Thread title" });
      await editor.fill(desiredTitle);
      const lostReply = mobile ? page.waitForEvent("requestfailed", request => request.url() === renameUrl) : undefined;
      await editor.press("Enter");
      if (mobile) {
        expect((await lostReply)!.failure()?.errorText).toContain("ERR_FAILED");
        await expect(sidebar.getByRole("button", { name: "Check rename status" })).toBeVisible();
        browserDiagnostics.allowNetworkFailures = false;
        await capture(page, testInfo, "background-thread-actions-mobile.png");
        await page.getByRole("button", { name: "Close thread navigation" }).click();
        await page.getByRole("button", { name: "Open thread navigation" }).click();
        await expect(editor).toHaveValue(desiredTitle);
        await expect(editor).not.toBeEditable();
        await sidebar.getByRole("button", { name: "Dismiss", exact: true }).click();
        await expect(editor).toBeHidden();
        await expect(row.getByTestId("thread-row-link")).toBeVisible();
        const reopened = await openMenu();
        await expect(reopened.getByRole("menuitem", { name: "Archive", exact: true })).toBeEnabled();
        await reopened.getByRole("menuitem", { name: "Rename", exact: true }).click();
        await expect(editor).toHaveValue(desiredTitle);
        await expect(editor).not.toBeEditable();
        await sidebar.getByRole("button", { name: "Check rename status" }).click();
      }
      await expect(editor).toBeHidden();
      await expect(row).toContainText(desiredTitle);
      expect(requests).toHaveLength(mobile ? 2 : 1);
      if (mobile) expect(requests[1]).toEqual(requests[0]);
      expect(requests[0]).toMatchObject({ kind: "perform", operation: { action: "rename", title: desiredTitle } });
      await page.unroute(renameUrl);

      const archived = page.waitForResponse(response =>
        response.request().method() === "PATCH" && response.url() === `${fixture.url}/api/threads/${target}/inventory`);
      await (await openMenu()).getByRole("menuitem", { name: "Archive", exact: true }).click();
      const response = await archived;
      expect(response.ok(), await response.text()).toBe(true);
      expect(response.request().postDataJSON()).toMatchObject({ action: "archive", expectedPendingQuestionCount: 0 });
      expect(await response.json()).toEqual({ archivedThreadIds: [target] });
      await expect(row).toBeHidden();
      await expect(page).toHaveURL(selectedUrl);
      if (mobile) await page.getByRole("button", { name: "Close thread navigation" }).click();
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      expect(acknowledgements).not.toContain("unseen_completion");
      await touch?.detach();
    }
    expect(navigated.filter(url => url !== selectedUrl)).toEqual([]);
  } finally {
    try { await page.goto("about:blank"); }
    finally { await fixture.close(); }
  }
});
