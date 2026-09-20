import { normalizedThreadSnapshotSchema } from "../../src/shared/protocol/conversation.js";
import { expect, test } from "./fixtures.js";
import {
  capture,
  openSedesWorkspace,
  selectCustomNewThreadTarget,
} from "./helpers.js";
import { exerciseClaudeParityCoverage } from "./claude-parity-coverage.js";

test("compiled Claude backend streams, settles, and reloads through normalized UI", async ({
  page,
}, testInfo) => {
  await openSedesWorkspace(page);

  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/threads") &&
      response.status() === 201,
  );
  await page
    .getByTestId("desktop-sidebar")
    .getByTestId("new-thread-trigger")
    .click();
  await page
    .getByRole("textbox", { name: "Thread name" })
    .fill("Claude browser integration");
  await selectCustomNewThreadTarget(page, "Claude subscription · Claude");
  await page.getByRole("button", { name: "Create thread" }).click();
  await created;
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);

  const threadPath = new URL(page.url()).pathname;
  const composer = page.getByTestId("composer");
  const configuration = composer.getByTestId("thread-configuration");
  await expect(
    configuration.getByRole("combobox", { name: "Model" }),
  ).toContainText("Claude Sonnet 5");
  await expect(
    configuration.getByRole("combobox", { name: /Reasoning|Effort/ }),
  ).toContainText(/low/i);
  await expect(configuration.getByRole("combobox")).toHaveCount(2);

  const initialSnapshotResponse = await page.request.get(
    `/api${threadPath}?activityDetail=full`,
  );
  expect(initialSnapshotResponse.ok()).toBe(true);
  const initialSnapshot = normalizedThreadSnapshotSchema.parse(
    await initialSnapshotResponse.json(),
  );
  expect(initialSnapshot.capabilities.backend).toMatchObject({
    brand: "claude",
    modelLabel: { text: "Claude Sonnet 5" },
  });
  expect(initialSnapshot.capabilities.settings.map(({ id }) => id)).toEqual([
    "model",
    "thinking_level",
  ]);
  expect(initialSnapshot.capabilities.providerFeatures).toEqual([
    expect.objectContaining({
      ref: { featureId: "claude.permissions", schemaVersion: 1 },
      availability: "available",
    }),
  ]);
  const initialOperationIds = initialSnapshot.capabilities.operations.map(
    ({ id }) => id,
  );
  expect(initialOperationIds).not.toContain("clone");
  expect(initialOperationIds).not.toContain("compact");
  const initialDeliveryModes = initialSnapshot.capabilities.deliveryModes.map(
    ({ id }) => id,
  );
  expect(initialDeliveryModes).toContain("submit");
  expect(initialDeliveryModes).not.toContain("steer"); // Still an unbound draft.

  await page.getByRole("button", { name: "Thread actions" }).click();
  const threadControls = page.getByRole("dialog", { name: "Thread actions" });
  await expect(
    threadControls.getByRole("button", { name: "Compact context" }),
  ).toHaveCount(0);
  await expect(
    threadControls.getByText(/Claude execution settings/i),
  ).toHaveCount(0);
  const permissionMode = threadControls.getByRole("combobox", {
    name: "Permission mode",
  });
  await expect(permissionMode).toContainText("Default");
  await expect(threadControls.getByText("Claude permissions")).toBeVisible();
  await expect(
    threadControls.getByText(/Fast mode|provider feature|tool access/i),
  ).toHaveCount(0);

  await page.keyboard.press("Escape");

  const prompt = "Exercise the Claude browser integration";
  await page.getByRole("textbox", { name: /Message Claude/ }).fill(prompt);
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/operations") &&
      response.ok(),
  );
  await page.getByRole("button", { name: "Send message" }).click();
  await accepted;
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  const permission = page.getByRole("dialog", {
    name: "Run fixture command?",
  });
  await expect(permission).toBeVisible();
  await expect(permission.getByTestId("interaction-prompt-code")).toContainText(
    "npm run typecheck",
  );
  const allowOnce = permission.getByTestId("decision-primary-action");
  await expect(allowOnce).toContainText("Allow once");
  await permission.getByTestId("decision-primary-menu").click();
  await capture(page, testInfo, "claude-permission-session-grant.png");
  await page
    .getByRole("menuitem", { name: "Allow for Claude session" })
    .click();
  await expect(permission).toHaveCount(0);
  const guarded = page.getByRole("dialog", { name: "Run guarded fixture command?", exact: true });
  await expect(guarded).toBeVisible();
  const guardedDeny = guarded.getByRole("button", { name: "Deny", exact: true });
  await expect(guardedDeny).toHaveCount(1);
  await expect(guardedDeny).toBeFocused();
  await expect(guarded.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
  await expect(guarded.getByTestId("decision-primary-action")).toHaveCount(0);
  await expect(guarded.getByTestId("decision-primary-menu")).toHaveCount(0);
  await expect(guarded.getByText("Allow for Claude session", { exact: true })).toHaveCount(0);
  await capture(page, testInfo, "claude-permission-default-deny.png");
  // Enter must activate the focused Deny, never the old primary approval.
  await page.keyboard.press("Enter");
  await expect(guarded).toHaveCount(0);
  const nextGuarded = page.getByRole("dialog", { name: "Run another guarded fixture command?", exact: true });
  await expect(nextGuarded).toBeVisible();
  await expect(nextGuarded.getByRole("button", { name: "Deny", exact: true })).toBeFocused();
  await expect(nextGuarded.getByTestId("decision-primary-menu")).toHaveCount(0);
  await expect(nextGuarded.getByText("Allow for Claude session", { exact: true })).toHaveCount(0);
  await nextGuarded.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect(nextGuarded).toHaveCount(0);
  await expect(
    page.getByText("Claude is streaming through the normalized browser UI…", {
      exact: true,
    }),
  ).toBeVisible();
  await capture(page, testInfo, "claude-normalized-streaming.png");

  const completedText =
    "Claude completed this offline subscription-backed browser fixture.";
  await expect(page.getByText(completedText, { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Send message" }),
  ).toBeVisible();
  await expect(page.getByText(prompt, { exact: true })).toBeVisible();

  // Native conversation steering joins active work without an exact-turn request.
  await page.getByRole("textbox", { name: /Message Claude/ }).fill("Exercise Claude Steer");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: /Message Claude/ }).fill("Use the revised Claude approach");
  const steerRequest = page.waitForRequest(request => request.method() === "POST" &&
    request.url().endsWith("/operations") && request.postDataJSON()?.mode === "steer");
  await capture(page, testInfo, "claude-steer-active.png");
  await page.getByRole("button", { name: "Steer", exact: true }).click();
  expect((await steerRequest).postDataJSON().steerTarget).toEqual({ kind: "conversation" });
  await expect(page.getByText("Claude incorporated the revised approach.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Use the revised Claude approach", { exact: true })).toHaveCount(1);
  await expect(page.getByText("Claude incorporated the revised approach.", { exact: true })).toHaveCount(1);

  // The parent is ready for ordinary input while the child remains alive.
  const input = page.getByRole("textbox", { name: /Message Claude/ });
  await input.fill("Start background fixture");
  await page.getByRole("button", { name: "Send message" }).click();
  const backgroundActivity = page.getByTestId("background-activity-status");
  await expect(backgroundActivity).toContainText("Waiting for subagent");
  await expect(backgroundActivity).toContainText("Sleep 20 seconds test");
  const startedAgent = page.getByLabel("Collaboration activity").filter({ hasText: "Started subagent · Sleep 20 seconds test" });
  await expect(startedAgent).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  const pulse = backgroundActivity.locator(".reasoning-summary-status-dot");
  await expect.poll(() => pulse.evaluate((element) => getComputedStyle(element, "::after").animationName)).toBe("reasoning-summary-status-pulse");
  await expect.poll(() => pulse.evaluate((element) => getComputedStyle(element).animationName)).toBe("background-activity-dot-pulse");
  // Check visible changes in the core, not just a declared animation name.
  const pulseFrames = await pulse.evaluate((element) => {
    const animation = element.getAnimations().find(candidate =>
      candidate instanceof CSSAnimation && candidate.animationName === "background-activity-dot-pulse")!;
    animation.pause();
    animation.currentTime = 0;
    const bright = { opacity: Number(getComputedStyle(element).opacity), transform: getComputedStyle(element).transform };
    animation.currentTime = 750;
    const dim = { opacity: Number(getComputedStyle(element).opacity), transform: getComputedStyle(element).transform };
    animation.play();
    return { bright, dim };
  });
  expect(pulseFrames.bright.opacity - pulseFrames.dim.opacity).toBeGreaterThan(0.5);
  expect(pulseFrames.bright.transform).not.toBe(pulseFrames.dim.transform);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => pulse.evaluate((element) => getComputedStyle(element, "::after").animationName)).toBe("none");
  await expect.poll(() => pulse.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
  await expect.poll(() => pulse.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await expect.poll(() => pulse.evaluate((element) => getComputedStyle(element, "::after").animationName)).toBe("reasoning-summary-status-pulse");
  await capture(page, testInfo, "claude-background-waiting.png");
  const desktopViewport = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(backgroundActivity).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await capture(page, testInfo, "claude-background-waiting-mobile.png");
  await page.setViewportSize(desktopViewport);

  await input.fill("Complete the background fixture");
  const backgroundFollowup = page.waitForResponse((response) =>
    response.request().method() === "POST" && response.url().endsWith("/operations"),
  );
  await page.getByRole("button", { name: "Send message" }).click();
  const backgroundFollowupResponse = await backgroundFollowup;
  expect(backgroundFollowupResponse.status()).toBe(200);
  expect(await backgroundFollowupResponse.json()).toMatchObject({ resolvedDeliveryMode: "submit" });
  await expect(backgroundActivity).toHaveCount(0);
  const completedAgent = page.getByLabel("Collaboration activity").filter({ hasText: "Subagent completed" });
  await expect(completedAgent).toHaveCount(1);
  await expect(completedAgent).toContainText("Sleep 20 seconds test");
  await expect(startedAgent).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await capture(page, testInfo, "claude-background-completed.png");

  await page.getByRole("button", { name: "Thread actions" }).click();
  await expect(permissionMode).toContainText("Default");
  const permissionChanged = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/operations") &&
      response.ok(),
  );
  await permissionMode.click();
  await page.getByRole("option", { name: "Don't ask" }).click();
  await permissionChanged;
  await expect(permissionMode).toContainText("Don't ask");
  await page.keyboard.press("Escape");

  await page.reload();
  await expect(page).toHaveURL(threadPath);
  await expect(page.getByText(prompt, { exact: true })).toBeVisible();
  await expect(page.getByText(completedText, { exact: true }).first()).toBeVisible();
  await expect(backgroundActivity).toHaveCount(0);
  await expect(completedAgent).toHaveCount(1);
  await expect(completedAgent).toContainText("Sleep 20 seconds test");
  await expect(startedAgent).toHaveCount(1);
  await expect(
    page.getByTestId("composer").getByRole("combobox", { name: "Model" }),
  ).toContainText("Claude Sonnet 5");
  await page.getByRole("button", { name: "Thread actions" }).click();
  await expect(
    page
      .getByRole("dialog", { name: "Thread actions" })
      .getByRole("combobox", { name: "Permission mode" }),
  ).toContainText("Don't ask");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Compact context" }),
  ).toHaveCount(0);

  const restoredSnapshotResponse = await page.request.get(
    `/api${threadPath}?activityDetail=full`,
  );
  expect(restoredSnapshotResponse.ok()).toBe(true);
  const restoredSnapshot = normalizedThreadSnapshotSchema.parse(
    await restoredSnapshotResponse.json(),
  );
  expect(restoredSnapshot.capabilities.backend.brand).toBe("claude");
  expect(restoredSnapshot.capabilities.providerFeatures).toEqual([
    expect.objectContaining({
      ref: { featureId: "claude.permissions", schemaVersion: 1 },
      availability: "available",
    }),
  ]);
  expect(restoredSnapshot.providerFeatures).toEqual([
    expect.objectContaining({
      ref: { featureId: "claude.permissions", schemaVersion: 1 },
      state: expect.objectContaining({ kind: "object" }),
    }),
  ]);
  const restoredDeliveryModes = restoredSnapshot.capabilities.deliveryModes.map(
    ({ id }) => id,
  );
  expect(restoredDeliveryModes).toContain("submit");
  expect(restoredDeliveryModes).toContain("steer");
  expect(restoredSnapshot.capabilities.deliveryModes.find(mode => mode.id === "steer")?.steerTarget).toBe("conversation");
  const restoredOperationIds = restoredSnapshot.capabilities.operations.map(
    ({ id }) => id,
  );
  expect(restoredOperationIds).not.toContain("clone");
  expect(restoredOperationIds).not.toContain("compact");

  await input.fill("Exercise Claude Stop");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await capture(page, testInfo, "claude-stop-working.png");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(page.getByText("[Request interrupted by user for tool use]", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(page.getByText("[Request interrupted by user for tool use]", { exact: true })).toHaveCount(0);
  await capture(page, testInfo, "claude-stop-restored.png");
});

test("Claude sends native images and restores semantic tool activity", async ({
  page,
  browserDiagnostics,
}, testInfo) =>
  exerciseClaudeParityCoverage({ page, browserDiagnostics }, testInfo));
