import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FrameLocator, Locator, Page } from "@playwright/test";
import {
  pagePublicationResultSchema,
  type PublishPageRequest,
} from "../../src/shared/protocol/pages.js";
import { test, expect } from "./fixtures.js";
import {
  capture,
  createDraftThread,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openWorkspaceDirectory,
  overlaySettled,
  sendCurrentDraft,
} from "./helpers.js";
import { loadE2ERunContext } from "./run-context.js";

const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function mockup(version: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}body{margin:0;padding:24px;font:16px system-ui;background:#f2f5ff;color:#152447;min-height:100vh}
    main{max-width:620px;margin:auto;background:white;padding:20px;border-radius:16px;box-shadow:0 3px 15px #15244722}
    h1{font-size:26px;margin:0 0 16px}img{width:44px;height:44px;image-rendering:pixelated}button{font:inherit;padding:12px;background:#254fbd;color:white;border:0;border-radius:8px}
    #layout{padding:16px 0}.wide{display:none}@media(min-width:600px){.wide{display:block}.narrow{display:none}}
    </style></head><body><main><img src="images/logo.png" alt="Saved local logo"><h1>Inbox ${version}</h1>
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

async function openPageMenu(page: Page, card: Locator): Promise<Locator> {
  const trigger = card.getByRole("button", { name: /^Page details:/ });
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
  return page.locator(".page-preview-menu:visible");
}

test("published HTML keeps revisions, target viewport, local images, and host isolation across screen sizes", async ({
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

    const revisionMenu = await openPageMenu(page, secondCard);
    await revisionMenu
      .getByRole("button", { name: "Previous page revision" })
      .click();
    await expect(
      revisionMenu.getByRole("button", {
        name: "Return to published revision 2",
      }),
    ).toBeVisible();
    await expect(
      pageDocument(secondCard).getByRole("heading", { name: "Inbox one" }),
    ).toBeVisible();
    await revisionMenu
      .getByRole("button", {
        name: "Return to published revision 2",
        exact: true,
      })
      .click();
    await expect(
      pageDocument(secondCard).getByRole("heading", { name: "Inbox two" }),
    ).toBeVisible();

    await writeFile(htmlPath, mockup("three"));
    await publish(page, threadId, {
      path: htmlPath,
      title: "Inbox mockup",
      pageId: first.pageId,
      expectedRevision: 2,
      viewport: { width: 390, height: 600 },
    });
    await revisionMenu
      .getByRole("button", { name: "Check for a newer page revision" })
      .click();
    await expect(
      pageDocument(secondCard).getByRole("heading", { name: "Inbox three" }),
    ).toBeVisible();
    await expect(
      revisionMenu.getByRole("button", {
        name: "Return to published revision 2",
      }),
    ).toBeVisible();
    await revisionMenu
      .getByRole("button", {
        name: "Return to published revision 2",
        exact: true,
      })
      .click();
    await expect(
      pageDocument(secondCard).getByRole("heading", { name: "Inbox two" }),
    ).toBeVisible();

    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 360, height: 900 });
    await firstCard.scrollIntoViewIfNeeded();
    await expect(firstFrame.locator("#layout")).toHaveText(
      "Viewport 390 × 600",
    );
    await expect
      .poll(
        async () => (await firstCard.locator("iframe").boundingBox())!.width,
      )
      .toBeLessThan(390);
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "generative-ui-phone-on-phone.png");
    await openPageMenu(page, firstCard);
    await page
      .getByRole("button", { name: "Expand page: Inbox mockup" })
      .click();
    const expanded = page.getByRole("dialog", {
      name: "Inbox mockup · Revision 1",
      exact: true,
    });
    await expect(expanded).toBeVisible();
    await overlaySettled(expanded);
    await expect(pageDocument(expanded).locator("#layout")).toHaveText(
      "Viewport 390 × 600",
    );
    const initialScale = await expanded
      .locator("iframe")
      .evaluate((frame) => getComputedStyle(frame).transform);
    await expanded
      .getByRole("button", { name: "Zoom in", exact: true })
      .click();
    await expect
      .poll(() =>
        expanded
          .locator("iframe")
          .evaluate((frame) => getComputedStyle(frame).transform),
      )
      .not.toBe(initialScale);
    await expect(pageDocument(expanded).locator("#layout")).toHaveText(
      "Viewport 390 × 600",
    );
    await capture(page, testInfo, "generative-ui-expanded-mobile.png");
    await expanded.getByRole("button", { name: "Close", exact: true }).click();
    await expect(expanded).toBeHidden();
    await expect(
      firstCard.getByRole("button", { name: "Page details: Inbox mockup" }),
    ).toBeFocused();

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
    await page
      .getByRole("button", { name: "Thread actions", exact: true })
      .click();
    await page.getByRole("menuitem", { name: /^Published pages/ }).click();
    const library = page.getByRole("dialog", {
      name: "Published pages",
      exact: true,
    });
    await expect(library).toBeVisible();
    await library
      .getByRole("button", { name: /Inbox mockup.*Revision 3/ })
      .click();
    await expect(
      pageDocument(library).getByRole("heading", { name: "Inbox three" }),
    ).toBeVisible();
    await capture(page, testInfo, "generative-ui-saved-pages.png");
    await library.getByRole("button", { name: "Close", exact: true }).click();
    await expect(library).toBeHidden();
    await firstCard.scrollIntoViewIfNeeded();
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
  } finally {
    await page.request.post("/__e2e/pi/turn-response/release");
  }
});

test("page loading waits for transfer completion and viewport-based content reaches a bounded height", async ({
  page,
}, testInfo) => {
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
      html: "<!doctype html><html><body><p>Slow valid document</p></body></html>",
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
      await capture(page, testInfo, "generative-ui-inline-diagram-zoom.png");

      const saved = await publish(page, threadId, {
        title: "Mobile touch preview",
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
      await openPageMenu(page, card);
      await capture(page, testInfo, "generative-ui-mobile-details.png");
    } finally {
      await page.request.post("/__e2e/pi/mermaid/release/closed");
      await page.request.post("/__e2e/pi/mermaid/release/settled");
    }
  });
});
