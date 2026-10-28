import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { FrameLocator, Locator, Page, TestInfo } from "@playwright/test";
import {
  pagePublicationResultSchema,
  type PublishPageRequest,
} from "../../src/shared/protocol/pages.js";
import { test, expect, type BrowserDiagnostics } from "./fixtures.js";
import {
  capture,
  createDraftThread,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openWorkspaceDirectory,
  sendCurrentDraft,
} from "./helpers.js";
import { movePanel, openPanel, quickButton, stagePanel } from "./workspace-panel-helpers.js";
import { loadE2ERunContext } from "./run-context.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function mockup(version: string): string {
  const charset = version === "one" ? "" : `<meta charset="${version === "two" ? "windows-1252" : "utf-8"}">`;
  return `<!doctype html><html><head>${charset}<style>
    *{box-sizing:border-box}body{margin:0;padding:24px;font:16px system-ui;background:#f2f5ff;color:#152447;min-height:100vh}
    main{max-width:620px;margin:auto;background:white;padding:20px;border-radius:16px;box-shadow:0 3px 15px #15244722}
    h1{font-size:26px;margin:0 0 16px}img{width:44px;height:44px;image-rendering:pixelated}button{font:inherit;padding:12px;background:#254fbd;color:white;border:0;border-radius:8px}
    #layout{padding:16px 0}.wide{display:none}@media(min-width:600px){.wide{display:block}.narrow{display:none}}
    </style></head><body><main><img src="images/logo.png" alt="Saved local logo"><h1>Inbox ${version}</h1>
    <p id="unicode">Résumé – 東京 🦊</p><label>Draft note<input id="draft-note" value="Saved résumé"></label>
    <div class="narrow">Mobile layout</div><div class="wide">Desktop layout</div><p id="layout"></p>
    <button id="counter">Clicks: 0</button><p id="privacy"></p></main><script>
    const layout=()=>document.querySelector('#layout').textContent='Viewport '+innerWidth+' × '+innerHeight;
    layout();addEventListener('resize',layout);let count=0;document.querySelector('#counter').onclick=()=>document.querySelector('#counter').textContent='Clicks: '+(++count);
    let parentBlocked=false,storageBlocked=false;try{void parent.document.body}catch{parentBlocked=true}try{localStorage.setItem('preview','unsafe')}catch{storageBlocked=true}
    document.querySelector('#privacy').textContent=parentBlocked&&storageBlocked?'Isolated from host':'Isolation failed';
    </script></body></html>`;
}

async function publish(
  page: Page,
  threadId: string,
  input: PublishPageRequest,
) {
  const response = await page.request.post(`/__e2e/threads/${threadId}/pages`, {
    data: input,
  });
  expect(response.ok(), await response.text()).toBe(true);
  return pagePublicationResultSchema.parse(await response.json()).page;
}

function pageCard(page: Page, title: string, revision: number): Locator {
  return page
    .locator('[data-item-kind="page"]')
    .filter({ has: page.getByRole("group", { name: title, exact: true }) })
    .filter({
      has: page.locator(`.page-preview[data-page-revision="${revision}"]`),
    });
}

function pageDocument(container: Locator): FrameLocator {
  return container
    .frameLocator(".page-frame-document")
    .frameLocator("iframe[data-page-document]");
}

async function openPage(page: Page, card: Locator): Promise<Locator> {
  await card.getByRole("button", { name: /^Open in Pages/ }).click();
  const panel = stagePanel(page, "Pages");
  await expect(panel).toBeVisible();
  return panel;
}

async function downloadSavedHtml(
  page: Page,
  viewer: Locator,
  browserDiagnostics: BrowserDiagnostics,
  testInfo: TestInfo,
  revision: number,
  fileName: string,
) {
  const currentUrl = page.url();
  // Chromium reports its deliberate attachment navigation as ERR_ABORTED,
  // matching the saved workspace-file download coverage.
  browserDiagnostics.allowNetworkFailures = true;
  try {
    const downloaded = page.waitForEvent("download");
    await viewer.getByRole("button", { name: "Download HTML", exact: true }).click();
    const download = await downloaded;
    expect(await download.failure()).toBeNull();
    expect(download.suggestedFilename()).toBe(`Inbox mockup-r${revision}.html`);
    const filePath = testInfo.outputPath(fileName);
    await download.saveAs(filePath);
    expect(page.url()).toBe(currentUrl);
    await expect(viewer).toBeVisible();
    const bytes = await readFile(filePath);
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const html = bytes.subarray(3).toString("utf8");
    expect(html).toContain(`data:image/png;base64,${PNG}`);
    expect(html).toContain("Résumé – 東京 🦊");
    expect(html).toContain('value="Saved résumé"');
    expect(html).not.toContain("Unsaved live note");
    expect(html).not.toContain("sedes-page-document");
    expect(html).not.toContain("sedes:page-");
    expect(html).not.toContain("__sedes");
    return { filePath, html };
  } finally {
    browserDiagnostics.allowNetworkFailures = false;
  }
}

async function expectStandaloneHtml(page: Page, filePath: string, heading: string) {
  const standalone = await page.context().newPage();
  const errors: string[] = [];
  standalone.on("pageerror", error => errors.push(error.message));
  try {
    await standalone.goto(pathToFileURL(filePath).toString());
    await expect(standalone.getByRole("heading", { name: heading, exact: true })).toBeVisible();
    await expect(standalone.locator("#unicode")).toHaveText("Résumé – 東京 🦊");
    await expect(standalone.getByLabel("Draft note")).toHaveValue("Saved résumé");
    await expect(standalone.getByRole("button", { name: "Clicks: 0", exact: true })).toBeVisible();
    expect(await standalone.evaluate(() => "sedes" in window)).toBe(false);
    const image = standalone.getByRole("img", { name: "Saved local logo" });
    await expect(image).toHaveAttribute("src", /^data:image\/png;base64,/u);
    expect(await image.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await standalone.close();
  }
}

test("published HTML keeps revisions, downloads, target viewport, local images, and host isolation across screen sizes", async ({
  page,
  browserDiagnostics,
}, testInfo) => {
  const workspace = path.join(
    loadE2ERunContext().workspacesDirectory,
    "generative-ui",
  );
  const htmlPath = path.join(workspace, "mockup.html");
  await mkdir(path.join(workspace, "images"), { recursive: true });
  await writeFile(
    path.join(workspace, "images", "logo.png"),
    Buffer.from(PNG, "base64"),
  );
  await writeFile(htmlPath, mockup("one"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openWorkspaceDirectory(page, workspace);
  const threadPath = await createDraftThread(page, "Generated page previews");
  const threadId = threadPath.split("/").at(-1)!;
  expect(
    (await page.request.post("/__e2e/pi/turn-response/arm")).status(),
  ).toBe(204);
  await fillAndPersistDraft(
    page,
    "Publish the mockup while this turn stays active.",
  );
  await sendCurrentDraft(page);
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  try {
    const first = await publish(page, threadId, {
      path: htmlPath,
      title: "Inbox mockup",
      viewport: { width: 390, height: 600 },
    });
    const firstCard = pageCard(page, "Inbox mockup", 1);
    await firstCard.scrollIntoViewIfNeeded();
    const firstFrame = pageDocument(firstCard);
    await expect(
      firstCard.locator(".wb-media-frame-header, .page-frame-size"),
    ).toHaveCount(0);
    await expect(
      firstFrame.getByRole("heading", { name: "Inbox one" }),
    ).toBeVisible();
    await expect(
      firstFrame.getByText("Mobile layout", { exact: true }),
    ).toBeVisible();
    await expect(firstFrame.locator("#layout")).toHaveText(
      "Viewport 390 × 600",
    );
    await expect(
      firstFrame.getByText("Isolated from host", { exact: true }),
    ).toBeVisible();
    expect(await firstCard.locator("iframe").getAttribute("sandbox")).toBe(
      "allow-scripts",
    );
    await expect(firstCard.locator("iframe")).toHaveAttribute("inert", "");
    await firstCard.locator(".page-frame-viewport").click({ position: { x: 20, y: 20 } });
    await expect(firstCard.locator("iframe")).not.toHaveAttribute("inert", "");
    await firstFrame.getByRole("button", { name: "Clicks: 0" }).click();
    await expect(
      firstFrame.getByRole("button", { name: "Clicks: 1" }),
    ).toBeVisible();
    await capture(page, testInfo, "generative-ui-phone-on-desktop.png");

    // A document navigation retains its browsing context and is rejected;
    // a later host layout reparent creates a distinct context and is allowed.
    await firstFrame.locator("body").evaluate(() => location.reload());
    await expect(firstCard.getByRole("alert")).toHaveText(
      "Page preview unavailable.",
    );
    await firstCard.getByRole("button", { name: "Retry preview" }).click();
    await expect(
      firstFrame.getByRole("heading", { name: "Inbox one" }),
    ).toBeVisible();

    await writeFile(htmlPath, mockup("two"));
    const second = await publish(page, threadId, {
      path: htmlPath,
      title: "Inbox mockup",
      pageId: first.pageId,
      expectedRevision: 1,
      viewport: { width: 390, height: 600 },
    });
    expect(second.revision).toBe(2);
    const secondCard = pageCard(page, "Inbox mockup", 2);
    await secondCard.scrollIntoViewIfNeeded();
    await expect(
      pageDocument(secondCard).getByRole("heading", { name: "Inbox two" }),
    ).toBeVisible();
    await firstCard.scrollIntoViewIfNeeded();
    await expect(
      firstFrame.getByRole("heading", { name: "Inbox one" }),
    ).toBeVisible();

    // Chat opens the exact published revision, even when newer revisions exist.
    const viewer = await openPage(page, firstCard);
    // A cold lazy tenant may focus its retained panel target before the
    // document resolves; a warm open focuses Back. Both must leave Chat.
    await expect.poll(() => viewer.evaluate(node => {
      const target = node.querySelector('[data-portal-target="pages"]');
      const active = document.activeElement;
      return target?.contains(active) ? "Pages" : active?.outerHTML.slice(0, 300);
    })).toBe("Pages");
    await expect(viewer.getByLabel("Revision 1 of 2")).toHaveText("1/2");
    await expect(viewer.getByRole("button", { name: "Lock page revision", exact: true })).toHaveAttribute("aria-pressed", "false");
    const revisionFrame = pageDocument(viewer);
    await expect(revisionFrame.getByRole("heading", { name: "Inbox one" })).toBeVisible();
    await viewer.getByRole("button", { name: "Next page revision", exact: true }).click();
    await expect(revisionFrame.getByRole("heading", { name: "Inbox two" })).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Return to published revision 1" })).toHaveText("2/2");
    // Browsing history does not lock the document: the next publication follows
    // the same page even when the viewer is deliberately showing an older one.
    await viewer.getByRole("button", { name: "Previous page revision", exact: true }).click();
    await expect(revisionFrame.getByRole("heading", { name: "Inbox one" })).toBeVisible();
    await expect(viewer.getByRole("button", { name: "Lock page revision", exact: true })).toHaveAttribute("aria-pressed", "false");

    await writeFile(htmlPath, mockup("three"));
    await publish(page, threadId, {
      path: htmlPath,
      title: "Inbox mockup",
      pageId: first.pageId,
      expectedRevision: 2,
      viewport: { width: 390, height: 600 },
    });
    await expect(viewer.getByRole("button", { name: "Return to published revision 1" })).toHaveText("3/3");
    await expect(revisionFrame.getByRole("heading", { name: "Inbox three" })).toBeVisible();
    await capture(page, testInfo, "generative-ui-pages-auto-update-desktop.png");
    await revisionFrame.getByRole("button", { name: "Clicks: 0" }).click();
    await revisionFrame.getByLabel("Draft note").fill("Preserved during revision notifications");
    await viewer.locator(".page-frame-document").evaluate(frame => {
      (window as unknown as { __revisionNotificationFrame?: Element }).__revisionNotificationFrame = frame;
    });
    const refreshedList = page.waitForResponse(response => response.url().includes(`/api/threads/${threadId}/pages?`));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await refreshedList;
    await expect(viewer.getByRole("button", { name: "Return to published revision 1" })).toHaveText("3/3");
    // Rediscovering the current revision must not reload its live frame.
    expect(await viewer.locator(".page-frame-document").evaluate(frame =>
      (window as unknown as { __revisionNotificationFrame?: Element }).__revisionNotificationFrame === frame,
    )).toBe(true);
    await expect(revisionFrame.getByRole("button", { name: "Clicks: 1" })).toBeVisible();
    await expect(revisionFrame.getByLabel("Draft note")).toHaveValue("Preserved during revision notifications");

    await viewer.getByRole("button", { name: "Lock page revision", exact: true }).click();
    await expect(viewer.getByRole("button", { name: "Lock page revision", exact: true })).toHaveAttribute("aria-pressed", "true");
    await writeFile(htmlPath, mockup("four"));
    await publish(page, threadId, {
      path: htmlPath,
      title: "Inbox mockup",
      pageId: first.pageId,
      expectedRevision: 3,
      viewport: { width: 390, height: 600 },
    });
    await expect(viewer.getByRole("button", { name: "Return to published revision 1" })).toHaveText("3/4");
    await expect(revisionFrame.getByRole("heading", { name: "Inbox three" })).toBeVisible();
    expect(await viewer.locator(".page-frame-document").evaluate(frame =>
      (window as unknown as { __revisionNotificationFrame?: Element }).__revisionNotificationFrame === frame,
    )).toBe(true);
    await expect(revisionFrame.getByLabel("Draft note")).toHaveValue("Preserved during revision notifications");
    await capture(page, testInfo, "generative-ui-pages-locked-desktop.png");
    await viewer.getByRole("button", { name: "Lock page revision", exact: true }).click();
    await expect(viewer.getByRole("button", { name: "Lock page revision", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(viewer.getByRole("button", { name: "Return to published revision 1" })).toHaveText("4/4");
    await expect(revisionFrame.getByRole("heading", { name: "Inbox four" })).toBeVisible();

    // Lock an older revision before checking that panel arrangement and hiding
    // preserve the selection independently of the latest saved publication.
    await viewer.getByRole("button", { name: "Previous page revision", exact: true }).click();
    await expect(revisionFrame.getByRole("heading", { name: "Inbox three" })).toBeVisible();
    await viewer.getByRole("button", { name: "Previous page revision", exact: true }).click();
    await expect(revisionFrame.getByRole("heading", { name: "Inbox two" })).toBeVisible();
    await viewer.getByRole("button", { name: "Lock page revision", exact: true }).click();
    await expect(viewer.getByRole("button", { name: "Lock page revision", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(viewer.getByRole("button", { name: "Return to published revision 1" })).toHaveText("2/4");
    await revisionFrame.getByRole("button", { name: "Clicks: 0" }).click();
    await revisionFrame.getByLabel("Draft note").fill("Preserved while arranging panels");

    await expect(revisionFrame.getByRole("button", { name: "Clicks: 1" })).toBeVisible();
    await expect(revisionFrame.getByLabel("Draft note")).toHaveValue("Preserved while arranging panels");
    // Browser frame identity and unsent input survive visible geometry changes.
    await viewer.locator(".page-frame-document").evaluate(frame => {
      (window as unknown as { __pagesFrame?: Element }).__pagesFrame = frame;
    });
    const expectLivePage = async () => {
      expect(await viewer.locator(".page-frame-document").evaluate(frame =>
        (window as unknown as { __pagesFrame?: Element }).__pagesFrame === frame,
      )).toBe(true);
      await expect(revisionFrame.getByRole("button", { name: "Clicks: 1" })).toBeVisible();
      await expect(revisionFrame.getByLabel("Draft note")).toHaveValue("Preserved while arranging panels");
    };
    await capture(page, testInfo, "generative-ui-pages-beside-streaming-chat.png");
    await viewer.getByRole("button", { name: "Maximize Pages panel", exact: true }).click();
    const stageBox = (await page.locator(".workspace-panel-stage").boundingBox())!;
    await expect.poll(async () => Math.round((await viewer.boundingBox())!.width)).toBe(Math.round(stageBox.width));
    await expectLivePage();
    await capture(page, testInfo, "generative-ui-pages-maximized.png");
    await viewer.getByRole("button", { name: "Restore Pages panel", exact: true }).click();
    await expectLivePage();
    await movePanel(page, "Pages", "Left");
    await expectLivePage();
    await movePanel(page, "Pages", "Right");
    const resize = page.getByRole("separator", { name: "Resize Pages panel" });
    const resizeBox = (await resize.boundingBox())!;
    const beforeWidth = (await viewer.boundingBox())!.width;
    await page.mouse.move(resizeBox.x + resizeBox.width / 2, resizeBox.y + resizeBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizeBox.x - 60, resizeBox.y + resizeBox.height / 2, { steps: 4 });
    await page.mouse.up();
    await expect.poll(async () => (await viewer.boundingBox())!.width).toBeGreaterThan(beforeWidth + 40);
    await expectLivePage();

    // Hidden Pages retains its selected revision, but stops the authored frame.
    await quickButton(page, "Pages").click();
    await expect(viewer).toHaveCount(0);
    await expect(page.locator('.workspace-panel-parking iframe')).toHaveCount(0);
    await quickButton(page, "Pages").click();
    await expect(viewer).toBeVisible();
    await expect(revisionFrame.getByRole("heading", { name: "Inbox two" })).toBeVisible();
    await expect(revisionFrame.getByRole("button", { name: "Clicks: 0" })).toBeVisible();
    await expect(revisionFrame.getByLabel("Draft note")).toHaveValue("Saved résumé");
    await expect(viewer.getByRole("button", { name: "Return to published revision 1" })).toHaveText("2/4");
    await expect(viewer.getByRole("button", { name: "Lock page revision", exact: true })).toHaveAttribute("aria-pressed", "true");
    await quickButton(page, "Pages").click();

    await page.setViewportSize({ width: 360, height: 900 });
    await firstCard.scrollIntoViewIfNeeded();
    await expect(firstFrame.locator("#layout")).toHaveText("Viewport 390 × 600");
    await expect.poll(async () => (await firstCard.locator("iframe").boundingBox())!.width).toBeLessThan(390);
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "generative-ui-phone-on-phone.png");
    const phone = await openPage(page, firstCard);
    await expect(phone.getByLabel("Revision 1 of 4")).toHaveText("1/4");
    await expect(phone.getByRole("button", { name: "Lock page revision", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(pageDocument(phone).locator("#layout")).toHaveText("Viewport 390 × 600");
    await expect(phone.locator(".page-frame-document")).not.toHaveAttribute("inert", "");
    await expect(phone.getByRole("button", { name: /interact.*preview/i })).toHaveCount(0);
    const percentage = phone.getByRole("button", { name: /^Zoom percentage:/ });
    await percentage.click();
    await expect(phone.getByRole("group", { name: "Zoom presets" })).toBeVisible();
    await percentage.press("Escape");
    await expect(phone).toBeVisible();
    await expect(phone.getByRole("group", { name: "Zoom presets" })).toHaveCount(0);
    await expect(percentage).toBeFocused();
    await pageDocument(phone).getByRole("button", { name: "Clicks: 0" }).click();
    await expect(pageDocument(phone).getByRole("button", { name: "Clicks: 1" })).toBeVisible();
    const initialScale = await phone.locator("iframe").evaluate(frame => getComputedStyle(frame).transform);
    await phone.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect.poll(() => phone.locator("iframe").evaluate(frame => getComputedStyle(frame).transform)).not.toBe(initialScale);
    await expect(pageDocument(phone).locator("#layout")).toHaveText("Viewport 390 × 600");
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "generative-ui-pages-mobile.png");
    await phone.getByRole("button", { name: "Lock page revision", exact: true }).click();
    await expect(phone.getByRole("button", { name: "Lock page revision", exact: true })).toHaveAttribute("aria-pressed", "true");
    await writeFile(htmlPath, mockup("five"));
    await publish(page, threadId, {
      path: htmlPath,
      title: "Inbox mockup",
      pageId: first.pageId,
      expectedRevision: 4,
      viewport: { width: 390, height: 600 },
    });
    await expect(phone.getByLabel("Revision 1 of 5")).toHaveText("1/5");
    await expect(pageDocument(phone).getByRole("heading", { name: "Inbox one" })).toBeVisible();
    await expect(pageDocument(phone).getByRole("button", { name: "Clicks: 1" })).toBeVisible();
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "generative-ui-pages-locked-mobile.png");
    await phone.getByRole("button", { name: "Lock page revision", exact: true }).click();
    await expect(phone.getByRole("button", { name: "Lock page revision", exact: true })).toHaveAttribute("aria-pressed", "false");
    await expect(phone.getByRole("button", { name: "Return to published revision 1" })).toHaveText("5/5");
    await expect(pageDocument(phone).getByRole("heading", { name: "Inbox five" })).toBeVisible();
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "generative-ui-pages-auto-update-mobile.png");
    // Dispatch the same cancelable requests as Android Back; panel and app
    // unit tests cover the native listener's ordering.
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("sedes:close-page", { cancelable: true })))).toBe(true);
    await expect(phone.getByRole("navigation", { name: "Published pages" })).toBeVisible();
    await expect(phone.locator("iframe")).toHaveCount(0);
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("sedes:close-page", { cancelable: true })))).toBe(false);
    expect(await page.evaluate(() => !window.dispatchEvent(new Event("sedes:show-chat", { cancelable: true })))).toBe(true);
    await expect(stagePanel(page, "Chat")).toBeVisible();
    await expect(phone).toHaveCount(0);

    const responsive = await publish(page, threadId, {
      html: '<!doctype html><html><head><style>body{margin:0}div{height:28px;background:#e3ebff}</style></head><body><div id="component">Chat bubble example</div><script>document.querySelector("#component").dataset.width=innerWidth;addEventListener("resize",()=>document.querySelector("#component").dataset.width=innerWidth)</script></body></html>',
      title: "Chat component",
    });
    const componentCard = pageCard(page, responsive.title, 1);
    await componentCard.scrollIntoViewIfNeeded();
    const componentFrame = pageDocument(componentCard);
    await expect(componentFrame.getByText("Chat bubble example")).toBeVisible();
    await expect
      .poll(
        async () =>
          (await componentCard.locator("iframe").boundingBox())!.height,
      )
      .toBe(28);
    const narrowWidth = Number(
      await componentFrame.locator("#component").getAttribute("data-width"),
    );
    expect(narrowWidth).toBeLessThan(360);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await componentCard.scrollIntoViewIfNeeded();
    await expect
      .poll(async () =>
        Number(
          await componentFrame.locator("#component").getAttribute("data-width"),
        ),
      )
      .toBeGreaterThan(narrowWidth);
    await capture(page, testInfo, "generative-ui-responsive-component.png");

    // The source files are editable inputs, not live dependencies of saved revisions.
    await firstCard.scrollIntoViewIfNeeded();
    await expect(firstFrame.getByRole("heading", { name: "Inbox one" })).toBeVisible();
    await rm(htmlPath);
    await rm(path.join(workspace, "images", "logo.png"));
    await page.reload();
    await firstCard.scrollIntoViewIfNeeded();
    await expect(
      firstFrame.getByRole("heading", { name: "Inbox one" }),
    ).toBeVisible();
    await expect(
      firstFrame.getByRole("img", { name: "Saved local logo" }),
    ).toHaveAttribute("src", /^data:image\/png;base64,/);
    expect(
      await firstFrame
        .getByRole("img", { name: "Saved local logo" })
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    ).toBe(1);
    // Export an older saved revision after both source files are gone. Live
    // interaction stays in the preview; the download contains the publication.
    const downloadViewer = await openPage(page, secondCard);
    await expect(pageDocument(downloadViewer).getByRole("heading", { name: "Inbox two" })).toBeVisible();
    await downloadViewer.getByRole("button", { name: "Previous page revision" }).click();
    await expect(pageDocument(downloadViewer).getByRole("heading", { name: "Inbox one" })).toBeVisible();
    await pageDocument(downloadViewer).getByLabel("Draft note").fill("Unsaved live note");
    await pageDocument(downloadViewer).getByRole("button", { name: "Clicks: 0", exact: true }).click();
    const firstDownload = await downloadSavedHtml(page, downloadViewer, browserDiagnostics, testInfo, 1, "inbox-revision-1.html");
    expect(firstDownload.html).toContain("Inbox one");
    expect(firstDownload.html).not.toContain("Inbox two");
    expect(firstDownload.html).not.toContain("charset=");
    await expectStandaloneHtml(page, firstDownload.filePath, "Inbox one");
    await expect(pageDocument(downloadViewer).getByLabel("Draft note")).toHaveValue("Unsaved live note");
    await expect(pageDocument(downloadViewer).getByRole("button", { name: "Clicks: 1", exact: true })).toBeVisible();
    await expect(downloadViewer.getByRole("button", { name: "Download HTML", exact: true })).toBeVisible();
    await capture(page, testInfo, "generative-ui-download-desktop.png");
    await downloadViewer.getByRole("button", { name: "Close Pages panel", exact: true }).click();
    await expect(downloadViewer).toBeHidden();
    const longPage = await publish(page, threadId, {
      html: '<!doctype html><style>body{margin:0;height:2200px;background:#eef2ff}</style><h1>Long library example</h1>',
      title: "Long example",
      viewport: { width: 390 },
    });
    const longCard = pageCard(page, longPage.title, 1);
    await longCard.scrollIntoViewIfNeeded();
    const longViewer = await openPage(page, longCard);
    await expect(pageDocument(longViewer).getByRole("heading", { name: "Long library example" })).toBeVisible();
    const longFrame = longViewer.locator(".page-frame-document");
    await expect.poll(async () => (await longFrame.boundingBox())?.width).toBe(390);
    await longViewer.getByRole("button", { name: "Zoom out", exact: true }).click();
    await longViewer.getByRole("button", { name: "Fit to view" }).click();
    await expect.poll(async () => (await longFrame.boundingBox())?.width).toBe(390);
    await expect.poll(() => longViewer.locator(".page-frame-viewport").evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    )).toBe(true);
    await capture(page, testInfo, "generative-ui-fullscreen-auto-height.png");
    await longViewer.getByRole("button", { name: "Back to Pages", exact: true }).click();
    const library = stagePanel(page, "Pages");
    const libraryList = library.getByRole("navigation", { name: "Published pages" });
    await expect(libraryList).toBeVisible();
    await capture(page, testInfo, "generative-ui-pages-browser.png");
    await expect(library.locator("iframe")).toHaveCount(0);
    await expect(library.getByRole("textbox")).toHaveCount(0);
    await library.getByRole("button", { name: "Refresh pages", exact: true }).click();
    await libraryList.getByRole("button", { name: "Chat component", exact: true }).click();
    await expect(pageDocument(library).getByText("Chat bubble example")).toBeVisible();
    await expect(library.getByRole("group", { name: "Page revision controls" })).toHaveCount(0);
    // Responsive content uses the full stage beyond the former dialog's caps.
    await page.setViewportSize({ width: 1920, height: 1200 });
    await library.getByRole("button", { name: "Maximize Pages panel", exact: true }).click();
    await expect.poll(async () => Number(await pageDocument(library).locator("#component").getAttribute("data-width"))).toBeGreaterThan(1200);
    await expect.poll(async () => (await library.locator(".page-frame-document").boundingBox())!.width).toBeGreaterThan(1200);
    expect((await library.boundingBox())!.height).toBeGreaterThan(900);
    await capture(page, testInfo, "generative-ui-responsive-pages-maximized.png");
    await library.getByRole("button", { name: "Restore Pages panel", exact: true }).click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await library.getByRole("button", { name: "Back to Pages", exact: true }).click();
    await libraryList
      .getByRole("button", { name: "Inbox mockup", exact: true })
      .click();
    await expect(
      pageDocument(library).getByRole("heading", { name: "Inbox five" }),
    ).toBeVisible();
    await expect(library.getByLabel("Revision 5 of 5")).toHaveText("5/5");
    for (const version of ["four", "three", "two"]) {
      await library.getByRole("button", { name: "Previous page revision" }).click();
      await expect(pageDocument(library).getByRole("heading", { name: `Inbox ${version}` })).toBeVisible();
    }
    const secondDownload = await downloadSavedHtml(page, library, browserDiagnostics, testInfo, 2, "inbox-revision-2.html");
    expect(secondDownload.html).toContain("Inbox two");
    expect(secondDownload.html).not.toContain("Inbox five");
    expect(secondDownload.html).toContain('charset="windows-1252"');
    await expectStandaloneHtml(page, secondDownload.filePath, "Inbox two");
    await library.getByRole("button", { name: "Return to published revision 5", exact: true }).click();
    await expect(pageDocument(library).getByRole("heading", { name: "Inbox five" })).toBeVisible();
    await expect(library.getByRole("button", { name: "Download HTML", exact: true })).toBeVisible();
    await pageDocument(library)
      .getByRole("button", { name: "Clicks: 0" })
      .click();
    await expect(
      pageDocument(library).getByRole("button", { name: "Clicks: 1" }),
    ).toBeVisible();
    await capture(page, testInfo, "generative-ui-saved-pages.png");
    await library.getByRole("button", { name: "Close Pages panel", exact: true }).click();
    await expect(library).toHaveCount(0);
    await page.getByRole("button", { name: "Thread actions", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: /^Published pages/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    // Reader input relinquishes the streaming transcript's live-edge follow.
    // A programmatic scroll alone deliberately does not change that ownership.
    const messages = page.getByRole("region", { name: "Messages", exact: true });
    const beforeReaderScroll = await messages.evaluate((element) => element.scrollTop);
    await messages.hover({ position: { x: 10, y: 10 } });
    await page.mouse.wheel(0, -120);
    await expect.poll(() => messages.evaluate((element) => element.scrollTop)).toBeLessThan(beforeReaderScroll);
    await firstCard.scrollIntoViewIfNeeded();
    await expect(firstCard).toBeInViewport();
    await expect(
      firstFrame.getByRole("heading", { name: "Inbox one" }),
    ).toBeVisible();
    // The controlled sink detects actual HTTP requests, not browser request
    // events that a CSP can reject before any network access takes place.
    const framingViolation =
      /^Framing ['"].+['"] violates the following Content Security Policy directive: /u;
    browserDiagnostics.allowedConsoleErrors.push(framingViolation);
    const blocked = page.waitForEvent("console", {
      predicate: (message) =>
        message.type() === "error" && framingViolation.test(message.text()),
    });
    await firstFrame.locator("body").evaluate((_body, destination) => {
      location.href = destination;
    }, new URL("/__e2e/page-navigation-sink", page.url()).toString());
    await blocked;
    expect(
      await (
        await page.request.get("/__e2e/page-navigation-sink-count")
      ).json(),
    ).toEqual({ hits: 0 });

    // Thread-following content never shows the prior thread's live document.
    await openPanel(page, "Pages");
    await library.getByRole("navigation", { name: "Published pages" }).getByRole("button", { name: "Inbox mockup", exact: true }).click();
    await expect(pageDocument(library).getByRole("heading", { name: "Inbox five" })).toBeVisible();
    await createDraftThread(page, "No pages from another thread");
    await expect(library.getByText("No pages have been published.", { exact: true })).toBeVisible();
    await expect(library.locator("iframe")).toHaveCount(0);
    await expect(library.getByRole("button", { name: "Send page response" })).toHaveCount(0);
  } finally {
    await page.request.post("/__e2e/pi/turn-response/release");
  }
});

test("page loading waits for transfer completion and viewport-based content reaches a bounded height", async ({
  page,
}, testInfo) => {
  await page.addInitScript(() => {
    if (location.href !== "about:srcdoc") return;
    const documentWindow = window as Window & {
      suspendPreviewAnimation?: boolean;
      suspendedPreviewFrames?: number;
      resumePreviewAnimation?: () => void;
    };
    const requestFrame = window.requestAnimationFrame.bind(window);
    const suspended: FrameRequestCallback[] = [];
    documentWindow.resumePreviewAnimation = () => {
      documentWindow.suspendPreviewAnimation = false;
      for (const callback of suspended.splice(0)) requestFrame(callback);
    };
    window.requestAnimationFrame = callback => {
      if (!documentWindow.suspendPreviewAnimation) return requestFrame(callback);
      documentWindow.suspendedPreviewFrames = (documentWindow.suspendedPreviewFrames ?? 0) + 1;
      suspended.push(callback);
      return 0;
    };
  });
  const workspace = path.join(
    loadE2ERunContext().workspacesDirectory,
    "generative-ui-sizing",
  );
  await mkdir(workspace, { recursive: true });
  await openWorkspaceDirectory(page, workspace);
  const threadPath = await createDraftThread(
    page,
    "Preview loading and sizing",
  );
  const threadId = threadPath.split("/").at(-1)!;
  expect(
    (await page.request.post("/__e2e/pi/turn-response/arm")).status(),
  ).toBe(204);
  await fillAndPersistDraft(
    page,
    "Keep this turn open while the page previews render.",
  );
  await sendCurrentDraft(page);
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
  let releaseResponse!: () => void;
  let observeRequest!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    releaseResponse = resolve;
  });
  const requestObserved = new Promise<void>((resolve) => {
    observeRequest = resolve;
  });
  let firstRequest = true;
  await page.route("**/page-render/*", async (route) => {
    const response = await route.fetch();
    if (firstRequest) {
      firstRequest = false;
      observeRequest();
      await responseGate;
    }
    await route.fulfill({ response });
  });
  try {
    await publish(page, threadId, {
      html: "<!doctype html><html><head><script>window.suspendPreviewAnimation=true</script></head><body><p>Slow valid document</p></body></html>",
      title: "Slow delivery",
    });
    const slow = pageCard(page, "Slow delivery", 1);
    await slow.scrollIntoViewIfNeeded();
    await requestObserved;
    await expect(slow.locator(".page-frame-document")).toBeAttached();
    // Timing is the behavior under test: a still-downloading valid document
    // must survive the former ten-second bootstrap deadline.
    await page.waitForTimeout(11_000);
    await expect(slow.getByRole("alert")).toHaveCount(0);
    await expect(slow.locator(".page-frame-document")).toBeAttached();
    releaseResponse();
    await expect(
      pageDocument(slow).getByText("Slow valid document"),
    ).toBeVisible();
    // Model WebView's suppressed painting callbacks for offscreen previews.
    // Loading must complete even while every rAF is held, while interrupted-
    // render recovery still waits for the first measured animation frame.
    await expect.poll(() => pageDocument(slow).locator("body").evaluate(() =>
      (window as Window & { suspendedPreviewFrames?: number }).suspendedPreviewFrames ?? 0,
    )).toBeGreaterThan(0);
    const pendingRecovery = await page.evaluate(() => localStorage.getItem("sedes-page-preview-pending"));
    expect(pendingRecovery).not.toBeNull();
    // Timing is the behavior under test: suppressing painting after load
    // must survive the separate ten-second bootstrap deadline as well.
    await page.waitForTimeout(11_000);
    await expect(slow.getByRole("alert")).toHaveCount(0);
    await expect(slow.locator(".page-frame-document")).toBeAttached();
    expect(await page.evaluate(() => localStorage.getItem("sedes-page-preview-pending"))).toBe(pendingRecovery);
    await capture(page, testInfo, "generative-ui-preview-without-paint.png");
    await pageDocument(slow).locator("body").evaluate(() =>
      (window as Window & { resumePreviewAnimation?: () => void }).resumePreviewAnimation?.(),
    );
    await expect.poll(() => page.evaluate(() => localStorage.getItem("sedes-page-preview-pending"))).toBeNull();

    await publish(page, threadId, {
      html: "<!doctype html><html><head><style>body{min-height:100vh;padding:12px}</style></head><body><p>Viewport-sized content</p></body></html>",
      title: "Viewport-height feedback",
    });
    const fitted = pageCard(page, "Viewport-height feedback", 1);
    await fitted.scrollIntoViewIfNeeded();
    const document = pageDocument(fitted);
    await expect(document.getByText("Viewport-sized content")).toBeVisible();
    const heights = await document.locator("body").evaluate(async () => {
      const values: number[] = [];
      for (let frame = 0; frame < 20; frame++) {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
        values.push(innerHeight);
      }
      return values;
    });
    expect(Math.max(...heights)).toBeLessThan(1000);
    expect(new Set(heights.slice(-8)).size).toBe(1);
    await capture(page, testInfo, "generative-ui-auto-height-bounded.png");
    await document.locator("body").evaluate((body) => {
      body.style.minHeight = "0";
      body.style.padding = "0";
      body.style.margin = "0";
      body.innerHTML = '<div style="height:32px">Changed content</div>';
    });
    await expect
      .poll(
        async () =>
          (await fitted.locator(".page-frame-document").boundingBox())!.height,
      )
      .toBe(32);

    const positioned = await publish(page, threadId, {
      title: "Visible positioned content",
      html: '<!doctype html><html><head><style>body{margin:0}.clip{height:100px;overflow:hidden}.fixed{position:fixed;top:50px;height:100px;width:100px;background:#bde}</style></head><body><div class="clip"><div class="fixed">Visible outside ancestor</div></div></body></html>',
    });
    const positionedCard = pageCard(page, positioned.title, 1);
    await positionedCard.scrollIntoViewIfNeeded();
    await expect.poll(async () =>
      (await positionedCard.locator(".page-frame-document").boundingBox())?.height,
    ).toBe(150);
    expect(await pageDocument(positionedCard).locator("body").evaluate(() =>
      window.document.elementFromPoint(50, 120)?.className,
    )).toBe("fixed");
    await capture(page, testInfo, "generative-ui-positioned-content.png");
  } finally {
    releaseResponse();
    await page.unrouteAll({ behavior: "wait" });
    await page.request.post("/__e2e/pi/turn-response/release");
  }
});

test.describe("mobile inline preview interaction", () => {
  test.use({
    viewport: { width: 1280, height: 900 },
    isMobile: true,
    hasTouch: true,
  });

  test("HTML hands swipes to chat until interaction is enabled and diagrams pinch inline", async ({
    page,
  }, testInfo) => {
    const workspace = path.join(
      loadE2ERunContext().workspacesDirectory,
      "mobile-preview-input",
    );
    await mkdir(workspace, { recursive: true });
    await openWorkspaceDirectory(page, workspace);
    const threadPath = await createDraftThread(page, "Mobile preview input");
    const threadId = threadPath.split("/").at(-1)!;
    await page.setViewportSize({ width: 390, height: 844 });
    await fillAndPersistDraft(page, "Stream a Mermaid diagram progressively");
    expect((await page.request.post("/__e2e/pi/mermaid/arm")).status()).toBe(
      204,
    );
    try {
      await sendCurrentDraft(page);
      await expect(
        page.locator('[data-item-kind="assistant_message"][data-item-status="streaming"]'),
      ).toBeVisible({ timeout: 12_000 });
      await expect(
        page.getByText("Waiting for diagram…", { exact: true }),
      ).toBeVisible();
      expect(
        (await page.request.post("/__e2e/pi/mermaid/release/closed")).status(),
      ).toBe(204);
      const diagram = page.locator(".mermaid-diagram .zoomable-preview-shell");
      await expect(diagram).toBeVisible();
      const touch = await page.context().newCDPSession(page);
      await diagram.scrollIntoViewIfNeeded();
      const viewport = diagram.locator(".zoomable-preview-viewport");
      const box = (await viewport.boundingBox())!;
      const y = box.y + box.height / 2;
      const center = box.x + box.width / 2;
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [
          { id: 1, x: center - 28, y },
          { id: 2, x: center + 28, y },
        ],
      });
      for (let step = 1; step <= 6; step++) {
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [
            { id: 1, x: center - 28 - step * 8, y },
            { id: 2, x: center + 28 + step * 8, y },
          ],
        });
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            ),
        );
      }
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await expect(viewport).toHaveAttribute("data-gesture-zoom", "true");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      // Cross natural size: Mermaid's generated inline max-width must not cap
      // the painted SVG while the containing zoom canvas keeps growing.
      await viewport.focus();
      for (let step = 0; step < 4; step++) await viewport.press("+");
      await expect.poll(() => diagram.locator("svg").evaluate((svg) => {
        const content = svg.closest<HTMLElement>(".zoomable-preview-content")!;
        const width = svg.getBoundingClientRect().width;
        return width > (svg as SVGSVGElement).viewBox.baseVal.width &&
          Math.abs(width - content.getBoundingClientRect().width) < 1;
      })).toBe(true);
      await capture(page, testInfo, "generative-ui-inline-diagram-zoom.png");

      const saved = await publish(page, threadId, {
        title: "Mobile touch preview with a longer heading",
        viewport: { width: 360, height: 1100 },
        html: '<!doctype html><html><body style="margin:0;padding:24px;background:#eceef8;min-height:1100px;font:16px system-ui"><h1>Touch preview</h1><button id="tap" style="padding:18px">Taps: 0</button><p>Swipe this preview to scroll the conversation.</p><script>let taps=0;document.querySelector("#tap").onclick=()=>document.querySelector("#tap").textContent="Taps: "+(++taps)</script></body></html>',
      });
      const card = pageCard(page, saved.title, 1);
      await card.scrollIntoViewIfNeeded();
      const frame = card.locator("iframe");
      await expect(frame).toBeVisible();
      await expect(frame).toHaveAttribute("inert", "");
      await expect(
        card.getByRole("button", { name: "Run interactive preview" }),
      ).toHaveCount(0);
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "dark";
      });
      await capture(page, testInfo, "generative-ui-mobile-passive.png");
      const messages = page.getByRole("region", { name: "Messages" });
      await messages.evaluate((element) => {
        element.scrollTop = Math.max(0, element.scrollTop - 100);
      });
      const before = await messages.evaluate((element) => element.scrollTop);
      const area = (await messages.boundingBox())!;
      const frameBox = (await frame.boundingBox())!;
      const x = frameBox.x + frameBox.width / 2;
      const start = Math.max(area.y + 130, frameBox.y + 110);
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y: start }],
      });
      for (let step = 1; step <= 6; step++) {
        await touch.send("Input.dispatchTouchEvent", {
          type: "touchMove",
          touchPoints: [{ x, y: start - 12 * step }],
        });
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => resolve()),
            ),
        );
      }
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await expect
        .poll(() => messages.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(before + 20);
      await card.scrollIntoViewIfNeeded();
      await card
        .getByRole("button", { name: "Interact with preview", exact: true })
        .tap();
      await expect(frame).not.toHaveAttribute("inert", "");
      await pageDocument(card).getByRole("button", { name: "Taps: 0" }).tap();
      await expect(
        pageDocument(card).getByRole("button", { name: "Taps: 1" }),
      ).toBeVisible();
      await capture(page, testInfo, "generative-ui-mobile-interacting.png");
      await card
        .getByRole("button", { name: "Done interacting with preview" })
        .tap();
      await expect(frame).toHaveAttribute("inert", "");
      await card.locator(".page-frame-viewport").tap({ position: { x: 20, y: 20 } });
      await expect(frame).not.toHaveAttribute("inert", "");
      await expect(pageDocument(card).getByRole("button", { name: "Taps: 1" })).toBeVisible();
      await card.getByRole("button", { name: "Done interacting with preview" }).tap();
      const mobileViewer = await openPage(page, card);
      const headerBox = (await mobileViewer.locator(".page-document-header").boundingBox())!;
      const actionsBox = (await mobileViewer.getByRole("toolbar", { name: "Page actions" }).boundingBox())!;
      expect(actionsBox.x).toBeGreaterThan(headerBox.x + headerBox.width / 2);
      await capture(page, testInfo, "generative-ui-mobile-details.png");
    } finally {
      await page.request.post("/__e2e/pi/mermaid/release/closed");
      await page.request.post("/__e2e/pi/mermaid/release/settled");
    }
  });
});
