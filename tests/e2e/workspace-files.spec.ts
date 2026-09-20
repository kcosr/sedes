import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  capture,
  expectNoPageOverflow,
  selectCustomNewThreadTarget,
} from "./helpers";
import {
  alphaExamplePath,
  alphaSupplementalExamplePath,
  alphaSupplementalLinkedPath,
  alphaSupplementalWorkspace,
  alphaUnavailableWorkspace,
  alphaWorkspace,
  betaWorkspace,
  createLiveAlphaFile,
  deleteLiveAlphaFile,
  imageWorkspace,
  linkOnlyWorktreeDisplayPath,
  linkOnlyWorktreeFilePath,
  makeAlphaUnavailableRootDisappear,
  resetWorkspaceFileFixtures,
  updateLiveAlphaFile,
  writeAlphaExample,
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

async function createNamedThread(page: Page, name: string): Promise<string> {
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
  const response = await created;
  const body = (await response.json()) as { threadId: string };
  await expect(page).toHaveURL(new RegExp(`/threads/${body.threadId}$`));
  return `/threads/${body.threadId}`;
}

async function navigateToThread(page: Page, pathname: string): Promise<void> {
  await page.evaluate((nextPath) => {
    window.history.pushState(null, "", nextPath);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, pathname);
}

async function openFilesPanel(page: Page): Promise<Locator> {
  const existing = page.getByRole("region", { name: "Workspace files" });
  if (!(await existing.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Panels", exact: true }).click();
    await page.getByRole("menuitem", { name: /^Files(?: —|$)/ }).click();
  }
  await expect(existing).toBeVisible({ timeout: 15_000 });
  return existing;
}

async function selectFile(
  page: Page,
  panel: Locator,
  filename: string,
): Promise<void> {
  await ensureTreeOpen(page);
  await fileItem(panel, filename).click();
}

function fileItem(panel: Locator, filename: string): Locator {
  return panel
    .getByRole("complementary", { name: "File browser" })
    .getByRole("treeitem", {
      name: new RegExp(`^${escapeRegExp(filename)}(?:\\s|$)`),
    });
}

function fileRoot(panel: Locator, displayLabel: string): Locator {
  return panel.getByRole("tabpanel", {
    name: new RegExp(`^${escapeRegExp(displayLabel)}(?: \\(unavailable\\))?$`),
  });
}

function rootTab(panel: Locator, displayLabel: string): Locator {
  return panel.getByRole("tablist", { name: "File roots" }).getByRole("tab", {
    name: new RegExp(`^${escapeRegExp(displayLabel)}(?: \\(unavailable\\))?$`),
  });
}

async function ensureTreeOpen(page: Page): Promise<void> {
  const toggle = page.getByRole("button", { name: "Toggle file browser" });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
}

async function selectRoot(
  page: Page,
  panel: Locator,
  displayLabel: string,
): Promise<Locator> {
  await ensureTreeOpen(page);
  await rootTab(panel, displayLabel).click();
  const root = fileRoot(panel, displayLabel);
  await expect(root).toBeVisible();
  return root;
}

function rootFileItem(
  panel: Locator,
  displayLabel: string,
  filename: string,
): Locator {
  return fileRoot(panel, displayLabel).getByRole("treeitem", {
    name: new RegExp(`^${escapeRegExp(filename)}(?:\\s|$)`),
  });
}

function fileTab(
  panel: Locator,
  displayLabel: string | undefined,
  relativePath: string,
  linked = false,
): Locator {
  const title = linked
    ? `${relativePath} (linked file)`
    : displayLabel
      ? `${displayLabel}: ${relativePath}`
      : relativePath;
  return panel.locator(`[role="tab"][title=${JSON.stringify(title)}]`);
}

async function attachFileRoot(
  page: Page,
  panel: Locator,
  absolutePath: string,
  displayLabel: string,
): Promise<void> {
  await page.getByRole("button", { name: "Add folder to Files" }).click();
  const dialog = page.getByRole("dialog", { name: "Add folder to Files" });
  await dialog
    .getByRole("textbox", { name: "Absolute folder path" })
    .fill(absolutePath);
  await dialog
    .getByRole("textbox", { name: "Folder display label" })
    .fill(displayLabel);
  const attached = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/file-roots"),
  );
  await dialog.getByRole("button", { name: "Add folder", exact: true }).click();
  expect((await attached).status()).toBe(201);
  await ensureTreeOpen(page);
  await expect(rootTab(panel, displayLabel)).toBeVisible();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  // Pierre owns the text model from beforeinput rather than reading the
  // contenteditable DOM after a generic fill operation.
  await page.keyboard.type(content);
}

test.describe.serial("workspace file browser and editor", () => {
  test.beforeAll(async () => {
    await resetWorkspaceFileFixtures();
  });

  test("browses, edits, resolves conflicts, synchronizes, retains scope, and uses a mobile panel", async ({
    browserDiagnostics,
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "New thread" }).first(),
    ).toBeVisible();

    await openWorkspace(page, alphaWorkspace);
    const alphaOne = await createNamedThread(page, "Alpha files one");
    const alphaTwo = await createNamedThread(page, "Alpha files two");
    await openWorkspace(page, betaWorkspace);
    const betaThread = await createNamedThread(page, "Beta files");
    await navigateToThread(page, alphaOne);
    await expect(page).toHaveURL(alphaOne);

    let panel = await openFilesPanel(page);
    // The panel mounts before its asynchronous root listing reaches the tree.
    await expect(fileItem(panel, "src")).toBeVisible();
    // The browser rail must fill the panel before any file is open — a
    // regression here collapses the tree to its empty-state content height.
    const panelBox = await panel.boundingBox();
    const treeBox = await panel
      .getByRole("complementary", { name: "File browser" })
      .boundingBox();
    expect(panelBox).not.toBeNull();
    expect(treeBox).not.toBeNull();
    expect(treeBox!.height).toBeGreaterThan(panelBox!.height * 0.7);
    const fileTreeBox = await panel
      .locator(".workspace-files-tree-host")
      .boundingBox();
    expect(fileTreeBox).not.toBeNull();
    expect(fileTreeBox!.height).toBeGreaterThan(treeBox!.height * 0.85);
    const truncationCopies = await panel
      .locator(".workspace-files-tree-host")
      .evaluate((host) => {
        const shadow = host.shadowRoot;
        if (!shadow) throw new Error("tree shadow root missing");
        return {
          overflow: [
            ...shadow.querySelectorAll<HTMLElement>(
              '[data-truncate-content="overflow"]',
            ),
          ].map((element) => getComputedStyle(element).display),
          markers: [
            ...shadow.querySelectorAll<HTMLElement>(
              "[data-truncate-marker-cell]",
            ),
          ].map((element) => getComputedStyle(element).display),
        };
      });
    expect(truncationCopies.overflow.length).toBeGreaterThan(0);
    expect(truncationCopies.markers.length).toBeGreaterThan(0);
    expect(new Set(truncationCopies.overflow)).toEqual(new Set(["none"]));
    expect(new Set(truncationCopies.markers)).toEqual(new Set(["none"]));
    // With nothing open the browser opens automatically as an overlay.
    await expect(panel.locator("main")).toHaveCount(0);
    await expect(
      panel.getByRole("separator", { name: "Resize file browser" }),
    ).toHaveCount(0);
    await fileItem(panel, "src").click();
    await expect(fileItem(panel, "example.ts")).toBeVisible();
    await expect(fileItem(panel, "status.ts")).toBeVisible();
    await expect(fileItem(panel, "untracked.md")).toBeVisible();
    await fileItem(panel, "docs").click();
    // Sorts after docs/ canonically but before it in byte order; both it and
    // its byte-order successors must survive tree construction.
    await expect(fileItem(panel, "SPEC.md")).toBeVisible();
    await expect(fileItem(panel, "guide.md")).toBeVisible();
    // Browse is filesystem-backed; Git ignore state belongs to Compare.
    await expect(fileItem(panel, "ignored.txt")).toBeVisible();
    const initialTreeBox = await panel
      .getByRole("complementary", { name: "File browser" })
      .boundingBox();
    expect(initialTreeBox).not.toBeNull();
    expect(initialTreeBox!.width).toBeLessThan(panelBox!.width);
    await selectFile(page, panel, "example.ts");
    await expect(panel).toContainText('export const workspace = "alpha";');
    await expect(
      panel.getByRole("button", {
        name: "Download saved file src/example.ts",
      }),
    ).toBeVisible();
    const viewerBeforeTree = await panel.locator("main").boundingBox();
    await page.getByRole("button", { name: "Toggle file browser" }).click();
    await expect(
      panel.getByRole("complementary", { name: "File browser" }),
    ).toBeVisible();
    const viewerWithTree = await panel.locator("main").boundingBox();
    expect(viewerWithTree!.x).toBeCloseTo(viewerBeforeTree!.x, 0);
    expect(viewerWithTree!.width).toBeCloseTo(viewerBeforeTree!.width, 0);
    await expect(
      panel.getByRole("separator", { name: "Resize file browser" }),
    ).toHaveCount(0);
    await capture(page, testInfo, "workspace-files-tree-overlay.png");

    await selectFile(page, panel, "SPEC.md");
    await expect(
      panel.getByRole("heading", { name: "Alpha spec" }),
    ).toBeVisible();
    const diagram = panel.getByRole("img", { name: "Mermaid diagram" });
    await expect(diagram).toBeVisible();
    const diagramBlock = panel.locator(".mermaid-diagram");
    const diagramSvg = diagramBlock.locator(".mermaid-diagram-svg > svg");
    await expect(diagramSvg).toHaveCount(1);
    const [diagramBlockBox, diagramSvgBox] = await Promise.all([
      diagramBlock.boundingBox(),
      diagramSvg.boundingBox(),
    ]);
    expect(diagramBlockBox).not.toBeNull();
    expect(diagramSvgBox).not.toBeNull();
    expect(diagramSvgBox!.width).toBeGreaterThan(diagramBlockBox!.width * 0.85);
    expect(diagramSvgBox!.height).toBeGreaterThan(520);
    await expect(diagramBlock).toHaveCSS(
      "background-color",
      "rgba(0, 0, 0, 0)",
    );
    await expect(diagramBlock).toHaveCSS("border-style", "none");
    const markdownViewer = await panel.locator("main").boundingBox();
    expect(markdownViewer!.width).toBeCloseTo(viewerBeforeTree!.width, 0);
    const expandDiagram = panel.getByRole("button", {
      name: "Expand Mermaid diagram",
    });
    await diagram.click();
    const diagramDialog = page.getByRole("dialog", {
      name: "Mermaid diagram preview",
    });
    await expect(diagramDialog).toBeVisible();
    const diagramPreviewImage = diagramDialog.locator(
      ".zoomable-preview-content > img",
    );
    await expect(diagramPreviewImage).toBeVisible();
    const diagramViewport = diagramDialog.getByRole("region", {
      name: "Mermaid diagram preview",
    });
    const [diagramPreviewImageBox, diagramViewportBox] = await Promise.all([
      diagramPreviewImage.boundingBox(),
      diagramViewport.boundingBox(),
    ]);
    expect(diagramPreviewImageBox).not.toBeNull();
    expect(diagramViewportBox).not.toBeNull();
    await expect(diagramPreviewImage).toHaveCSS("object-fit", "contain");
    expect(diagramPreviewImageBox!.width).toBeGreaterThan(
      diagramViewportBox!.width * 0.85,
    );
    const initialDiagramScrollRange = await diagramViewport.evaluate(
      (element) => ({
        horizontal: element.scrollWidth - element.clientWidth,
        vertical: element.scrollHeight - element.clientHeight,
      }),
    );
    expect(initialDiagramScrollRange.horizontal).toBeLessThanOrEqual(1);
    expect(initialDiagramScrollRange.vertical).toBeLessThanOrEqual(1);
    const initialCanvasBox = await diagramDialog
      .locator(".zoomable-preview-canvas")
      .boundingBox();
    expect(initialCanvasBox).not.toBeNull();
    await diagramDialog.getByRole("button", { name: "Zoom out" }).click();
    await expect(diagramDialog.getByLabel("Zoom level")).toHaveText("75%");
    const [reducedImageBox, reducedCanvasBox, reducedViewportBox] =
      await Promise.all([
        diagramPreviewImage.boundingBox(),
        diagramDialog.locator(".zoomable-preview-canvas").boundingBox(),
        diagramViewport.boundingBox(),
      ]);
    expect(reducedImageBox).not.toBeNull();
    expect(reducedCanvasBox).not.toBeNull();
    expect(reducedViewportBox).not.toBeNull();
    expect(reducedViewportBox!.width).toBeCloseTo(diagramViewportBox!.width, 0);
    expect(reducedViewportBox!.height).toBeCloseTo(
      diagramViewportBox!.height,
      0,
    );
    expect(reducedCanvasBox!.width).toBeCloseTo(
      initialCanvasBox!.width * 0.75,
      0,
    );
    expect(reducedImageBox!.width).toBeCloseTo(
      diagramPreviewImageBox!.width * 0.75,
      0,
    );
    await diagramDialog
      .getByRole("button", { name: "Reset diagram view" })
      .click();
    await expect(diagramDialog.getByLabel("Zoom level")).toHaveText("100%");
    const trackpadPrevented = await diagramViewport.evaluate((element) => {
      const event = new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        ctrlKey: true,
        clientX: element.getBoundingClientRect().left + 24,
        clientY: element.getBoundingClientRect().top + 24,
        deltaY: -40,
      });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    });
    expect(trackpadPrevented).toBe(true);
    await expect(diagramDialog.getByLabel("Zoom level")).not.toHaveText("100%");
    await diagramDialog
      .getByRole("button", { name: "Reset diagram view" })
      .click();
    const zoomInDiagram = diagramDialog.getByRole("button", {
      name: "Zoom in",
    });
    await zoomInDiagram.click();
    await expect(diagramDialog.getByLabel("Zoom level")).toHaveText("125%");
    await zoomInDiagram.click();
    await expect(diagramDialog.getByLabel("Zoom level")).toHaveText("150%");
    const diagramScrollRange = await diagramViewport.evaluate((element) => ({
      horizontal: element.scrollWidth - element.clientWidth,
      vertical: element.scrollHeight - element.clientHeight,
    }));
    expect(diagramScrollRange.horizontal).toBeGreaterThan(0);
    expect(diagramScrollRange.vertical).toBeGreaterThan(0);
    await expectNoPageOverflow(page);
    // Radix Presence treats Playwright's forced animation completion as an
    // exit transition. Preserve motion for this open-dialog capture so the
    // test can still verify the explicit close and focus restoration below.
    await capture(page, testInfo, "workspace-files-mermaid-diagram-zoom.png", {
      animations: "allow",
    });
    await diagramDialog.getByRole("button", { name: "Close" }).click();
    await expect(diagramDialog).toHaveCount(0);
    await expect(expandDiagram).toBeFocused();
    await expect(editor(panel)).toHaveCount(0);
    await panel.getByRole("button", { name: "Edit", exact: true }).click();
    await expect(editor(panel)).toBeVisible();
    await expect(editor(panel)).toContainText("Alpha spec");
    await panel.getByRole("button", { name: "Done", exact: true }).click();
    await expect(
      panel.getByRole("heading", { name: "Alpha spec" }),
    ).toBeVisible();
    await capture(page, testInfo, "workspace-files-markdown-preview.png");
    await panel.getByRole("tab", { name: /example\.ts/ }).click();
    await expect(panel).toContainText('export const workspace = "alpha";');

    let editable = await enterEditMode(panel);
    const savedContent = [
      'export const workspace = "alpha";',
      "export const answer = 42;",
      "",
    ].join("\n");
    await replaceEditorContent(page, editable, savedContent);
    await expect(
      panel.getByRole("button", { name: "Save", exact: true }),
    ).toBeEnabled();
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes("/files/content") &&
        response.ok(),
    );
    await editable.press("Control+s");
    await saved;
    await expect
      .poll(() => readFile(alphaExamplePath, "utf8"))
      .toBe(savedContent);
    await expect(
      panel.getByRole("button", { name: "Save", exact: true }),
    ).toBeDisabled();
    await capture(page, testInfo, "workspace-files-edit-saved.png");

    const reloadDraft = savedContent.replace("42", "43");
    await replaceEditorContent(page, editable, reloadDraft);
    await writeAlphaExample(savedContent.replace("42", "100"));
    browserDiagnostics.allowNetworkFailures = true;
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    let conflict = page.getByRole("dialog", { name: "File changed on disk" });
    await expect(conflict).toBeVisible();
    browserDiagnostics.allowNetworkFailures = false;
    await expect(conflict).toContainText("Your draft has not been lost.");
    await capture(page, testInfo, "workspace-files-conflict.png");
    await conflict.getByRole("button", { name: "Keep editing" }).click();
    editable = editor(panel);
    await expect(editable).toContainText("43");
    await panel
      .getByRole("button", { name: "File changed on disk. Resolve conflict." })
      .click();
    conflict = page.getByRole("dialog", { name: "File changed on disk" });
    await conflict.getByRole("button", { name: "Reload" }).click();
    await expect(conflict).toHaveCount(0);
    await expect(panel).toContainText("100");

    editable = await enterEditMode(panel);
    const overwriteDraft = savedContent.replace("42", "44");
    await replaceEditorContent(page, editable, overwriteDraft);
    await writeAlphaExample(savedContent.replace("42", "101"));
    browserDiagnostics.allowNetworkFailures = true;
    await panel.getByRole("button", { name: "Save", exact: true }).click();
    conflict = page.getByRole("dialog", { name: "File changed on disk" });
    await expect(conflict).toBeVisible();
    browserDiagnostics.allowNetworkFailures = false;
    await conflict.getByRole("button", { name: "Overwrite" }).click();
    await expect(conflict).toHaveCount(0);
    await expect
      .poll(() => readFile(alphaExamplePath, "utf8"))
      .toBe(overwriteDraft);

    const retainedDraft = overwriteDraft.replace("44", "45");
    editable = await enterEditMode(panel);
    await replaceEditorContent(page, editable, retainedDraft);
    await panel
      .getByRole("button", {
        name: "Download saved file src/example.ts",
      })
      .click();
    const savedVersionDialog = page.getByRole("dialog", {
      name: "Download saved version?",
    });
    await expect(savedVersionDialog).toContainText(
      "The download will contain the version currently saved on disk, not your draft.",
    );
    browserDiagnostics.allowNetworkFailures = true;
    const savedVersionDownload = page.waitForEvent("download");
    await savedVersionDialog
      .getByRole("button", { name: "Download saved version" })
      .click();
    const savedVersion = await savedVersionDownload;
    expect(savedVersion.suggestedFilename()).toBe("example.ts");
    expect(await readFile((await savedVersion.path())!, "utf8")).toBe(
      overwriteDraft,
    );
    browserDiagnostics.allowNetworkFailures = false;
    await expect(editable).toContainText("45");
    await page.getByRole("button", { name: "Toggle file browser" }).click();
    await createLiveAlphaFile('export const live = "created";\n');
    await page.getByRole("button", { name: "Refresh workspace files" }).click();
    let reload = page.getByRole("dialog", { name: "Reload file from disk?" });
    await reload.getByRole("button", { name: "Cancel" }).click();
    await ensureTreeOpen(page);
    await expect(fileItem(panel, "live-created.ts")).toBeVisible({
      timeout: 15_000,
    });
    await expect(editable).toContainText("45");
    await updateLiveAlphaFile('export const live = "modified";\n');
    await expect(editable).toContainText("45");
    await deleteLiveAlphaFile();
    await page.getByRole("button", { name: "Refresh workspace files" }).click();
    reload = page.getByRole("dialog", { name: "Reload file from disk?" });
    await reload.getByRole("button", { name: "Cancel" }).click();
    await ensureTreeOpen(page);
    await expect(fileItem(panel, "live-created.ts")).toHaveCount(0, {
      timeout: 15_000,
    });
    await expect(editable).toContainText("45");
    await capture(page, testInfo, "workspace-files-external-sync-dirty.png");

    await editable.evaluate((node) => {
      (
        window as typeof window & { __dirtyFilesEditor?: Element }
      ).__dirtyFilesEditor = node;
    });
    await page.getByRole("button", { name: "Close Files panel" }).click();
    const closeGuard = page.getByRole("dialog", {
      name: "Discard unsaved changes?",
    });
    await expect(closeGuard).toContainText(
      "Closing Files will discard its unsaved changes.",
    );
    await closeGuard.getByRole("button", { name: "Cancel" }).click();
    await expect(editable).toContainText("45");

    await page.getByRole("button", { name: "Collapse Files panel" }).click();
    await expect(panel).toBeHidden();
    await expect(
      page.getByRole("dialog", { name: "Discard unsaved changes?" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Panels" }).click();
    const restoreFiles = page.getByRole("menuitem", {
      name: /^Files —.*Collapsed$/,
    });
    await expect(restoreFiles.getByLabel("Unsaved changes")).toBeVisible();
    await restoreFiles.click();
    await expect(panel).toBeVisible();
    await expect(editable).toContainText("45");
    expect(
      await editable.evaluate(
        (node) =>
          (window as typeof window & { __dirtyFilesEditor?: Element })
            .__dirtyFilesEditor === node,
      ),
    ).toBe(true);

    await navigateToThread(page, alphaTwo);
    await expect(page).toHaveURL(alphaTwo);
    panel = await openFilesPanel(page);
    editable = editor(panel);
    await expect(editable).toContainText("45");

    await navigateToThread(page, betaThread);
    let workspaceGuard = page.getByRole("dialog", {
      name: "Discard unsaved changes?",
    });
    await expect(workspaceGuard).toContainText("unsaved panel changes");
    await workspaceGuard.getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(alphaTwo);
    await expect(editable).toContainText("45");

    await navigateToThread(page, betaThread);
    workspaceGuard = page.getByRole("dialog", {
      name: "Discard unsaved changes?",
    });
    await workspaceGuard
      .getByRole("button", { name: "Discard and leave" })
      .click();
    await expect(page).toHaveURL(betaThread);
    panel = page.getByRole("region", { name: "Workspace files" });
    await expect(panel).toBeVisible({ timeout: 15_000 });
    await ensureTreeOpen(page);
    await fileItem(panel, "app").click();
    await expect(fileItem(panel, "beta.ts")).toBeVisible();
    await expect(fileItem(panel, "example.ts")).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("region", { name: "Files panel", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Workspace files" }),
    ).toBeVisible();
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "workspace-files-mobile-sheet.png");
  });

  test("attaches bounded roots and routes Markdown path links through Files", async ({
    browserDiagnostics,
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await resetWorkspaceFileFixtures();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "New thread" }).first(),
    ).toBeVisible();

    await openWorkspace(page, alphaWorkspace);
    await createNamedThread(page, "Supplemental files");
    const panel = await openFilesPanel(page);

    await attachFileRoot(
      page,
      panel,
      alphaSupplementalWorkspace,
      "Agent context",
    );
    await attachFileRoot(
      page,
      panel,
      alphaUnavailableWorkspace,
      "Unavailable fixture",
    );

    // Root tabs keep identical relative paths as distinct addresses while one
    // full-height tree occupies the browser rail.
    await selectRoot(page, panel, "Agent context");
    await rootFileItem(panel, "Agent context", "src").click();
    await rootFileItem(panel, "Agent context", "example.ts").click();
    await expect(panel).toContainText('workspace = "alpha supplemental"');
    await selectRoot(page, panel, "alpha");
    await rootFileItem(panel, "alpha", "src").click();
    await rootFileItem(panel, "alpha", "example.ts").click();
    await expect(panel).toContainText('workspace = "alpha"');
    await expect(panel.getByRole("tab", { name: /example\.ts/ })).toHaveCount(
      2,
    );
    await expect(panel.locator(".workspace-files-tree-host")).toHaveCount(1);
    await capture(page, testInfo, "workspace-files-tabbed-roots.png");

    await selectRoot(page, panel, "alpha");
    await rootFileItem(panel, "alpha", "docs").click();
    await rootFileItem(panel, "alpha", "guide.md").click();
    const relativeResolved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/file-links/resolve") &&
        response.ok(),
    );
    await panel.getByRole("link", { name: "Guide details" }).click();
    await relativeResolved;
    await expect(
      panel.getByRole("heading", { name: "Guide details" }),
    ).toBeVisible();

    await fileTab(panel, "Agent context", "src/example.ts").click();
    let editable = await enterEditMode(panel);
    const savedSupplemental =
      'export const workspace = "alpha supplemental saved";\n';
    await replaceEditorContent(page, editable, savedSupplemental);
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().includes("/files/content") &&
        response.ok(),
    );
    await editable.press("Control+s");
    await saved;
    await expect
      .poll(() => readFile(alphaSupplementalExamplePath, "utf8"))
      .toBe(savedSupplemental);

    // The browser passes explicit file URLs, assistant-style absolute paths,
    // and workspace-relative paths to the server resolver. Absolute paths can
    // address attached roots; relative paths intentionally address primary.
    // A file elsewhere in this allowed Git worktree opens through a hidden
    // link-only root without adding that worktree to the visible root tabs.
    const attachedHref = `${pathToFileURL(alphaSupplementalLinkedPath).href}:3`;
    const linkOnlyHref = pathToFileURL(linkOnlyWorktreeFilePath).href;
    const composer = page.getByRole("textbox", { name: /Message/ });
    await composer.fill(
      `[supplemental file link](${attachedHref}), [primary absolute link](${alphaExamplePath}), [primary relative link](src/example.ts), and [link-only worktree file](${linkOnlyHref})`,
    );
    await page.getByRole("button", { name: "Send message" }).click();
    const assistant = page.locator(
      '[data-item-kind="assistant_message"][data-item-status="completed"]',
    );
    await expect(assistant).toContainText("supplemental file link", {
      timeout: 15_000,
    });

    // The normalized whole-file write opens through the same resolver and
    // seeks line 1 in the rendered Markdown preview without entering edit mode.
    const activityToggle = page
      .getByTestId("activity-group")
      .last()
      .getByRole("button", { name: /^Activity/ });
    if ((await activityToggle.getAttribute("aria-expanded")) !== "true") {
      await activityToggle.click();
    }
    const completedWrite = page
      .locator('[data-item-kind="file_change"][data-item-status="completed"]')
      .filter({ hasText: "streaming-notes.md" });
    const completedWriteToggle = completedWrite.getByRole("button", {
      name: /Write/,
    });
    if ((await completedWriteToggle.getAttribute("aria-expanded")) !== "true") {
      await completedWriteToggle.click();
    }
    const writeResolved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/file-links/resolve") &&
        response.ok(),
    );
    await completedWrite
      .getByRole("button", {
        name: "Open streaming-notes.md in Files at line 1",
      })
      .click();
    await writeResolved;
    await expect(
      fileTab(panel, undefined, "streaming-notes.md"),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      panel.getByRole("heading", { name: "Streaming notes" }),
    ).toBeInViewport();

    // A file link must override a restored open-tree snapshot when Files is
    // cold-mounted. The document should open directly without listing a
    // directory or restoring the tree overlay above it.
    const treeToggle = page.getByRole("button", {
      name: "Toggle file browser",
    });
    await ensureTreeOpen(page);
    await expect(treeToggle).toHaveAttribute("aria-expanded", "true");
    await page.getByRole("button", { name: "Close Files panel" }).click();
    await expect(panel).toHaveCount(0);

    const resolved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/file-links/resolve") &&
        response.ok(),
    );
    await assistant
      .getByRole("link", { name: "supplemental file link" })
      .click();
    await resolved;
    await expect(
      panel.getByRole("heading", { name: "Linked supplemental note" }),
    ).toBeVisible();
    await expect(
      panel.getByText("Opened from rendered Markdown."),
    ).toBeInViewport();
    await expect(
      fileTab(panel, "Agent context", "linked-note.md"),
    ).toHaveAttribute("aria-selected", "true");
    await expect(treeToggle).toHaveAttribute("aria-expanded", "false");

    for (const linkName of ["primary absolute link", "primary relative link"]) {
      const primaryResolved = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes("/file-links/resolve") &&
          response.ok(),
      );
      await assistant.getByRole("link", { name: linkName }).click();
      await primaryResolved;
      await expect(fileTab(panel, undefined, "src/example.ts")).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await expect(panel).toContainText('workspace = "alpha"');
    }
    await fileTab(panel, "Agent context", "linked-note.md").click();

    const linkOnlyResolved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/file-links/resolve") &&
        response.ok(),
    );
    await assistant
      .getByRole("link", { name: "link-only worktree file" })
      .click();
    await linkOnlyResolved;
    await expect(
      panel.getByRole("heading", {
        name: "Link-only worktree file",
      }),
    ).toBeVisible();
    await expect(
      fileTab(panel, undefined, linkOnlyWorktreeDisplayPath, true),
    ).toHaveAttribute("aria-selected", "true");
    await expect(
      panel
        .getByRole("tablist", { name: "File roots" })
        .getByRole("tab", { name: /link-only-worktree/ }),
    ).toHaveCount(0);
    await expect(treeToggle).toHaveAttribute("aria-expanded", "false");

    await treeToggle.click();
    await expect(treeToggle).toHaveAttribute("aria-expanded", "true");

    // One vanished root degrades independently; primary and other roots remain
    // browsable and the durable attachment stays visible for explicit removal.
    await makeAlphaUnavailableRootDisappear();
    browserDiagnostics.allowNetworkFailures = true;
    await page.getByRole("button", { name: "Refresh workspace files" }).click();
    await selectRoot(page, panel, "Unavailable fixture");
    await expect(fileRoot(panel, "Unavailable fixture")).toContainText(
      "This folder is no longer available.",
      { timeout: 15_000 },
    );
    browserDiagnostics.allowNetworkFailures = false;
    await fileTab(panel, undefined, "src/example.ts").click();
    await expect(panel).toContainText('workspace = "alpha"');
    await fileTab(panel, "Agent context", "src/example.ts").click();
    await expect(panel).toContainText("alpha supplemental saved");

    // Removing a supplemental with a dirty document requires an explicit
    // destructive confirmation and never deletes the folder's bytes.
    editable = await enterEditMode(panel);
    await replaceEditorContent(
      page,
      editable,
      'export const workspace = "dirty supplemental draft";\n',
    );
    await ensureTreeOpen(page);
    await panel
      .getByRole("button", { name: "Remove folder Agent context" })
      .click();
    let removeDialog = page.getByRole("dialog", {
      name: "Remove folder from Files?",
    });
    await expect(removeDialog).toContainText("unsaved changes");
    await removeDialog.getByRole("button", { name: "Cancel" }).click();
    await ensureTreeOpen(page);
    await expect(fileRoot(panel, "Agent context")).toBeVisible();

    await panel
      .getByRole("button", { name: "Remove folder Agent context" })
      .click();
    removeDialog = page.getByRole("dialog", {
      name: "Remove folder from Files?",
    });
    const removed = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().includes("/file-roots/") &&
        response.ok(),
    );
    await removeDialog.getByRole("button", { name: "Remove folder" }).click();
    await removed;
    await expect(rootTab(panel, "Agent context")).toHaveCount(0);
    await expect(readFile(alphaSupplementalExamplePath, "utf8")).resolves.toBe(
      savedSupplemental,
    );
  });

  test("previews real raster fixtures and refuses oversized or generic binary content", async ({
    browserDiagnostics,
    page,
  }, testInfo) => {
    test.setTimeout(120_000);
    await resetWorkspaceFileFixtures();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/");
    await expect(
      page.getByRole("button", { name: "New thread" }).first(),
    ).toBeVisible();

    await openWorkspace(page, imageWorkspace);
    await createNamedThread(page, "Image previews");
    let panel = await openFilesPanel(page);
    for (const [filename, mediaType] of [
      ["preview.png", "image/png"],
      ["preview.jpg", "image/jpeg"],
      ["preview.gif", "image/gif"],
      ["preview.webp", "image/webp"],
    ] as const) {
      await selectFile(page, panel, filename);
      const image = panel.locator(".zoomable-preview-viewport img");
      await expect(image).toBeVisible();
      await expect(image).toHaveAttribute(
        "src",
        new RegExp(`^data:${mediaType};base64,`),
      );
      const dimensions = await image.evaluate(async (element) => {
        const raster = element as HTMLImageElement;
        await raster.decode();
        return { width: raster.naturalWidth, height: raster.naturalHeight };
      });
      expect(dimensions.width).toBeGreaterThan(0);
      expect(dimensions.height).toBeGreaterThan(0);
      await expect(
        panel.locator(".zoomable-preview-toolbar > span"),
      ).toHaveAttribute("title", filename);
      await expect(
        panel.getByRole("button", { name: "Edit", exact: true }),
      ).toHaveCount(0);
      await expect(
        panel.getByRole("button", { name: "Save", exact: true }),
      ).toHaveCount(0);
      await expect(
        panel.getByRole("button", {
          name: `Download saved file ${filename}`,
        }),
      ).toBeVisible();
    }

    await fileTab(panel, undefined, "preview.png").click();
    await expect(panel.locator(".zoomable-preview-viewport img")).toBeVisible();
    const desktopViewport = panel.getByRole("region", {
      name: "Image preview for preview.png",
    });
    await expect(panel.getByLabel("Zoom level")).toHaveText("100%");
    for (let step = 0; step < 4; step += 1) {
      await panel.getByRole("button", { name: "Zoom in" }).click();
    }
    await expect(panel.getByLabel("Zoom level")).toHaveText("200%");
    const initialScroll = await desktopViewport.evaluate((element) => ({
      left: element.scrollLeft,
      top: element.scrollTop,
      maximumLeft: element.scrollWidth - element.clientWidth,
      maximumTop: element.scrollHeight - element.clientHeight,
    }));
    expect(initialScroll.maximumLeft).toBeGreaterThan(0);
    expect(initialScroll.maximumTop).toBeGreaterThan(0);
    const desktopViewportBox = await desktopViewport.boundingBox();
    expect(desktopViewportBox).not.toBeNull();
    await page.mouse.move(
      desktopViewportBox!.x + desktopViewportBox!.width / 2,
      desktopViewportBox!.y + desktopViewportBox!.height / 2,
    );
    await page.mouse.down();
    await page.mouse.move(
      desktopViewportBox!.x + desktopViewportBox!.width / 2 - 80,
      desktopViewportBox!.y + desktopViewportBox!.height / 2 - 60,
      { steps: 4 },
    );
    await page.mouse.up();
    const draggedScroll = await desktopViewport.evaluate((element) => ({
      left: element.scrollLeft,
      top: element.scrollTop,
      maximumLeft: element.scrollWidth - element.clientWidth,
      maximumTop: element.scrollHeight - element.clientHeight,
    }));
    expect(draggedScroll.left).toBeGreaterThan(initialScroll.left);
    expect(draggedScroll.top).toBeGreaterThan(initialScroll.top);
    expect(draggedScroll.left).toBeLessThanOrEqual(draggedScroll.maximumLeft);
    expect(draggedScroll.top).toBeLessThanOrEqual(draggedScroll.maximumTop);
    await capture(page, testInfo, "workspace-files-image-preview-zoomed.png");

    await fileTab(panel, undefined, "preview.jpg").click();
    await expect(panel.getByLabel("Zoom level")).toHaveText("100%");
    await fileTab(panel, undefined, "preview.png").click();
    await expect(panel.getByLabel("Zoom level")).toHaveText("200%");
    await panel.getByRole("button", { name: "Reset image view" }).click();
    await expect(panel.getByLabel("Zoom level")).toHaveText("100%");
    await expect
      .poll(() =>
        desktopViewport.evaluate((element) => ({
          left: element.scrollLeft,
          top: element.scrollTop,
        })),
      )
      .toEqual({ left: 0, top: 0 });
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "workspace-files-image-preview.png");

    await selectFile(page, panel, "oversized.png");
    await expect(
      panel.getByText("Image is larger than the preview limit (16 MiB)."),
    ).toBeVisible();
    await expect(panel.locator(".zoomable-preview-viewport img")).toHaveCount(
      0,
    );
    browserDiagnostics.allowNetworkFailures = true;
    const oversizedDownloadEvent = page.waitForEvent("download");
    await panel
      .getByRole("button", {
        name: "Download saved file oversized.png",
      })
      .click();
    const oversizedDownload = await oversizedDownloadEvent;
    expect(oversizedDownload.suggestedFilename()).toBe("oversized.png");
    const oversizedBytes = await readFile((await oversizedDownload.path())!);
    expect(oversizedBytes.byteLength).toBe(16 * 1_024 * 1_024 + 1);
    expect(oversizedBytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(oversizedBytes.at(-1)).toBe(0x61);
    browserDiagnostics.allowNetworkFailures = false;
    await selectFile(page, panel, "unknown.bin");
    await expect(
      panel.getByText("Binary files cannot be displayed."),
    ).toBeVisible();
    await expect(panel.locator(".zoomable-preview-viewport img")).toHaveCount(
      0,
    );
    await expect(
      panel.getByRole("button", {
        name: "Download saved file unknown.bin",
      }),
    ).toBeVisible();

    await writeFile(
      path.join(imageWorkspace, "unknown.bin"),
      Buffer.from([0x04, 0x05, 0x06, 0x07]),
    );
    browserDiagnostics.allowNetworkFailures = true;
    const stalePreflight = page.waitForResponse(
      (response) =>
        response.request().method() === "HEAD" &&
        response.url().includes("/files/download?") &&
        response.status() === 409,
    );
    await panel
      .getByRole("button", {
        name: "Download saved file unknown.bin",
      })
      .click();
    await stalePreflight;
    await expect(panel.getByRole("alert")).toContainText(
      "The file changed on disk. Refresh it before downloading.",
    );

    const refreshedBinary = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().includes("/files/content?") &&
        response.url().includes("unknown.bin") &&
        response.ok(),
    );
    await page.getByRole("button", { name: "Refresh workspace files" }).click();
    await refreshedBinary;

    let interceptedHead = false;
    let unexpectedDownloadCount = 0;
    const countUnexpectedDownload = (): void => {
      unexpectedDownloadCount += 1;
    };
    page.on("download", countUnexpectedDownload);
    await page.route("**/files/download?**", async (route) => {
      if (route.request().method() !== "HEAD" || interceptedHead) {
        await route.continue();
        return;
      }
      interceptedHead = true;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await writeFile(
        path.join(imageWorkspace, "unknown.bin"),
        Buffer.from([0x08, 0x09, 0x0a, 0x0b]),
      );
      await route.fulfill({ response });
    });
    const racedGet = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().includes("/files/download?") &&
        response.status() === 409,
    );
    await panel
      .getByRole("button", {
        name: "Download saved file unknown.bin",
      })
      .click();
    await racedGet;
    expect(interceptedHead).toBe(true);
    expect(unexpectedDownloadCount).toBe(0);
    await expect(panel.getByRole("alert")).toContainText(
      "The file could not be downloaded. Refresh it and try again.",
    );
    page.off("download", countUnexpectedDownload);
    await page.unroute("**/files/download?**");
    browserDiagnostics.allowNetworkFailures = false;

    await fileTab(panel, undefined, "preview.png").click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      page.getByRole("region", { name: "Files panel", exact: true }),
    ).toBeVisible();
    panel = page.getByRole("region", { name: "Workspace files" });
    await fileTab(panel, undefined, "preview.png").click();
    const image = panel.locator(".zoomable-preview-viewport img");
    await expect(image).toBeVisible();
    const [imageBox, previewBox] = await Promise.all([
      image.boundingBox(),
      panel.locator(".zoomable-preview-viewport").boundingBox(),
    ]);
    expect(imageBox).not.toBeNull();
    expect(previewBox).not.toBeNull();
    expect(imageBox!.width).toBeLessThanOrEqual(previewBox!.width);
    expect(imageBox!.height).toBeLessThanOrEqual(previewBox!.height);
    await panel.getByRole("button", { name: "Zoom in" }).click();
    await panel.getByRole("button", { name: "Zoom in" }).click();
    await expect(panel.getByLabel("Zoom level")).toHaveText("150%");
    const mobileViewport = panel.getByRole("region", {
      name: "Image preview for preview.png",
    });
    const mobileScrollRange = await mobileViewport.evaluate((element) => ({
      horizontal: element.scrollWidth - element.clientWidth,
      vertical: element.scrollHeight - element.clientHeight,
    }));
    expect(mobileScrollRange.horizontal).toBeGreaterThan(0);
    expect(mobileScrollRange.vertical).toBeGreaterThan(0);
    await mobileViewport.evaluate((element) => {
      element.scrollLeft = Math.min(
        40,
        element.scrollWidth - element.clientWidth,
      );
      element.scrollTop = Math.min(
        40,
        element.scrollHeight - element.clientHeight,
      );
      element.dispatchEvent(new Event("scroll"));
    });
    await expectNoPageOverflow(page);
    await capture(
      page,
      testInfo,
      "workspace-files-image-preview-mobile-zoomed.png",
    );
    await panel.getByRole("button", { name: "Reset image view" }).click();
    await expect(panel.getByLabel("Zoom level")).toHaveText("100%");
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "workspace-files-image-preview-mobile.png");
  });
});
