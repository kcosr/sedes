import type { Page, Request } from "@playwright/test";
import {
  normalizedApplicationSessionSchema,
  normalizedApplicationSnapshotSchema,
} from "../../src/shared/index.js";
import { test, expect } from "./fixtures.js";
import {
  capture,
  createDraftThread,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openSedesWorkspace,
  sendCurrentDraft,
} from "./helpers.js";

async function applicationSession(page: Page) {
  const response = await page.request.get("/api/application/session");
  expect(response.ok()).toBeTruthy();
  return normalizedApplicationSessionSchema.parse(await response.json());
}

async function applicationSnapshot(page: Page) {
  const response = await page.request.get("/api/application/snapshot");
  expect(response.ok()).toBeTruthy();
  return normalizedApplicationSnapshotSchema.parse(await response.json());
}

async function openForkSourceTurn(
  page: Page,
  childThreadId: string,
): Promise<void> {
  const snapshot = await applicationSnapshot(page);
  const origin = snapshot.forkOrigins.find(
    (candidate) => candidate.childThreadId === childThreadId,
  );
  expect(origin?.sourceThreadId).toBeTruthy();
  expect(origin?.sourceTurnId).toBeTruthy();
  await page.goto(
    `/threads/${origin!.sourceThreadId}#turn=${origin!.sourceTurnId}`,
  );
}

async function armForkControl(
  page: Page,
  sourceThreadId: string,
  mode: "hold" | "lose_response",
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await page.request.post(
        `/__e2e/forks/arm/${sourceThreadId}/${mode}`,
      );
      if (response.ok()) return;
      lastError = new Error(`e2e_fork_arm_failed:${response.status()}`);
    } catch (error) {
      lastError = error;
    }

    try {
      const response = await page.request.get("/__e2e/forks/state");
      if (response.ok()) {
        const state = (await response.json()) as {
          armed: boolean;
          sourceThreadId?: string;
          mode?: string;
        };
        if (
          state.armed &&
          state.sourceThreadId === sourceThreadId &&
          state.mode === mode
        ) {
          return;
        }
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error("e2e_fork_arm_failed");
}

test.describe.serial("normalized lineage browser journeys", () => {
  test("forks completed turns, recovers uncertainty, and presents durable families", async ({
    browser,
    browserDiagnostics,
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const threadEventRequests = new Map<string, number>();
    const filesRequests = new Set<Request>();
    const isFilesRequest = (request: Request) => {
      const url = new URL(request.url());
      return (
        /\/api\/workspaces\/[^/]+\/files\/status$/.test(url.pathname) ||
        (/\/api\/workspaces\/[^/]+\/files$/.test(url.pathname) &&
          url.searchParams.has("rootId"))
      );
    };
    page.on("request", (request) => {
      if (isFilesRequest(request)) filesRequests.add(request);
      const match = /^\/api\/threads\/([^/]+)\/events$/.exec(
        new URL(request.url()).pathname,
      );
      if (match?.[1]) {
        threadEventRequests.set(
          match[1],
          (threadEventRequests.get(match[1]) ?? 0) + 1,
        );
      }
    });
    page.on("requestfinished", (request) => filesRequests.delete(request));
    page.on("requestfailed", (request) => filesRequests.delete(request));
    await openSedesWorkspace(page);
    const sourcePath = await createDraftThread(page);
    const sourceThreadId = sourcePath.split("/").at(-1)!;

    await fillAndPersistDraft(page, "First inclusive boundary");
    await sendCurrentDraft(page);
    await expect(
      page.locator(
        '[data-item-kind="assistant_message"][data-item-status="completed"]',
      ),
    ).toHaveCount(1, { timeout: 15_000 });

    const activeForkPage = await page.context().newPage();
    await activeForkPage.goto(sourcePath);

    await fillAndPersistDraft(page, "Later turn excluded by the first fork");
    await sendCurrentDraft(page);
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(
      activeForkPage.getByRole("button", { name: "Stop" }),
    ).toBeVisible();
    const firstBoundary = page
      .getByRole("button", { name: /Fork from here/ })
      .first();
    await expect(firstBoundary).toHaveAttribute("aria-disabled", "false");
    await expect(
      page.getByRole("button", { name: /Fork from here/ }),
    ).toHaveCount(1);
    const runningUsageButton = page.locator('[data-turn-status="in_progress"]')
      .getByRole("button", { name: "Turn usage and cost" });
    await expect(runningUsageButton).toHaveCount(0);
    await expect(page.locator('[data-turn-status="in_progress"] footer')).toHaveCount(0);
    await expect(page.getByText("Current turn", { exact: true })).toHaveCount(0);
    await capture(page, testInfo, "running-turn-actions.png");

    await page.getByRole("button", { name: "Thread actions" }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Thread actions" })
        .getByRole("button", { name: "Fork", exact: true }),
    ).toBeEnabled();
    await page.keyboard.press("Escape");
    const completedTurn = page
      .locator('[data-turn-status="completed"]')
      .first();
    await completedTurn.hover();
    await expect(completedTurn.locator(".turn-fork-controls")).toHaveCSS(
      "opacity",
      "1",
    );
    await capture(
      page,
      testInfo,
      "lineage-streaming-historical-fork-desktop.png",
    );

    await expect(
      activeForkPage.getByRole("button", { name: /Fork from here/ }),
    ).toHaveCount(1);
    await activeForkPage
      .getByRole("button", { name: /Fork from here/ })
      .click();
    await expect
      .poll(() => new URL(activeForkPage.url()).pathname)
      .not.toBe(sourcePath);
    await expect(
      activeForkPage.getByText("First inclusive boundary").first(),
    ).toBeVisible();
    await expect(
      activeForkPage.getByText("Later turn excluded by the first fork"),
    ).toHaveCount(0);
    await activeForkPage.close();

    await expect(
      page.locator(
        '[data-item-kind="assistant_message"][data-item-status="completed"]',
      ),
    ).toHaveCount(2, { timeout: 15_000 });
    await expect(
      page.getByRole("button", { name: /Fork from here/ }),
    ).toHaveCount(2);

    await page.getByRole("button", { name: "Thread actions" }).click();
    const headerLatestFork = page
      .getByRole("dialog", { name: "Thread actions" })
      .getByRole("button", { name: "Fork", exact: true });
    await expect(headerLatestFork).toBeEnabled();
    await capture(page, testInfo, "lineage-latest-fork-top-menu-desktop.png");
    await page.keyboard.press("Escape");

    const sourceRow = page
      .getByTestId("desktop-sidebar")
      .locator(`[data-thread-id="${sourceThreadId}"]`);
    await sourceRow.click({ button: "right" });
    const contextLatestFork = page.getByRole("menuitem", {
      name: "Fork",
      exact: true,
    });
    await expect(contextLatestFork).toBeEnabled();
    await capture(
      page,
      testInfo,
      "lineage-latest-fork-context-menu-desktop.png",
    );
    await contextLatestFork.click();
    await expect.poll(() => new URL(page.url()).pathname).not.toBe(sourcePath);
    await expect(
      page.getByRole("textbox", { name: "Message Scripted agent" }),
    ).toHaveValue("");
    await page.goto(sourcePath);

    await armForkControl(page, sourceThreadId, "hold");
    await firstBoundary.click();
    await expect
      .poll(async () => {
        const response = await page.request.get("/__e2e/forks/state");
        return ((await response.json()) as { entered: boolean }).entered;
      })
      .toBe(true);
    await expect(
      page.getByRole("dialog", { name: "Creating fork…" }),
    ).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Creating fork…" }).getByRole("button")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Creating fork…" })).toBeVisible();
    await page.mouse.click(2, 2);
    await expect(page.getByRole("dialog", { name: "Creating fork…" })).toBeVisible();
    await capture(page, testInfo, "lineage-fork-pending-desktop.png");
    expect((await page.request.post("/__e2e/forks/release")).ok()).toBe(true);
    await expect.poll(() => new URL(page.url()).pathname).not.toBe(sourcePath);
    const firstChildPath = new URL(page.url()).pathname;
    const firstChildId = firstChildPath.split("/").at(-1)!;
    expect(firstChildId).not.toBe(sourceThreadId);
    await expect(
      page.getByText("First inclusive boundary").first(),
    ).toBeVisible();
    await expect(
      page.getByText("Later turn excluded by the first fork"),
    ).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Message Scripted agent" }),
    ).toHaveValue("");
    await capture(page, testInfo, "lineage-grouped-desktop.png");

    const turnGroup = page.locator(".conversation-turn").first();
    const turnFooter = turnGroup.locator(".turn-fork-controls");
    await page.mouse.move(0, 0);
    await expect(turnFooter).toHaveCSS("opacity", "1");
    await turnGroup.hover();
    await expect(turnFooter).toHaveCSS("opacity", "1");
    await capture(page, testInfo, "lineage-turn-footer-desktop.png");

    const firstChildFork = page.getByRole("button", { name: /Fork from here/ });
    await expect(firstChildFork).toHaveCount(1);
    await firstChildFork.click();
    await expect
      .poll(() => new URL(page.url()).pathname)
      .not.toBe(firstChildPath);
    const grandchildPath = new URL(page.url()).pathname;
    const grandchildId = grandchildPath.split("/").at(-1)!;
    expect(grandchildId).not.toBe(firstChildId);
    await expect(
      page
        .getByTestId("desktop-sidebar")
        .locator(`[data-thread-id="${grandchildId}"]`),
    ).toHaveAttribute("data-lineage-depth", "2");
    await capture(page, testInfo, "lineage-deep-family-desktop.png");

    await page.goto(sourcePath);
    await page.getByRole("button", { name: "Thread actions" }).click();
    const threadActions = page.getByTestId("thread-actions-menu");
    const headerArchive = threadActions.getByRole("button", {
      name: "Archive",
      exact: true,
    });
    await headerArchive.click();
    await expect(
      page.getByRole("menuitem", { name: "Archive only this thread" }),
    ).toBeVisible();
    await capture(page, testInfo, "lineage-archive-family-header-desktop.png");
    await page.keyboard.press("Escape");
    await expect(threadActions).toBeVisible();
    await expect(headerArchive).toBeFocused();
    await page.keyboard.press("Escape");
    await page.goto(grandchildPath);

    const sourceArchiveRow = sourceRow.getByTestId("thread-row").first();
    await sourceArchiveRow.hover();
    await sourceArchiveRow.getByTestId("thread-row-archive").click();
    await expect(
      page.getByRole("menuitem", { name: "Archive only this thread" }),
    ).toBeVisible();
    await expect(
      page.getByRole("menuitem", {
        name: /Archive thread and \d+ descendants/,
      }),
    ).toBeEnabled();
    await capture(
      page,
      testInfo,
      "lineage-archive-family-dropdown-desktop.png",
    );
    await page.getByRole("menuitem", { name: "Cancel" }).click();

    await sourceArchiveRow.click({ button: "right" });
    const archiveSubmenu = page.getByRole("menuitem", { name: "Archive" });
    await archiveSubmenu.hover();
    await expect(
      page.getByRole("menuitem", { name: "Archive only this thread" }),
    ).toBeVisible();
    await capture(page, testInfo, "lineage-archive-family-context-desktop.png");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");

    await openForkSourceTurn(page, grandchildId);
    await expect(page).toHaveURL(new RegExp(`/threads/${firstChildId}#turn=`));
    await expect(page.locator(".source-turn-highlight")).toHaveCount(1);
    const historicalUrl = page.url();
    const composer = page.getByRole("textbox", {
      name: "Message Scripted agent",
    });
    await expect(composer).toBeDisabled();
    await expect
      .poll(() => threadEventRequests.get(firstChildId) ?? 0)
      .toBeGreaterThan(0);
    const focusedThreadEventRequests = threadEventRequests.get(firstChildId);
    await page.getByTestId("thread-view").evaluate((node) => {
      (window as typeof window & { __lineageChat?: Element }).__lineageChat =
        node;
    });
    const groupingBeforePanels = await page.evaluate(() =>
      localStorage.getItem("sedes.sidebar.groupForks"),
    );

    await page.getByRole("button", { name: "Panels", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Files(?: —|$)/ }).click();
    await expect(
      page.getByRole("region", { name: "Workspace files" }),
    ).toBeVisible({ timeout: 15_000 });
    const rowHandle = page.getByRole("separator", {
      name: "Resize Chat and Files panels",
    });
    const layoutBeforeResize = await page.evaluate(() =>
      localStorage.getItem(`sedes-thread-panel-instance-layout@4:${encodeURIComponent(location.pathname.split("/")[2] ?? "")}`),
    );
    const rowBox = await rowHandle.boundingBox();
    expect(rowBox).not.toBeNull();
    await page.mouse.move(rowBox!.x + 2, rowBox!.y + rowBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(rowBox!.x + 36, rowBox!.y + rowBox!.height / 2);
    await page.mouse.up();
    expect(
      await page.evaluate(() =>
        localStorage.getItem(`sedes-thread-panel-instance-layout@4:${encodeURIComponent(location.pathname.split("/")[2] ?? "")}`),
      ),
    ).not.toBe(layoutBeforeResize);

    await page.getByRole("button", { name: "Collapse Chat panel" }).click();
    await expect(page.getByTestId("thread-view")).toBeHidden();
    await expect(
      page.getByRole("region", { name: "Workspace files" }),
    ).toBeVisible();
    expect(page.url()).toBe(historicalUrl);
    await capture(page, testInfo, "lineage-historical-chat-collapsed.png");
    await page.getByRole("button", { name: "Panels" }).click();
    await page.getByRole("menuitem", { name: /^Chat —/ }).click();
    await expect(composer).toBeDisabled();
    expect(
      await page
        .getByTestId("thread-view")
        .evaluate(
          (node) =>
            (window as typeof window & { __lineageChat?: Element })
              .__lineageChat === node,
        ),
    ).toBe(true);
    expect(
      await page.evaluate(() =>
        localStorage.getItem("sedes.sidebar.groupForks"),
      ),
    ).toBe(groupingBeforePanels);
    expect(page.url()).toBe(historicalUrl);
    await expect(page.locator(".source-turn-highlight")).toHaveCount(1);
    expect(threadEventRequests.get(firstChildId)).toBe(
      focusedThreadEventRequests,
    );
    await capture(page, testInfo, "lineage-historical-chat-restored.png");

    await page.getByRole("button", { name: "Return to latest" }).click();
    await expect(page).toHaveURL(firstChildPath);
    await expect(composer).toBeEnabled();
    expect(threadEventRequests.get(firstChildId)).toBe(
      focusedThreadEventRequests,
    );
    await capture(page, testInfo, "lineage-return-live-retained-panels.png");
    // This serial journey next exercises application-lineage publication in
    // two pages. Release the real Files subscription after proving that it
    // survived the historical/live route transition. The later view-mode
    // section uses Chat collapse to cover independent layout preferences.
    browserDiagnostics.allowNetworkFailures = true;
    try {
      await page.getByRole("button", { name: "Close Files panel" }).click();
      await expect.poll(() => filesRequests.size, { timeout: 15_000 }).toBe(0);
    } finally {
      browserDiagnostics.allowNetworkFailures = false;
    }

    await page.goto(sourcePath);
    await armForkControl(page, sourceThreadId, "lose_response");
    await page
      .getByRole("button", { name: /Fork from here/ })
      .last()
      .click();
    await expect(
      page.getByRole("button", { name: "Open recovery thread" }),
    ).toBeVisible();
    await expect(page).toHaveURL(sourcePath);
    await capture(page, testInfo, "lineage-fork-recovery-desktop.png");
    await page.getByRole("button", { name: "Retry same fork" }).click();
    await expect.poll(() => new URL(page.url()).pathname).not.toBe(sourcePath);
    const recoveredChildPath = new URL(page.url()).pathname;
    const recoveredChildId = recoveredChildPath.split("/").at(-1)!;
    await expect(
      page.getByRole("textbox", { name: "Message Scripted agent" }),
    ).toHaveValue("");

    const secondPage = await page.context().newPage();
    await secondPage.goto(recoveredChildPath);
    const childRow = (candidate: typeof page) =>
      candidate
        .getByTestId("desktop-sidebar")
        .locator(`[data-thread-id="${recoveredChildId}"]`);
    await expect(childRow(page)).toHaveAttribute("data-lineage-depth", "1");
    await expect(childRow(secondPage)).toHaveAttribute(
      "data-lineage-depth",
      "1",
    );
    await expect(
      childRow(page).getByRole("button", { name: /Forked from/ }),
    ).toHaveCount(0);
    await expect(
      childRow(secondPage).getByRole("button", { name: /Forked from/ }),
    ).toHaveCount(0);
    await childRow(page).hover();
    const detachAction = childRow(page).getByRole("button", {
      name: /Show .* as top-level/,
    });
    await expect(detachAction).toBeVisible();
    await expect(
      childRow(page).locator(".thread-row-default-trailing"),
    ).toHaveCSS("opacity", "0");
    await capture(page, testInfo, "lineage-sidebar-nesting-hover-desktop.png");
    await detachAction.click();
    await expect(childRow(page)).toHaveAttribute("data-lineage-depth", "0");
    await expect(childRow(secondPage)).toHaveAttribute(
      "data-lineage-depth",
      "0",
    );
    await expect(
      childRow(page).getByRole("button", { name: /Forked from/ }),
    ).toHaveCount(1);
    await expect(
      childRow(secondPage).getByRole("button", { name: /Forked from/ }),
    ).toHaveCount(1);
    await childRow(secondPage).hover();
    const reattachAction = childRow(secondPage).getByRole("button", {
      name: /Group .* under its source/,
    });
    await expect(
      reattachAction.locator(".lucide-arrow-down-wide-narrow"),
    ).toHaveCount(1);
    await reattachAction.click();
    await expect(childRow(page)).toHaveAttribute("data-lineage-depth", "1");
    await expect(childRow(secondPage)).toHaveAttribute(
      "data-lineage-depth",
      "1",
    );
    await expect(
      childRow(page).getByRole("button", { name: /Forked from/ }),
    ).toHaveCount(0);
    await expect(
      childRow(secondPage).getByRole("button", { name: /Forked from/ }),
    ).toHaveCount(0);
    await secondPage.close();

    const [session, snapshot] = await Promise.all([
      applicationSession(page),
      applicationSnapshot(page),
    ]);
    const source = snapshot.threads.find(
      ({ id }) => id === sourceThreadId,
    )!;
    const snooze = await page.request.patch(
      `/api/threads/${sourceThreadId}/inventory`,
      {
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        },
        data: {
          action: "snooze",
          expectedRevision: source.inventoryRevision,
          mutationId: crypto.randomUUID(),
          snoozedUntil: new Date(Date.now() + 3_600_000).toISOString(),
        },
      },
    );
    expect(snooze.ok()).toBe(true);
    await expect(childRow(page)).toHaveAttribute("data-lineage-depth", "0");
    await expect(
      childRow(page).getByRole("button", { name: /Forked from/ }),
    ).toHaveCount(1);
    await capture(page, testInfo, "lineage-lifecycle-promoted-desktop.png");

    // Fork grouping now lives in the view-options popover.
    const panelsBeforeGrouping = await page.evaluate(() =>
      localStorage.getItem(`sedes-thread-panel-instance-layout@4:${encodeURIComponent(location.pathname.split("/")[2] ?? "")}`),
    );
    await capture(page, testInfo, "lineage-grouped-panels.png");
    await page.getByRole("button", { name: "View options" }).click();
    await page.getByRole("checkbox", { name: /Group fork families/ }).click();
    await page.keyboard.press("Escape");
    await expect(childRow(page)).toHaveAttribute("data-lineage-depth", "0");
    await expect(
      childRow(page).getByRole("button", { name: /Forked from/ }),
    ).toHaveCount(1);
    // Grouping preferences and panel layout persistence are independent.
    expect(
      await page.evaluate(() =>
        localStorage.getItem(`sedes-thread-panel-instance-layout@4:${encodeURIComponent(location.pathname.split("/")[2] ?? "")}`),
      ),
    ).toBe(panelsBeforeGrouping);
    await capture(page, testInfo, "lineage-flat-desktop.png");
    const flatGrouping = await page.evaluate(() =>
      localStorage.getItem("sedes.sidebar.groupForks"),
    );
    // Singleton panel presentation must not disturb the sidebar view prefs.
    await page.getByRole("button", { name: "Collapse Chat panel" }).click();
    await expect(page.getByTestId("thread-view")).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Panels" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "View options" }).click();
    await expect(
      page.getByRole("checkbox", { name: /Group fork families/ }),
    ).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    expect(
      await page.evaluate(() =>
        localStorage.getItem("sedes.sidebar.groupForks"),
      ),
    ).toBe(flatGrouping);
    await page.getByRole("button", { name: "Panels" }).click();
    await page.getByRole("menuitem", { name: /^Chat —/ }).click();
    await capture(page, testInfo, "lineage-flat-panels.png");
    await page.reload();
    await page.getByRole("button", { name: "View options" }).click();
    await expect(
      page.getByRole("checkbox", { name: /Group fork families/ }),
    ).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");

    const touchContext = await browser.newContext({
      baseURL: testInfo.project.use.baseURL as string,
      viewport: { width: 360, height: 780 },
      hasTouch: true,
      isMobile: true,
    });
    const touchPage = await touchContext.newPage();
    await touchPage.goto(recoveredChildPath);
    const touchForkControls = touchPage.locator(".turn-fork-controls").first();
    await expect(touchForkControls).toHaveCSS("opacity", "1");
    const touchForkTarget = await touchPage
      .getByRole("button", { name: /Fork from here/ })
      .first()
      .boundingBox();
    expect(touchForkTarget?.width).toBeGreaterThanOrEqual(44);
    expect(touchForkTarget?.height).toBeGreaterThanOrEqual(44);
    await capture(touchPage, testInfo, "lineage-turn-footer-mobile.png");
    await touchPage
      .getByRole("button", { name: "Open thread navigation" })
      .tap();
    await expect(
      touchPage.getByRole("dialog", { name: "Thread navigation" }),
    ).toBeVisible();
    const touchViewOptions = touchPage.getByRole("button", {
      name: "View options",
    });
    const touchTarget = await touchViewOptions.boundingBox();
    expect(touchTarget?.width).toBeGreaterThanOrEqual(36);
    expect(touchTarget?.height).toBeGreaterThanOrEqual(36);
    await capture(touchPage, testInfo, "lineage-mobile-touch.png");
    // Repeat from the same original row after navigation makes its store inactive.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (attempt > 0)
        await touchPage.getByRole("button", { name: "Open thread navigation" }).tap();
      const drawer = touchPage.getByRole("dialog", { name: "Thread navigation" });
      const originalRow = drawer.locator(`[data-thread-id="${recoveredChildId}"]`).getByTestId("flat-thread-row").first();
      await expect(originalRow).toBeVisible();
      await originalRow.scrollIntoViewIfNeeded();
      await originalRow.dispatchEvent("pointerdown", {
        pointerType: "touch", button: 0, clientX: 80, clientY: 200,
      });
      const sheet = touchPage.getByTestId("thread-actions-sheet");
      await expect(sheet).toBeVisible();
      const forkResponse = touchPage.waitForResponse((response) =>
        response.request().method() === "POST" && response.url().includes("/fork"));
      await sheet.getByRole("button", { name: "Fork", exact: true }).tap();
      expect((await forkResponse).ok()).toBe(true);
      await expect(drawer).toBeHidden();
      await expect(touchPage).not.toHaveURL(recoveredChildPath);
      await expect(touchPage.getByRole("dialog", { name: "Creating fork…" })).toBeHidden();
      await expect(touchPage.getByRole("button", { name: "Retry same fork" })).toHaveCount(0);
    }
    await touchContext.close();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Open thread navigation" }).click();
    await expect(
      page.getByRole("dialog", { name: "Thread navigation" }),
    ).toBeVisible();
    await capture(page, testInfo, "lineage-mobile-drawer.png");
    await expectNoPageOverflow(page);
    await page.getByRole("button", { name: "Close thread navigation" }).click();

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(recoveredChildPath);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await openForkSourceTurn(page, recoveredChildId);
    await expect(page).toHaveURL(
      new RegExp(`/threads/${sourceThreadId}#turn=`),
    );
    await expect(page.locator(".source-turn-highlight")).toHaveCount(1);
    // Source navigation focuses the highlighted turn in an animation frame
    // after it mounts. Wait for that handoff before testing keyboard focus;
    // otherwise it can steal focus between Shift+Tab and Tab.
    await expect(page.locator(".source-turn-highlight")).toBeFocused();
    const focusBoundary = page
      .getByRole("button", { name: /Fork from here/ })
      .first();
    await focusBoundary.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    await expect(focusBoundary).toBeFocused();
    await expect(focusBoundary).toHaveCSS("outline-style", "solid");
    await capture(page, testInfo, "lineage-fork-focus-desktop.png");
    await expectNoPageOverflow(page);

    await page.goto(recoveredChildPath);
    await fillAndPersistDraft(
      page,
      "Keep this descendant active during archive preflight",
    );
    await sendCurrentDraft(page);
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    const activeFamilySourceRow = page
      .getByTestId("desktop-sidebar")
      .locator(`[data-thread-id="${sourceThreadId}"]`)
      .getByTestId("thread-row")
      .first();
    await activeFamilySourceRow.hover();
    await activeFamilySourceRow.getByTestId("thread-row-archive").click();
    const blockedArchiveAll = page.getByRole("menuitem", {
      name: /Archive thread and \d+ descendants/,
    });
    await expect(blockedArchiveAll).toBeDisabled();
    await expect(
      page.getByText("A descendant is running and cannot be archived."),
    ).toBeVisible();
    await capture(
      page,
      testInfo,
      "lineage-archive-family-running-disabled-desktop.png",
    );
    await page.getByRole("menuitem", { name: "Cancel" }).click();
    await page.getByRole("button", { name: "Stop" }).click();

    const [cleanupSession, cleanupSnapshot] = await Promise.all([
      applicationSession(page),
      applicationSnapshot(page),
    ]);
    const snoozedSource = cleanupSnapshot.threads.find(
      ({ id }) => id === sourceThreadId,
    )!;
    const wake = await page.request.patch(
      `/api/threads/${sourceThreadId}/inventory`,
      {
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": cleanupSession.csrfToken,
        },
        data: {
          action: "wake",
          expectedRevision: snoozedSource.inventoryRevision,
          mutationId: crypto.randomUUID(),
        },
      },
    );
    expect(wake.ok()).toBe(true);

    await expect
      .poll(async () => {
        const current = await applicationSnapshot(page);
        return current.threads.find(({ id }) => id === sourceThreadId)
          ?.inventoryState;
      })
      .toBe("active");
    const finalSourceRow = page
      .getByTestId("desktop-sidebar")
      .locator(`[data-thread-id="${sourceThreadId}"]`)
      .getByTestId("thread-row")
      .first();
    await finalSourceRow.hover();
    await finalSourceRow.getByTestId("thread-row-archive").click();
    const archiveFamily = page.getByRole("menuitem", {
      name: /Archive thread and \d+ descendants/,
    });
    await expect(archiveFamily).toBeEnabled();
    await archiveFamily.click();
    await expect(
      page
        .getByTestId("desktop-sidebar")
        .locator(`[data-thread-id="${sourceThreadId}"]`),
    ).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
    const archived = await applicationSnapshot(page);
    for (const archivedThreadId of [
      sourceThreadId,
      firstChildId,
      grandchildId,
      recoveredChildId,
    ]) {
      expect(
        archived.threads.find(({ id }) => id === archivedThreadId)
          ?.inventoryState,
      ).toBe("archived");
    }
  });
});
