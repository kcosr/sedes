import { test, expect } from "./fixtures";
import {
  openSettingsPage,
  returnFromSettings,
  capture,
  createDraftThread,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openSedesWorkspace,
  sendCurrentDraft,
} from "./helpers";

test.describe.serial("normalized streaming and restored state", () => {
  let completedThreadPath = "";

  test("desktop session streams semantic tools and progressive assistant text", async ({
    page,
  }, testInfo) => {
    const session = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" &&
        response.url().endsWith("/api/application/session") &&
        response.ok(),
    );
    await openSedesWorkspace(page);
    await session;
    completedThreadPath = await createDraftThread(page);
    await expect(page.getByText("This thread is ready")).toBeVisible();
    // Finish the new-thread focus handoff before exercising picker autofocus.
    await expect(
      page.getByRole("textbox", { name: "Message Scripted agent" }),
    ).toBeFocused();
    const desktopModelPicker = page
      .getByTestId("composer")
      .getByRole("combobox", { name: "Model" });
    await desktopModelPicker.click();
    const desktopModelSearch = page.getByRole("searchbox", {
      name: "Search models",
    });
    await expect(desktopModelSearch).toBeFocused();
    await desktopModelSearch.fill("CONFORMANCE");
    await expect(
      page.getByRole("option", { name: "Conformance model" }),
    ).toBeVisible();
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "normalized-model-picker-desktop.png");
    await page.keyboard.press("Escape");
    await expect(desktopModelPicker).toBeFocused();
    await page.getByRole("button", { name: "Thread actions" }).click();
    await expect(page.getByRole("button", { name: "Automate…" })).toBeVisible();
    await page.keyboard.press("Escape");

    const prompt = "Summarize normalized streaming";
    await fillAndPersistDraft(page, prompt);
    await sendCurrentDraft(page);

    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    const activityGroup = page
      .locator('[data-testid="activity-group"][data-activity-detail="full"]')
      .last();
    await expect(activityGroup).toBeVisible();
    await expect(activityGroup).toHaveAttribute(
      "data-activity-status",
      "working",
    );
    const activityToggle = activityGroup.getByRole("button", {
      name: /^Activity/,
    });
    await expect(activityToggle).toHaveAttribute("aria-expanded", "false");
    await activityToggle.click();
    await expect(activityToggle).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator('[data-item-kind="tool"]')).toBeVisible();
    await expect
      .poll(() =>
        activityGroup.evaluate((group) => {
          const content = group.closest<HTMLElement>(".message-content");
          const details = group.querySelector<HTMLElement>(
            '[data-testid="activity-group-details"]',
          );
          const cards = Array.from(
            group.querySelectorAll<HTMLElement>(".op-card"),
          );
          if (!content || !details || cards.length === 0) return false;
          const contentRight = content.getBoundingClientRect().right;
          return (
            details.scrollWidth <= details.clientWidth + 1 &&
            cards.every(
              (card) => card.getBoundingClientRect().right <= contentRight + 1,
            )
          );
        }),
      )
      .toBe(true);
    const userItem = page.locator('[data-item-kind="user_message"]').last();
    const tool = page
      .locator('[data-item-kind="tool"]')
      .getByRole("button", { name: /Inspect workspace/ });
    await expect(tool).toBeVisible();

    const streamingWrite = activityGroup
      .locator('[data-item-kind="file_change"]')
      .last();
    await expect(streamingWrite).toBeVisible();
    await expect(streamingWrite).toHaveAttribute(
      "data-item-status",
      "streaming",
    );
    const writeToggle = streamingWrite.getByRole("button", {
      name: /Write/,
    });
    await expect(writeToggle).toHaveAttribute("aria-expanded", "false");
    await expect(writeToggle.locator(".op-target-scroll")).toHaveText("streaming-notes.md");
    await writeToggle.click();
    await expect(writeToggle).toHaveAttribute("aria-expanded", "true");
    const writeDiff = streamingWrite.getByTestId("pierre-file-change-diff");
    await expect(writeDiff).toBeVisible();
    await expect(writeDiff).toHaveAttribute(
      "aria-label",
      "Diff for streaming-notes.md",
    );
    await expect(streamingWrite).toContainText("# Streaming notes");
    await expect(streamingWrite).toContainText("first line");
    await expect(writeToggle.locator(".diff-counts")).toHaveText(
      /^\+(?:2|3) −0$/,
    );
    const activityBarBox = await page
      .locator(".input-activity-bar")
      .boundingBox();
    const composer = page.getByTestId("composer");
    const composerBox = await composer.boundingBox();
    const composerCornerRadius = await composer.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).borderTopLeftRadius),
    );
    expect(activityBarBox).not.toBeNull();
    expect(composerBox).not.toBeNull();
    expect(
      Math.abs(activityBarBox!.x - (composerBox!.x + composerCornerRadius)),
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(
        activityBarBox!.width - (composerBox!.width - composerCornerRadius * 2),
      ),
    ).toBeLessThanOrEqual(1);
    const writeElement = await streamingWrite.elementHandle();
    expect(writeElement).not.toBeNull();
    const userPrecedesWrite = await userItem.evaluate(
      (user, write) =>
        Boolean(
          user.compareDocumentPosition(write as Node) &
          Node.DOCUMENT_POSITION_FOLLOWING,
        ),
      writeElement!,
    );
    expect(userPrecedesWrite).toBe(true);
    await capture(page, testInfo, "normalized-progressive-tool-desktop.png");
    await expect(streamingWrite).toContainText("second line");
    await expect(writeToggle.locator(".diff-counts")).toContainText("+3");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(writeDiff).toBeVisible();
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "normalized-progressive-tool-mobile.png");
    await page.setViewportSize({ width: 1280, height: 720 });

    const streamingCommand = activityGroup
      .locator('[data-item-kind="command"]')
      .last();
    await expect(streamingCommand).toBeVisible();
    await expect(streamingCommand).toHaveAttribute(
      "data-item-status",
      "streaming",
    );
    const commandToggle = streamingCommand.getByRole("button", {
      name: /Command/,
    });
    await expect(commandToggle).toHaveAttribute("aria-expanded", "false");
    await page.setViewportSize({ width: 390, height: 844 });
    const commandPreview = commandToggle.locator(".op-target-scroll");
    await expect.poll(() => commandPreview.evaluate(
      (element) => element.scrollWidth > element.clientWidth,
    )).toBe(true);
    await commandPreview.scrollIntoViewIfNeeded();
    await capture(page, testInfo, "normalized-command-preview-mobile.png");
    const previewBox = await commandPreview.boundingBox();
    expect(previewBox).not.toBeNull();
    await page.mouse.move(previewBox!.x + previewBox!.width - 8, previewBox!.y + previewBox!.height / 2);
    await page.mouse.wheel(100, 0);
    await expect.poll(() => commandPreview.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await expect(commandToggle).toHaveAttribute("aria-expanded", "false");
    await commandPreview.evaluate((element) => { element.scrollLeft = 0; });
    await commandPreview.evaluate((element) => { element.scrollLeft = 0; });
    const dragBox = (await commandPreview.boundingBox())!;
    await page.mouse.move(dragBox.x + dragBox.width - 8, dragBox.y + dragBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(dragBox.x + 8, dragBox.y + dragBox.height / 2, { steps: 5 });
    await page.mouse.up();
    await expect.poll(() => commandPreview.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await expect(commandPreview).toHaveAttribute("data-scrolled", "true");
    await expect(commandPreview).toHaveCSS("text-overflow", "clip");
    await expect(commandToggle).toHaveAttribute("aria-expanded", "false");
    await commandToggle.focus();
    await page.keyboard.press("ArrowLeft");
    await expect.poll(() => commandPreview.evaluate((element) => element.scrollLeft)).toBe(0);
    await expect(commandPreview).toHaveAttribute("data-scrolled", "false");
    await expect(commandPreview).toHaveCSS("text-overflow", "ellipsis");
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => commandPreview.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await expect(commandToggle).toHaveAttribute("aria-expanded", "false");
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "normalized-command-scroll-mobile.png");
    await page.setViewportSize({ width: 1280, height: 720 });
    await commandToggle.click();
    await expect(commandToggle).toHaveAttribute("aria-expanded", "true");
    await expect(streamingCommand).toContainText("first output");
    await expect(streamingCommand).toContainText("second output");

    await page.evaluate(() => {
      type SmoothStreamingProbe = {
        observer: MutationObserver;
        state: {
          sawFadingGrapheme: boolean;
          sawFadingList: boolean;
          sawSettledWhileStreaming: boolean;
          maximumGraphemes: number;
          animatedTextInLayout: boolean;
          renderedLengths: number[];
        };
      };
      const targetWindow = window as typeof window & {
        __sedesSmoothStreamingProbe?: SmoothStreamingProbe;
      };
      const state = {
        sawFadingGrapheme: false,
        sawFadingList: false,
        sawSettledWhileStreaming: false,
        maximumGraphemes: 0,
        animatedTextInLayout: true,
        renderedLengths: [] as number[],
      };
      const sample = () => {
        const active = document.querySelector<HTMLElement>(
          '[data-item-kind="assistant_message"][data-item-status="streaming"] .progressive-markdown-animated .markdown',
        );
        if (!active) return;
        const graphemes = [
          ...active.querySelectorAll<HTMLElement>(
            ".progressive-markdown-grapheme",
          ),
        ];
        state.maximumGraphemes = Math.max(
          state.maximumGraphemes,
          graphemes.length,
        );
        state.sawFadingGrapheme ||= graphemes.some(
          (grapheme) => Number(getComputedStyle(grapheme).opacity) < 1,
        );
        state.sawFadingList ||= [...active.querySelectorAll<HTMLElement>("li .progressive-markdown-grapheme")].some(
          (span) => Number(getComputedStyle(span).opacity) < 1,
        );
        state.sawSettledWhileStreaming ||=
          graphemes.length > 0 &&
          graphemes.every(
            (grapheme) => Number(getComputedStyle(grapheme).opacity) === 1,
          );
        const renderedLength = active.textContent?.length ?? 0;
        if (state.renderedLengths.at(-1) !== renderedLength) {
          state.renderedLengths.push(renderedLength);
        }
        state.animatedTextInLayout &&=
          [...active.querySelectorAll(".progressive-markdown-grapheme")].every((span) =>
            span.textContent !== "" && Number(getComputedStyle(span).opacity) > 0 &&
            getComputedStyle(span).display === "inline",
          );
      };
      const observer = new MutationObserver(sample);
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["style"],
      });
      targetWindow.__sedesSmoothStreamingProbe = { observer, state };
      sample();
    });

    const assistant = page.locator('[data-item-kind="assistant_message"]');
    const streamingAssistant = page.locator(
      '[data-item-kind="assistant_message"][data-item-status="streaming"]',
    );
    await expect(streamingAssistant).toBeVisible();
    await expect(
      streamingAssistant.getByRole("heading", { name: "Live summary" }),
    ).toBeVisible();
    const activeStreamingMarkdown = streamingAssistant.locator(
      '.progressive-markdown-animated .markdown',
    );
    await expect(activeStreamingMarkdown).toContainText("Workspace inspected");
    await expect(streamingAssistant.locator("strong").first()).toHaveText("Workspace inspected");
    await page.getByRole("button", { name: "Find in thread" }).click();
    const streamingFind = page.getByRole("searchbox", {
      name: "Find in thread",
    });
    await streamingFind.fill("Workspace");
    await expect(page.locator(".thread-find-count")).toHaveText(
      /^1 of \d+$/,
    );
    await expect
      .poll(() =>
        page.evaluate(() =>
          (
            CSS as unknown as {
              highlights?: Map<string, { size: number }>;
            }
          ).highlights?.get("sedes-thread-find-match")?.size ?? 0,
        ),
      )
      .toBeGreaterThan(0);
    await capture(page, testInfo, "thread-find-streaming-desktop.png");
    await page.keyboard.press("Escape");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const targetWindow = window as typeof window & {
            __sedesSmoothStreamingProbe?: {
              state: { sawFadingList: boolean };
            };
          };
          return Boolean(
            targetWindow.__sedesSmoothStreamingProbe?.state.sawFadingList,
          );
        }),
      )
      .toBe(true);
    const activeAccessibility = await activeStreamingMarkdown.ariaSnapshot();
    expect(activeAccessibility.match(/Workspace inspected/gu)).toHaveLength(1);
    const fadeState = await page.evaluate(() => {
      const targetWindow = window as typeof window & {
        __sedesSmoothStreamingProbe?: {
          state: {
            sawFadingGrapheme: boolean;
            sawFadingList: boolean;
            sawSettledWhileStreaming: boolean;
            maximumGraphemes: number;
            animatedTextInLayout: boolean;
            renderedLengths: number[];
          };
        };
      };
      return targetWindow.__sedesSmoothStreamingProbe?.state;
    });
    expect(fadeState).toBeDefined();
    expect(fadeState!.maximumGraphemes).toBeGreaterThan(0);
    expect(fadeState!.maximumGraphemes).toBeLessThanOrEqual(128);
    expect(fadeState!.sawFadingGrapheme).toBe(true);
    expect(fadeState!.sawFadingList).toBe(true);
    await expect(streamingAssistant.locator("li")).toHaveText([
      "Workspace inspected I found a deterministic normalized result for Summarize normalized streaming.",
    ]);
    expect(fadeState!.animatedTextInLayout).toBe(true);
    await capture(
      page,
      testInfo,
      "normalized-progressive-markdown-desktop.png",
    );

    await expect(assistant).toContainText("I found");
    await expect(assistant).toContainText("a deterministic normalized result");
    await expect(
      page.locator(
        '[data-item-kind="assistant_message"][data-item-status="completed"]',
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toBeVisible();

    const completedAssistant = page
      .locator(
        '[data-item-kind="assistant_message"][data-item-status="completed"]',
      )
      .last();
    await expect(
      completedAssistant.locator("strong", {
        hasText: "Workspace inspected",
      }),
    ).toBeVisible();
    await expect(
      completedAssistant.locator("li[data-markdown-block]").first(),
    ).toBeVisible();
    await expect(
      completedAssistant.locator(".progressive-markdown-animated"),
    ).toHaveCount(0);
    const completedFadeState = await page.evaluate(() => {
      const targetWindow = window as typeof window & {
        __sedesSmoothStreamingProbe?: {
          observer: MutationObserver;
          state: {
            sawSettledWhileStreaming: boolean;
            renderedLengths: number[];
          };
        };
      };
      const state = targetWindow.__sedesSmoothStreamingProbe?.state;
      targetWindow.__sedesSmoothStreamingProbe?.observer.disconnect();
      delete targetWindow.__sedesSmoothStreamingProbe;
      return state;
    });
    expect(completedFadeState?.sawSettledWhileStreaming).toBe(true);
    expect(
      new Set(completedFadeState?.renderedLengths ?? []).size,
    ).toBeGreaterThan(1);
    await completedAssistant.evaluate((root) => {
      const listItem = root.querySelector("li");
      if (!listItem) throw new Error("Completed assistant list item missing");
      const range = document.createRange();
      range.selectNodeContents(listItem);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    const chatSelectionActions = page.getByRole("toolbar", {
      name: "Selected message text actions",
    });
    await expect(chatSelectionActions).toBeVisible();
    await chatSelectionActions
      .getByRole("button", { name: "Add note…" })
      .click();
    await chatSelectionActions
      .getByRole("textbox", { name: "Note about selected message text" })
      .fill("Use this completed response as context");
    await capture(page, testInfo, "chat-selection-note-desktop.png");
    await page.keyboard.press("Escape");
    await expect(
      chatSelectionActions.getByRole("textbox", {
        name: "Note about selected message text",
      }),
    ).toBeHidden();
    await page.keyboard.press("Escape");
    await expect(chatSelectionActions).toBeHidden();

    const historyTarget = page.getByRole("button", {
      name: "Jump to conversation message 1",
    });
    await expect(historyTarget).toBeVisible();
    await expect(historyTarget).toHaveAttribute("aria-current", "location");
    await historyTarget.hover();
    const historyPreview = page.getByRole("tooltip");
    await expect(historyPreview).toContainText(prompt);
    await expect(historyPreview).toContainText(
      "I found a deterministic normalized result",
    );
    await capture(page, testInfo, "chat-history-rail-hover-desktop.png");

    await expect(
      page.locator('[data-item-kind="tool"][data-item-status="completed"]'),
    ).toBeVisible();
    await expect(tool).toHaveAttribute("aria-expanded", "false");
    await tool.click();
    await expect(tool).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.getByRole("heading", { name: "Arguments" }),
    ).toBeVisible();
    await expect(page.getByText("workspace inspection complete")).toBeVisible();
    await expect(page.getByText("files", { exact: true })).toBeVisible();
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "normalized-semantic-tool-desktop.png");

    const completedWrite = page
      .locator('[data-item-kind="file_change"][data-item-status="completed"]')
      .filter({ hasText: "streaming-notes.md" });
    const completedWriteToggle = completedWrite.getByRole("button", {
      name: /Write/,
    });
    if ((await completedWriteToggle.getAttribute("aria-expanded")) !== "true") {
      await completedWriteToggle.click();
    }
    await completedWrite
      .getByRole("button", {
        name: /Line wrap on/,
      })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() => localStorage.getItem("sedes-diff-line-wrap")),
      )
      .toBe("false");

    await page.reload();
    const reloadedActivityToggle = page
      .locator('[data-testid="activity-group"][data-activity-detail="full"]')
      .last()
      .getByRole("button", { name: /^Activity/ });
    await expect(reloadedActivityToggle).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await reloadedActivityToggle.click();
    const reloadedWrite = page
      .locator('[data-item-kind="file_change"][data-item-status="completed"]')
      .filter({ hasText: "streaming-notes.md" });
    const reloadedWriteToggle = reloadedWrite.getByRole("button", {
      name: /Write/,
    });
    await reloadedWriteToggle.click();
    await expect(
      reloadedWrite.getByRole("button", { name: /Horizontal scroll/ }),
    ).toHaveAttribute("aria-pressed", "false");
    await expect(
      reloadedWrite.getByTestId("pierre-file-change-diff"),
    ).toBeVisible();
    // Touch emulation changes browser input capabilities; exercise it after desktop checks.
    await page.setViewportSize({ width: 390, height: 844 });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true });
    // Resizing re-renders the diff above the command asynchronously. Its outer
    // container is visible before the lines reserve their final height.
    await expect(reloadedWrite.locator('[data-line="3"]')).toHaveText("second line");
    await expect(reloadedWrite.locator('[data-line="3"]')).toBeVisible();
    // A trial action waits for stable geometry and an unobstructed hit target
    // without toggling the command before the actual touch gesture.
    await commandPreview.click({ trial: true });
    const touchBox = (await commandPreview.boundingBox())!;
    const touchY = touchBox.y + touchBox.height / 2;
    const touchX = touchBox.x + touchBox.width - 8;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: touchX, y: touchY }] });
    for (let offset = 15; offset <= 90; offset += 15) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: touchX - offset, y: touchY }] });
      await page.waitForTimeout(30);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect.poll(() => commandPreview.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
    await expect(commandToggle).toHaveAttribute("aria-expanded", "false");
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await cdp.detach();
    await capture(page, testInfo, "normalized-command-touch-mobile.png");
  });

  test("summary projection exposes explicit reasoning status without full activity", async ({
    page,
  }, testInfo) => {
    await page.goto(completedThreadPath);
    const fullGroup = page
      .locator('[data-testid="activity-group"][data-activity-detail="full"]')
      .last();
    const fullToggle = fullGroup.getByRole("button", {
      name: /^Activity/,
    });
    await fullToggle.click();
    await expect(
      page.getByRole("button", { name: /Inspect workspace/ }),
    ).toBeVisible();

    await openSettingsPage(page, "general");
    const setting = page.getByTestId("activity-detail-setting");
    await expect(setting).toHaveValue("full");
    const summaryStream = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        request.method() === "GET" &&
        url.pathname.endsWith("/events") &&
        url.searchParams.get("activityDetail") === "summary"
      );
    });
    await setting.selectOption("summary");
    await summaryStream;
    await returnFromSettings(page);

    const summaryGroup = page
      .locator('[data-testid="activity-group"][data-activity-detail="summary"]')
      .last();
    await expect(summaryGroup).toBeVisible();
    await expect(summaryGroup).toContainText(/^Activity/);
    const summaryToggle = summaryGroup.getByRole("button", {
      name: /^Activity/,
    });
    await expect(summaryToggle).toHaveAttribute("aria-expanded", "false");
    await summaryToggle.click();
    await expect(summaryToggle).toHaveAttribute("aria-expanded", "true");
    const enableDetails = summaryGroup.getByRole("button", {
      name: "Enable details",
    });
    await expect(enableDetails).toBeVisible();
    await expect(
      summaryGroup.getByTestId("activity-group-details"),
    ).toHaveCount(0);
    await expect(summaryGroup.locator("[data-item-kind]")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /Inspect workspace/ }),
    ).toHaveCount(0);
    await capture(page, testInfo, "normalized-activity-summary-desktop.png");

    await fillAndPersistDraft(page, "Stream explicit reasoning summaries");
    await sendCurrentDraft(page);

    const summaryStatus = page.getByTestId("reasoning-summary-status");
    const summaryTrigger = summaryStatus.getByRole("button", {
      name: "Show full reasoning summary",
    });
    const busyBar = page.locator(".input-activity-bar.visible");
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(busyBar).toBeVisible();

    await expect(summaryTrigger).toHaveText("Preparing");
    await expect(summaryTrigger).toHaveText(
      "Preparing to inspect the workspace",
    );
    await expect(summaryTrigger).toContainText("Running focused checks");
    await expect(summaryTrigger).not.toContainText(
      "Preparing to inspect the workspace",
    );
    await expect(summaryStatus).toHaveAttribute("data-visible", "true");
    await expect(
      summaryStatus.locator(".reasoning-summary-status-dot"),
    ).toBeVisible();
    const assistantMessage = page
      .locator('[data-item-kind="assistant_message"] .markdown')
      .last();
    await expect(assistantMessage).toBeVisible();
    const [statusFontSize, assistantFontSize] = await Promise.all([
      summaryTrigger.evaluate((element) => getComputedStyle(element).fontSize),
      assistantMessage.evaluate(
        (element) => getComputedStyle(element).fontSize,
      ),
    ]);
    expect(statusFontSize).toBe(assistantFontSize);
    // Hold the ephemeral row steady while viewport, screenshot, and popover
    // assertions inspect the final streamed part.
    await summaryTrigger.hover();
    await summaryTrigger.focus();

    for (const privateMarker of [
      "RAW_REASONING_DETAIL_MUST_NOT_REACH_SUMMARY_CLIENT",
      "TOOL_DETAIL_MUST_NOT_REACH_SUMMARY_CLIENT",
      "TOOL_RESULT_MUST_NOT_REACH_SUMMARY_CLIENT",
    ]) {
      await expect(page.getByText(privateMarker, { exact: false })).toHaveCount(
        0,
      );
    }
    await expect(page.locator('[data-item-kind="reasoning"]')).toHaveCount(0);
    await expect(page.locator('[data-item-kind="tool"]')).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(summaryStatus).toBeVisible();
    await expectNoPageOverflow(page);
    const compactLayout = await summaryTrigger.evaluate((trigger) => {
      const candidates = [
        trigger,
        ...Array.from(trigger.querySelectorAll("*")),
      ];
      const truncated = candidates.find((candidate) => {
        const style = getComputedStyle(candidate);
        return (
          style.whiteSpace === "nowrap" &&
          style.overflowX === "hidden" &&
          style.textOverflow === "ellipsis"
        );
      });
      const status = trigger.closest<HTMLElement>(
        '[data-testid="reasoning-summary-status"]',
      );
      const activityBar = document.querySelector<HTMLElement>(
        ".input-activity-bar.visible",
      );
      const composerWrap =
        document.querySelector<HTMLElement>(".composer-wrap");
      const statusRect = status?.getBoundingClientRect();
      const activityRect = activityBar?.getBoundingClientRect();
      return {
        hasEllipsisTarget: truncated !== undefined,
        statusHeight: statusRect?.height ?? 0,
        statusBeforeComposer:
          Boolean(status && composerWrap) &&
          Boolean(
            status!.compareDocumentPosition(composerWrap!) &
            Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        statusAboveActivityBar:
          statusRect !== undefined &&
          activityRect !== undefined &&
          statusRect.bottom <= activityRect.top + 1,
      };
    });
    expect(compactLayout.hasEllipsisTarget).toBe(true);
    expect(compactLayout.statusHeight).toBeGreaterThan(0);
    expect(compactLayout.statusHeight).toBeLessThanOrEqual(44);
    expect(compactLayout.statusBeforeComposer).toBe(true);
    expect(compactLayout.statusAboveActivityBar).toBe(true);
    await capture(
      page,
      testInfo,
      "normalized-reasoning-summary-status-mobile.png",
    );

    await summaryTrigger.click();
    const summaryPopover = page.getByTestId("reasoning-summary-popover");
    await expect(summaryPopover).toBeVisible();
    await expect(
      page.getByRole("dialog", { name: "Reasoning summary" }),
    ).toBeVisible();
    await expect(summaryPopover).toContainText(
      "Running focused checks across the workspace before executing the normalized streaming verification sequence",
    );
    await expect(summaryPopover).not.toContainText(
      "RAW_REASONING_DETAIL_MUST_NOT_REACH_SUMMARY_CLIENT",
    );
    await page.keyboard.press("Escape");
    await expect(summaryPopover).toBeHidden();
    await page.keyboard.press("Tab");
    await expect(summaryTrigger).not.toBeFocused();
    await page.mouse.move(0, 0);

    // The defined idle fade removes only the ephemeral summary. The generic
    // running treatment remains authoritative until the turn settles.
    await expect(summaryStatus).toHaveAttribute("data-visible", "false", {
      timeout: 6_000,
    });
    await expect(busyBar).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    await expect(
      page.locator(
        '[data-item-kind="assistant_message"][data-item-status="completed"]',
      ),
    ).toBeVisible();
    await page.setViewportSize({ width: 1280, height: 720 });

    const latestSummaryGroup = page
      .locator('[data-testid="activity-group"][data-activity-detail="summary"]')
      .last();
    const latestSummaryToggle = latestSummaryGroup.getByRole("button", {
      name: /^Activity/,
    });
    await latestSummaryToggle.click();
    const latestEnableDetails = latestSummaryGroup.getByRole("button", {
      name: "Enable details",
    });
    await expect(latestEnableDetails).toBeVisible();

    const fullStream = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return (
        request.method() === "GET" &&
        url.pathname.endsWith("/events") &&
        url.searchParams.get("activityDetail") === "full"
      );
    });
    await latestEnableDetails.click();
    await fullStream;
    const restoredFullGroup = page
      .locator('[data-testid="activity-group"][data-activity-detail="full"]')
      .last();
    await expect(restoredFullGroup).toBeVisible();
    await expect(
      restoredFullGroup.getByRole("button", { name: /^Activity/ }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(
      restoredFullGroup.getByTestId("activity-group-details"),
    ).toBeVisible();
    await expect(
      restoredFullGroup.getByRole("button", { name: "Disable details" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Inspect workspace/ }),
    ).toBeVisible();
  });

  test("a Mermaid fence hides incomplete source and renders as soon as it closes", async ({
    page,
  }, testInfo) => {
    await openSedesWorkspace(page);
    await createDraftThread(page);
    await fillAndPersistDraft(page, "Stream a Mermaid diagram progressively");
    expect((await page.request.post("/__e2e/pi/mermaid/arm")).status()).toBe(204);
    try {
      await sendCurrentDraft(page);

      const streamingAssistant = page.locator(
        '[data-item-kind="assistant_message"][data-item-status="streaming"]',
      );
      await expect(streamingAssistant).toBeVisible({ timeout: 12_000 });
      await expect(
        streamingAssistant.getByText("Waiting for diagram…", { exact: true }),
      ).toBeVisible();
      await expect(streamingAssistant).not.toContainText("flowchart TD");
      await expect(
        streamingAssistant.getByRole("img", { name: "Mermaid diagram" }),
      ).toHaveCount(0);

      // Advance only after observing the incomplete fence; hold settlement until
      // the real renderer and browser have observed the closed diagram.
      expect((await page.request.post("/__e2e/pi/mermaid/release/closed")).status()).toBe(204);
      const diagram = streamingAssistant.getByRole("img", {
        name: "Mermaid diagram",
      });
      await expect(diagram).toBeVisible();
      await expect(streamingAssistant).toContainText(
        "Diagram ready while the response is still streaming.",
      );
      await expect(streamingAssistant).toHaveAttribute(
        "data-item-status",
        "streaming",
      );
      const messageViewport = page.getByRole("region", { name: "Messages" });
      const diagramSvg = streamingAssistant.locator(
        ".mermaid-diagram-svg > svg",
      );
      const expectDiagramToFitViewport = async () => {
        await expect.poll(() => diagramSvg.evaluate((svg) => {
          const viewport = svg.closest<HTMLElement>(".message-viewport")!;
          const maximum = Math.max(0, viewport.clientHeight - 32);
          const renderedHeight = svg.getBoundingClientRect().height;
          const maximumHeight = Number.parseFloat(getComputedStyle(svg).maxHeight);
          return viewport.clientHeight > 100 &&
            renderedHeight > 0 && renderedHeight <= maximum + 1 &&
            Math.abs(maximumHeight - maximum) <= 1;
        })).toBe(true);
      };
      await expectDiagramToFitViewport();
      const [messageViewportBox, diagramSvgBox] = await Promise.all([
        messageViewport.boundingBox(),
        diagramSvg.boundingBox(),
      ]);
      expect(messageViewportBox).not.toBeNull();
      expect(diagramSvgBox).not.toBeNull();
      expect(diagramSvgBox!.height).toBeLessThanOrEqual(
        messageViewportBox!.height - 31,
      );
      expect(diagramSvgBox!.height).toBeGreaterThan(
        messageViewportBox!.height * 0.7,
      );
      await capture(page, testInfo, "normalized-streaming-mermaid-closed.png");
      const desktopViewport = page.viewportSize()!;
      await page.setViewportSize({ width: 390, height: 844 });
      await expectDiagramToFitViewport();
      await expectNoPageOverflow(page);
      await capture(page, testInfo, "normalized-streaming-mermaid-mobile.png");
      // A keyboard-like height reduction must size media against the actual
      // message region, including the composer and other surrounding chrome.
      await page.setViewportSize({ width: 390, height: 500 });
      await expectDiagramToFitViewport();
      await expectNoPageOverflow(page);
      await capture(page, testInfo, "normalized-streaming-mermaid-mobile-short.png");
      await page.setViewportSize(desktopViewport);
      await expectDiagramToFitViewport();
      expect((await page.request.post("/__e2e/pi/mermaid/release/settled")).status()).toBe(204);

      await expect(
        page.locator(
          '[data-item-kind="assistant_message"][data-item-status="completed"]',
        ),
      ).toContainText("Diagram ready while the response is still streaming.");
    } finally {
      // Ensure a failed assertion cannot leave this job's fixture turn held.
      await page.request.post("/__e2e/pi/mermaid/release/closed");
      await page.request.post("/__e2e/pi/mermaid/release/settled");
    }
  });

  test("an unselected automation clone publishes live sidebar activity", async ({
    page,
  }, testInfo) => {
    await page.goto(completedThreadPath);
    const sourceThreadId = completedThreadPath.split("/").at(-1);
    expect(sourceThreadId).toBeTruthy();
    const sessionResponse = await page.request.get(
      "/api/application/session",
    );
    expect(sessionResponse.ok()).toBe(true);
    const session = (await sessionResponse.json()) as {
      csrfToken: string;
    };
    const headers = {
      "Content-Type": "application/json",
      "X-CSRF-Token": session.csrfToken,
    };
    const createResponse = await page.request.post(
      `/api/threads/${sourceThreadId}/automation`,
      {
        headers,
        data: {
          prompt: "Exercise background activity projection",
          runMode: "clone",
          schedule: {
            kind: "date_time",
            runAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
          misfirePolicy: "skip",
          precheck: null,
          mutationId: crypto.randomUUID(),
        },
      },
    );
    expect(createResponse.ok()).toBe(true);

    const runResponse = await page.request.post(
      `/api/threads/${sourceThreadId}/automation/run-now`,
      {
        headers,
        data: { mutationId: crypto.randomUUID() },
      },
    );
    expect(runResponse.ok()).toBe(true);
    const run = (await runResponse.json()) as {
      resultThreadId?: string;
    };
    expect(run.resultThreadId).toBeTruthy();
    await expect(page).toHaveURL(completedThreadPath);

    const activeChild = page
      .getByTestId("desktop-sidebar")
      .locator(`[data-thread-id="${run.resultThreadId}"]`);
    await expect(activeChild).toHaveCount(1);
    await expect(activeChild.locator('[data-selected="false"]')).toHaveCount(1);
    const runningIndicator = activeChild.getByRole("img", { name: "Running", exact: true });
    await expect(runningIndicator).toBeVisible();
    await expect(activeChild).toContainText("New thread");
    await capture(page, testInfo, "background-automation-clone-activity.png");

    await expect(runningIndicator).toBeHidden({ timeout: 15_000 });
    const latestDefinitionResponse = await page.request.get(
      `/api/threads/${sourceThreadId}/automation`,
    );
    expect(latestDefinitionResponse.ok()).toBe(true);
    const latestDefinition = (await latestDefinitionResponse.json()) as {
      revision: number;
      lastRun?: { state: string };
    };
    expect(latestDefinition.lastRun?.state).toBe("completed");
    const deleteResponse = await page.request.delete(
      `/api/threads/${sourceThreadId}/automation`,
      {
        headers,
        data: {
          expectedRevision: latestDefinition.revision,
          mutationId: crypto.randomUUID(),
        },
      },
    );
    expect(deleteResponse.ok()).toBe(true);
  });

  test("restored stats, compaction, and appearance use normalized state", async ({
    page,
  }, testInfo) => {
    await page.goto(completedThreadPath);
    await page.getByRole("button", { name: "Thread actions" }).click();
    await page.getByRole("button", { name: "Session stats" }).click();
    const stats = page.getByRole("dialog", { name: "Session stats" });
    await expect(stats).toBeVisible();
    await expect(stats.getByText("Context used")).toBeVisible();
    await expect(stats.getByText("Compactions")).toBeVisible();
    await expect(stats.getByRole("heading", { name: "Recorded session usage" })).toBeVisible();
    await expect(stats.getByText("Estimated cost")).toBeVisible();
    await expect(stats.getByText(/fixture-model/)).toBeVisible();
    await capture(page, testInfo, "restored-session-stats.png");
    await stats
      .getByRole("button", { name: "Close", exact: true })
      .last()
      .click();
    const usageButton = page.getByRole("button", { name: "Turn usage and cost" }).last();
    await usageButton.hover();
    const turnUsage = page.getByRole("dialog", { name: "Turn usage", exact: true });
    await expect(turnUsage).toBeVisible();
    await expect(turnUsage.getByText("Input", { exact: true })).toBeVisible();
    await expect(turnUsage.getByText("11", { exact: true })).toBeVisible();
    await expect(turnUsage.getByText("7", { exact: true })).toBeVisible();
    await expect(turnUsage.getByText("$0.0002", { exact: true })).toBeVisible();
    await usageButton.click();
    await page.getByRole("button", { name: "Thread actions" }).hover();
    await expect(turnUsage).toBeVisible();
    await capture(page, testInfo, "recorded-turn-usage.png");
    await page.keyboard.press("Escape");
    await expect(turnUsage).toHaveCount(0);
    await expect(usageButton).toBeFocused();

    await openSettingsPage(page, "appearance");
    await page.getByRole("radio", { name: "Dark" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await returnFromSettings(page);
    await expect(page.getByTestId("settings-view")).toHaveCount(0);
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.getByRole("button", { name: "Thread actions" }).click();
    const compactResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/operations") &&
        response.ok() &&
        response.request().postDataJSON().kind === "perform" &&
        response.request().postDataJSON().operation?.action === "compact",
    );
    await page.getByRole("button", { name: "Compact context" }).click();
    await compactResponse;
    await expect(page.locator('[data-item-kind="compaction"]')).toBeVisible();
    await page.getByRole("button", { name: "Thread actions" }).click();
    await page.getByRole("button", { name: "Session stats" }).click();
    await expect(
      page
        .getByRole("dialog", { name: "Session stats" })
        .getByTestId("session-stat-group")
        .filter({ hasText: "Compactions" })
        .getByText("1", { exact: true }),
    ).toBeVisible();
    await capture(page, testInfo, "restored-compact-dark.png");
    await page.keyboard.press("Escape");

    // Exercise the compact mobile layout with realistic partial Codex counts.
    // Availability remains backed by the real fixture's persisted turn usage.
    await page.route("**/api/threads/*/usage/turns/*", async route => {
      const response = await route.fetch();
      const report = await response.json();
      report.state = "partial";
      report.measurementScope = "partial_interval";
      report.summary.models = [{ model: null, provider: null }];
      report.summary.costs = [];
      report.summary.costQuality = "unreported";
      report.summary.reasons = ["unknown_baseline", "model_coverage_unknown", "main_loop_only"];
      for (const [key, value] of Object.entries({ input: "20178", output: "249", cacheRead: "18496", cacheWrite: "0", reasoning: "0", total: "20427" })) {
        report.summary.metrics[key] = { value, quality: "partial", basis: ["sdk_normalized", "derived"], providerPresence: "unknown" };
      }
      await route.fulfill({ response, json: report });
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const touch = await page.context().newCDPSession(page);
    await touch.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
    await page.reload();
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    const mobileUsageButton = page.getByRole("button", { name: "Turn usage and cost" }).last();
    await mobileUsageButton.click();
    const mobileUsage = page.getByRole("dialog", { name: "Turn usage", exact: true });
    await expect(mobileUsage.getByText("20,178", { exact: true })).toBeVisible();
    await expect(mobileUsage.getByText("Partial", { exact: true })).toBeVisible();
    await expect(mobileUsage.getByText("Cache write")).toHaveCount(0);
    await expect(mobileUsage.getByText(/SDK-normalized|Unknown model/)).toHaveCount(0);
    const bounds = await mobileUsage.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(12);
    expect(bounds!.y).toBeGreaterThanOrEqual(12);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(378);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(832);
    expect(bounds!.height).toBeLessThan(310);
    expect(await mobileUsage.evaluate(element => element.scrollHeight <= element.clientHeight)).toBe(true);
    await capture(page, testInfo, "mobile-recorded-turn-usage.png");
    await page.keyboard.press("Escape");
    await capture(page, testInfo, "mobile-turn-footer.png");
  });
});
