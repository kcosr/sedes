import path from "node:path";
import { test, expect } from "./fixtures";
import {
  capture,
  createDraftThread,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openSedesWorkspace,
  selectCustomNewThreadTarget,
  selectDeliveryMode,
  selectRadixOption,
  sendCurrentDraft,
} from "./helpers";

const repositoryDisplayName = path.basename(process.cwd());

test("active chat notes deliver the combined composer draft with Steer and Queue", async ({ page }, testInfo) => {
  await openSedesWorkspace(page);
  await page.getByTestId("desktop-sidebar").getByTestId("new-thread-trigger").click();
  await selectCustomNewThreadTarget(page, "Codex TCP external · Codex TCP");
  const created = page.waitForResponse((response) =>
    response.request().method() === "POST" &&
    response.url().endsWith("/api/threads") && response.status() === 201,
  );
  await page.getByRole("button", { name: "Create thread" }).click();
  await created;
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/u);
  const threadId = new URL(page.url()).pathname.split("/").at(-1)!;
  const composer = page.getByRole("textbox", { name: "Message Codex" });
  const sourceText = "Keep working while I annotate this request.";
  expect((await page.request.post("/__e2e/codex/turn-completion/arm")).status()).toBe(204);
  try {
    await fillAndPersistDraft(page, sourceText, "Message Codex");
    await sendCurrentDraft(page);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();

    const source = page.locator('[data-item-kind="user_message"]:not([data-client-provisional="true"])')
      .filter({ hasText: sourceText }).first().locator("[data-conversation-message-text]");
    const actions = page.getByRole("toolbar", { name: "Selected message text actions" });
    const selectSource = async () => {
      await source.scrollIntoViewIfNeeded();
      await source.evaluate((root) => {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const first = walker.nextNode();
        if (!(first instanceof Text)) throw new Error("Source message text missing");
        let last = first;
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (node instanceof Text) last = node;
        }
        const range = document.createRange();
        // Plain-message capture intentionally accepts text-node boundaries,
        // matching a native text selection rather than an element selection.
        range.setStart(first, 0);
        range.setEnd(last, last.length);
        const selection = document.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
      });
      await expect(actions).toBeVisible();
      await actions.getByRole("button", { name: "Add note…" }).click();
    };

    for (const mode of ["steer", "queue"] as const) {
      await page.setViewportSize(mode === "steer"
        ? { width: 1280, height: 900 }
        : { width: 390, height: 844 });
      await selectDeliveryMode(page, mode === "steer" ? "Steer" : "Queue");
      const draftText = `Existing composer instructions for ${mode}.`;
      await fillAndPersistDraft(page, draftText, "Message Codex");
      await selectSource();
      await actions.getByRole("textbox", { name: "Note about selected message text" }).fill("Already attached context");
      await actions.getByRole("button", { name: "Add note", exact: true }).click();
      await expect(actions).toBeHidden();
      await expect(page.getByTestId("composer").getByLabel("Context excerpts")).toContainText("Already attached context");
      await selectSource();
      const note = `New annotation for ${mode}.`;
      await actions.getByRole("textbox", { name: "Note about selected message text" }).fill(note);
      const send = actions.getByRole("button", { name: `Add note & ${mode}`, exact: true });
      await expect(send).toBeEnabled();
      await expect(send).toHaveAccessibleDescription("Includes this selection, note, and any existing composer content.");
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      await expectNoPageOverflow(page);
      await capture(page, testInfo, `chat-active-note-${mode}-${mode === "steer" ? "desktop" : "mobile"}.png`);

      if (mode === "steer") {
        expect((await page.request.post(`/__e2e/codex/steer-materialization/arm/${threadId}`)).status()).toBe(204);
      }
      const combinedDraft = page.waitForResponse((response) => {
        if (response.request().method() !== "PUT" ||
            !response.url().endsWith(`/api/threads/${threadId}/draft`) || !response.ok()) return false;
        const body = response.request().postDataJSON();
        return body.contextExcerpts?.some((excerpt: { note?: string }) => excerpt.note === note);
      });
      const delivered = page.waitForResponse((response) => {
        if (response.request().method() !== "POST" ||
            !response.url().endsWith(`/api/threads/${threadId}/operations`) || !response.ok()) return false;
        const body = response.request().postDataJSON();
        return body.kind === "deliver" && body.mode === mode;
      });
      await send.click();
      expect((await combinedDraft).request().postDataJSON()).toMatchObject({
        text: draftText,
        contextExcerpts: [
          { excerpt: sourceText, note: "Already attached context" },
          { excerpt: sourceText, note },
        ],
      });
      await delivered;
      await expect(actions).toBeHidden();
      await expect(composer).toHaveValue("");
      await expect(page.getByTestId("composer").getByLabel("Context excerpts")).toHaveCount(0);
      if (mode === "steer") {
        await expect.poll(async () => {
          const response = await page.request.get("/__e2e/codex/steer-materialization/state");
          return (await response.json()).heldCount;
        }).toBe(1);
        expect((await page.request.post("/__e2e/codex/steer-materialization/release")).status()).toBe(204);
      } else {
        await expect(page.getByRole("region", { name: "Pending inputs" })).toContainText(draftText);
      }
    }
  } finally {
    await page.request.post("/__e2e/codex/steer-materialization/reset");
    expect((await page.request.post("/__e2e/codex/turn-completion/release")).status()).toBe(204);
  }
});

test.describe.serial("normalized composer state", () => {
  test("composer attachments upload, remove, stash, restore, reload, and deliver", async ({
    page,
    browserDiagnostics,
  }, testInfo) => {
    await openSedesWorkspace(page);
    await createDraftThread(page);
    const composer = page.getByTestId("composer");
    const fileInput = composer.locator('input[type="file"]');
    const attachmentList = composer.getByLabel("Attachments");

    let releaseDraftLinkRequest!: () => void;
    const delayedDraftLink = new Promise<void>((resolve) => {
      releaseDraftLinkRequest = resolve;
    });
    let markDraftLinkStarted!: () => void;
    const draftLinkStarted = new Promise<void>((resolve) => {
      markDraftLinkStarted = resolve;
    });
    let draftLinkWasDelayed = false;
    const draftRoute = /\/api\/threads\/[^/]+\/draft$/u;
    await page.route(draftRoute, async (route) => {
      const request = route.request();
      const body = request.postDataJSON() as { attachmentIds?: unknown[] };
      if (
        request.method() === "PUT" &&
        !draftLinkWasDelayed &&
        (body.attachmentIds?.length ?? 0) > 0
      ) {
        draftLinkWasDelayed = true;
        markDraftLinkStarted();
        await delayedDraftLink;
      }
      await route.continue();
    });

    const delayedUploadRoute =
      /\/api\/threads\/[^/]+\/composer-attachments\/[^/?]+(?:\?.*)?$/u;
    let releaseDelayedUpload!: () => void;
    const delayedUpload = new Promise<void>((resolve) => {
      releaseDelayedUpload = resolve;
    });
    await page.route(delayedUploadRoute, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        request.method() === "PUT" &&
        url.searchParams.get("fileName") === "cancel-before-upload.txt"
      ) {
        await delayedUpload;
      }
      await route.continue().catch(() => undefined);
    });

    browserDiagnostics.allowNetworkFailures = true;
    await fileInput.setInputFiles({
      name: "cancel-before-upload.txt",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("cancel this upload"),
    });
    await expect(
      attachmentList.getByText("cancel-before-upload.txt", { exact: true }),
    ).toBeVisible();
    await attachmentList
      .getByRole("button", {
        name: "Remove attachment: cancel-before-upload.txt",
      })
      .click();
    await expect(
      attachmentList.getByText("cancel-before-upload.txt", { exact: true }),
    ).toHaveCount(0);
    releaseDelayedUpload();
    await page.unroute(delayedUploadRoute);

    const tinyPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAkCAIAAAC2bqvFAAAACXBIWXMAAAABAAAAAQBPJcTWAAABGElEQVR4nO2ZMQ7CMAxFbakS3WDsysYx4WZcg42REbYymbRG0FCbGhB1G+XJQiJKYv/8JkBAUCCpEYkI5f5KM2gD1P54T2SpJ1Ao7VLK3qT/gxCN6awCxqyeMWr4wIFpYhIw/vIzFhOGBXhVzwxqSP0R8l1+5r0JSTswheVnggmgFJO0A7NAFTCd54dpd7JQUroOzIUswJsswJsswJsswJsswBtVgP1mZhzEb3KQggONrkoOOmB4rZdwgmdsKXob4gordQqowk+p1wFxlJdowK43xQLOTT/ci+Pn74B3Ab+SBXhTNNfxvB9iHodWCbDuHGHf/D/Am1HpXwMc2xDnb4/ycEisCDayACVvXITTZ0K+Xu8wvgnGdDe223I93IVcvAAAAABJRU5ErkJggg==",
      "base64",
    );
    const pngUpload = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "PUT" &&
        url.pathname.includes("/composer-attachments/") &&
        url.searchParams.get("fileName") === "tiny-preview.png" &&
        response.ok()
      );
    });
    const fileUpload = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return (
        response.request().method() === "PUT" &&
        url.pathname.includes("/composer-attachments/") &&
        url.searchParams.get("fileName") === "notes.bin" &&
        response.ok()
      );
    });
    await fileInput.setInputFiles([
      {
        name: "tiny-preview.png",
        mimeType: "image/png",
        buffer: tinyPng,
      },
      {
        name: "notes.bin",
        mimeType: "application/octet-stream",
        buffer: Buffer.from([0x00, 0x01, 0x02, 0x03]),
      },
    ]);
    await Promise.all([pngUpload, fileUpload]);
    await expect(attachmentList.locator("[data-upload-id]")).toHaveCount(0);
    await expect(
      attachmentList.getByText("tiny-preview.png", { exact: true }),
    ).toBeVisible();
    await expect(
      attachmentList.getByText("notes.bin", { exact: true }),
    ).toBeVisible();
    const uploadedImage = attachmentList
      .locator("[data-attachment-id]")
      .filter({ hasText: "tiny-preview.png" })
      .locator("img");
    await draftLinkStarted;
    // The former direct-content thumbnail exhausted its retries about 3.1s
    // after upload, while this draft owner link is still blocked. The local
    // verified object URL remains valid instead of exposing a broken image.
    await page.waitForTimeout(1_500);
    await expect
      .poll(() =>
        uploadedImage.evaluate(
          (image) => (image as HTMLImageElement).naturalWidth,
        ),
      )
      .toBeGreaterThan(0);
    await expect(uploadedImage).toHaveAttribute("src", /^blob:/u);
    const draftLinked = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith("/draft") &&
        response.ok(),
    );
    releaseDraftLinkRequest();
    await draftLinked;
    await page.unroute(draftRoute);
    browserDiagnostics.allowNetworkFailures = false;

    await page.setViewportSize({ width: 390, height: 844 });
    const composerSettings = page.locator('.desktop-config[data-variant="pill"]');
    const reasoning = composerSettings.locator('[data-setting-id="thinking_level"] [role="combobox"]');
    await expect(reasoning).toBeVisible();
    await expect(composerSettings.locator('[data-setting-id="model"]')).toBeHidden();
    await reasoning.click();
    await page.getByRole("option", { name: "High", exact: true }).click();
    await expect(reasoning).toHaveText("High");
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "normalized-composer-attachments-mobile.png");
    await page.setViewportSize({ width: 1280, height: 720 });

    await attachmentList
      .getByRole("button", { name: "Preview image: tiny-preview.png" })
      .click();
    const imageDialog = page.getByRole("dialog", {
      name: "Image preview: tiny-preview.png",
    });
    const imageViewport = imageDialog.getByRole("region", {
      name: "Image preview for tiny-preview.png",
    });
    const imageCanvas = imageDialog.locator(".zoomable-preview-canvas");
    const popupImage = imageDialog.locator(".zoomable-preview-content > img");
    const [
      initialImageViewportBox,
      initialImageCanvasBox,
      initialPopupImageBox,
    ] = await Promise.all([
      imageViewport.boundingBox(),
      imageCanvas.boundingBox(),
      popupImage.boundingBox(),
    ]);
    expect(initialImageViewportBox).not.toBeNull();
    expect(initialImageCanvasBox).not.toBeNull();
    expect(initialPopupImageBox).not.toBeNull();
    await imageDialog.getByRole("button", { name: "Zoom out" }).click();
    await expect(imageDialog.getByLabel("Zoom level")).toHaveText("75%");
    const [
      reducedImageViewportBox,
      reducedImageCanvasBox,
      reducedPopupImageBox,
    ] = await Promise.all([
      imageViewport.boundingBox(),
      imageCanvas.boundingBox(),
      popupImage.boundingBox(),
    ]);
    expect(reducedImageViewportBox!.width).toBeCloseTo(
      initialImageViewportBox!.width,
      0,
    );
    expect(reducedImageViewportBox!.height).toBeCloseTo(
      initialImageViewportBox!.height,
      0,
    );
    expect(reducedImageCanvasBox!.width).toBeCloseTo(
      initialImageCanvasBox!.width * 0.75,
      0,
    );
    expect(reducedPopupImageBox!.width).toBeCloseTo(
      initialPopupImageBox!.width * 0.75,
      0,
    );
    await imageDialog.getByRole("button", { name: "Close" }).click();
    await expect(imageDialog).toHaveCount(0);

    const removedFileSaved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith("/draft") &&
        response.ok(),
    );
    await attachmentList
      .getByRole("button", { name: "Remove attachment: notes.bin" })
      .click();
    await removedFileSaved;
    await expect(
      attachmentList.getByText("notes.bin", { exact: true }),
    ).toHaveCount(0);

    await page.reload();
    const reloadedAttachments = page
      .getByTestId("composer")
      .getByLabel("Attachments");
    const reloadedImageCard = reloadedAttachments
      .locator("[data-attachment-id]")
      .filter({ hasText: "tiny-preview.png" });
    await expect(reloadedImageCard).toBeVisible();
    const reloadedImage = reloadedImageCard.locator("img");
    await expect(reloadedImage).toBeVisible();
    await expect
      .poll(() =>
        reloadedImage.evaluate(
          (image) => (image as HTMLImageElement).naturalWidth,
        ),
      )
      .toBeGreaterThan(0);

    const stashed = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/stashes") &&
        response.ok(),
    );
    await page.getByRole("button", { name: "Stash prompt" }).click();
    await stashed;
    await expect(reloadedImageCard).toHaveCount(0);

    await page.getByRole("button", { name: "Open 1 stashed prompts" }).click();
    const restore = page.getByRole("menuitem").filter({
      hasText: "1 attachment",
    });
    await expect(restore).toBeVisible();
    const restored = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/stashes/") &&
        response.url().endsWith("/restore") &&
        response.ok(),
    );
    await restore.click();
    await restored;
    await expect(
      page
        .getByTestId("composer")
        .getByLabel("Attachments")
        .getByText("tiny-preview.png", { exact: true }),
    ).toBeVisible();

    // Restore mounts a fresh thumbnail. Wait for its request to finish before
    // Send removes the draft card, avoiding an intentional image cancellation.
    await expect.poll(() => page.getByTestId("composer").getByLabel("Attachments")
      .locator("[data-attachment-id]").filter({ hasText: "tiny-preview.png" }).locator("img")
      .evaluate(image => (image as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    await sendCurrentDraft(page);
    const sentAttachment = page
      .locator('[data-item-kind="user_message"]')
      .last()
      .getByText("tiny-preview.png", { exact: true });
    await expect(sentAttachment).toBeVisible();
    await expect(
      page.locator(
        '[data-item-kind="assistant_message"][data-item-status="completed"]',
      ),
    ).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await expect(sentAttachment).toBeVisible();
  });

  test("task references persist, track live state, fail closed, and deliver immutable context", async ({
    page,
  }, testInfo) => {
    await openSedesWorkspace(page);
    await createDraftThread(page);

    await page.getByTestId("tasks-panel-toggle").first().click();
    const tasksPanel = page.locator('[data-slot="tasks-panel"]');
    await tasksPanel.getByRole("radio", { name: "Thread" }).click();

    const taskCreated = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/tasks") &&
        response.status() === 201,
    );
    await tasksPanel
      .getByPlaceholder("Search or add task")
      .fill("Implement durable task context");
    await tasksPanel.getByPlaceholder("Search or add task").press("Enter");
    const createdTask = (await (await taskCreated).json()).task as {
      id: string;
    };

    await tasksPanel.getByRole("button", { name: "Edit", exact: true }).click();
    await tasksPanel
      .getByRole("textbox", { name: "Task notes" })
      .fill("Preserve this exact body when the prompt is accepted.");
    const taskEdited = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/api/tasks/${createdTask.id}`) &&
        response.ok(),
    );
    await tasksPanel.getByRole("button", { name: "Save task" }).click();
    await taskEdited;

    let attachedDraftRequest: Record<string, unknown> | undefined;
    const taskAttached = page.waitForResponse(async (response) => {
      if (
        response.request().method() !== "PUT" ||
        !response.url().endsWith("/draft") ||
        !response.ok()
      ) {
        return false;
      }
      const body = (await response.request().postDataJSON()) as {
        taskReferenceIds?: string[];
      } & Record<string, unknown>;
      if (body.taskReferenceIds?.includes(createdTask.id) !== true)
        return false;
      attachedDraftRequest = body;
      return true;
    });
    await tasksPanel.getByRole("button", { name: "Add to prompt" }).click();
    await taskAttached;
    expect(attachedDraftRequest?.taskReferenceIds).toEqual([createdTask.id]);
    expect(JSON.stringify(attachedDraftRequest)).not.toContain(
      "Preserve this exact body when the prompt is accepted.",
    );
    await expect(tasksPanel).toBeVisible();

    const composer = page.getByTestId("composer");
    const textarea = composer.getByRole("textbox", {
      name: "Message Scripted agent",
    });
    const attachedTasks = composer.getByLabel("Attached tasks");
    let durableTaskChip = attachedTasks.locator(
      `[data-task-id="${createdTask.id}"]`,
    );
    await expect(durableTaskChip).toContainText(
      "Implement durable task context",
    );
    await expect(durableTaskChip).toHaveAttribute("data-state", "available");
    await expect(textarea).toHaveValue("");

    await page.reload();
    durableTaskChip = page
      .getByTestId("composer")
      .getByLabel("Attached tasks")
      .locator(`[data-task-id="${createdTask.id}"]`);
    await expect(durableTaskChip).toContainText(
      "Implement durable task context",
    );
    await expect(textarea).toHaveValue("");

    await tasksPanel.getByRole("radio", { name: "Thread" }).click();
    await tasksPanel
      .getByRole("button", { name: 'View "Implement durable task context"' })
      .click();
    await tasksPanel.getByRole("button", { name: "Edit", exact: true }).click();
    await tasksPanel
      .getByRole("textbox", { name: "Task title" })
      .fill("Ship durable task context");
    await tasksPanel
      .getByRole("textbox", { name: "Task notes" })
      .fill("This is the body captured at send time.");
    const taskRenamed = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/api/tasks/${createdTask.id}`) &&
        response.ok(),
    );
    await tasksPanel.getByRole("button", { name: "Save task" }).click();
    await taskRenamed;
    await expect(durableTaskChip).toContainText("Ship durable task context");

    const renamedTaskRow = tasksPanel
      .locator(".tasks-row")
      .filter({ hasText: "Ship durable task context" });
    const taskCompleted = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/api/tasks/${createdTask.id}`) &&
        response.ok(),
    );
    await renamedTaskRow
      .getByRole("checkbox", {
        name: 'Mark "Ship durable task context" as done',
      })
      .click();
    const acceptedTaskSnapshot = (await (await taskCompleted).json()).task as {
      revision: number;
    };
    await expect(durableTaskChip).toHaveAttribute("data-state", "completed");

    const missingTaskCreated = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/tasks") &&
        response.status() === 201,
    );
    await tasksPanel
      .getByPlaceholder("Search or add task")
      .fill("Disposable task reference");
    await tasksPanel.getByPlaceholder("Search or add task").press("Enter");
    const disposableTask = (await (await missingTaskCreated).json()).task as {
      id: string;
    };
    const disposableAttached = page.waitForResponse(async (response) => {
      if (
        response.request().method() !== "PUT" ||
        !response.url().endsWith("/draft") ||
        !response.ok()
      ) {
        return false;
      }
      const body = (await response.request().postDataJSON()) as {
        taskReferenceIds?: string[];
      };
      return body.taskReferenceIds?.includes(disposableTask.id) === true;
    });
    await tasksPanel.getByRole("button", { name: "Add to prompt" }).click();
    await disposableAttached;

    await tasksPanel.getByRole("radio", { name: "Thread" }).click();
    await tasksPanel.getByRole("button", { name: "Edit", exact: true }).click();
    await tasksPanel.getByRole("button", { name: "Delete task" }).click();
    const taskDeleted = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().endsWith(`/api/tasks/${disposableTask.id}`) &&
        response.status() === 204,
    );
    await tasksPanel
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await taskDeleted;
    await page.keyboard.press("Escape");

    const missingTaskChip = page
      .getByTestId("composer")
      .getByLabel("Attached tasks")
      .locator(`[data-task-id="${disposableTask.id}"]`);
    await expect(missingTaskChip).toHaveAttribute("data-state", "missing");
    await expect(page.getByTestId("composer").getByRole("alert")).toContainText(
      "Remove the missing task before sending.",
    );
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toBeDisabled();
    await capture(page, testInfo, "composer-task-references-missing.png");

    const missingTaskRemoved = page.waitForResponse(async (response) => {
      if (
        response.request().method() !== "PUT" ||
        !response.url().endsWith("/draft") ||
        !response.ok()
      ) {
        return false;
      }
      const body = (await response.request().postDataJSON()) as {
        taskReferenceIds?: string[];
      };
      return (
        body.taskReferenceIds?.includes(createdTask.id) === true &&
        body.taskReferenceIds?.includes(disposableTask.id) === false
      );
    });
    await missingTaskChip
      .getByRole("button", { name: "Remove task: Disposable task reference" })
      .click();
    await missingTaskRemoved;

    await expect(textarea).toHaveValue("");
    await sendCurrentDraft(page);
    const deliveredTask = page.locator(
      `details.message-task-card[data-task-id="${createdTask.id}"]`,
    );
    await expect(deliveredTask).toContainText("Ship durable task context");
    await expect(deliveredTask).toContainText("Completed");
    await deliveredTask.locator("summary").click();
    await expect(deliveredTask).toContainText(
      "This is the body captured at send time.",
    );
    await expect(deliveredTask).toContainText(createdTask.id);
    await expect(deliveredTask).toContainText(
      String(acceptedTaskSnapshot.revision),
    );

    await expect(
      page.locator(
        '[data-item-kind="assistant_message"][data-item-status="completed"]',
      ),
    ).toBeVisible({ timeout: 30_000 });
    await page.reload();
    await expect(deliveredTask).toContainText("Ship durable task context");
    await expect(deliveredTask).toContainText(
      "This is the body captured at send time.",
    );
    await page.getByTestId("tasks-panel-toggle").first().click();
    await tasksPanel.getByRole("radio", { name: "Thread" }).click();
    await tasksPanel
      .getByRole("button", { name: 'View "Ship durable task context"' })
      .click();
    await tasksPanel.getByRole("button", { name: "Edit", exact: true }).click();
    await tasksPanel.getByRole("button", { name: "Delete task" }).click();
    const deliveredTaskDeleted = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().endsWith(`/api/tasks/${createdTask.id}`) &&
        response.status() === 204,
    );
    await tasksPanel
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await deliveredTaskDeleted;
    await page.keyboard.press("Escape");

    await expect(deliveredTask).toContainText("Ship durable task context");
    await expect(deliveredTask).toContainText(
      "This is the body captured at send time.",
    );
    await expect(deliveredTask).toContainText(createdTask.id);
    await expect(textarea).toHaveValue("");
  });

  test("draft movement and inventory actions survive normalized transitions", async ({
    page,
  }, testInfo) => {
    await openSedesWorkspace(page);
    const secondWorkspace = path.resolve(import.meta.dirname, "../../src");
    const picker = page
      .getByTestId("desktop-sidebar")
      .getByTestId("workspace-picker");
    await picker.click();
    await page.getByLabel("Absolute directory path").fill(secondWorkspace);
    const opened = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/workspaces/open") &&
        response.status() === 201,
    );
    await page.getByRole("dialog", { name: "Add project" }).getByRole("button", { name: "Add project" }).click();
    await opened;
    const projectFilter = page
      .getByTestId("desktop-sidebar")
      .getByRole("combobox", { name: "Project filter" });
    await expect(projectFilter).toContainText("src");

    // Project selection is an independent, persisted sidebar axis. It remains
    // active in a flat projection and after the application bootstraps again.
    await page
      .getByTestId("desktop-sidebar")
      .getByTestId("view-quick-toggle")
      .click();
    await expect(projectFilter).toContainText("src");
    await page.reload();
    await expect(projectFilter).toContainText("src");
    await page
      .getByTestId("desktop-sidebar")
      .getByTestId("view-quick-toggle")
      .click();

    await selectRadixOption(page, projectFilter, repositoryDisplayName);
    await expect(projectFilter).toContainText(repositoryDisplayName);

    const threadPath = await createDraftThread(page);
    await expect(page.getByTestId("thread-context")).toContainText(
      repositoryDisplayName,
    );
    await fillAndPersistDraft(page, "Preserve this draft while moving it");
    await page.getByRole("button", { name: "Thread actions" }).click();
    const moved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/operations") &&
        response.ok() &&
        response.request().postDataJSON().kind === "move_draft",
    );
    await selectRadixOption(
      page,
      page.getByRole("combobox", { name: "Draft workspace" }),
      "src",
    );
    await moved;
    await expect(page).toHaveURL(threadPath);
    await expect(
      page.getByRole("textbox", { name: "Message Scripted agent" }),
    ).toHaveValue("Preserve this draft while moving it");
    await expect(page.getByTestId("thread-context")).toContainText("src");
    // Routing to a thread in another project does not silently replace the
    // user's filter choice; select the moved thread's project explicitly.
    await expect(projectFilter).toContainText(repositoryDisplayName);
    await selectRadixOption(page, projectFilter, "src");

    const movedThreadId = threadPath.split("/").at(-1)!;
    const desktopSidebar = page.getByTestId("desktop-sidebar");
    const movedThreadRow = desktopSidebar
      .locator(`[data-thread-id="${movedThreadId}"]`)
      .getByTestId("thread-row")
      .first();
    await movedThreadRow.hover();
    const pinned = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/api/threads/${movedThreadId}/pin`) &&
        response.ok(),
    );
    await movedThreadRow
      .getByRole("button", { name: "Pin New thread" })
      .click();
    await pinned;

    // Non-Project views extract a pinned thread into one collapsible group
    // rather than duplicating it in its ordinary Timeline group.
    await desktopSidebar.getByTestId("view-quick-toggle").click();
    const pinnedGroup = desktopSidebar.locator(
      '[data-testid="flat-group"][data-group="pinned"]',
    );
    await expect(pinnedGroup).toContainText("Pinned · 1");
    await expect(pinnedGroup).toContainText("New thread");
    await expect(
      desktopSidebar.locator(`[data-thread-id="${movedThreadId}"]`),
    ).toHaveCount(1);
    await pinnedGroup.getByRole("button", { name: "Pinned · 1" }).click();
    await expect(pinnedGroup.getByTestId("flat-thread-row")).toBeHidden();
    await pinnedGroup.getByRole("button", { name: "Pinned · 1" }).click();
    await expect(pinnedGroup.getByTestId("flat-thread-row")).toBeVisible();
    await capture(page, testInfo, "thread-pinning-sidebar-desktop.png");

    await desktopSidebar.getByRole("button", { name: "View options" }).click();
    await page.getByRole("checkbox", { name: "Pinned only" }).click();
    await page.keyboard.press("Escape");
    await page.reload();
    await expect(pinnedGroup).toContainText("New thread");
    await desktopSidebar.getByRole("button", { name: "View options" }).click();
    await expect(
      page.getByRole("checkbox", { name: "Pinned only" }),
    ).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");

    const pinnedThreadLink = pinnedGroup
      .getByTestId("thread-row-link")
      .filter({ hasText: "New thread" });
    await pinnedThreadLink.click({ button: "right" });
    const unpinned = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/api/threads/${movedThreadId}/pin`) &&
        response.ok(),
    );
    await page.getByRole("menuitem", { name: "Unpin" }).click();
    await unpinned;
    await expect(pinnedGroup).toHaveCount(0);

    await desktopSidebar.getByRole("button", { name: "View options" }).click();
    await page.getByRole("checkbox", { name: "Pinned only" }).click();
    await page.keyboard.press("Escape");
    await expect(
      desktopSidebar.locator(`[data-thread-id="${movedThreadId}"]`),
    ).toHaveCount(1);
    await desktopSidebar.getByTestId("view-quick-toggle").click();

    await page.getByRole("button", { name: "Thread actions" }).click();
    await page
      .getByRole("dialog", { name: "Thread actions" })
      .getByRole("button", { name: "Settle", exact: true })
      .click();
    await expect(
      page
        .getByTestId("desktop-sidebar")
        .locator('[data-testid="inventory-shelf"][data-shelf="settled"]'),
    ).toContainText("New thread");

    await page.getByRole("button", { name: "Thread actions" }).click();
    await page
      .getByRole("dialog", { name: "Thread actions" })
      .getByRole("button", { name: "Unsettle", exact: true })
      .click();
    await expect(
      page
        .getByTestId("desktop-sidebar")
        .locator('[data-testid="inventory-shelf"][data-shelf="settled"]'),
    ).not.toContainText("New thread");

    await page.getByRole("button", { name: "Thread actions" }).click();
    await page.getByRole("button", { name: "Snooze…" }).click();
    const snooze = page.getByRole("dialog", { name: "Snooze this thread" });
    await snooze
      .getByLabel(/Reminder/)
      .fill("Return to this preserved draft");
    await snooze.getByRole("button", { name: "1 hour" }).click();
    await snooze.getByRole("button", { name: "Snooze", exact: true }).click();
    await expect(
      page
        .getByTestId("desktop-sidebar")
        .locator('[data-testid="inventory-shelf"][data-shelf="snoozed"]'),
    ).toContainText("New thread");

    await page.getByRole("button", { name: "Thread actions" }).click();
    await page.getByRole("button", { name: "Wake now" }).click();
    const reminder = page.getByTestId("wake-attention");
    await expect(reminder).toContainText("Return to this preserved draft");
    await page.reload();
    await expect(reminder).toContainText("Return to this preserved draft");
    await reminder.getByRole("button", { name: "Dismiss" }).click();
    await expect(reminder).toBeHidden();
    await page.reload();
    await expect(reminder).toBeHidden();

    // Pinning is orthogonal to inventory lifecycle. Archive hides the thread,
    // but restoring it preserves the principal-owned pin attribute.
    const activeProjectRow = page
      .getByTestId("desktop-sidebar")
      .locator(`[data-thread-id="${movedThreadId}"]`)
      .getByTestId("thread-row")
      .first();
    await activeProjectRow.hover();
    const repinned = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/api/threads/${movedThreadId}/pin`) &&
        response.ok(),
    );
    await activeProjectRow
      .getByRole("button", { name: "Pin New thread" })
      .click();
    await repinned;

    await page.getByRole("button", { name: "Thread actions" }).click();
    // Childless threads archive immediately on desktop — no choices menu.
    await page.getByRole("button", { name: "Archive", exact: true }).click();
    await expect(page).toHaveURL("/");
    await page
      .getByTestId("desktop-sidebar")
      .getByRole("button", { name: "More" })
      .click();
    await page.getByRole("menuitem", { name: "Archived threads" }).click();
    await expect(page).toHaveURL("/archived");
    const archivedThreadId = threadPath.split("/").at(-1)!;
    const archivedRow = page.locator(
      `[data-testid="archive-row"][data-thread-id="${archivedThreadId}"]`,
    );
    await expect(archivedRow).toContainText("New thread");
    await capture(page, testInfo, "restored-inventory-lifecycle.png");
    await archivedRow.getByRole("button", { name: "Restore" }).click();
    await expect(archivedRow).toBeHidden();
    const restoredResponse = await page.request.get(
      "/api/application/snapshot",
    );
    expect(restoredResponse.ok()).toBe(true);
    const restoredSnapshot = (await restoredResponse.json()) as {
      threads: Array<{ id: string; pinned: boolean }>;
    };
    expect(
      restoredSnapshot.threads.find(
        ({ id }) => id === archivedThreadId,
      )?.pinned,
    ).toBe(true);
  });

  test("Stop interrupts an active normalized turn", async ({ page }) => {
    await openSedesWorkspace(page);
    await createDraftThread(page);
    await fillAndPersistDraft(page, "Keep this turn active until I stop it");
    await sendCurrentDraft(page);

    const stop = page.getByRole("button", { name: "Stop" });
    await expect(stop).toBeVisible();
    const interrupted = page.waitForResponse(async (response) => {
      if (
        response.request().method() !== "POST" ||
        !response.url().endsWith("/operations") ||
        !response.ok()
      ) {
        return false;
      }
      return (await response.request().postDataJSON()).kind === "interrupt";
    });
    await stop.click();
    await interrupted;

    await expect(stop).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toBeVisible();
    await expect(
      page.locator('[data-turn-status="interrupted"]'),
    ).toBeVisible();
  });
});


test("failed turns explain the current error and retain quiet details after retry and reload", async ({ page }, testInfo) => {
  await openSedesWorkspace(page, { preserveSidebarView: true });
  await expect(page.getByTestId("desktop-sidebar").getByTestId("view-quick-toggle")).toHaveAccessibleName("Switch to Projects");
  await createDraftThread(page);
  await fillAndPersistDraft(page, "Fail with a visible model configuration diagnostic");
  await sendCurrentDraft(page);
  const diagnostic = "The configured model is unavailable. Select another model.";
  const currentFailure = page.locator(".thread-notice.error").filter({ hasText: diagnostic });
  await expect(currentFailure).toBeVisible();
  await expect(page.locator(".turn-failure-details")).toHaveCount(0);
  await expect(currentFailure).not.toHaveAttribute("role", "alert");
  await capture(page, testInfo, "turn-failure-current.png");

  await page.reload();
  await expect(currentFailure).toBeVisible();
  await expect(page.locator(".turn-failure-details")).toHaveCount(0);
  await capture(page, testInfo, "turn-failure-reopened.png");

  expect((await page.request.post("/__e2e/pi/turn-response/arm")).status()).toBe(204);
  await fillAndPersistDraft(page, "Retry after correcting the model configuration");
  // Drafting a retry is not an authoritative lifecycle transition.
  await expect(currentFailure).toBeVisible();
  await sendCurrentDraft(page);
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(currentFailure).toHaveCount(0);
  const history = page.locator(".turn-failure-details");
  await expect(history).toHaveCount(1);
  await expect(history).not.toHaveAttribute("open");
  await history.getByText("Failed turn details", { exact: true }).click();
  await expect(history.getByText(diagnostic, { exact: true })).toBeVisible();
  await capture(page, testInfo, "turn-failure-history-during-retry.png");
  expect((await page.request.post("/__e2e/pi/turn-response/release")).status()).toBe(204);
  // The retained scripted response completes at 13 × 800 ms after release.
  await expect(page.getByRole("button", { name: "Stop" })).toBeHidden({ timeout: 20_000 });
  await page.reload();
  await expect(currentFailure).toHaveCount(0);
  await expect(history).toHaveCount(1);
  await expect(history).not.toHaveAttribute("open");
  await history.getByText("Failed turn details", { exact: true }).click();
  await expect(history.getByText(diagnostic, { exact: true })).toBeVisible();
  await capture(page, testInfo, "turn-failure-history-reopened.png");
});
