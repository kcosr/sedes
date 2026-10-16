import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  capture,
  createDraftThread,
  expectNoPageOverflow,
  openWorkspaceDirectory,
} from "./helpers";
import { loadE2ERunContext } from "./run-context.js";

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const response = await page.request.get("/api/application/session");
  expect(response.ok()).toBe(true);
  const session = (await response.json()) as { csrfToken: string };
  return { "X-CSRF-Token": session.csrfToken };
}

const group = (page: Page, key: string): Locator =>
  page.locator(`[data-testid="automations-group"][data-group="${key}"]`);
const row = (scope: Page | Locator, automationId: string): Locator =>
  scope.locator(`[data-testid="automation-row"][data-automation-id="${automationId}"]`);

test("lists every automation from the More menu and opens one", async ({
  page,
}, testInfo) => {
  const workspace = path.join(
    loadE2ERunContext().workspacesDirectory,
    "automations-list",
  );
  await mkdir(workspace, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await openWorkspaceDirectory(page, workspace);

  // One thread through New thread; the second reuses its request.
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/threads") &&
      response.status() === 201,
  );
  const nightlyPath = await createDraftThread(page, "Nightly dependency audit");
  const nightly = nightlyPath.split("/").at(-1)!;
  const template = (await created).request().postDataJSON() as Record<
    string,
    unknown
  >;
  const headers = await csrfHeaders(page);
  const weeklyResponse = await page.request.post("/api/threads", {
    headers,
    data: { ...template, title: "Weekly release notes draft" },
  });
  expect(weeklyResponse.ok(), await weeklyResponse.text()).toBe(true);
  const weekly = ((await weeklyResponse.json()) as { threadId: string })
    .threadId;

  // Definitions have their own identity, independent of their source thread.
  // The scripted agent completes the nightly prompt in two short steps.
  const automationIds: string[] = [];
  for (const [threadId, name, prompt, expression, initialState] of [
    [nightly, "Nightly dependency audit", "Measure turn throughput", "0 2 * * *", "enabled"],
    [weekly, "Weekly release notes draft", "Draft release notes from merged PRs.", "0 9 * * 1", "paused"],
    [weekly, "Monthly dependency summary", "Summarize dependency changes.", "30 6 1 * *", "paused"],
    [weekly, "Hourly incident check", "Check for new incidents.", "30 * * * *", "paused"],
    [weekly, "Weekday planning", "Prepare today's plan.", "0 9 * * 1-5", "paused"],
    [weekly, "Twice-monthly audit", "Audit changes on the first and fifteenth.", "30 6 1,15 * *", "paused"],
  ] as const) {
    const response = await page.request.post(
      "/api/automations",
      {
        headers,
        data: {
          threadId,
          name,
          initialState,
          prompt,
          runMode: "same_thread",
          schedule: { kind: "cron", expression, timeZone: "UTC" },
          misfirePolicy: "coalesce",
          precheck: null,
          mutationId: randomUUID(),
        },
      },
    );
    expect(response.ok(), await response.text()).toBe(true);
    automationIds.push(((await response.json()) as { id: string }).id);
  }
  const [nightlyAutomation, weeklyAutomation] = automationIds as [string, string];

  // The sidebar's Projects view links its Automations shelf to the page.
  const sidebar = page.getByTestId("desktop-sidebar");
  const shelf = sidebar.locator('[data-testid="inventory-shelf"][data-shelf="automations"]');
  await expect(
    shelf.getByRole("link", { name: "View all automations" }),
  ).toBeVisible();

  await sidebar.getByRole("button", { name: "More" }).click();
  await page.getByRole("menuitem", { name: "Automations" }).click();
  await expect(page).toHaveURL("/automations");
  const view = page.locator("section.automations-view");
  await expect(
    view.getByRole("heading", { level: 1, name: "Automations" }),
  ).toBeVisible();
  await expect(view.getByTestId("automations-count")).toHaveText(
    /^6\s*automations$/u,
  );
  await expect(view.getByTestId("automations-status")).toContainText(
    "Grouped by status",
  );
  await expect(group(page, "status:upcoming")).toContainText("Upcoming · 1");
  const nightlyRow = row(group(page, "status:upcoming"), nightlyAutomation);
  await expect(nightlyRow).toContainText("Nightly dependency audit");
  await expect(nightlyRow).toContainText("Every day at 2:00 AM UTC");
  const weeklyRow = row(group(page, "status:paused"), weeklyAutomation);
  await expect(weeklyRow).toContainText("Weekly release notes draft");
  await expect(weeklyRow).toContainText("Not started");
  await expect(weeklyRow).toContainText("Every Monday at 9:00 AM UTC");
  const [, , monthlyAutomation, hourlyAutomation, weekdayAutomation, customAutomation] = automationIds;
  await expect(row(page, monthlyAutomation!)).toContainText("Monthly on the 1st at 6:30 AM UTC");
  await expect(row(page, hourlyAutomation!)).toContainText("Every hour at :30");
  await expect(row(page, weekdayAutomation!)).toContainText("Every weekday at 9:00 AM UTC");
  await expect(row(page, customAutomation!)).toContainText("Custom schedule (30 6 1,15 * *, UTC)");
  const listTitle = view.getByRole("heading", { level: 1, name: "Automations" });
  const listBounds = (await view.locator(".automations-list").first().boundingBox())!;
  const titleBounds = (await listTitle.boundingBox())!;
  expect(Math.abs(titleBounds.x - listBounds.x)).toBeLessThanOrEqual(1);
  await capture(page, testInfo, "automations-list-desktop.png");

  // Pause from the row menu (⋯ shows on hover or focus); the summary
  // stream moves the row live.
  await nightlyRow.hover();
  await nightlyRow
    .getByRole("button", { name: "Actions for Nightly dependency audit" })
    .click();
  await page.getByRole("menuitem", { name: "Pause" }).click();
  await expect(group(page, "status:paused")).toContainText("Paused · 6");
  await expect(group(page, "status:upcoming")).toHaveCount(0);
  // It never ran, so it reads as not started.
  await expect(row(group(page, "status:paused"), nightlyAutomation)).toContainText(
    "Not started",
  );
  await row(page, nightlyAutomation).hover();
  await row(page, nightlyAutomation)
    .getByRole("button", { name: "Actions for Nightly dependency audit" })
    .click();
  await page.getByRole("menuitem", { name: "Enable" }).click();
  await expect(row(group(page, "status:upcoming"), nightlyAutomation)).toBeVisible();

  // Search covers the prompt preview.
  const search = view.getByRole("searchbox", { name: "Search automations" });
  await search.fill("merged prs");
  await expect(view.getByTestId("automation-row")).toHaveCount(1);
  await expect(row(page, weeklyAutomation)).toBeVisible();
  await capture(page, testInfo, "automations-search-populated-desktop.png");
  // The native search clear control shares the muted styling of Settings and Find.
  const searchBounds = (await search.boundingBox())!;
  await search.click({ position: { x: searchBounds.width - 12, y: searchBounds.height / 2 } });
  await expect(search).toHaveValue("");
  await expect(view.getByTestId("automation-row")).toHaveCount(6);

  // A phone keeps the outcome and schedule on line 2 and ⋯ always visible.
  await page.setViewportSize({ width: 390, height: 844 });
  const phoneRow = row(page, weeklyAutomation);
  await expect(phoneRow.locator('[data-layout="narrow"]')).toHaveText(
    "Not started · Weekly release notes draft · Every Monday at 9:00 AM UTC",
  );
  await expect(phoneRow.locator('[data-layout="wide"]')).toBeHidden();
  await expect(
    phoneRow.getByRole("button", { name: "Actions for Weekly release notes draft" }),
  ).toBeVisible();
  const phoneBar = page.locator(".pane-nav-header");
  await expect(phoneBar).toBeVisible();
  await expect(phoneBar.locator('[data-slot="settings-page-back"]')).toHaveCount(0);
  expect(await phoneBar.evaluate((element) => getComputedStyle(element).borderBottomWidth)).toBe("0px");
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "automations-list-mobile.png");
  await page.setViewportSize({ width: 1440, height: 900 });

  // The whole row opens the automation page. Its one "‹" link names the
  // list it came from, and its meta line names the thread as a link.
  await row(page, nightlyAutomation)
    .getByRole("link", { name: "Nightly dependency audit" })
    .click();
  await expect(page).toHaveURL(`/automations/${nightlyAutomation}`);

  const back = view.locator('[data-slot="settings-page-back"]');
  const threadLink = view.getByRole("link", {
    name: "Nightly dependency audit",
    exact: true,
  });
  await expect(back).toHaveText("Automations");
  await expect(threadLink).toBeVisible();
  await capture(page, testInfo, "automation-navigation-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(threadLink).toBeVisible();
  await expect(phoneBar.locator('[data-slot="settings-page-back"]')).toBeVisible();
  expect(await phoneBar.evaluate((element) => getComputedStyle(element).borderBottomWidth)).toBe("1px");
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "automation-navigation-mobile.png");
  await page.setViewportSize({ width: 1440, height: 900 });

  await threadLink.click();
  await expect(page).toHaveURL(`/threads/${nightly}`);
  await page.getByRole("button", { name: "Automations", exact: true }).click();
  await expect(page).toHaveURL(`/threads/${nightly}/automations`);

  // The thread's own list names the thread in its "‹" link, lists its
  // automations flat without the global Scope, search or View options, and
  // its rows leave out the thread, project and backend.
  await expect(back).toHaveText("Nightly dependency audit");
  await expect(back).toHaveAttribute("href", `/threads/${nightly}`);
  await expect(view.getByTestId("automations-count")).toHaveText(
    /^1\s*automations$/u,
  );
  await expect(view.getByRole("searchbox")).toHaveCount(0);
  await expect(view.getByTestId("automations-view-options")).toHaveCount(0);
  await expect(view.getByTestId("automations-status")).toHaveCount(0);
  await expect(view.getByTestId("automations-group")).toHaveCount(0);
  const threadListBounds = (await view.locator(".automations-list").boundingBox())!;
  const threadTitleBounds = (await listTitle.boundingBox())!;
  expect(Math.abs(threadTitleBounds.x - threadListBounds.x)).toBeLessThanOrEqual(1);
  await expect(
    row(page, nightlyAutomation).locator('[data-layout="wide"]'),
  ).toHaveText("Every day at 2:00 AM UTC");
  await expect(
    view.getByRole("button", { name: "Add automation", exact: true }),
  ).toHaveAttribute("data-variant", "outline");
  await capture(page, testInfo, "automations-thread-list-desktop.png");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(
    row(page, nightlyAutomation).locator('[data-layout="narrow"]'),
  ).toHaveText("Every day at 2:00 AM UTC");
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "automations-thread-list-mobile.png");
  await page.setViewportSize({ width: 1440, height: 900 });

  await back.click();
  await expect(page).toHaveURL(`/threads/${nightly}`);
  await page.getByRole("button", { name: "Automations", exact: true }).click();
  await expect(page).toHaveURL(`/threads/${nightly}/automations`);
  await row(page, nightlyAutomation).getByRole("link", { name: "Nightly dependency audit" }).click();
  await expect(page).toHaveURL(`/automations/${nightlyAutomation}`);
  await expect(back).toHaveText("Automations");
  await back.click();
  await expect(page).toHaveURL(`/threads/${nightly}/automations`);
  await row(page, nightlyAutomation).getByRole("link", { name: "Nightly dependency audit" }).click();
  await expect(page).toHaveURL(`/automations/${nightlyAutomation}`);

  // Run now: the scripted agent answers, and once its turn settles the run
  // reads how that turn ended, here and in the list.
  await view.getByRole("button", { name: "Run now" }).click();
  const finishedRun = view.getByRole("button", {
    name: /\sFinished(?: in [^,]+)?, Manual$/u,
  });
  await expect(finishedRun).toBeVisible();
  await back.click();
  await expect(page).toHaveURL(`/threads/${nightly}/automations`);
  await expect(
    row(page, nightlyAutomation).locator(".automation-row-secondary"),
  ).toHaveText(/^Finished (?:just now|\d+m ago)$/u);

  // Go to turn opens the thread at the turn the run started.
  await row(page, nightlyAutomation)
    .getByRole("link", { name: "Nightly dependency audit" })
    .click();
  await finishedRun.click();
  const goToTurn = view.getByRole("link", { name: "Go to turn" });
  await expect(goToTurn).toHaveAttribute(
    "href",
    new RegExp(`^/threads/${nightly}#turn=.+$`, "u"),
  );
  const turnId = decodeURIComponent(
    (await goToTurn.getAttribute("href"))!.split("#turn=")[1]!,
  );
  await goToTurn.click();
  await expect(page).toHaveURL(new RegExp(`/threads/${nightly}#turn=`, "u"));
  await expect(page.locator(`[data-turn-id="${turnId}"]`).first()).toBeVisible();
  await expect(page.locator(".source-turn-highlight")).toBeVisible();
});
