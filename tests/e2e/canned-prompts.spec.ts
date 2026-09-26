import type { Page, Request } from "@playwright/test";
import { cannedPromptLibrarySchema } from "../../src/shared/protocol/canned-prompts.js";
import { expect, test } from "./fixtures";
import {
  openSettingsPage,
  returnFromSettings,
  capture,
  expectNoPageOverflow,
  openSedesWorkspace,
  selectCustomNewThreadTarget,
  selectRadixOption,
  selectDeliveryMode,
} from "./helpers";

type DeliveredRequest = {
  readonly kind?: unknown;
  readonly mode?: unknown;
  readonly mutationId?: unknown;
};

function isDeliveryRequest(request: Request): boolean {
  if (
    request.method() !== "POST" ||
    !request.url().includes("/api/threads/") ||
    !request.url().endsWith("/operations")
  ) {
    return false;
  }
  return (
    (request.postDataJSON() as DeliveredRequest | undefined)?.kind === "deliver"
  );
}

async function openPromptsSettings(page: Page) {
  await openSettingsPage(page, "prompts");
  const dialog = page.getByTestId("settings-view");
  await expect(dialog.getByRole("heading", { name: "Prompts" })).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Add prompt" }),
  ).toBeEnabled();
  return dialog;
}

async function addPrompt(
  page: Page,
  dialog: ReturnType<Page["getByTestId"]>,
  title: string,
  text: string,
): Promise<void> {
  await dialog.getByRole("button", { name: "Add prompt" }).click();
  const editor = dialog.getByRole("region", { name: "Prompt editor" });
  await editor.getByRole("textbox", { name: "Title" }).fill(title);
  await editor.getByRole("textbox", { name: "Prompt" }).fill(text);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/application/canned-prompts") &&
      response.status() === 201,
  );
  await editor.getByRole("button", { name: "Add prompt" }).click();
  await created;
  await expect(dialog.getByRole("status")).toContainText("Prompt added.");
}

async function createCodexThread(page: Page): Promise<string> {
  await page
    .getByTestId("desktop-sidebar")
    .getByTestId("new-thread-trigger")
    .click();
  await selectCustomNewThreadTarget(page, "Codex TCP external · Codex TCP");
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/threads") &&
      response.status() === 201,
  );
  await page.getByRole("button", { name: "Create thread" }).click();
  await created;
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/u);
  const threadId = new URL(page.url()).pathname.split("/").at(-1);
  if (!threadId) throw new Error("canned_prompts_e2e_thread_id_missing");
  await expect(
    page.getByRole("textbox", { name: "Message Codex" }),
  ).toBeVisible();
  return threadId;
}

test("saved prompts flow from principal settings through desktop and mobile delivery", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openSedesWorkspace(page);

  const settings = await openPromptsSettings(page);
  await addPrompt(
    page,
    settings,
    "Review changes",
    "Review the current changes and report concrete correctness risks.",
  );
  await addPrompt(
    page,
    settings,
    "Run focused tests",
    "Run the smallest focused tests that prove the changed behavior.",
  );
  await addPrompt(
    page,
    settings,
    "Explain design",
    "Explain the architecture and the important ownership boundaries.",
  );

  const savedPrompts = settings.getByRole("region", { name: "Saved prompts" });
  // A short desktop window must keep the whole scroll viewport on screen.
  await page.setViewportSize({ width: 1440, height: 480 });
  const listBounds = await savedPrompts.boundingBox();
  expect(listBounds).not.toBeNull();
  expect(listBounds!.y + listBounds!.height).toBeLessThanOrEqual(480);
  const placementBounds = await settings.getByRole("radiogroup", { name: "Prompts placement" }).boundingBox();
  expect(placementBounds).not.toBeNull();
  expect(listBounds!.y).toBeGreaterThanOrEqual(placementBounds!.y + placementBounds!.height);
  expect(await savedPrompts.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await savedPrompts.hover();
  await page.mouse.wheel(0, 1000);
  await expect.poll(() => savedPrompts.evaluate((element) =>
    Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop),
  )).toBeLessThanOrEqual(1);
  await expect(savedPrompts.getByRole("button", { name: "Delete Explain design", exact: true })).toBeInViewport();
  await capture(page, testInfo, "canned-prompts-short-window.png");
  await page.setViewportSize({ width: 1440, height: 320 });
  const settingsContent = settings.locator(".settings-content");
  await settingsContent.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(savedPrompts.getByRole("button", { name: "Delete Explain design", exact: true })).toBeInViewport();
  await page.setViewportSize({ width: 1440, height: 900 });
  const designPrompt = savedPrompts
    .getByRole("article")
    .filter({ hasText: "Explain design" });
  const reordered = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith("/api/application/canned-prompts/order") &&
      response.ok(),
  );
  await designPrompt
    .getByRole("button", { name: "Move Explain design up" })
    .click();
  await reordered;

  await designPrompt.locator(".canned-prompt-select").click();
  const editor = settings.getByRole("region", { name: "Prompt editor" });
  await editor.getByRole("textbox", { name: "Title" }).fill("Explain system");
  const updated = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().includes("/api/application/canned-prompts/") &&
      !response.url().endsWith("/order") &&
      response.ok(),
  );
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await updated;
  await expect(settings.getByRole("status")).toContainText("Prompt saved.");

  const testsPrompt = savedPrompts
    .getByRole("article")
    .filter({ hasText: "Run focused tests" });
  await testsPrompt
    .getByRole("button", { name: "Delete Run focused tests" })
    .click();
  const confirmation = testsPrompt.getByRole("group", {
    name: "Delete Run focused tests?",
  });
  const deleted = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url().includes("/api/application/canned-prompts/") &&
      response.ok(),
  );
  await confirmation.getByRole("button", { name: "Delete" }).click();
  await deleted;
  await expect(testsPrompt).toHaveCount(0);
  await capture(page, testInfo, "canned-prompts-settings-desktop.png");

  const libraryResponse = await page.request.get(
    "/api/application/canned-prompts",
  );
  expect(libraryResponse.ok()).toBe(true);
  const library = cannedPromptLibrarySchema.parse(await libraryResponse.json());
  expect(library.items.map(({ title, position }) => [title, position])).toEqual(
    [
      ["Review changes", 0],
      ["Explain system", 1],
    ],
  );

  const showTab = settings.getByRole("checkbox", {
    name: "Show Prompts",
  });
  await expect(showTab).toBeChecked();
  await expect(
    settings.getByRole("radio", { name: "Above composer" }),
  ).toBeChecked();
  await showTab.click();
  await expect(showTab).not.toBeChecked();
  await returnFromSettings(page);

  const threadId = await createCodexThread(page);
  const promptTab = page.getByRole("button", { name: "Open saved prompts" });
  await expect(promptTab).toHaveCount(0);
  const reopenedSettings = await openPromptsSettings(page);
  const reopenedShowTab = reopenedSettings.getByRole("checkbox", {
    name: "Show Prompts",
  });
  await expect(reopenedShowTab).not.toBeChecked();
  await reopenedShowTab.click();
  const toolbarPlacement = reopenedSettings.getByRole("radio", {
    name: "Composer toolbar",
  });
  await toolbarPlacement.click();
  await expect(toolbarPlacement).toBeChecked();
  await returnFromSettings(page);
  await expect(promptTab).toBeVisible();
  await expect(promptTab).toHaveClass(/composer-prompt-toolbar/u);
  await expect(promptTab).toHaveText("");
  await expect(promptTab.locator("svg")).toHaveCount(1);
  expect(
    await page
      .getByTestId("composer")
      .evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).borderTopLeftRadius),
      ),
  ).toBeGreaterThan(0);
  expect(
    await promptTab.evaluate((element) =>
      element.nextElementSibling?.getAttribute("aria-label"),
    ),
  ).toBe("Stash prompt");

  const heldTurn = await page.request.post("/__e2e/codex/turn-completion/arm");
  expect(heldTurn.status()).toBe(204);

  await promptTab.click();
  const desktopPicker = page.getByRole("dialog", { name: "Saved prompts" });
  await expect(desktopPicker).toHaveAttribute("data-layout", "desktop");
  const search = desktopPicker.getByRole("searchbox", {
    name: "Search saved prompts",
  });
  await expect(search).toBeFocused();
  await search.fill("architecture");
  await expect(
    desktopPicker.getByRole("listitem").filter({ hasText: "Explain system" }),
  ).toBeVisible();
  await expect(
    desktopPicker.getByRole("listitem").filter({ hasText: "Review changes" }),
  ).toHaveCount(0);
  await capture(page, testInfo, "canned-prompts-picker-desktop.png");

  const idleDelivery = page.waitForResponse(
    (response) => isDeliveryRequest(response.request()) && response.ok(),
  );
  await desktopPicker
    .getByRole("button", { name: "Send prompt: Explain system" })
    .click();
  const idleResponse = await idleDelivery;
  expect(idleResponse.request().postDataJSON()).toMatchObject({
    kind: "deliver",
    mode: "submit",
  });
  const composer = page.getByRole("textbox", { name: "Message Codex" });
  await expect(composer).toHaveValue("");
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
  await expect(
    page.getByText(
      "Explain the architecture and the important ownership boundaries.",
      { exact: true },
    ),
  ).toBeVisible();
  await capture(page, testInfo, "canned-prompt-submit-in-flight-desktop.png");

  let deliveryCount = 0;
  const countDeliveries = (request: Request) => {
    if (isDeliveryRequest(request)) deliveryCount += 1;
  };
  page.on("request", countDeliveries);
  await selectDeliveryMode(page, "Steer");
  await composer.fill("Keep this existing draft.");
  await promptTab.click();
  const dirtyPicker = page.getByRole("dialog", { name: "Saved prompts" });
  await expect(dirtyPicker).toContainText(
    "Tap to send with the current draft, or add it to the composer",
  );
  await dirtyPicker
    .getByRole("button", {
      name: "Add prompt to composer: Review changes",
    })
    .click();
  await expect(composer).toHaveValue(
    "Keep this existing draft.\n\nReview the current changes and report concrete correctness risks.",
  );
  expect(deliveryCount).toBe(0);
  page.off("request", countDeliveries);

  const steerArmed = await page.request.post(
    `/__e2e/codex/steer-materialization/arm/${threadId}`,
  );
  expect(steerArmed.ok()).toBe(true);
  await promptTab.click();
  const steerDelivery = page.waitForResponse(
    (response) => isDeliveryRequest(response.request()) && response.ok(),
  );
  await page
    .getByRole("dialog", { name: "Saved prompts" })
    .getByRole("button", { name: "Send prompt: Explain system" })
    .click();
  expect((await steerDelivery).request().postDataJSON()).toMatchObject({
    kind: "deliver",
    mode: "steer",
  });
  await expect(composer).toHaveValue("");
  await expect(
    page.getByText(
      "Keep this existing draft.\n\nReview the current changes and report concrete correctness risks.\n\nExplain the architecture and the important ownership boundaries.",
      { exact: true },
    ),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoPageOverflow(page);
  await expect(promptTab).toHaveClass(/composer-prompt-toolbar/u);
  await expect(promptTab).toHaveText("");
  await expect(promptTab.locator("svg")).toHaveCount(1);
  await expect(page.locator(".composer-prompt-rail")).toHaveCount(0);
  expect(
    await promptTab.evaluate((element) =>
      element.nextElementSibling?.getAttribute("aria-label"),
    ),
  ).toMatch(/stashed prompts|Stash prompt/u);
  const composerBoundsWithToolbar = await page
    .getByTestId("composer")
    .boundingBox();
  expect(composerBoundsWithToolbar).not.toBeNull();
  const pendingBoundsWithToolbar = await page
    .getByTestId("pending-input-strip")
    .boundingBox();
  expect(pendingBoundsWithToolbar).not.toBeNull();
  expect(
    await page
      .getByTestId("composer")
      .evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).borderTopLeftRadius),
      ),
  ).toBe(0);
  expect(
    Math.abs(
      pendingBoundsWithToolbar!.y +
        pendingBoundsWithToolbar!.height -
        composerBoundsWithToolbar!.y,
    ),
  ).toBeLessThanOrEqual(1);
  await promptTab.click();
  const mobileToolbarPicker = page.getByRole("dialog", {
    name: "Saved prompts",
  });
  await expect(mobileToolbarPicker).toBeVisible();
  await expect(mobileToolbarPicker).toHaveAttribute("data-layout", "mobile");
  await page.keyboard.press("Escape");
  await expect(mobileToolbarPicker).toBeHidden();
  await capture(page, testInfo, "canned-prompts-toolbar-mobile.png");

  await page.evaluate(() => {
    localStorage.setItem("sedes-prompts-placement", "above_composer");
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "sedes-prompts-placement",
        newValue: "above_composer",
      }),
    );
  });
  await expect(promptTab).toHaveClass(/composer-prompt-tab/u);
  await expect(promptTab).toHaveText("Prompts");
  const tabBounds = await promptTab.boundingBox();
  expect(tabBounds).not.toBeNull();
  const composerBounds = await page.getByTestId("composer").boundingBox();
  expect(composerBounds).not.toBeNull();
  const pendingBounds = await page
    .getByTestId("pending-input-strip")
    .boundingBox();
  expect(pendingBounds).not.toBeNull();
  expect(
    Math.abs(tabBounds!.y + tabBounds!.height - pendingBounds!.y),
  ).toBeLessThanOrEqual(1);
  expect(
    Math.abs(pendingBounds!.y + pendingBounds!.height - composerBounds!.y),
  ).toBeLessThanOrEqual(1);
  const activityBar = page.locator(".input-activity-bar.visible");
  await expect(activityBar).toBeVisible();
  const activityBounds = await activityBar.boundingBox();
  expect(activityBounds).not.toBeNull();
  expect(activityBounds!.y).toBeGreaterThanOrEqual(composerBounds!.y - 0.5);
  const touch = await page.context().newCDPSession(page);
  await touch.send("Emulation.setTouchEmulationEnabled", {
    enabled: true,
    maxTouchPoints: 1,
  });
  const tabTouchPoint = {
    x: tabBounds!.x + tabBounds!.width / 2,
    y: tabBounds!.y + tabBounds!.height / 2,
  };
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [tabTouchPoint],
  });
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ ...tabTouchPoint, y: tabTouchPoint.y - 48 }],
  });
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  const mobilePicker = page.getByRole("dialog", { name: "Saved prompts" });
  await expect(mobilePicker).toBeVisible();
  await expect(mobilePicker).toHaveAttribute("data-layout", "mobile");
  const manageButton = mobilePicker.getByRole("button", { name: "Manage" });
  await expect(manageButton).toBeVisible();
  expect(
    await manageButton.evaluate(
      (button) => button.scrollWidth <= button.clientWidth,
    ),
  ).toBe(true);
  await expect(
    mobilePicker.getByRole("searchbox", { name: "Search saved prompts" }),
  ).toHaveCount(0);
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: 20, y: 400 }],
  });
  await touch.send("Input.dispatchTouchEvent", {
    type: "touchEnd",
    touchPoints: [],
  });
  await expect(mobilePicker).toBeHidden();
  await promptTab.click();
  await expect(mobilePicker).toBeVisible();
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "canned-prompts-picker-mobile.png");

  // A steer Codex has not recorded yet withholds further delivery, so let it
  // materialize before queueing the next prompt.
  await page.keyboard.press("Escape");
  await expect(mobilePicker).toBeHidden();
  expect(
    (
      await page.request.post("/__e2e/codex/steer-materialization/release")
    ).ok(),
  ).toBe(true);
  await expect(
    page.getByRole("region", { name: "Pending inputs" }).getByText(
      "Keep this existing draft.\n\nReview the current changes and report concrete correctness risks.\n\nExplain the architecture and the important ownership boundaries.",
      { exact: true },
    ),
  ).toHaveCount(0);
  await selectDeliveryMode(page, "Queue");
  await expect(page.locator("body")).not.toHaveCSS("pointer-events", "none");
  await promptTab.click();
  await expect(mobilePicker).toBeVisible();

  const queuedDelivery = page.waitForResponse(
    (response) => isDeliveryRequest(response.request()) && response.ok(),
  );
  await mobilePicker
    .getByRole("button", { name: "Send prompt: Explain system" })
    .click();
  const queueResponse = await queuedDelivery;
  expect(queueResponse.request().postDataJSON()).toMatchObject({
    kind: "deliver",
    mode: "queue",
  });
  await expect(
    page
      .getByRole("region", { name: "Pending inputs" })
      .getByText(
        "Explain the architecture and the important ownership boundaries.",
        { exact: true },
      ),
  ).toBeVisible();
  await expectNoPageOverflow(page);

  expect(
    (await page.request.post("/__e2e/codex/turn-completion/release")).status(),
  ).toBe(204);
});
