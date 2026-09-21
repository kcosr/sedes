import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { writeFile } from "node:fs/promises";
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
  const panel = page.getByRole("region", { name: "Workspace files", exact: true });
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
    const git = async (...args: string[]) => promisify(execFile)("git", ["-C", alphaWorkspace, ...args]);
    await git("branch", "-M", "main");
    await git("checkout", "-b", "feature/navigation");
    await writeFile(path.join(alphaWorkspace, "branch-only.ts"), "export const navigation = true;\n");
    await git("add", "branch-only.ts");
    await git("commit", "-m", "Add branch navigation example");
    await git("checkout", "main");
    await writeFile(path.join(alphaWorkspace, "preview.bin"), Buffer.from([0, 1, 2, 3]));
  });

  test("compares the working tree without resizing and preserves dirty browse drafts", async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    // This isolated server omits pairing. Exercise the admitted-client storage
    // contract here; namespace derivation and admission are integration-tested.
    await page.route("**/api/auth/status", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), navigationNamespace: "e".repeat(64) } });
    });
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

    await page.getByRole("tab", { name: "Changes", exact: true }).click();
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
      name: "Changed files",
      exact: true,
    });
    await filesButton.click();
    const changedFilesDialog = compareSurface.getByRole("complementary", { name: "Changed files" });
    await expect(changedFilesDialog).toBeVisible();
    await expect(changedFilesDialog.getByText("status.ts", { exact: true })).toBeVisible();
    await expect(changedFilesDialog.getByText("untracked.md")).toBeVisible();
    await expect(changedFilesDialog.getByText("preview.bin", { exact: true })).toBeVisible();
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
    // Collapsing Chat gives Files the full reading width and exposes the persistent navigator.
    await page.getByRole("button", { name: "Collapse Chat panel" }).click();
    const navigator = compareSurface.getByRole("complementary", { name: "Changed files" });
    await expect(navigator).toBeVisible();
    await compareSurface.getByRole("button", { name: "Split", exact: true }).click();
    await navigator.getByRole("textbox", { name: "Filter changed files" }).fill("status");
    await navigator.getByRole("treeitem").filter({ hasText: "status.ts" }).click();
    const changedFileFilter = navigator.getByRole("textbox", { name: "Filter changed files" });
    await changedFileFilter.fill("x".repeat(1100));
    await expect(changedFileFilter).toHaveValue("x".repeat(1024));
    await expect.poll(() => page.evaluate(() => {
      const key = Object.keys(localStorage).find((key) => key.startsWith("sedes.files-navigation.v1:"));
      const entry = key && JSON.parse(localStorage.getItem(key)!).entries.find(
        (entry: { mode: string }) => entry.mode === "compare",
      );
      return { filterLength: entry?.navigation?.filter.length, filePath: entry?.navigation?.file?.newPath };
    })).toEqual({ filterLength: 1024, filePath: "src/status.ts" });
    await navigator.getByRole("textbox", { name: "Filter changed files" }).fill("");
    await capture(page, testInfo, "workspace-files-compare-desktop.png");
    await compareSurface.getByRole("button", { name: "Comments (0)", exact: true }).click();
    const review = page.getByRole("dialog", { name: "Review", exact: true });
    await expect(review.getByRole("button", { name: "Current review", exact: true })).toBeVisible();
    const reviewBounds = await review.boundingBox();
    expect(reviewBounds!.y).toBeGreaterThanOrEqual(0);
    expect(reviewBounds!.x + reviewBounds!.width).toBeLessThanOrEqual(1440);
    await capture(page, testInfo, "workspace-files-review-inspector.png");
    await review.getByRole("button", { name: "Close", exact: true }).click();
    await navigator.getByRole("treeitem").filter({ hasText: "preview.bin" }).click();
    await expect(compareSurface.getByText("Binary file — no text diff", { exact: true })).toBeVisible();
    await navigator.getByRole("treeitem").filter({ hasText: "status.ts" }).click();
    // A searchable commit row exposes the subject and date rather than a duplicate hash.
    const settingsToggle = compareSurface.getByRole("button", { name: /Comparison and review/ });
    if (await settingsToggle.getAttribute("aria-expanded") !== "true") await settingsToggle.click();
    await compareSurface.getByRole("button", { name: "Base revision", exact: true }).click();
    const revisionDialog = page.getByRole("dialog", { name: "Choose base revision" });
    await expect(revisionDialog.getByText("Seed workspace file fixture", { exact: true })).toBeVisible();
    await capture(page, testInfo, "workspace-files-revision-picker.png");
    await revisionDialog.getByRole("textbox", { name: "Search base revisions" }).fill("main");
    await expect(revisionDialog.getByRole("listbox").getByRole("option").filter({ hasText: "main" })).toBeVisible();
    await page.keyboard.press("Escape");

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      compareSurface.getByRole("button", { name: "Split" }),
    ).toBeDisabled();
    await expect(
      compareSurface.getByRole("button", { name: /Comparison and review/ }),
    ).toHaveAttribute("aria-expanded", "false");
    await expect(compareSurface.getByRole("button", { name: "Base revision" })).toBeHidden();
    await compareSurface.getByRole("button", { name: "Changed files", exact: true }).click();
    await expect(compareSurface.getByRole("tree", { name: "Changed file tree" })).toBeVisible();
    await compareSurface.getByRole("button", { name: "Close changed files" }).click();
    await capture(page, testInfo, "workspace-files-compare-mobile.png");

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByRole("tab", { name: "Browse" }).click();
    await expect(editor(panel)).toContainText("export const answer = 99;");
    await page.getByRole("tab", { name: "Changes", exact: true }).click();
    await expect(compareSurface.getByRole("button", { name: "Split", exact: true })).toHaveAttribute("aria-pressed", "true");
    // Review the feature branch from its common ancestor with main.
    if (await settingsToggle.getAttribute("aria-expanded") !== "true") await settingsToggle.click();
    await compareSurface.getByRole("button", { name: "Branches", exact: true }).click();
    await compareSurface.getByRole("button", { name: "Compare revision", exact: true }).click();
    await page.getByRole("dialog", { name: "Choose compare revision" }).getByRole("listbox").getByRole("option").filter({ hasText: "feature/navigation" }).click();
    await runCompare.click();
    await expect(compareSurface.getByText("1 changed file", { exact: true })).toBeVisible();
    await expect(compareSurface.locator("diffs-container").filter({ hasText: "branch-only.ts" })).toBeVisible();
    await capture(page, testInfo, "workspace-files-branch-comparison.png");
    // Save the retained Browse draft before reloading the application.
    await page.getByRole("tab", { name: "Browse", exact: true }).click();
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    await expect(panel.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect(panel.getByLabel("Unsaved changes", { exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: "Changes", exact: true }).click();
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.startsWith("sedes.files-navigation.v1:")))).toBe(true);
    await page.reload();
    const restored = await openFilesPanel(page);
    await expect(page.getByRole("tab", { name: "Changes", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(restored.getByText("1 changed file", { exact: true })).toBeVisible();
    await expect(restored.locator("diffs-container").filter({ hasText: "branch-only.ts" })).toBeVisible();
    await page.emulateMedia({ colorScheme: "dark" });
    await capture(page, testInfo, "workspace-files-restored-dark.png");
  });
});
