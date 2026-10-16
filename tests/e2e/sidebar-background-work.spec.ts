import { randomUUID } from "node:crypto";
import { expect, test } from "./fixtures.js";
import { capture, createDraftThread, expectNoPageOverflow, openSedesWorkspace, selectCustomNewThreadTarget } from "./helpers.js";
import { normalizedApplicationSnapshotSchema, taskMutationResultSchema } from "../../src/shared/index.js";

test("sidebar open-task filter shares menu and toolbar state across views and live task updates", async ({ page }, testInfo) => {
  await openSedesWorkspace(page);
  const openPath = await createDraftThread(page, "Sidebar open task work");
  const threadId = openPath.split("/").at(-1)!;
  await createDraftThread(page, "Sidebar plain work");
  const session = await (await page.request.get("/api/application/session")).json();
  const headers = { "X-CSRF-Token": session.csrfToken };
  const created = await page.request.post("/api/tasks", {
    headers,
    data: { mutationId: randomUUID(), title: "Direct sidebar task", scope: { kind: "thread", threadId } },
  });
  expect(created.status()).toBe(201);
  let task = taskMutationResultSchema.parse(await created.json()).task;
  expect((await page.request.post("/api/tasks", {
    headers,
    data: { mutationId: randomUUID(), title: "Global sidebar task", scope: { kind: "global" } },
  })).status()).toBe(201);
  const sidebar = page.getByTestId("desktop-sidebar");
  // The modal View options menu hides its background from the accessibility
  // tree; inspect the same toolbar control's saved state while it is open.
  const toggle = sidebar.getByTestId("view-tasks-toggle");
  await expect(toggle).toHaveAccessibleName("Has open tasks");
  const openRow = sidebar.locator(`[data-thread-id="${threadId}"]`);
  const plainRow = sidebar.getByText("Sidebar plain work", { exact: true });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(openRow).toBeVisible();
  await expect(plainRow).toHaveCount(0);
  await sidebar.getByTestId("view-options-trigger").click();
  const checkbox = page.getByRole("menuitemcheckbox", { name: "Has open tasks", exact: true });
  await expect(checkbox).toHaveAttribute("aria-checked", "true");
  await checkbox.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(plainRow).toBeVisible();
  await checkbox.click();
  await page.keyboard.press("Escape");
  for (const view of ["Timeline", "State", "Flat list", "Projects"]) {
    await sidebar.getByTestId("view-options-trigger").click();
    await page.getByRole("group", { name: "Group by", exact: true })
      .getByRole("menuitemradio", { name: view, exact: true }).click();
    await expect(openRow).toBeVisible();
    await expect(plainRow).toHaveCount(0);
  }
  await page.evaluate(() => localStorage.setItem("sedes-sidebar-width", "220"));
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(openRow).toBeVisible();
  await expect(plainRow).toHaveCount(0);
  const sidebarBox = await sidebar.boundingBox();
  const toggleBox = await toggle.boundingBox();
  expect(sidebarBox!.width).toBe(220);
  expect(await sidebar.locator(".sidebar-search-row button").evaluateAll((buttons) =>
    buttons.map((button) => (button as HTMLElement).dataset.testid),
  )).toEqual(["view-quick-toggle", "view-options-trigger", "view-tasks-toggle"]);
  expect(toggleBox!.x + toggleBox!.width).toBeLessThanOrEqual(sidebarBox!.x + sidebarBox!.width);
  expect((await sidebar.getByRole("searchbox", { name: "Search threads" }).boundingBox())!.width).toBeGreaterThan(50);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "sidebar-open-tasks-narrow-desktop.png");

  for (const completed of [true, false]) {
    const updated = await page.request.patch(`/api/tasks/${task.id}`, {
      headers,
      data: { mutationId: randomUUID(), expectedRevision: task.revision, completed },
    });
    expect(updated.status()).toBe(200);
    task = taskMutationResultSchema.parse(await updated.json()).task;
    if (completed) await expect(openRow).toHaveCount(0);
    else await expect(openRow).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open thread navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Thread navigation" });
  const mobileToggle = drawer.getByRole("button", { name: "Has open tasks", exact: true });
  await expect(mobileToggle).toBeInViewport();
  await expect(mobileToggle).toHaveAttribute("aria-pressed", "true");
  const mobileToggleBox = await mobileToggle.boundingBox();
  expect(mobileToggleBox!.width).toBeGreaterThanOrEqual(36);
  expect(mobileToggleBox!.height).toBeGreaterThanOrEqual(36);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "sidebar-open-tasks-mobile.png");
  await drawer.getByTestId("view-options-trigger").click();
  const sheet = page.getByRole("dialog", { name: "View options" });
  await expect(sheet.getByRole("menuitemcheckbox", { name: "Has open tasks", exact: true })).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Close thread navigation" }).click();
  await page.setViewportSize({ width: 1280, height: 720 });
  expect((await page.request.delete(`/api/tasks/${task.id}`, { headers })).status()).toBe(204);
  await expect(openRow).toHaveCount(0);
  await toggle.click();
  await expect(openRow).toBeVisible();
  await expect(plainRow).toBeVisible();
});

test("sidebar prioritizes turns, unseen completion, subagents, and background commands", async ({ page }, testInfo) => {
  await openSedesWorkspace(page);
  await page.getByRole("button", { name: "Switch to Timeline", exact: true }).click();
  await page.getByTestId("desktop-sidebar").getByTestId("new-thread-trigger").click();
  await page.getByRole("textbox", { name: "Thread name" }).fill("Background work priority");
  await selectCustomNewThreadTarget(page, "Claude subscription · Claude");
  const created = page.waitForResponse(response => response.request().method() === "POST"
    && response.url().endsWith("/api/threads") && response.status() === 201);
  await page.getByRole("button", { name: "Create thread" }).click();
  const { threadId } = await (await created).json() as { threadId: string };
  await expect(page).toHaveURL(new RegExp(`/threads/${threadId}$`));
  const row = page.getByTestId("desktop-sidebar").getByTestId("flat-thread-row")
    .filter({ has: page.getByText("Background work priority", { exact: true }) });
  const glyph = row.locator(".flat-row-glyph");
  const advance = async (stage: string) => {
    expect((await page.request.post(`/__e2e/claude/sidebar-background/${stage}`)).status()).toBe(204);
  };

  await page.getByRole("textbox", { name: /Message Claude/ }).fill("Start sidebar background fixture");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByTestId("background-activity-status")).toContainText("1 subagent, 1 command");
  await expect(glyph).toHaveAttribute("data-glyph", "running");
  await expect(glyph.locator(".comet-spinner")).toHaveCSS("animation-duration", "1s");
  await capture(page, testInfo, "sidebar-background-running.png");

  // Finish while away so the real attention service produces the completion dot.
  await page.goto("/");
  await expect(row).toBeVisible();
  await advance("finish");
  await expect(glyph).toHaveAttribute("data-glyph", "unseen");
  await expect(glyph.locator(".comet-spinner")).toHaveCount(0);
  await expect(glyph).toHaveAttribute("title", /1 subagent, 1 command/);
  await capture(page, testInfo, "sidebar-background-unseen.png");

  await advance("empty");
  await expect(glyph).toHaveAttribute("title", "Finished while you were away");
  await capture(page, testInfo, "sidebar-idle-unseen.png");
  await advance("agents");
  await expect(glyph).toHaveAttribute("title", /1 subagent, 1 command/);
  await row.getByTestId("thread-row-link").click();
  await page.mouse.move(900, 100);
  await expect(glyph).toHaveAttribute("data-glyph", "background-agents");
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
  await expect(glyph.locator(".comet-spinner")).toHaveCSS("animation-duration", "1.8s");
  await capture(page, testInfo, "sidebar-background-agents.png");
  await row.getByTestId("thread-row-link").hover();
  const peek = page.getByTestId("thread-peek");
  await expect(peek).toContainText("Background work · 1 subagent, 1 command");
  await expect(peek.locator('.thread-peek-row-icon[data-glyph="background-agents"]')).toBeVisible();
  await capture(page, testInfo, "sidebar-background-peek.png");
  await page.mouse.move(900, 100);
  await expect(peek).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(glyph.locator(".comet-spinner")).toHaveCSS("animation-name", "none");
  await capture(page, testInfo, "sidebar-background-reduced-motion.png");
  await page.emulateMedia({ reducedMotion: "no-preference" });

  await advance("commands");
  await expect(glyph).toHaveAttribute("data-glyph", "background-commands");
  await expect(glyph).toHaveAttribute("title", "Background command running");
  await expect(glyph.locator(".flat-row-background-dot")).toHaveCSS("width", "6px");
  await expect(glyph.locator(".flat-row-background-dot")).toHaveCSS("height", "6px");
  await expect(glyph.locator(".comet-spinner")).toHaveCount(0);
  await capture(page, testInfo, "sidebar-background-commands.png");
  await advance("empty");
  await expect(glyph).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByTestId("background-activity-status")).toHaveCount(0);
});

test("scheduled and snoozed cards show their deadline once on desktop and mobile", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSedesWorkspace(page);
  const scheduledId = (await createDraftThread(page, "Scheduled deadline once")).split("/").at(-1)!;
  const snoozedId = (await createDraftThread(page, "Snoozed deadline once")).split("/").at(-1)!;
  const session = await (await page.request.get("/api/application/session")).json();
  const headers = { "X-CSRF-Token": session.csrfToken };
  const scheduled = await page.request.post("/api/automations", {
    headers,
    data: {
      threadId: scheduledId, name: "Future reminder", prompt: "Review the work",
      runMode: "same_thread", initialState: "enabled",
      schedule: { kind: "date_time", runAt: new Date(Date.now() + 7_200_000).toISOString() },
      misfirePolicy: null, precheck: null, mutationId: randomUUID(),
    },
  });
  expect(scheduled.status(), await scheduled.text()).toBe(201);
  const snapshot = normalizedApplicationSnapshotSchema.parse(
    await (await page.request.get("/api/application/snapshot")).json(),
  );
  const snoozedThread = snapshot.threads.find(({ id }) => id === snoozedId)!;
  const snoozed = await page.request.patch(`/api/threads/${snoozedId}/inventory`, {
    headers,
    data: {
      action: "snooze", expectedRevision: snoozedThread.inventoryRevision,
      snoozedUntil: new Date(Date.now() + 10_800_000).toISOString(), mutationId: randomUUID(),
    },
  });
  expect(snoozed.status(), await snoozed.text()).toBe(204);

  const sidebar = page.getByTestId("desktop-sidebar");
  await sidebar.getByTestId("view-options-trigger").click();
  await page.getByRole("group", { name: "Group by", exact: true })
    .getByRole("menuitemradio", { name: "State", exact: true }).click();
  await sidebar.getByTestId("view-options-trigger").click();
  await page.getByRole("group", { name: "Density", exact: true })
    .getByRole("menuitemradio", { name: "Card", exact: true }).click();
  await page.keyboard.press("Escape");
  for (const group of ["scheduled", "snoozed"]) {
    const trigger = sidebar.locator(`[data-group="${group}"] > .shelf-trigger`);
    if (await trigger.getAttribute("aria-expanded") !== "true") await trigger.click();
  }
  for (const threadId of [scheduledId, snoozedId]) {
    const row = sidebar.locator(`[data-thread-id="${threadId}"]`).first();
    await expect(row).toBeVisible();
    await expect(row.getByTestId("flat-row-time")).toBeVisible();
    await expect(row.getByTestId("flat-row-time")).toHaveAttribute("data-future", "true");
    await expect(row.getByTestId("flat-row-time")).not.toHaveText("");
    await expect(row.getByTestId("flat-row-context")).toHaveCount(0);
  }
  await capture(page, testInfo, "sidebar-deadlines-once-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open thread navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Thread navigation" });
  for (const threadId of [scheduledId, snoozedId]) {
    const row = drawer.locator(`[data-thread-id="${threadId}"]`).first();
    await expect(row).toBeVisible();
    await expect(row.getByTestId("flat-row-time")).toBeVisible();
    await expect(row.getByTestId("flat-row-time")).toHaveAttribute("data-future", "true");
    await expect(row.getByTestId("flat-row-context")).toHaveCount(0);
  }
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "sidebar-deadlines-once-mobile.png");
});
