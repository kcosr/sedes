import { randomUUID } from "node:crypto";
import type { Locator, Page } from "@playwright/test";
import {
  normalizedApplicationSessionSchema,
  normalizedApplicationSnapshotSchema,
  taskMutationResultSchema,
  threadGroupMutationResultSchema,
} from "../../src/shared/index.js";
import { expect, test } from "./fixtures";
import {
  openSettingsPage,
  returnFromSettings,
  capture,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openSedesWorkspace,
  overlaySettled,
  selectCustomNewThreadTarget,
  selectRadixOption,
  sendCurrentDraft,
} from "./helpers";

async function createNamedDraft(page: Page, title: string): Promise<string> {
  const sidebar = page.getByTestId("desktop-sidebar");
  await sidebar.getByTestId("new-thread-trigger").click();
  const creation = page.getByRole("dialog", { name: "New thread" });
  await creation.getByRole("textbox", { name: "Thread name" }).fill(title);
  await selectCustomNewThreadTarget(page, "Pi SDK");
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/threads") &&
      response.status() === 201,
  );
  await creation.getByRole("button", { name: "Create thread" }).click();
  const result = (await (await created).json()) as { threadId: string };
  await expect(page).toHaveURL(new RegExp(`/threads/${result.threadId}$`));
  return result.threadId;
}

async function currentSession(page: Page) {
  const response = await page.request.get("/api/application/session");
  expect(response.ok()).toBe(true);
  return normalizedApplicationSessionSchema.parse(await response.json());
}

async function currentSnapshot(page: Page) {
  const response = await page.request.get("/api/application/snapshot");
  expect(response.ok()).toBe(true);
  return normalizedApplicationSnapshotSchema.parse(await response.json());
}

async function assignGroup(
  page: Page,
  firstThreadId: string,
  secondThreadId: string,
  name: string,
): Promise<string> {
  const [session, initial] = await Promise.all([
    currentSession(page),
    currentSnapshot(page),
  ]);
  const first = initial.threads.find(({ id }) => id === firstThreadId);
  expect(first).toBeDefined();
  if (!first) throw new Error("thread_group_first_thread_missing");

  const created = await page.request.patch(
    `/api/threads/${firstThreadId}/group`,
    {
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrfToken,
      },
      data: {
        action: "create",
        name,
        expectedRevision: first.groupAssignmentRevision,
        mutationId: randomUUID(),
      },
    },
  );
  expect(created.status()).toBe(200);
  const groupId = threadGroupMutationResultSchema.parse(
    await created.json(),
  ).groupId;
  expect(groupId).not.toBeNull();
  if (!groupId) throw new Error("thread_group_create_missing_id");

  const afterCreate = await currentSnapshot(page);
  const second = afterCreate.threads.find(
    ({ id }) => id === secondThreadId,
  );
  expect(second).toBeDefined();
  if (!second) throw new Error("thread_group_second_thread_missing");
  const assigned = await page.request.patch(
    `/api/threads/${secondThreadId}/group`,
    {
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrfToken,
      },
      data: {
        action: "assign",
        groupId,
        expectedRevision: second.groupAssignmentRevision,
        mutationId: randomUUID(),
      },
    },
  );
  expect(assigned.status()).toBe(200);
  return groupId;
}

async function assignExistingGroup(
  page: Page,
  threadId: string,
  groupId: string,
): Promise<void> {
  const [session, snapshot] = await Promise.all([
    currentSession(page),
    currentSnapshot(page),
  ]);
  const thread = snapshot.threads.find(({ id }) => id === threadId);
  expect(thread).toBeDefined();
  if (!thread) throw new Error("thread_group_assignment_thread_missing");
  const assigned = await page.request.patch(`/api/threads/${threadId}/group`, {
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": session.csrfToken,
    },
    data: {
      action: "assign",
      groupId,
      expectedRevision: thread.groupAssignmentRevision,
      mutationId: randomUUID(),
    },
  });
  expect(assigned.status()).toBe(200);
}

async function expectInventoryStates(
  page: Page,
  expected: Readonly<
    Record<string, "active" | "snoozed" | "settled" | "archived">
  >,
): Promise<void> {
  await expect
    .poll(async () => {
      const snapshot = await currentSnapshot(page);
      return Object.fromEntries(
        Object.keys(expected).map((threadId) => [
          threadId,
          snapshot.threads.find(({ id }) => id === threadId)
            ?.inventoryState,
        ]),
      );
    })
    .toEqual(expected);
}

async function transitionInventory(
  page: Page,
  threadId: string,
  action: "snooze" | "wake",
): Promise<void> {
  const [session, snapshot] = await Promise.all([
    currentSession(page),
    currentSnapshot(page),
  ]);
  const thread = snapshot.threads.find(({ id }) => id === threadId);
  expect(thread).toBeDefined();
  if (!thread) throw new Error("inventory_transition_thread_missing");
  const response = await page.request.patch(
    `/api/threads/${threadId}/inventory`,
    {
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": session.csrfToken,
      },
      data: {
        action,
        expectedRevision: thread.inventoryRevision,
        mutationId: randomUUID(),
        ...(action === "snooze"
          ? { snoozedUntil: new Date(Date.now() + 3_600_000).toISOString() }
          : {}),
      },
    },
  );
  expect(response.status()).toBe(204);
}

async function chooseThreadGroups(page: Page, sidebar: Locator): Promise<void> {
  // Choosing a grouping closes the menu; the next press on the trigger
  // reopens it even while the closing menu still fades out.
  await sidebar.getByTestId("view-options-trigger").click();
  await page
    .getByRole("group", { name: "Group by" })
    .getByRole("menuitemradio", { name: "Timeline" })
    .click();
  await sidebar.getByTestId("view-options-trigger").click();
  await page
    .getByRole("group", { name: "Stack by" })
    .getByRole("menuitemradio", { name: "Thread groups" })
    .click();
  await expect(page.getByRole("menu", { name: "View options" })).toBeHidden();
  await expect(sidebar.getByTestId("view-options-trigger")).toBeVisible();
}

test("thread groups stack on desktop and open as a member sheet on mobile", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSedesWorkspace(page);
  const selectedId = await createNamedDraft(page, "Grouped selected thread");
  const filteredId = await createNamedDraft(page, "Filtered group member");
  const siblingId = await createNamedDraft(page, "Grouped recent sibling");
  const ordinaryId = await createNamedDraft(page, "Ordinary ungrouped thread");
  const groupId = await assignGroup(
    page,
    selectedId,
    siblingId,
    "Focus cluster",
  );
  await assignExistingGroup(page, filteredId, groupId);
  await transitionInventory(page, filteredId, "snooze");

  await page.goto(`/threads/${selectedId}`);
  const desktopSidebar = page.getByTestId("desktop-sidebar");
  await chooseThreadGroups(page, desktopSidebar);
  await desktopSidebar.getByTestId("view-options-trigger").click();
  const showSnoozed = page.getByRole("menuitemcheckbox", { name: "Snoozed" });
  await expect(showSnoozed).toBeChecked();
  await showSnoozed.click();
  await page.keyboard.press("Escape");

  const groupStack = desktopSidebar.locator(
    `[data-testid="thread-group-stack"][data-group-id="${groupId}"]`,
  );
  await expect(groupStack).toHaveCount(1);
  await expect(groupStack).toHaveAttribute(
    "data-representative-thread-id",
    siblingId,
  );
  await expect(groupStack).toHaveAttribute("data-density", "compact");
  await expect(
    desktopSidebar.locator(`[data-thread-id="${ordinaryId}"]`),
  ).toBeVisible();
  await expect(
    groupStack.locator(
      ".thread-group-stack-count, [data-testid=thread-group-count]",
    ),
  ).toHaveCount(0);
  await expect(groupStack).not.toContainText(/Focus cluster\s*[·(]\s*2/u);

  await groupStack.getByTestId("thread-row-link").click();
  await expect(page).toHaveURL(new RegExp(`/threads/${siblingId}$`));
  await page.goto(`/threads/${selectedId}`);
  await expect(groupStack).toHaveCount(1);

  await groupStack.hover();
  const roster = page.getByTestId("thread-group-roster");
  await expect(roster).toBeVisible();
  await expect(roster.getByTestId("thread-group-member")).toHaveCount(2);
  const selectedMember = roster.locator(
    `[data-testid="thread-group-member"][data-thread-id="${selectedId}"]`,
  );
  const siblingMember = roster.locator(
    `[data-testid="thread-group-member"][data-thread-id="${siblingId}"]`,
  );
  await expect(siblingMember).toHaveAttribute("data-representative", "true");
  await expect(selectedMember).toHaveAttribute("data-selected", "true");

  await roster
    .getByRole("button", { name: "Manage group Focus cluster" })
    .click();
  const renameGroupItem = page.getByRole("menuitem", {
    name: "Rename group…",
  });
  await expect(renameGroupItem).toBeVisible();
  await expect(roster).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(renameGroupItem).toBeHidden();
  await expect(roster).toBeVisible();

  await siblingMember.click({ button: "right" });
  const archiveItem = page.getByRole("menuitem", { name: "Archive" });
  await expect(archiveItem).toBeVisible();
  await page.waitForTimeout(250);
  await expect(archiveItem).toBeVisible();
  await expect(roster).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(archiveItem).toBeHidden();
  await expect(roster).toBeVisible();

  await siblingMember.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Snooze…" }).click();
  const snoozeDialog = page.getByRole("dialog", {
    name: "Snooze this thread",
  });
  await expect(snoozeDialog).toBeVisible();
  await expect(roster).toBeVisible();
  const layers = await page.evaluate(() => {
    const rosterElement = document.querySelector<HTMLElement>(
      '[data-testid="thread-group-roster"]',
    );
    const rosterSurface = rosterElement?.closest<HTMLElement>(
      ".thread-group-roster-popover",
    );
    const dialogElement = document.querySelector<HTMLElement>(
      '[data-slot="dialog-content"][data-layer="over-dialog"]',
    );
    const overlayElement = document.querySelector<HTMLElement>(
      '[data-testid="dialog-overlay"][data-layer="over-dialog"]',
    );
    if (!rosterSurface || !dialogElement || !overlayElement) {
      throw new Error("stack_dialog_layer_missing");
    }
    const zIndex = (element: HTMLElement) =>
      Number.parseInt(getComputedStyle(element).zIndex, 10);
    return {
      roster: zIndex(rosterSurface),
      dialog: zIndex(dialogElement),
      overlay: zIndex(overlayElement),
    };
  });
  expect(layers.overlay).toBeGreaterThan(layers.roster);
  expect(layers.dialog).toBeGreaterThan(layers.overlay);
  await snoozeDialog.getByRole("button", { name: "Close" }).click();
  await expect(snoozeDialog).toBeHidden();

  await siblingMember.hover();
  const peek = page.getByTestId("thread-peek");
  await expect(peek).toBeVisible();
  await expect(peek).toContainText("Grouped recent sibling");
  const [memberBox, peekBox] = await Promise.all([
    siblingMember.boundingBox(),
    peek.boundingBox(),
  ]);
  expect(memberBox).not.toBeNull();
  expect(peekBox).not.toBeNull();
  expect(Math.abs(memberBox!.y - peekBox!.y)).toBeLessThanOrEqual(3);
  expect(peekBox!.x).toBeGreaterThan(memberBox!.x + memberBox!.width);
  await capture(page, testInfo, "sidebar-thread-group-roster-desktop.png");
  await siblingMember.getByTestId("thread-row-link").click();
  await expect(page).toHaveURL(new RegExp(`/threads/${siblingId}$`));
  await expect(peek).toHaveCount(0);
  await expect(roster).toBeHidden();

  const search = desktopSidebar.getByPlaceholder("Search threads");
  await search.fill("Grouped selected");
  await expect(groupStack).toHaveCount(0);
  await expect(
    desktopSidebar.locator(`[data-thread-id="${selectedId}"]`),
  ).toBeVisible();
  await expect(
    desktopSidebar.locator(`[data-thread-id="${siblingId}"]`),
  ).toHaveCount(0);
  await search.fill("");
  await expect(groupStack).toHaveCount(1);

  await desktopSidebar.getByTestId("group-filter").click();
  const groupSearch = page.getByRole("combobox", { name: "Search groups", exact: true });
  await groupSearch.fill("cluster");
  await expect(page.getByRole("option", { name: "All groups", exact: true })).toBeVisible();
  await expect(page.getByRole("option", { name: "Ungrouped", exact: true })).toBeVisible();
  await expect(groupStack).toHaveCount(1);
  await page.getByRole("option", { name: /^Focus cluster/u }).click();
  await expect(groupStack).toHaveCount(0);
  await expect(
    desktopSidebar.locator(`[data-thread-id="${selectedId}"]`),
  ).toBeVisible();
  await expect(
    desktopSidebar.locator(`[data-thread-id="${siblingId}"]`),
  ).toBeVisible();
  await selectRadixOption(
    page,
    desktopSidebar.getByTestId("group-filter"),
    "All groups",
  );
  await expect(groupStack).toHaveCount(1);

  await expect(groupStack).toHaveCount(1);
  await groupStack.hover();
  const settleStack = groupStack.getByTestId("thread-stack-face-settle");
  await expect(settleStack).toHaveAccessibleName(
    "Settle 2 threads in Focus cluster",
  );
  await expect(groupStack.getByTitle("Pin")).toHaveCount(0);
  await expect(groupStack.getByTitle("Snooze")).toHaveCount(0);
  const taskSession = await currentSession(page);
  const stackTasks = [];
  for (const [threadId, title] of [
    [selectedId, "Finish selected thread"],
    [siblingId, "Finish sibling thread"],
    [filteredId, "Keep filtered thread task open"],
  ] as const) {
    const response = await page.request.post("/api/tasks", {
      headers: { "X-CSRF-Token": taskSession.csrfToken },
      data: { mutationId: randomUUID(), title, scope: { kind: "thread", threadId } },
    });
    expect(response.status()).toBe(201);
    stackTasks.push(taskMutationResultSchema.parse(await response.json()).task);
  }
  const settleRequest = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/thread-inventory/bulk") &&
      response.status() === 200,
  );
  await settleStack.click();
  const stackActionDialog = page.getByRole("dialog", {
    name: "Settle threads in Focus cluster",
  });
  await expect(stackActionDialog).toContainText(
    "Settle 2 threads.",
  );
  await expect(stackActionDialog.getByText("Finish selected thread", { exact: true })).toBeVisible();
  await expect(stackActionDialog.getByText("Finish sibling thread", { exact: true })).toBeVisible();
  await expect(stackActionDialog.getByText("Keep filtered thread task open", { exact: true })).toHaveCount(0);
  await stackActionDialog.getByRole("radio", { name: "Complete all", exact: true }).click();
  await capture(page, testInfo, "sidebar-thread-stack-complete-tasks.png");
  await stackActionDialog.getByRole("button", { name: "Settle" }).click();
  await settleRequest;
  await expect(stackActionDialog).toBeHidden();
  await expectInventoryStates(page, {
    [selectedId]: "settled",
    [siblingId]: "settled",
    [filteredId]: "snoozed",
  });
  const afterCompletion = await currentSnapshot(page);
  for (const task of stackTasks) {
    const current = afterCompletion.tasks.find(({ id }) => id === task.id);
    expect(current?.scope).toEqual(task.scope);
    expect(current?.completedAt).toEqual(
      task.scope.kind === "thread" && task.scope.threadId === filteredId
        ? null
        : expect.any(String),
    );
  }

  await groupStack.click({ button: "right" });
  const stackMenu = page.getByTestId("thread-stack-context-menu");
  await expect(stackMenu).toBeVisible();
  await expect(
    stackMenu.getByRole("menuitem", { name: "Settle stack", exact: true }),
  ).toBeDisabled();
  await expect(stackMenu.getByRole("menuitem", { name: "Pin" })).toHaveCount(0);
  await expect(
    stackMenu.getByRole("menuitem", { name: "Snooze…" }),
  ).toHaveCount(0);
  await stackMenu
    .getByRole("menuitem", { name: "Unsettle stack", exact: true })
    .click();
  const unsettleDialog = page.getByRole("dialog", {
    name: "Unsettle threads in Focus cluster",
  });
  await expect(unsettleDialog).toContainText(
    "Unsettle 2 threads.",
  );
  const unsettleRequest = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/thread-inventory/bulk") &&
      response.status() === 200,
  );
  await unsettleDialog.getByRole("button", { name: "Unsettle" }).click();
  await unsettleRequest;
  await expect(unsettleDialog).toBeHidden();
  await expectInventoryStates(page, {
    [selectedId]: "active",
    [siblingId]: "active",
    [filteredId]: "snoozed",
  });

  await page.goto(`/threads/${siblingId}`);
  await fillAndPersistDraft(page, "Keep one visible stack member running");
  await sendCurrentDraft(page);
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(groupStack).toHaveCount(1);
  await groupStack.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Archive stack" }).click();
  const blockedArchiveDialog = page.getByRole("dialog", {
    name: "Archive threads in Focus cluster",
  });
  await expect(blockedArchiveDialog).toContainText("1 blocked thread");
  await expect(
    blockedArchiveDialog.getByRole("button", { name: "Archive" }),
  ).toBeDisabled();
  await capture(
    page,
    testInfo,
    "sidebar-thread-stack-running-blocker-desktop.png",
  );
  await blockedArchiveDialog.getByRole("button", { name: "Cancel" }).click();
  await expectInventoryStates(page, {
    [selectedId]: "active",
    [siblingId]: "active",
    [filteredId]: "snoozed",
  });
  await page.getByRole("button", { name: "Stop" }).click();
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden();
  await transitionInventory(page, filteredId, "wake");
  await expectInventoryStates(page, {
    [selectedId]: "active",
    [siblingId]: "active",
    [filteredId]: "active",
  });
  await expect(groupStack).toHaveCount(1);

  const projectAnchorId = await desktopSidebar
    .locator(".flat-list-item[data-thread-id]")
    .first()
    .getAttribute("data-thread-id");
  expect(projectAnchorId).not.toBeNull();

  await desktopSidebar.getByTestId("view-options-trigger").click();
  await page
    .getByRole("group", { name: "Stack by" })
    .getByRole("menuitemradio", { name: "Projects" })
    .click();
  const projectStack = desktopSidebar.locator(
    '[data-testid="project-stack"][data-workspace-id]',
  );
  await expect(projectStack).toHaveCount(1);
  await expect(projectStack).toHaveAttribute(
    "data-representative-thread-id",
    projectAnchorId!,
  );
  await projectStack.hover();
  await expect(roster).toBeVisible();
  expect(
    await roster.getByTestId("thread-group-member").count(),
  ).toBeGreaterThanOrEqual(3);
  for (const threadId of [selectedId, siblingId, filteredId, ordinaryId]) {
    await expect(
      roster.locator(
        `[data-testid="thread-group-member"][data-thread-id="${threadId}"]`,
      ),
    ).toHaveCount(1);
  }
  await expect(
    roster.getByRole("button", { name: /Manage group/u }),
  ).toHaveCount(0);
  await expect(projectStack).not.toContainText(/3 threads?/iu);
  await capture(page, testInfo, "sidebar-project-stack-desktop.png");

  await desktopSidebar.getByTestId("view-options-trigger").click();
  await page
    .getByRole("group", { name: "Stack by" })
    .getByRole("menuitemradio", { name: "Thread groups" })
    .click();
  await expect(groupStack).toHaveCount(1);

  await desktopSidebar.getByTestId("view-options-trigger").click();
  await page.getByRole("menuitemradio", { name: "Card" }).click();
  await page.keyboard.press("Escape");
  await expect(groupStack).toHaveAttribute("data-density", "card");
  await openSettingsPage(page, "appearance");
  const settings = page.getByTestId("settings-view");
  await settings.getByRole("radio", { name: "Dark" }).click();
  await returnFromSettings(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const stackEdgeStyles = await groupStack.evaluate((stack) => {
    const face = stack.querySelector<HTMLElement>(".flat-row");
    if (!face) throw new Error("thread_group_stack_face_missing");
    const faceStyle = getComputedStyle(face);
    const middleSheetStyle = getComputedStyle(stack, "::before");
    const backSheetStyle = getComputedStyle(stack, "::after");
    return {
      faceTopColor: faceStyle.borderTopColor,
      faceTopWidth: faceStyle.borderTopWidth,
      faceRightWidth: faceStyle.borderRightWidth,
      faceBottomWidth: faceStyle.borderBottomWidth,
      faceLeftWidth: faceStyle.borderLeftWidth,
      faceTopRightRadius: faceStyle.borderTopRightRadius,
      middleSheetTopWidth: middleSheetStyle.borderTopWidth,
      middleSheetRightColor: middleSheetStyle.borderRightColor,
      middleSheetRightWidth: middleSheetStyle.borderRightWidth,
      middleSheetTopRightRadius: middleSheetStyle.borderTopRightRadius,
      middleSheetTransform: middleSheetStyle.transform,
      backSheetContent: backSheetStyle.content,
      backSheetRightWidth: backSheetStyle.borderRightWidth,
      backSheetTopRightRadius: backSheetStyle.borderTopRightRadius,
      backSheetTransform: backSheetStyle.transform,
    };
  });
  expect(stackEdgeStyles).toMatchObject({
    faceTopWidth: "1px",
    faceRightWidth: "1px",
    faceBottomWidth: "1px",
    faceLeftWidth: "1px",
    faceTopRightRadius: "8px",
    middleSheetTopWidth: "1px",
    middleSheetRightWidth: "1px",
    middleSheetTopRightRadius: "8px",
    middleSheetTransform: "matrix(1, 0, 0, 1, 4, 4)",
    backSheetRightWidth: "1px",
    backSheetTopRightRadius: "8px",
    backSheetTransform: "matrix(1, 0, 0, 1, 8, 8)",
  });
  expect(stackEdgeStyles.backSheetContent).not.toBe("none");
  expect(stackEdgeStyles.faceTopColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(stackEdgeStyles.middleSheetRightColor).not.toBe("rgba(0, 0, 0, 0)");
  await capture(page, testInfo, "sidebar-thread-group-card-desktop.png");
  await expectNoPageOverflow(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/threads/${selectedId}`);
  await page.getByRole("button", { name: "Open thread navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Thread navigation" });
  await expect(drawer).toBeVisible();
  const mobileStack = drawer.locator(
    `[data-testid="thread-group-stack"][data-group-id="${groupId}"]`,
  );
  await mobileStack.click({ button: "right" });
  const sheet = page.getByTestId("thread-group-sheet");
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("thread-group-member")).toHaveCount(3);
  await expect(
    sheet.getByTestId("thread-stack-header-settle"),
  ).toHaveAccessibleName("Settle 3 threads in Focus cluster");
  await expect(
    page.getByTestId("thread-stack-actions-sheet"),
  ).toHaveCount(0);
  await expect(
    page.getByTestId("thread-stack-context-menu"),
  ).toHaveCount(0);
  await expect
    .poll(async () => {
      const box = await sheet.boundingBox();
      return box ? Math.abs(box.y + box.height - 844) : Number.POSITIVE_INFINITY;
    })
    .toBeLessThanOrEqual(1);
  await capture(page, testInfo, "sidebar-thread-stack-combined-sheet-mobile.png");
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(drawer).toBeVisible();

  const mobileRepresentativeId = await mobileStack.getAttribute(
    "data-representative-thread-id",
  );
  expect(mobileRepresentativeId).not.toBeNull();
  await mobileStack.getByTestId("thread-row-link").click();
  await expect(page).toHaveURL(
    new RegExp(`/threads/${mobileRepresentativeId!}$`),
  );
  await expect(drawer).toBeHidden();

  await page.getByRole("button", { name: "Open thread navigation" }).click();
  await expect(drawer).toBeVisible();
  await mobileStack.click({ button: "right" });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId("thread-group-member")).toHaveCount(3);
  await expect(
    sheet.locator(
      `[data-testid="thread-group-member"][data-thread-id="${mobileRepresentativeId!}"]`,
    ),
  ).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("thread-peek")).toHaveCount(0);
  await capture(page, testInfo, "sidebar-thread-group-sheet-mobile.png");

  const mobileMember = sheet.locator(
    `[data-testid="thread-group-member"][data-thread-id="${siblingId}"]`,
  );
  await mobileMember.click({ button: "right" });
  const threadContextSheet = page.getByTestId("thread-actions-sheet");
  await expect(threadContextSheet).toBeVisible();
  await expect(threadContextSheet).toContainText("Grouped recent sibling");
  await expect(page.getByTestId("thread-context-menu")).toHaveCount(0);
  await overlaySettled(threadContextSheet);
  const threadContextBox = await threadContextSheet.boundingBox();
  expect(threadContextBox).not.toBeNull();
  expect(
    Math.abs(threadContextBox!.y + threadContextBox!.height - 844),
  ).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(threadContextSheet).toBeHidden();
  await expect(sheet).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden();
  await expect(drawer).toBeVisible();
  await mobileStack.click({ button: "right" });
  await expect(sheet).toBeVisible();
  await sheet
    .locator(
      `[data-testid="thread-group-member"][data-thread-id="${siblingId}"]`,
    )
    .getByTestId("thread-row-link")
    .click();
  await expect(page).toHaveURL(new RegExp(`/threads/${siblingId}$`));
  await expect(sheet).toBeHidden();
  await expect(drawer).toBeHidden();

  await page.getByRole("button", { name: "Open thread navigation" }).click();
  await expect(drawer).toBeVisible();
  await mobileStack.click({ button: "right" });
  await expect(sheet).toBeVisible();
  await expect(
    sheet.getByTestId("thread-stack-header-settle"),
  ).toHaveAccessibleName("Settle 3 threads in Focus cluster");
  await expect(
    sheet.getByTestId("thread-stack-header-unsettle"),
  ).toBeDisabled();
  const mobileArchiveImpact = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/thread-inventory/bulk-impact") &&
      response.status() === 200,
  );
  await sheet.getByTestId("thread-stack-header-archive").click();
  await mobileArchiveImpact;
  const archiveDialog = page.getByRole("dialog", {
    name: "Archive threads in Focus cluster",
  });
  await expect(archiveDialog).toContainText(
    "Archive 3 threads.",
  );
  await expect(sheet).toBeHidden();
  await capture(
    page,
    testInfo,
    "sidebar-thread-stack-archive-confirmation-mobile.png",
  );
  const archiveRequest = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/thread-inventory/bulk") &&
      response.status() === 200,
  );
  await archiveDialog.getByRole("button", { name: "Archive" }).click();
  await archiveRequest;
  await expect(archiveDialog).toBeHidden();
  await expect(page).toHaveURL(/\/$/u);
  await expectInventoryStates(page, {
    [selectedId]: "archived",
    [siblingId]: "archived",
    [filteredId]: "archived",
    [ordinaryId]: "active",
  });
  await expectNoPageOverflow(page);
});

test("move to group searches destinations on desktop and mobile", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSedesWorkspace(page);
  const targetId = await createNamedDraft(page, "Move this thread");
  const siblingId = await createNamedDraft(page, "Group destination member");
  const otherId = await createNamedDraft(page, "Another destination member");
  const alphaId = await assignGroup(page, targetId, siblingId, "Alpha planning");
  const betaId = await assignGroup(page, siblingId, otherId, "Beta delivery");
  await page.goto(`/threads/${targetId}`);

  const sidebar = page.getByTestId("desktop-sidebar");
  const row = sidebar.locator(`[data-thread-id="${targetId}"]`);
  const rowLink = row.getByTestId("thread-row-link");
  // "Move to group" is a searchable submenu: a search row over the groups,
  // then "New group…" (and "Remove from group" while grouped).
  const submenu = page.getByRole("menu", { name: "Move to group", exact: true });
  const search = submenu.getByRole("searchbox", { name: "Search groups", exact: true });
  const groupRows = submenu.getByRole("menuitemradio");
  const openDesktopMove = async () => {
    await rowLink.focus();
    await row.click({ button: "right" });
    await page
      .getByTestId("thread-context-menu")
      .getByRole("menuitem", { name: "Move to group", exact: true })
      .click();
    await expect(submenu).toBeVisible();
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("");
  };
  const groupAssignment = async () => {
    const snapshot = await currentSnapshot(page);
    return snapshot.threads.find(({ id }) => id === targetId)?.groupId;
  };
  const assignedGroupName = async () => {
    const snapshot = await currentSnapshot(page);
    const groupId = snapshot.threads.find(({ id }) => id === targetId)?.groupId;
    return snapshot.groups.find(({ id }) => id === groupId)?.name;
  };
  const newGroupDialog = page.getByRole("dialog", { name: "New group", exact: true });
  const newGroupName = newGroupDialog.getByRole("textbox", { name: "Group name", exact: true });

  await openDesktopMove();
  await expect(groupRows).toHaveText(["Alpha planning", "Beta delivery"]);
  await expect(submenu.getByRole("menuitemradio", { name: "Alpha planning" })).toBeChecked();
  await expect(submenu.getByRole("menuitem", { name: "New group…", exact: true })).toBeVisible();
  await expect(submenu.getByRole("menuitem", { name: "Remove from group", exact: true })).toBeVisible();
  // Enter with nothing typed picks nothing.
  await search.press("Enter");
  await expect(submenu).toBeVisible();
  expect(await groupAssignment()).toBe(alphaId);
  await search.press("Escape");
  await expect(submenu).toBeHidden();
  expect(await groupAssignment()).toBe(alphaId);

  // Typing filters; Enter takes the first result.
  await openDesktopMove();
  await page.keyboard.type("DELIVERY");
  await expect(groupRows).toHaveText(["Beta delivery"]);
  await expect(submenu.getByRole("menuitem", { name: "New group…", exact: true })).toBeVisible();
  expect(await groupAssignment()).toBe(alphaId);
  await capture(page, testInfo, "thread-move-group-search-desktop.png");
  await search.press("Enter");
  await expect(submenu).toBeHidden();
  await expect.poll(groupAssignment).toBe(betaId);

  // The arrow keys move into the results; the current group carries the check.
  await openDesktopMove();
  await search.press("ArrowDown");
  await expect(submenu.getByRole("menuitemradio", { name: "Alpha planning" })).toBeFocused();
  await expect(submenu.getByRole("menuitemradio", { name: "Beta delivery" })).toBeChecked();
  await page.keyboard.press("ArrowUp");
  await expect(search).toBeFocused();

  // A search that matches no group offers to create it, in one step.
  await page.keyboard.type("Ops rotation");
  await expect(groupRows).toHaveCount(0);
  await submenu.getByRole("menuitem", { name: "Create group “Ops rotation”", exact: true }).click();
  await expect(submenu).toBeHidden();
  await expect.poll(assignedGroupName).toBe("Ops rotation");

  // New group… opens the create-only dialog, prefilled with the search.
  await openDesktopMove();
  await page.keyboard.type("Launch");
  await submenu.getByRole("menuitem", { name: "New group…", exact: true }).click();
  await expect(newGroupDialog).toBeVisible();
  await expect(newGroupName).toHaveValue("Launch");
  await expect(newGroupName).toBeFocused();
  await expect(newGroupDialog.getByRole("searchbox")).toHaveCount(0);
  await expect(newGroupDialog.getByRole("menuitemradio")).toHaveCount(0);
  await expect(newGroupDialog.getByText("Alpha planning")).toHaveCount(0);
  // A duplicate name stays on the field.
  await newGroupName.fill("alpha PLANNING");
  await newGroupDialog.getByRole("button", { name: "Create", exact: true }).click();
  await expect(newGroupName).toHaveAttribute("aria-invalid", "true");
  await expect(newGroupDialog.getByText("A group named “alpha PLANNING” already exists.")).toBeVisible();
  await capture(page, testInfo, "thread-new-group-dialog-desktop.png");
  await newGroupName.fill("New release planning");
  await newGroupName.press("Enter");
  await expect(newGroupDialog).toBeHidden();
  await expect(rowLink).toBeFocused();
  await expect.poll(assignedGroupName).toBe("New release planning");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/threads/${targetId}`);
  await page.getByRole("button", { name: "Open thread navigation" }).click();
  const drawer = page.getByRole("dialog", { name: "Thread navigation", exact: true });
  const mobileRow = drawer.locator(`[data-thread-id="${targetId}"]`);
  const actions = page.getByTestId("thread-actions-sheet");
  const openMobileMove = async () => {
    await mobileRow.click({ button: "right" });
    await expect(actions).toBeVisible();
    await actions.getByRole("menuitem", { name: "Move to group", exact: true }).click();
  };
  const mobileSearch = actions.getByRole("searchbox", { name: "Search groups", exact: true });
  const mobileGroupRows = actions.getByRole("menuitemradio");

  // The drill-in is the same searchable picker; it opens for browsing.
  await openMobileMove();
  await expect(mobileSearch).toBeVisible();
  await expect(mobileSearch).not.toBeFocused();
  await expect(mobileGroupRows).toHaveCount(4);
  await expect(actions.getByRole("menuitemradio", { name: "New release planning" })).toBeChecked();
  await mobileSearch.click();
  await expect(mobileSearch).toBeFocused();
  await mobileSearch.fill("ALPHA");
  await expect(mobileGroupRows).toHaveText(["Alpha planning"]);
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "thread-move-group-search-mobile.png");
  await actions.getByRole("menuitemradio", { name: "Alpha planning" }).click();
  await expect(actions).toBeHidden();
  await expect.poll(groupAssignment).toBe(alphaId);

  // Create from the search, then New group… hands off to its dialog.
  await openMobileMove();
  await mobileSearch.fill("Night shift");
  await actions.getByRole("menuitem", { name: "Create group “Night shift”", exact: true }).click();
  await expect(actions).toBeHidden();
  await expect.poll(assignedGroupName).toBe("Night shift");
  await openMobileMove();
  await mobileSearch.fill("Weekend");
  await actions.getByRole("menuitem", { name: "New group…", exact: true }).click();
  await expect(actions).toBeHidden();
  await expect(newGroupDialog).toBeVisible();
  await expect(newGroupName).toHaveValue("Weekend");
  await expect(newGroupDialog.getByRole("searchbox")).toHaveCount(0);
  await capture(page, testInfo, "thread-new-group-dialog-mobile.png");
  await newGroupDialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(newGroupDialog).toBeHidden();
  await expect.poll(assignedGroupName).toBe("Night shift");

  await openMobileMove();
  await actions.getByRole("menuitem", { name: "Remove from group", exact: true }).click();
  await expect(actions).toBeHidden();
  await expect.poll(groupAssignment).toBeNull();
  await expect(drawer).toBeVisible();
});
