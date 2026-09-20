import type { Page, Request, Route } from "@playwright/test";
import { test, expect } from "./fixtures";
import {
  capture,
  fillAndPersistDraft,
  openSedesWorkspace,
  selectCustomNewThreadTarget,
  sendCurrentDraft,
} from "./helpers";

function threadEventsRequest(request: Request): boolean {
  return /\/api\/threads\/[^/]+\/events$/.test(
    new URL(request.url()).pathname,
  );
}

function eventsThreadId(request: Request): string | undefined {
  return new URL(request.url()).pathname.match(
    /^\/api\/threads\/([^/]+)\/events$/,
  )?.[1];
}

async function createNamedDraftThread(
  page: Page,
  title: string,
): Promise<string> {
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
  const titleInput = page.getByRole("textbox", { name: "Thread name" });
  await expect(titleInput).toBeVisible();
  await titleInput.fill(title);
  await selectCustomNewThreadTarget(page, "Pi SDK");
  await page.getByRole("button", { name: "Create thread" }).click();
  await created;
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
  await expect(
    page.getByRole("textbox", { name: "Message Scripted agent" }),
  ).toBeVisible();
  return new URL(page.url()).pathname;
}

test("inactive thread streams retain visible history and catch up accumulated output with one checkpoint", async ({
  page,
}, testInfo) => {
  const network = await page.context().newCDPSession(page);
  await network.send("Network.enable");
  const checkpointThreads: string[] = [];
  network.on("Network.eventSourceMessageReceived", (message) => {
    if (message.eventName !== "thread-checkpoint") return;
    checkpointThreads.push(JSON.parse(message.data).snapshot.thread.id as string);
  });
  const activeApplicationRequests = new Set<Request>();
  const activeThreadRequests = new Set<Request>();
  const settlements = new Map<Request, () => void>();
  const settled = new WeakSet<Request>();

  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/api/application/events") {
      activeApplicationRequests.add(request);
    } else if (threadEventsRequest(request)) {
      activeThreadRequests.add(request);
    }
  });
  const markSettled = (request: Request) => {
    activeApplicationRequests.delete(request);
    activeThreadRequests.delete(request);
    settled.add(request);
    settlements.get(request)?.();
    settlements.delete(request);
  };
  page.on("requestfinished", markSettled);
  page.on("requestfailed", markSettled);
  const waitForSettlement = (request: Request): Promise<void> => {
    if (settled.has(request)) return Promise.resolve();
    return new Promise((resolve) => settlements.set(request, resolve));
  };

  const applicationStreamStarted = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/application/events",
  );
  await openSedesWorkspace(page);
  const applicationRequest = await applicationStreamStarted;

  const firstStreamStarted = page.waitForRequest(threadEventsRequest);
  const firstPath = await createNamedDraftThread(page, "Retained thread A");
  const firstThreadId = firstPath.slice("/threads/".length);
  const firstRequest = await firstStreamStarted;
  expect(eventsThreadId(firstRequest)).toBe(firstThreadId);
  expect(new URL(firstRequest.url()).searchParams.has("replayCursor")).toBe(
    false,
  );

  await fillAndPersistDraft(page, "Render an authoritative retained response");
  await sendCurrentDraft(page);
  const retainedAssistant = page.locator(
    '[data-item-kind="assistant_message"][data-item-status="completed"]',
  );
  await expect(retainedAssistant).toContainText(
    "a deterministic normalized result",
    { timeout: 15_000 },
  );

  await fillAndPersistDraft(page, "Accumulate a retained background response");
  await sendCurrentDraft(page);
  const backgroundAssistant = page.locator(
    '[data-item-kind="assistant_message"]',
  ).filter({ hasText: "Background response ready." });
  await expect(backgroundAssistant).toContainText("Background response ready.");
  await expect(backgroundAssistant).toHaveAttribute("data-item-status", "streaming");

  const firstStreamClosed = waitForSettlement(firstRequest);
  const secondStreamStarted = page.waitForRequest(threadEventsRequest);
  const secondPath = await createNamedDraftThread(page, "Selected thread B");
  const secondThreadId = secondPath.slice("/threads/".length);
  const secondRequest = await secondStreamStarted;
  expect(eventsThreadId(secondRequest)).toBe(secondThreadId);
  await firstStreamClosed;
  expect(activeThreadRequests).toEqual(new Set([secondRequest]));
  expect((await page.request.post("/__e2e/pi/background-burst/release")).status()).toBe(204);

  let interceptedReplay!: Route;
  let replayInterceptedResolve!: () => void;
  const replayIntercepted = new Promise<void>((resolve) => {
    replayInterceptedResolve = resolve;
  });
  let releaseReplay!: () => void;
  const replayMayContinue = new Promise<void>((resolve) => {
    releaseReplay = resolve;
  });
  await page.route(
    `**/api/threads/${firstThreadId}/events**`,
    async (route) => {
      interceptedReplay = route;
      replayInterceptedResolve();
      await replayMayContinue;
      await route.continue();
    },
    { times: 1 },
  );

  const secondStreamClosed = waitForSettlement(secondRequest);
  await page
    .getByTestId("desktop-sidebar")
    .getByTestId("thread-row-link")
    .filter({ hasText: "Retained thread A" })
    .click();
  await replayIntercepted;
  await expect(page).toHaveURL(firstPath);

  const replayUrl = new URL(interceptedReplay.request().url());
  expect(replayUrl.searchParams.get("replayCursor")).toMatch(/\S+/);
  await secondStreamClosed;
  expect(activeThreadRequests.has(secondRequest)).toBe(false);
  expect(
    [...activeThreadRequests].every(
      (request) => eventsThreadId(request) === firstThreadId,
    ),
  ).toBe(true);

  // The prior normalized projection renders before the replay request is
  // allowed to reach the server; returning to the thread does not wait for a
  // replacement snapshot merely to reconstruct already-known history.
  await expect(retainedAssistant).toContainText(
    "a deterministic normalized result",
  );
  await expect(backgroundAssistant).toContainText("Background response ready.");
  await expect(backgroundAssistant).not.toContainText("Background update 640:");

  const replayResponse = page.waitForResponse(
    (response) => response.request() === interceptedReplay.request(),
  );
  checkpointThreads.length = 0;
  releaseReplay();
  expect((await replayResponse).status()).toBe(200);
  await expect(backgroundAssistant).toContainText("Background update 640:");
  await expect(backgroundAssistant).toHaveAttribute("data-item-status", "streaming");
  await expect.poll(() => checkpointThreads).toEqual([firstThreadId]);
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeEnabled();
  // The old completed turn remains in the retained window after replacement.
  await expect(retainedAssistant).toContainText("a deterministic normalized result");
  await capture(page, testInfo, "background-checkpoint-streaming.png");
  expect((await page.request.post("/__e2e/pi/background-burst/finish")).status()).toBe(204);
  await expect(backgroundAssistant).toHaveAttribute("data-item-status", "completed");
  await expect(backgroundAssistant).toContainText("Background response complete: 界 🌍.");
  await expect(
    page.getByRole("textbox", { name: "Message Scripted agent" }),
  ).toBeEnabled();
  expect(activeApplicationRequests).toEqual(new Set([applicationRequest]));
  expect(activeThreadRequests.size).toBe(1);
  expect(eventsThreadId([...activeThreadRequests][0]!)).toBe(firstThreadId);
  await capture(page, testInfo, "background-checkpoint-completed.png");
  await network.detach();
});
