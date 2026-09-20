import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { capture, selectCustomNewThreadTarget } from "./helpers";
import {
  alphaWorkspace,
  resetWorkspaceFileFixtures,
} from "./workspace-files-fixture";

async function openWorkspace(page: Page, workspace: string): Promise<void> {
  const picker = page
    .getByTestId("desktop-sidebar")
    .getByTestId("workspace-picker");
  await picker.click();
  await page.getByLabel("Absolute directory path").fill(workspace);
  const opened = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/workspaces/open") &&
      response.status() === 201,
  );
  await page.getByRole("dialog", { name: "Add project" }).getByRole("button", { name: "Add project" }).click();
  await opened;
  await expect(
    page
      .getByTestId("desktop-sidebar")
      .getByTestId("project-filter"),
  ).toContainText(path.basename(workspace));
}

async function createNamedThread(page: Page, name: string): Promise<void> {
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
  await page.getByRole("textbox", { name: "Thread name" }).fill(name);
  await selectCustomNewThreadTarget(page, "Pi SDK");
  await page.getByRole("button", { name: "Create thread" }).click();
  await created;
}

async function openFilesPanel(page: Page): Promise<Locator> {
  const panel = page.getByRole("region", { name: "Workspace files" });
  if (!(await panel.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Panels", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Files(?: —|$)/ }).click();
  }
  await expect(panel).toBeVisible({ timeout: 15_000 });
  return panel;
}

async function ensureTreeOpen(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Toggle file browser" });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

async function selectFile(
  page: Page,
  panel: Locator,
  filename: string,
): Promise<void> {
  await ensureTreeOpen(page);
  const segments = filename.split("/");
  for (const directory of segments.slice(0, -1)) {
    await panel
      .getByRole("complementary", { name: "File browser" })
      .getByRole("treeitem", {
        name: new RegExp(`^${escapeRegExp(directory)}(?:\\s|$)`),
      })
      .click();
  }
  const treeLabel = path.basename(filename);
  await panel
    .getByRole("complementary", { name: "File browser" })
    .getByRole("treeitem", {
      name: new RegExp(`^${escapeRegExp(treeLabel)}(?:\\s|$)`),
    })
    .click();
}

function editor(panel: Locator): Locator {
  return panel.locator('[contenteditable="true"][role="textbox"]');
}

async function enterEditMode(panel: Locator): Promise<Locator> {
  const current = editor(panel);
  if (!(await current.isVisible().catch(() => false))) {
    await panel.getByRole("button", { name: "Edit", exact: true }).click();
  }
  await expect(current).toBeVisible();
  return current;
}

async function replaceEditorContent(
  page: Page,
  editable: Locator,
  content: string,
): Promise<void> {
  await editable.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(content);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test.describe.serial("workspace files compare", () => {
  test.beforeAll(async () => {
    await resetWorkspaceFileFixtures();
  });

  test("compares the working tree without resizing and preserves dirty browse drafts", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await openWorkspace(page, alphaWorkspace);
    await createNamedThread(page, "Alpha compare");

    const panel = await openFilesPanel(page);
    await expect(
      page.locator(
        '[data-panel-id="workspace-files"] .workspace-panel-subtitle',
      ),
    ).toHaveText("alpha");
    await selectFile(page, panel, "src/example.ts");
    const editable = await enterEditMode(panel);
    await replaceEditorContent(
      page,
      editable,
      'export const workspace = "alpha";\nexport const answer = 99;\n',
    );

    await page.getByRole("tab", { name: "Compare" }).click();
    const compareSurface = panel.locator(".workspace-files-compare-surface");
    await expect(compareSurface).toBeVisible();
    await expect(
      compareSurface.getByText(
        "Unsaved Browse drafts are excluded from this comparison.",
      ),
    ).toBeVisible();

    const compareBeforeTree = await compareSurface.boundingBox();
    expect(compareBeforeTree).not.toBeNull();
    const treeToggle = page.getByRole("button", {
      name: "Toggle file browser",
    });
    if ((await treeToggle.getAttribute("aria-expanded")) === "true") {
      await treeToggle.click();
      await expect(treeToggle).toHaveAttribute("aria-expanded", "false");
    }
    await treeToggle.click();
    await expect(treeToggle).toHaveAttribute("aria-expanded", "true");
    const compareAfterTree = await compareSurface.boundingBox();
    expect(compareAfterTree).not.toBeNull();
    expect(
      Math.abs(compareAfterTree!.width - compareBeforeTree!.width),
    ).toBeLessThan(4);
    expect(
      Math.abs(compareAfterTree!.height - compareBeforeTree!.height),
    ).toBeLessThan(4);
    await treeToggle.click();
    await expect(treeToggle).toHaveAttribute("aria-expanded", "false");

    const runCompare = compareSurface.getByRole("button", {
      name: "Compare",
      exact: true,
    });
    await expect(runCompare).toBeEnabled();
    await runCompare.click();
    await expect(compareSurface.getByText(/changed files?/)).toBeVisible({
      timeout: 20_000,
    });

    const filesButton = compareSurface.getByRole("button", {
      name: /Files/,
      exact: false,
    });
    const filesButtonBox = await filesButton.boundingBox();
    await filesButton.click();
    const changedFilesDialog = page.getByRole("dialog", {
      name: "Changed files",
    });
    await expect(changedFilesDialog).toBeVisible();
    await expect(changedFilesDialog.getByText("src/status.ts")).toBeVisible();
    await expect(changedFilesDialog.getByText("untracked.md")).toBeVisible();
    const changedFilesBox = await changedFilesDialog.boundingBox();
    expect(filesButtonBox).not.toBeNull();
    expect(changedFilesBox).not.toBeNull();
    expect(changedFilesBox!.y).toBeGreaterThanOrEqual(filesButtonBox!.y);
    await changedFilesDialog
      .getByRole("button", { name: "Close changed files" })
      .click();
    await expect(changedFilesDialog).toHaveCount(0);

    const reviewedStatusFile = compareSurface
      .locator("diffs-container")
      .filter({ hasText: "src/status.ts" })
      .first();
    const markReviewed = reviewedStatusFile.locator(
      "button.workspace-compare-reviewed",
    );
    await expect(markReviewed).toBeVisible({ timeout: 20_000 });
    await expect(markReviewed).toHaveText("Mark reviewed");
    await markReviewed.click();
    await expect(markReviewed).toHaveText("Reviewed");
    await capture(page, testInfo, "workspace-files-compare-desktop.png");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      compareSurface.getByRole("button", { name: "Split" }),
    ).toBeDisabled();
    await expect(
      compareSurface.getByRole("button", { name: /Comparison and review/ }),
    ).toHaveAttribute("aria-expanded", "false");
    await expect(compareSurface.getByLabel("Repository")).toHaveCount(0);
    await capture(page, testInfo, "workspace-files-compare-mobile.png");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("tab", { name: "Browse" }).click();
    await expect(editor(panel)).toContainText("export const answer = 99;");
  });
});
