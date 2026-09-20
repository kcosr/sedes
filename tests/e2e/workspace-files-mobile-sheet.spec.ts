import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  capture,
  fillAndPersistDraft,
  selectCustomNewThreadTarget,
  selectProjectIfNeeded,
  sendCurrentDraft,
} from "./helpers";
import {
  alphaWorkspace,
  resetWorkspaceFileFixtures,
} from "./workspace-files-fixture";

test.use({ hasTouch: true });

async function openMobileFilesPanel(page: Page) {
  await page.getByRole("button", { name: "Panels", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Files(?: —|$)/ }).click();
}

test("mobile rendered Markdown selection actions open notes and attach to the composer", async ({
  page,
}, testInfo) => {
  await resetWorkspaceFileFixtures();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "New thread" }).first(),
  ).toBeVisible();

  const picker = page
    .getByTestId("desktop-sidebar")
    .getByTestId("workspace-picker");
  await picker.click();
  await page.getByLabel("Absolute directory path").fill(alphaWorkspace);
  await page.getByRole("dialog", { name: "Add project" }).getByRole("button", { name: "Add project" }).click();
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
    .fill("Mobile context");
  await selectProjectIfNeeded(page, path.basename(alphaWorkspace));
  await selectCustomNewThreadTarget(page, "Pi SDK");
  await page.getByRole("button", { name: "Create thread" }).click();
  await created;

  await page.setViewportSize({ width: 412, height: 915 });
  await openMobileFilesPanel(page);
  const panel = page.getByRole("region", { name: "Workspace files" });
  await expect(panel).toBeVisible();
  await panel.getByRole("treeitem", { name: /^SPEC\.md(?:\s|$)/ }).tap();
  const preview = panel.getByLabel("Markdown preview for SPEC.md");
  await expect(preview).toBeVisible();
  await preview.evaluate((root) => {
    const paragraph = root.querySelector("p");
    if (!paragraph) throw new Error("Markdown paragraph missing");
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });

  const actions = page.getByRole("toolbar", { name: "Selected text actions" });
  await expect(actions).toBeVisible();
  await expect(actions).toHaveCSS("position", "fixed");
  await expect(actions.getByText("Selected text", { exact: true })).toBeVisible();
  await expect(actions.getByText("Selection actions", { exact: true })).toBeVisible();
  const actionBounds = await actions.boundingBox();
  expect(actionBounds?.x).toBeGreaterThanOrEqual(12);
  expect(
    actionBounds ? 412 - actionBounds.x - actionBounds.width : undefined,
  ).toBeGreaterThanOrEqual(12);
  await actions.getByRole("button", { name: "Add note…" }).tap();
  await expect(
    actions.getByText("Add an optional note", { exact: true }),
  ).toBeVisible();
  const note = actions.getByRole("textbox", {
    name: "Note about selected text",
  });
  await expect(note).toBeVisible();
  expect((await note.boundingBox())?.height).toBeGreaterThanOrEqual(120);
  for (const button of await actions.getByRole("button").all()) {
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await note.fill("Check this paragraph");
  await capture(page, testInfo, "workspace-files-mobile-selection-note.png");
  await actions.getByRole("button", { name: "Add note", exact: true }).tap();
  await expect(actions).toBeHidden();
  await expect(preview.locator(".context-selection-confirmation")).toHaveCount(
    0,
  );

  await page.getByRole("button", { name: "Collapse Files panel" }).tap();
  await expect(page.getByRole("button", { name: "Panels" })).toBeVisible();

  // Regression: the mobile base sized itself to the viewport rather than to
  // the stage under the workbench bar, so the layout's overflow clipped the
  // composer's send row by exactly the bar's height.
  const sendBox = await page
    .getByRole("button", { name: "Send message" })
    .boundingBox();
  expect(sendBox).not.toBeNull();
  expect(sendBox!.y + sendBox!.height).toBeLessThanOrEqual(915);
  await expect(page.getByLabel("Context excerpts")).toContainText("SPEC.md");
  await expect(page.getByLabel("Context excerpts")).toContainText(
    "Check this paragraph",
  );

  await fillAndPersistDraft(page, "Mobile transcript selection");
  await sendCurrentDraft(page);
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({
    timeout: 20_000,
  });
  const assistant = page
    .locator(
      '[data-item-kind="assistant_message"][data-item-status="completed"]',
    )
    .last();
  await expect(assistant).toBeVisible({ timeout: 20_000 });
  await expect(assistant.locator("[data-markdown-block]")).toHaveCount(2);
  await assistant.evaluate((root) => {
    const blocks = root.querySelectorAll("[data-markdown-block]");
    const firstBlock = blocks.item(0);
    const lastBlock = blocks.item(blocks.length - 1);
    if (!firstBlock || !lastBlock || firstBlock === lastBlock) {
      throw new Error("Completed assistant multi-line content missing");
    }
    root.dispatchEvent(
      new PointerEvent("pointerdown", {
        bubbles: true,
        button: 0,
        isPrimary: true,
        pointerId: 17,
        pointerType: "touch",
      }),
    );
    const range = document.createRange();
    range.setStart(firstBlock, 0);
    range.setEnd(lastBlock, lastBlock.childNodes.length);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  const chatActions = page.getByRole("toolbar", {
    name: "Selected message text actions",
  });
  await page.waitForTimeout(500);
  await expect(chatActions).toBeHidden();
  await assistant.evaluate((root) => {
    root.dispatchEvent(
      new PointerEvent("pointerup", {
        bubbles: true,
        button: 0,
        isPrimary: true,
        pointerId: 17,
        pointerType: "touch",
      }),
    );
  });
  await expect(chatActions).toBeVisible();
  await expect(chatActions).toHaveCSS("position", "fixed");
  await chatActions.getByRole("button", { name: "Add note…" }).tap();
  const chatNote = chatActions.getByRole("textbox", {
    name: "Note about selected message text",
  });
  await chatNote.fill("Use this response as context");
  for (const button of await chatActions.getByRole("button").all()) {
    expect((await button.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  }
  await capture(page, testInfo, "chat-mobile-selection-note.png");
  await chatActions
    .getByRole("button", { name: "Add note", exact: true })
    .tap();
  await expect(chatActions).toBeHidden();
  await expect(
    assistant.locator(".context-selection-confirmation"),
  ).toHaveCount(0);
  await expect(
    page.getByTestId("composer").getByLabel("Context excerpts"),
  ).toContainText("Conversation message");
});

// Regression: the panel stops wheel/touchmove itself so the tree's scroller —
// which lives in a shadow root an ancestor cannot inspect — keeps its own
// gestures instead of leaking them to the surface behind the panel.
test("mobile panel file list scrolls by touch and fallback ellipsis CSS applies", async ({
  page,
}, testInfo) => {
  await resetWorkspaceFileFixtures();
  // Enough files that the tree overflows a phone-sized panel.
  const manyDirectory = path.join(alphaWorkspace, "many");
  await mkdir(manyDirectory, { recursive: true });
  await Promise.all(
    Array.from({ length: 60 }, (_, index) =>
      writeFile(
        path.join(
          manyDirectory,
          `very-long-component-name-for-truncation-${String(index).padStart(3, "0")}.ts`,
        ),
        `export const value = ${index};\n`,
        "utf8",
      ),
    ),
  );

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(
    page.getByRole("button", { name: "New thread" }).first(),
  ).toBeVisible();
  const picker = page
    .getByTestId("desktop-sidebar")
    .getByTestId("workspace-picker");
  await picker.click();
  await page.getByLabel("Absolute directory path").fill(alphaWorkspace);
  await page.getByRole("dialog", { name: "Add project" }).getByRole("button", { name: "Add project" }).click();
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
  await page.getByRole("textbox", { name: "Thread name" }).fill("Sheet scroll");
  await selectProjectIfNeeded(page, path.basename(alphaWorkspace));
  await selectCustomNewThreadTarget(page, "Pi SDK");
  await page.getByRole("button", { name: "Create thread" }).click();
  await created;

  await page.setViewportSize({ width: 412, height: 915 });
  await openMobileFilesPanel(page);
  await expect(
    page.getByRole("region", { name: "Workspace files" }),
  ).toBeVisible();
  const mobilePanel = page.getByRole("region", {
    name: "Files panel",
    exact: true,
  });
  await expect(mobilePanel).toBeVisible();

  // The panel is in-flow and starts below the workbench bar, so the bar
  // stays visible and usable for every panel instead of being covered.
  const barBox = await page
    .getByTestId("workspace-workbench-bar")
    .boundingBox();
  const filesSheetBox = await mobilePanel.boundingBox();
  expect(barBox).not.toBeNull();
  expect(filesSheetBox).not.toBeNull();
  expect(filesSheetBox!.y).toBeGreaterThanOrEqual(
    barBox!.y + barBox!.height - 1,
  );
  // Nothing covers the bar: the topmost element at the trigger's own centre
  // is still inside the bar, so it stays tappable while the panel is open.
  const trigger = page
    .getByTestId("workspace-workbench-bar")
    .getByRole("button", { name: "Panels" });
  await expect(trigger).toBeVisible();
  const triggerBox = await trigger.boundingBox();
  expect(triggerBox).not.toBeNull();
  const barOwnsItsRow = await page.evaluate(
    ({ x, y }) =>
      document
        .elementFromPoint(x, y)
        ?.closest('[data-testid="workspace-workbench-bar"]') != null,
    {
      x: triggerBox!.x + triggerBox!.width / 2,
      y: triggerBox!.y + triggerBox!.height / 2,
    },
  );
  expect(barOwnsItsRow).toBe(true);

  const scrollTop = () =>
    page.evaluate(
      () =>
        document
          .querySelector(".workspace-files-tree-host")
          ?.shadowRoot?.querySelector(
            '[data-file-tree-virtualized-scroll="true"]',
          )?.scrollTop ?? -1,
    );
  await expect.poll(scrollTop).toBe(0);

  // Directory contents are loaded only when the user expands that directory.
  await page
    .getByRole("region", { name: "Workspace files" })
    .getByRole("treeitem", { name: /^many(?:\s|$)/ })
    .click();
  await expect(
    page
      .getByRole("region", { name: "Workspace files" })
      .getByRole("treeitem", {
        name: /^very-long-component-name-for-truncation-000\.ts(?:\s|$)/,
      }),
  ).toBeVisible();

  // Supplemental attachments can persist from the earlier serial Files
  // journey. Target the active root's shadow scroller directly.
  const firstTreeBox = await page
    .locator(".workspace-files-tree-host")
    .first()
    .boundingBox();
  expect(firstTreeBox).not.toBeNull();
  const touchX = firstTreeBox!.x + firstTreeBox!.width / 2;
  const touchStartY = firstTreeBox!.y + firstTreeBox!.height - 15;
  const touchEndY = firstTreeBox!.y + 15;

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: touchX, y: touchStartY }],
  });
  for (let step = 1; step <= 12; step += 1) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        {
          x: touchX,
          y: touchStartY - ((touchStartY - touchEndY) * step) / 12,
        },
      ],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect.poll(scrollTop, { timeout: 5_000 }).toBeGreaterThan(100);

  // One surface at a time: tapping a file swaps the full-width browser for
  // the viewer; the toolbar toggle brings the browser back full width.
  const panel = page.getByRole("region", { name: "Workspace files" });
  // CSS locator on purpose: a collapsed (display: none) aside leaves the
  // accessibility tree, so role queries cannot assert its hidden state.
  const browser = panel.locator(".workspace-files-tree");
  // Let the kinetic-scroll state clear; rows ignore taps while scrolling.
  await page.waitForFunction(() => {
    const shadow = document.querySelector(
      ".workspace-files-tree-host",
    )?.shadowRoot;
    return shadow?.querySelector("[data-is-scrolling]") == null;
  });
  await page.waitForTimeout(300);
  // The virtualizer reuses row nodes by viewport slot, so locator-driven
  // auto-scroll taps race it; tap a currently visible file row by
  // coordinates instead.
  const rowPoint = await page.evaluate(() => {
    const shadow = document.querySelector(
      ".workspace-files-tree-host",
    )?.shadowRoot;
    const rows = [...(shadow?.querySelectorAll('[role="treeitem"]') ?? [])];
    const row = rows.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return (
        rect.top > 200 &&
        rect.top < 600 &&
        (candidate.textContent ?? "").includes("very-long")
      );
    });
    const rect = row?.getBoundingClientRect();
    return rect ? { x: rect.x + 80, y: rect.y + rect.height / 2 } : null;
  });
  expect(rowPoint).not.toBeNull();
  await page.touchscreen.tap(rowPoint!.x, rowPoint!.y);
  await expect(panel.locator("main")).toBeVisible();
  await expect(browser).not.toHaveClass(/workspace-files-tree-open/);
  const activeFileTab = panel
    .getByRole("tablist", { name: "Open files" })
    .locator('[role="tab"][aria-selected="true"]');
  const activeFileKey = await activeFileTab.getAttribute(
    "data-workspace-file-key",
  );
  expect(activeFileKey).not.toBeNull();
  const viewerBox = await panel.locator("main").boundingBox();
  const sheetBox = await panel.boundingBox();
  expect(viewerBox!.width).toBeGreaterThan(sheetBox!.width * 0.95);

  await page.getByRole("button", { name: "Toggle file browser" }).tap();
  await expect(browser).toHaveClass(/workspace-files-tree-open/);
  await expect(panel.locator("main")).toBeVisible();
  const viewerWithTreeBox = await panel.locator("main").boundingBox();
  expect(viewerWithTreeBox!.width).toBeCloseTo(viewerBox!.width, 0);
  const browserBox = await browser.boundingBox();
  expect(browserBox!.width).toBeGreaterThan(sheetBox!.width * 0.75);
  expect(browserBox!.width).toBeLessThan(sheetBox!.width * 0.95);

  // The cross-engine override must already suppress Pierre's duplicated
  // overflow copy; packaged clients no longer need a separate injection.
  const overflowDisplay = await page.evaluate(() => {
    const shadow = document.querySelector(
      ".workspace-files-tree-host",
    )?.shadowRoot;
    const overflow = shadow?.querySelector(
      '[data-truncate-content="overflow"]',
    );
    return overflow ? getComputedStyle(overflow).display : "missing";
  });
  expect(overflowDisplay).toBe("none");
  await capture(page, testInfo, "workspace-files-mobile-sheet-scroll.png");

  // Last, because selecting a panel moves focus into it. The menu must paint
  // above the full-stage panel it drops over. Compare their stacking order.
  await trigger.tap();
  await expect(page.getByRole("menu")).toBeVisible();
  const stacking = await page.evaluate(() => {
    const menu = document.querySelector('[data-slot="dropdown-menu-content"]');
    const openPanel = document.querySelector(".workspace-panel-mobile-base");
    if (!menu || !openPanel) return null;
    const menuRect = menu.getBoundingClientRect();
    return {
      overlaps:
        menuRect.bottom > openPanel.getBoundingClientRect().top,
      menuOwnsCenter:
        document
          .elementFromPoint(
            menuRect.left + menuRect.width / 2,
            menuRect.top + menuRect.height / 2,
          )
          ?.closest('[data-slot="dropdown-menu-content"]') === menu,
    };
  });
  expect(stacking?.overlaps).toBe(true);
  expect(stacking?.menuOwnsCenter).toBe(true);

  // Choosing Chat is only a client-local foreground switch on narrow screens,
  // so the open document and browser state survive when the menu restores Files.
  await page.getByRole("menuitem", { name: /^Chat —/ }).tap();
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(mobilePanel).toHaveCount(0);
  await expect(page.getByTestId("thread-view")).toBeVisible();

  await trigger.tap();
  await page.getByRole("menuitem", { name: /^Files —/ }).tap();
  await expect(mobilePanel).toBeVisible();
  await expect(panel.locator("main")).toBeVisible();
  await expect(activeFileTab).toHaveAttribute(
    "data-workspace-file-key",
    activeFileKey!,
  );
  // The open document is durable; the file tree is a transient popover and
  // correctly dismisses when its owning panel is parked.
  await expect(browser).not.toHaveClass(/workspace-files-tree-open/);
});
