import type { Locator, Page, Response } from "@playwright/test";
import { expect, test } from "./fixtures";
import {
  capture,
  createDraftThread,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openSedesWorkspace,
  selectRadixOption,
  selectDeliveryMode,
  selectCustomNewThreadTarget,
  sendCurrentDraft,
} from "./helpers";

type HeldDeliverResponse = {
  readonly entered: Promise<{ readonly mutationId: string }>;
  readonly upstreamCompleted: Promise<number>;
  release(): void;
  dispose(): Promise<void>;
};

type HeldDeliverAcrossNavigation = HeldDeliverResponse & {
  dispatch(): void;
};

const heldControlDisposers = new WeakMap<Page, Set<() => Promise<void>>>();

function registerHeldControl(
  page: Page,
  cleanup: () => Promise<void>,
): () => Promise<void> {
  const disposers = heldControlDisposers.get(page) ?? new Set();
  heldControlDisposers.set(page, disposers);
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    disposers.delete(dispose);
    await cleanup();
  };
  disposers.add(dispose);
  return dispose;
}

async function holdNextDeliverRequest(page: Page): Promise<{
  readonly entered: Promise<{ readonly mutationId: string }>;
  release(): void;
  dispose(): Promise<void>;
}> {
  let resolveEntered!: (value: { readonly mutationId: string }) => void;
  const entered = new Promise<{ readonly mutationId: string }>((resolve) => {
    resolveEntered = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let handled = false;
  const pattern = "**/api/threads/*/operations";
  const handler: Parameters<Page["route"]>[1] = async (route) => {
    const body = route.request().postDataJSON() as
      { readonly kind?: unknown; readonly mutationId?: unknown } | undefined;
    if (handled || body?.kind !== "deliver") {
      await route.continue();
      return;
    }
    if (typeof body.mutationId !== "string") {
      await route.abort("failed");
      return;
    }
    handled = true;
    resolveEntered({ mutationId: body.mutationId });
    await gate;
    await route.continue();
  };
  await page.route(pattern, handler);
  const dispose = registerHeldControl(page, async () => {
    release();
    await page.unroute(pattern, handler);
  });
  return {
    entered,
    release,
    dispose,
  };
}

async function holdNextDeliverRejection(page: Page): Promise<{
  readonly entered: Promise<{ readonly mutationId: string }>;
  reject(): void;
  dispose(): Promise<void>;
}> {
  let resolveEntered!: (value: { readonly mutationId: string }) => void;
  const entered = new Promise<{ readonly mutationId: string }>((resolve) => {
    resolveEntered = resolve;
  });
  let reject!: () => void;
  const gate = new Promise<void>((resolve) => {
    reject = resolve;
  });
  let handled = false;
  const pattern = "**/api/threads/*/operations";
  const handler: Parameters<Page["route"]>[1] = async (route) => {
    const body = route.request().postDataJSON() as
      { readonly kind?: unknown; readonly mutationId?: unknown } | undefined;
    if (handled || body?.kind !== "deliver") {
      await route.continue();
      return;
    }
    if (typeof body.mutationId !== "string") {
      await route.abort("failed");
      return;
    }
    handled = true;
    resolveEntered({ mutationId: body.mutationId });
    await gate;
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        error: {
          code: "backend_rejected",
          message: "The fixture proved that delivery was not accepted.",
          retryable: false,
        },
      }),
    });
  };
  await page.route(pattern, handler);
  const dispose = registerHeldControl(page, async () => {
    reject();
    await page.unroute(pattern, handler);
  });
  return { entered, reject, dispose };
}

async function holdNextDeliverResponse(
  page: Page,
  outcome: "release" | "drop" = "release",
): Promise<HeldDeliverResponse> {
  let resolveEntered!: (value: { readonly mutationId: string }) => void;
  const entered = new Promise<{ readonly mutationId: string }>((resolve) => {
    resolveEntered = resolve;
  });
  let resolveUpstream!: (status: number) => void;
  const upstreamCompleted = new Promise<number>((resolve) => {
    resolveUpstream = resolve;
  });
  let release!: () => void;
  const releaseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let handled = false;
  const pattern = "**/api/threads/*/operations";
  const handler: Parameters<Page["route"]>[1] = async (route) => {
    const body = route.request().postDataJSON() as
      { readonly kind?: unknown; readonly mutationId?: unknown } | undefined;
    if (handled || body?.kind !== "deliver") {
      await route.continue();
      return;
    }
    if (typeof body.mutationId !== "string") {
      await route.abort("failed");
      return;
    }
    handled = true;
    resolveEntered({ mutationId: body.mutationId });
    const upstream = await route.fetch();
    resolveUpstream(upstream.status());
    if (outcome === "drop") {
      await route.abort("failed");
      return;
    }
    await releaseGate;
    await route.fulfill({ response: upstream });
  };
  await page.route(pattern, handler);
  const dispose = registerHeldControl(page, async () => {
    release();
    await page.unroute(pattern, handler);
  });
  return {
    entered,
    upstreamCompleted,
    release,
    dispose,
  };
}

async function holdNextDeliverAcrossNavigation(
  page: Page,
): Promise<HeldDeliverAcrossNavigation> {
  let resolveEntered!: (value: { readonly mutationId: string }) => void;
  const entered = new Promise<{ readonly mutationId: string }>((resolve) => {
    resolveEntered = resolve;
  });
  let dispatch!: () => void;
  const dispatchGate = new Promise<void>((resolve) => {
    dispatch = resolve;
  });
  let resolveUpstream!: (status: number) => void;
  const upstreamCompleted = new Promise<number>((resolve) => {
    resolveUpstream = resolve;
  });
  let release!: () => void;
  const responseGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let handled = false;
  const pattern = "**/api/threads/*/operations";
  const handler: Parameters<Page["route"]>[1] = async (route) => {
    const body = route.request().postDataJSON() as
      { readonly kind?: unknown; readonly mutationId?: unknown } | undefined;
    if (handled || body?.kind !== "deliver") {
      await route.continue();
      return;
    }
    if (typeof body.mutationId !== "string") {
      await route.abort("failed");
      return;
    }
    handled = true;
    resolveEntered({ mutationId: body.mutationId });
    await dispatchGate;
    const upstream = await route.fetch();
    resolveUpstream(upstream.status());
    await responseGate;
    try {
      await route.fulfill({ response: upstream });
    } catch (error) {
      // A client-side navigation may cancel and therefore handle the original
      // request while the fixture-owned upstream request continues. That is
      // the intentional disconnect boundary for this helper.
      if (
        !(error instanceof Error) ||
        !error.message.includes("already handled")
      ) {
        throw error;
      }
    }
  };
  await page.route(pattern, handler);
  const dispose = registerHeldControl(page, async () => {
    dispatch();
    release();
    await page.unroute(pattern, handler);
  });
  return {
    entered,
    upstreamCompleted,
    dispatch,
    release,
    dispose,
  };
}

async function createCodexDraftThread(page: Page): Promise<string> {
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
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
  const threadId = new URL(page.url()).pathname.split("/").at(-1);
  if (!threadId) throw new Error("e2e_codex_thread_id_missing");
  return threadId;
}

function operationKind(response: Response): string | undefined {
  if (
    response.request().method() !== "POST" ||
    !response.url().includes("/api/threads/") ||
    !response.url().endsWith("/operations")
  ) {
    return undefined;
  }
  const body = response.request().postDataJSON() as
    { readonly kind?: unknown } | undefined;
  return typeof body?.kind === "string" ? body.kind : undefined;
}

async function queueComposerInput(page: Page, text: string): Promise<void> {
  const composer = page.getByRole("textbox", {
    name: "Message Scripted agent",
  });
  await composer.fill(text);
  const accepted = page.waitForResponse(
    (response) => operationKind(response) === "deliver" && response.ok(),
  );
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await accepted;
  await expect(composer).toHaveValue("");
  // Enqueue advances the thread revision. Wait for the authoritative queue
  // projection before composing the next mutation so this journey exercises
  // repeated valid queueing, not a deliberate stale-revision conflict.
  await expect(
    page
      .getByRole("region", { name: "Pending inputs" })
      .getByText(text, { exact: true }),
  ).toBeVisible();
}

async function uploadStructuredQueueAttachments(page: Page): Promise<void> {
  const composer = page.getByTestId("composer");
  const fileInput = composer.locator('input[type="file"]');
  const attachmentList = composer.getByLabel("Attachments");
  const tinyPng = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAkCAIAAAC2bqvFAAAACXBIWXMAAAABAAAAAQBPJcTWAAABGElEQVR4nO2ZMQ7CMAxFbakS3WDsysYx4WZcg42REbYymbRG0FCbGhB1G+XJQiJKYv/8JkBAUCCpEYkI5f5KM2gD1P54T2SpJ1Ao7VLK3qT/gxCN6awCxqyeMWr4wIFpYhIw/vIzFhOGBXhVzwxqSP0R8l1+5r0JSTswheVnggmgFJO0A7NAFTCd54dpd7JQUroOzIUswJsswJsswJsswJsswBtVgP1mZhzEb3KQggONrkoOOmB4rZdwgmdsKXob4gordQqowk+p1wFxlJdowK43xQLOTT/ci+Pn74B3Ab+SBXhTNNfxvB9iHodWCbDuHGHf/D/Am1HpXwMc2xDnb4/ycEisCDayACVvXITTZ0K+Xu8wvgnGdDe223I93IVcvAAAAABJRU5ErkJggg==",
    "base64",
  );
  const uploaded = ["restore-preview.png", "restore-notes.txt"].map(
    (fileName) =>
      page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "PUT" &&
          url.pathname.includes("/composer-attachments/") &&
          url.searchParams.get("fileName") === fileName &&
          response.ok()
        );
      }),
  );
  const linked = page.waitForResponse((response) => {
    if (
      response.request().method() !== "PUT" ||
      !response.url().endsWith("/draft") ||
      !response.ok()
    ) {
      return false;
    }
    const body = response.request().postDataJSON() as
      { readonly attachmentIds?: unknown[] } | undefined;
    return body?.attachmentIds?.length === 2;
  });

  await fileInput.setInputFiles([
    {
      name: "restore-preview.png",
      mimeType: "image/png",
      buffer: tinyPng,
    },
    {
      name: "restore-notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("durable queued attachment"),
    },
  ]);
  await Promise.all([...uploaded, linked]);
  await expect(attachmentList.locator("[data-upload-id]")).toHaveCount(0);
  await expect(
    attachmentList.getByText("restore-preview.png", { exact: true }),
  ).toBeVisible();
  await expect(
    attachmentList.getByText("restore-notes.txt", { exact: true }),
  ).toBeVisible();
}

test.afterEach(async ({ page, request }) => {
  const disposers = [...(heldControlDisposers.get(page) ?? [])];
  for (const dispose of disposers.reverse()) {
    try {
      await dispose();
    } catch {
      // The page may already be closing after an assertion failure. Server
      // fixture resets below are the authoritative cross-test cleanup.
    }
  }
  heldControlDisposers.delete(page);
  const reset = await request.post("/__e2e/codex/steer-materialization/reset");
  expect(reset.ok()).toBe(true);
  const submitReset = await request.post(
    "/__e2e/codex/submit-materialization/reset",
  );
  expect(submitReset.ok()).toBe(true);
  const completionReset = await request.post(
    "/__e2e/codex/turn-completion/reset",
  );
  expect(completionReset.ok()).toBe(true);
  const submitFaultReset = await request.post(
    "/__e2e/codex/reset-submit-outcome-unknown",
  );
  expect(submitFaultReset.ok()).toBe(true);
  const piPendingSteerReset = await request.post(
    "/__e2e/pi/pending-steer/reset",
  );
  expect(piPendingSteerReset.ok()).toBe(true);
});

test("idle Send clears immediately and reconciles one final-looking bubble for first and bound delivery", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSedesWorkspace(page);
  await createCodexDraftThread(page);
  const composer = page.getByRole("textbox", { name: "Message Codex" });

  const exerciseSend = async (
    prompt: string,
    ordering: "materialization_first" | "response_first",
    screenshotName?: string,
  ) => {
    await fillAndPersistDraft(page, prompt, "Message Codex");
    const armed = await page.request.post(
      "/__e2e/codex/submit-materialization/arm",
    );
    expect(armed.status()).toBe(204);
    const heldResponse = await holdNextDeliverResponse(page);
    try {
      await page.getByRole("button", { name: "Send message" }).click();
      const { mutationId } = await heldResponse.entered;
      const message = page
        .getByRole("region", { name: "Messages" })
        .locator(
          `[data-message-role="user"][data-delivery-operation-id="${mutationId}"]`,
        );

      // This state is observable while the HTTP operation is still in flight:
      // the final-looking destination and visual composer clear are one client
      // transition, independent of receipt or provider materialization.
      await expect(composer).toHaveValue("");
      await expect(composer).toBeFocused();
      await expect(message).toHaveCount(1);
      await expect(message).toHaveAttribute("data-client-provisional", "true");
      await expect(message).toContainText(prompt);
      await expect(message).not.toContainText(/sending|pending|unconfirmed/i);
      if (screenshotName) await capture(page, testInfo, screenshotName);

      expect(await heldResponse.upstreamCompleted).toBe(200);
      const fixtureState = await page.request.get(
        "/__e2e/codex/submit-materialization/state",
      );
      expect(await fixtureState.json()).toMatchObject({
        armed: false,
        held: true,
      });
      await expect(message).toHaveAttribute("data-client-provisional", "true");

      if (ordering === "response_first") {
        heldResponse.release();
        await expect(message).toHaveAttribute(
          "data-client-provisional",
          "true",
        );
      }
      const released = await page.request.post(
        "/__e2e/codex/submit-materialization/release",
      );
      expect(released.status()).toBe(204);
      await expect(message).not.toHaveAttribute("data-client-provisional");
      await expect(message).toHaveCount(1);
      await expect(message).toContainText(prompt);
      if (ordering === "materialization_first") {
        // The correlated SSE item wins while the delivery promise is still
        // unresolved. A late receipt must not recreate the local row.
        heldResponse.release();
        await expect(message).not.toHaveAttribute("data-client-provisional");
        await expect(message).toHaveCount(1);
      }
    } finally {
      await heldResponse.dispose();
      await page.request.post("/__e2e/codex/submit-materialization/reset");
    }
  };

  await exerciseSend(
    "Show the first Send before creation and delivery finish",
    "materialization_first",
    "optimistic-first-send-in-flight-desktop.png",
  );
  await expect(
    page.locator(
      '[data-item-kind="assistant_message"][data-item-status="completed"]',
    ),
  ).toContainText("Codex is streaming a browser-neutral normalized response.");

  await exerciseSend(
    "Show a bound idle Send before queue dispatch materializes",
    "response_first",
    "optimistic-bound-send-in-flight-desktop.png",
  );
  await expect(
    page
      .locator(
        '[data-item-kind="assistant_message"][data-item-status="completed"]',
      )
      .last(),
  ).toContainText("Codex is streaming a browser-neutral normalized response.");
});

test("clean idle rejection removes the bubble and restores the mobile composer", async ({
  page,
  browserDiagnostics,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSedesWorkspace(page);
  await createCodexDraftThread(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const composer = page.getByRole("textbox", { name: "Message Codex" });
  const prompt = "Restore this exact mobile draft after clean rejection";
  await fillAndPersistDraft(page, prompt, "Message Codex");
  const heldRejection = await holdNextDeliverRejection(page);
  try {
    await page.getByRole("button", { name: "Send message" }).click();
    const { mutationId } = await heldRejection.entered;
    const message = page
      .getByRole("region", { name: "Messages" })
      .locator(`[data-delivery-operation-id="${mutationId}"]`);
    await expect(message).toHaveCount(1);
    await expect(message).toHaveAttribute("data-client-provisional", "true");
    await expect(composer).toHaveValue("");
    await expect(composer).toBeFocused();
    await expectNoPageOverflow(page);

    browserDiagnostics.allowNetworkFailures = true;
    heldRejection.reject();
    await expect(message).toHaveCount(0);
    await expect(composer).toHaveValue(prompt);
    await expect(composer).toBeFocused();
    await expect(page.getByRole("alert")).toContainText(
      "The fixture proved that delivery was not accepted.",
    );
    await expectNoPageOverflow(page);
  } finally {
    browserDiagnostics.allowNetworkFailures = false;
    await heldRejection.dispose();
  }
});

test("bound uncertain queue takeover removes its optimistic bubble without duplication", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSedesWorkspace(page);
  await createCodexDraftThread(page);
  await fillAndPersistDraft(
    page,
    "Bind this Codex thread before the uncertain bound Send",
    "Message Codex",
  );
  await sendCurrentDraft(page);
  await expect(
    page.locator(
      '[data-item-kind="assistant_message"][data-item-status="completed"]',
    ),
  ).toContainText("Codex is streaming a browser-neutral normalized response.");

  const faultArmed = await page.request.post(
    "/__e2e/codex/arm-submit-outcome-unknown",
  );
  expect(faultArmed.status()).toBe(204);
  const prompt = "Demote this bound Send to one uncertain queue row";
  await fillAndPersistDraft(page, prompt, "Message Codex");
  const responsePromise = page.waitForResponse(
    (response) => operationKind(response) === "deliver" && response.ok(),
  );
  const requestPromise = page.waitForRequest((request) => {
    if (request.method() !== "POST" || !request.url().endsWith("/operations")) {
      return false;
    }
    const body = request.postDataJSON() as { readonly kind?: unknown };
    return body.kind === "deliver";
  });
  await page.getByRole("button", { name: "Send message" }).click();
  const [response, request] = await Promise.all([
    responsePromise,
    requestPromise,
  ]);
  expect(await response.json()).toMatchObject({ status: "delivery_queued" });
  const requestBody = request.postDataJSON() as {
    readonly mutationId?: unknown;
  };
  if (typeof requestBody.mutationId !== "string") {
    throw new Error("e2e_bound_submit_operation_id_missing");
  }
  const operationId = requestBody.mutationId;
  const transcriptMessage = page
    .getByRole("region", { name: "Messages" })
    .locator(`[data-delivery-operation-id="${operationId}"]`);
  const queueRow = page
    .getByRole("region", { name: "Pending inputs" })
    .locator(`[data-delivery-operation-id="${operationId}"]`);
  await expect(queueRow).toHaveCount(1);
  await expect(queueRow).toContainText(prompt);
  await expect(queueRow).toContainText("Delivery unconfirmed");
  await expect(transcriptMessage).toHaveCount(0);
  await expect(page.getByText(prompt, { exact: true })).toHaveCount(1);
  const paused = page.getByTestId("queue-paused");
  await expect(paused).toContainText("Queue paused: an earlier delivery needs reconciliation");
  const draft = "Preserve this unsent draft through reconciliation";
  await fillAndPersistDraft(page, draft, "Message Codex");
  const recovered = page.waitForResponse((response) => operationKind(response) === "recover_uncertain" && response.ok());
  await page.getByRole("button", { name: "Reconcile delivery" }).click();
  await recovered;
  await expect(page.getByRole("button", { name: "Reconcile delivery" })).toBeEnabled();
  await expect(paused).toContainText("cannot dispatch until this is resolved");
  await expect(page.getByRole("textbox", { name: "Message Codex" })).toHaveValue(draft);
  await expect(queueRow).toContainText(prompt);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoPageOverflow(page);
  await capture(page, testInfo, "queue-paused-mobile.png");
});

test("reconnect replacement retires a local Queue row that was never streamed", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSedesWorkspace(page);
  const threadId = await createCodexDraftThread(page);
  const completionArmed = await page.request.post(
    "/__e2e/codex/turn-completion/arm",
  );
  expect(completionArmed.status()).toBe(204);
  await fillAndPersistDraft(
    page,
    "Keep this turn active while Queue disconnects",
    "Message Codex",
  );
  await sendCurrentDraft(page);
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  await selectDeliveryMode(page, "Queue");
  const prompt = "Materialize this Queue input entirely while disconnected";
  await fillAndPersistDraft(page, prompt, "Message Codex");
  const heldDelivery = await holdNextDeliverAcrossNavigation(page);
  try {
    await page.getByRole("button", { name: "Queue", exact: true }).click();
    const { mutationId } = await heldDelivery.entered;
    const localRow = page.locator(
      `[data-pending-queue-operation-id="${mutationId}"]`,
    );
    await expect(localRow).toHaveCount(1);

    const originalPath = new URL(page.url()).pathname;
    const otherThread = page
      .getByTestId("desktop-sidebar")
      .getByTestId("thread-row-link")
      .filter({ hasText: /Imported Codex history/ });
    await otherThread.click();
    await expect(page).not.toHaveURL(new RegExp(`${originalPath}$`));

    // Only now may the request reach the server. The original thread stream
    // is closed, so neither its durable queue row nor its later removal can be
    // observed by the retained client store.
    heldDelivery.dispatch();
    expect(await heldDelivery.upstreamCompleted).toBe(200);
    heldDelivery.release();
    const completionReleased = await page.request.post(
      "/__e2e/codex/turn-completion/release",
    );
    expect(completionReleased.status()).toBe(204);
    await expect
      .poll(async () => {
        const snapshot = await page.request.get(
          `/api/threads/${threadId}?activityDetail=full`,
        );
        return JSON.stringify(await snapshot.json());
      })
      .toContain(prompt);

    // A snapshot supersedes the unseen queue incrementals in replay storage.
    // Reconnect therefore receives only the authoritative replacement that
    // already contains the correlated user message.
    const replacement = await page.request.post(
      `/__e2e/threads/${threadId}/publish-authoritative-replacement`,
    );
    expect(await replacement.json()).toEqual({ published: true });
    await page.goBack();
    await expect(page).toHaveURL(new RegExp(`${originalPath}$`));
    const message = page
      .getByRole("region", { name: "Messages" })
      .locator(`[data-delivery-operation-id="${mutationId}"]`);
    await expect(message).toHaveCount(1);
    await expect(message).not.toHaveAttribute("data-client-provisional");
    await expect(message).toContainText(prompt);
    await expect(localRow).toHaveCount(0);

    await expect(message).toHaveCount(1);
    await expect(
      page
        .getByRole("region", { name: "Messages" })
        .getByText(prompt, { exact: true }),
    ).toHaveCount(1);
  } finally {
    await heldDelivery.dispose();
  }
});

test("Queue clears before its request and ambiguous Steer remains until exact materialization", async ({
  page,
  browserDiagnostics,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSedesWorkspace(page);
  await createCodexDraftThread(page);
  const completionArmed = await page.request.post(
    "/__e2e/codex/turn-completion/arm",
  );
  expect(completionArmed.status()).toBe(204);
  await fillAndPersistDraft(
    page,
    "Keep the Codex turn active for immediate Queue and Steer",
    "Message Codex",
  );
  await sendCurrentDraft(page);
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  const composer = page.getByRole("textbox", { name: "Message Codex" });
  await selectDeliveryMode(page, "Queue");
  const queueText = "Stage this Queue row before the request begins";
  await fillAndPersistDraft(page, queueText, "Message Codex");
  const heldQueue = await holdNextDeliverRequest(page);
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  const { mutationId: queueOperationId } = await heldQueue.entered;
  const queueRow = page.locator(
    `[data-pending-queue-operation-id="${queueOperationId}"]`,
  );
  await expect(composer).toHaveValue("");
  await expect(composer).toBeFocused();
  await expect(queueRow).toHaveCount(1);
  await expect(queueRow).toContainText(queueText);
  await capture(page, testInfo, "pending-queue-immediate-desktop.png");
  heldQueue.release();
  await expect(
    page
      .getByRole("region", { name: "Pending inputs" })
      .locator(`[data-delivery-operation-id="${queueOperationId}"]`),
  ).toHaveCount(1);
  await heldQueue.dispose();
  const durableQueueRow = page
    .getByRole("region", { name: "Pending inputs" })
    .locator(`[data-delivery-operation-id="${queueOperationId}"]`);
  await durableQueueRow
    .getByRole("button", { name: `Delete queued input: ${queueText}` })
    .click();
  await expect(durableQueueRow).toHaveCount(0);

  await selectDeliveryMode(page, "Steer");
  const steerText = "Keep exactly one unconfirmed Steer after response loss";
  await fillAndPersistDraft(page, steerText, "Message Codex");
  const threadId = new URL(page.url()).pathname.split("/").at(-1);
  if (!threadId) throw new Error("e2e_codex_thread_id_missing");
  const materializationArmed = await page.request.post(
    `/__e2e/codex/steer-materialization/arm/${threadId}`,
  );
  expect(materializationArmed.status()).toBe(204);
  const droppedSteer = await holdNextDeliverResponse(page, "drop");
  let steerOperationId!: string;
  let steerRow!: Locator;
  browserDiagnostics.allowNetworkFailures = true;
  try {
    await page.getByRole("button", { name: "Steer", exact: true }).click();
    ({ mutationId: steerOperationId } = await droppedSteer.entered);
    steerRow = page
      .getByRole("region", { name: "Pending inputs" })
      .locator(
        `[data-pending-steer-operation-id="${steerOperationId}"], [data-delivery-operation-id="${steerOperationId}"]`,
      );
    await expect(composer).toHaveValue("");
    await expect(steerRow).toHaveCount(1);
    await expect(steerRow).toContainText(steerText);
    expect(await droppedSteer.upstreamCompleted).toBe(200);
    await expect(steerRow).toContainText("Steer unconfirmed");
    await expect(composer).toHaveValue("");
    await expect(
      page
        .getByRole("region", { name: "Pending inputs" })
        .getByText(steerText, {
          exact: true,
        }),
    ).toHaveCount(1);
    await capture(page, testInfo, "pending-steer-unconfirmed-desktop.png");
  } finally {
    browserDiagnostics.allowNetworkFailures = false;
    await droppedSteer.dispose();
  }

  const postClearDraft = "Keep this next draft while the steer is unresolved";
  await composer.fill(postClearDraft);
  const originalPath = new URL(page.url()).pathname;
  const sidebar = page.getByTestId("desktop-sidebar");
  const otherThread = sidebar
    .getByTestId("thread-row-link")
    .filter({ hasText: /Imported Codex history/ });
  await expect(otherThread).toBeVisible();
  await otherThread.click();
  await expect(page).not.toHaveURL(new RegExp(`${originalPath}$`));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`${originalPath}$`));
  await expect(composer).toHaveValue(postClearDraft);
  await expect(steerRow).toContainText(/Pending steer|Steer unconfirmed/);
  await expect(steerRow.getByRole("button")).toHaveCount(0);

  const materializationReleased = await page.request.post(
    "/__e2e/codex/steer-materialization/release",
  );
  expect(materializationReleased.status()).toBe(204);
  await expect(steerRow).toHaveCount(0);
  await expect(composer).toHaveValue(postClearDraft);
  await expect(
    page.locator(
      `[data-item-kind="user_message"][data-delivery-operation-id="${steerOperationId}"]`,
    ),
  ).toHaveCount(1);
});

test("pending inputs stay ordered and support Delete, Restore, and head Steer on desktop and mobile", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSedesWorkspace(page);
  await createDraftThread(page);

  await fillAndPersistDraft(
    page,
    "Keep the scripted turn active for queue controls",
  );
  await sendCurrentDraft(page);
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  await selectDeliveryMode(page, "Queue");

  const queuedMessages = [
    "Queue alpha: preserve FIFO order",
    "Queue bravo: restore this complete structured input without losing any composer content",
    "Queue charlie: stays visible",
    "Queue delta: delete with one click",
    "Queue echo: exercise bounded layout",
    "Queue foxtrot: exercise bounded layout",
    "Queue golf: exercise bounded layout",
    "Queue hotel: exercise bounded layout",
    "Queue india: exercise bounded layout",
    "Queue juliet: exercise bounded layout",
  ] as const;
  for (const [index, message] of queuedMessages.entries()) {
    if (index === 1) await uploadStructuredQueueAttachments(page);
    await queueComposerInput(page, message);
  }

  const strip = page.getByRole("region", { name: "Pending inputs" });
  const rows = strip.getByRole("listitem");
  await expect(strip).toBeVisible();
  await expect(rows).toHaveCount(queuedMessages.length);
  await expect(strip.getByText("Queued", { exact: true })).toHaveCount(0);
  for (const [index, message] of queuedMessages.entries()) {
    await expect(rows.nth(index)).toContainText(message);
  }
  await expect(
    rows.nth(0).getByRole("button", {
      name: `Steer queued input into active turn: ${queuedMessages[0]}`,
    }),
  ).toBeVisible();
  await expect(
    rows.nth(1).getByRole("button", {
      name: /^Steer queued input into active turn:/,
    }),
  ).toHaveCount(0);
  for (const [index, message] of queuedMessages.entries()) {
    await expect(
      rows.nth(index).getByRole("button", {
        name: `Restore queued input to composer: ${message}`,
      }),
    ).toBeEnabled();
  }
  await expect(rows.nth(1)).toContainText("2 files");
  await expect(
    page.locator('[data-item-status="streaming"]').first(),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoPageOverflow(page);
  const initialMobileOverflow = await strip.evaluate((element) => {
    const candidates = [element, ...element.querySelectorAll<HTMLElement>("*")];
    const scrollContainer = candidates.find((candidate) => {
      const overflowY = getComputedStyle(candidate).overflowY;
      return (
        (overflowY === "auto" || overflowY === "scroll") &&
        candidate.scrollHeight > candidate.clientHeight
      );
    });
    return scrollContainer
      ? {
          bounded: true,
          clientHeight: scrollContainer.clientHeight,
          scrollHeight: scrollContainer.scrollHeight,
        }
      : { bounded: false, clientHeight: 0, scrollHeight: 0 };
  });
  expect(initialMobileOverflow.bounded).toBe(true);
  expect(initialMobileOverflow.scrollHeight).toBeGreaterThan(
    initialMobileOverflow.clientHeight,
  );
  await page.setViewportSize({ width: 1280, height: 800 });

  const steered = page.waitForResponse(
    (response) =>
      operationKind(response) === "steer_queued_input" && response.ok(),
  );
  await rows
    .nth(0)
    .getByRole("button", {
      name: `Steer queued input into active turn: ${queuedMessages[0]}`,
    })
    .click();
  await steered;
  await expect(strip.getByText(queuedMessages[0], { exact: true })).toHaveCount(
    0,
  );
  await expect(rows).toHaveCount(queuedMessages.length - 1);
  await expect(rows.nth(0)).toContainText(queuedMessages[1]);
  await expect(
    page
      .locator('[data-item-kind="user_message"]')
      .filter({ hasText: queuedMessages[0] }),
  ).toBeVisible();

  const composer = page.getByRole("textbox", {
    name: "Message Scripted agent",
  });
  const retainedDraft = "Keep this draft while queued inputs change";
  await fillAndPersistDraft(page, retainedDraft);
  for (const message of queuedMessages.slice(1)) {
    await expect(
      strip.getByRole("button", {
        name: `Restore queued input to composer: ${message}`,
      }),
    ).toBeDisabled();
  }

  let releaseDelete!: () => void;
  const deleteGate = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  let observedDelete!: () => void;
  const deleteObserved = new Promise<void>((resolve) => {
    observedDelete = resolve;
  });
  await page.route("**/api/threads/*/operations", async (route) => {
    const body = route.request().postDataJSON() as
      { readonly kind?: unknown } | undefined;
    if (body?.kind === "cancel_queued_input") {
      observedDelete();
      await deleteGate;
    }
    await route.continue();
  });

  const deleteTarget = rows.filter({ hasText: queuedMessages[3] });
  const deleted = page.waitForResponse(
    (response) =>
      operationKind(response) === "cancel_queued_input" && response.ok(),
  );
  await deleteTarget
    .getByRole("button", {
      name: `Delete queued input: ${queuedMessages[3]}`,
    })
    .click();
  await deleteObserved;
  await expect(deleteTarget).toBeVisible();
  await expect(composer).toHaveValue(retainedDraft);
  releaseDelete();
  await deleted;
  await page.unroute("**/api/threads/*/operations");

  await expect(deleteTarget).toHaveCount(0);
  await expect(rows).toHaveCount(queuedMessages.length - 2);
  await expect(composer).toHaveValue(retainedDraft);

  const draftCleared = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith("/draft") &&
      response.ok(),
  );
  await composer.fill("");
  await draftCleared;
  const restoreTarget = rows.filter({ hasText: queuedMessages[1] });
  const restored = page.waitForResponse(
    (response) =>
      operationKind(response) === "restore_queued_input" && response.ok(),
  );
  await restoreTarget
    .getByRole("button", {
      name: `Restore queued input to composer: ${queuedMessages[1]}`,
    })
    .click();
  await restored;
  await expect(restoreTarget).toHaveCount(0);
  await expect(rows).toHaveCount(queuedMessages.length - 3);
  await expect(composer).toHaveValue(queuedMessages[1]);
  await expect(composer).toBeFocused();
  const restoredAttachments = page
    .getByTestId("composer")
    .getByLabel("Attachments");
  const restoredImageCard = restoredAttachments
    .locator("[data-attachment-id]")
    .filter({ hasText: "restore-preview.png" });
  await expect(restoredImageCard).toBeVisible();
  await expect(
    restoredAttachments.getByText("restore-notes.txt", { exact: true }),
  ).toBeVisible();
  await expect(restoredImageCard.locator("img")).toBeVisible();

  await expect(rows.nth(0)).toContainText(queuedMessages[2]);
  await expect(
    rows.nth(0).getByRole("button", {
      name: `Steer queued input into active turn: ${queuedMessages[2]}`,
    }),
  ).toBeVisible();
  await expect(composer).toHaveValue(queuedMessages[1]);

  await capture(page, testInfo, "pending-input-strip-streaming-desktop.png");
  const deliveryButton = page.getByTestId("composer").locator(".queue-button");
  await expect(deliveryButton).toHaveText("");
  await expect(deliveryButton.locator("svg")).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoPageOverflow(page);
  await expect(composer).toBeVisible();
  await expect(composer).toHaveValue(queuedMessages[1]);
  await expect(deliveryButton).toHaveText("");
  await expect(page.locator('.desktop-config [data-setting-id="thinking_level"] [role="combobox"]')).toBeVisible();
  const mobileRestore = rows.nth(0).getByRole("button", {
    name: `Restore queued input to composer: ${queuedMessages[2]}`,
  });
  const mobileForward = rows.nth(0).getByRole("button", {
    name: `Steer queued input into active turn: ${queuedMessages[2]}`,
  });
  await expect(mobileRestore).toBeDisabled();
  await expect(mobileRestore.locator("svg")).toHaveCount(1);
  await expect(mobileForward.locator("svg")).toHaveCount(1);
  await expect(mobileRestore).toHaveText("");
  await expect(mobileForward).toHaveText("");
  await capture(page, testInfo, "pending-input-strip-streaming-mobile.png");

  await page.reload();
  const reloadedComposer = page.getByRole("textbox", {
    name: "Message Scripted agent",
  });
  await expect(reloadedComposer).toHaveValue(queuedMessages[1]);
  const reloadedAttachments = page
    .getByTestId("composer")
    .getByLabel("Attachments");
  const reloadedImageCard = reloadedAttachments
    .locator("[data-attachment-id]")
    .filter({ hasText: "restore-preview.png" });
  await expect(reloadedImageCard).toBeVisible();
  await expect(
    reloadedAttachments.getByText("restore-notes.txt", { exact: true }),
  ).toBeVisible();
  await expect
    .poll(() =>
      reloadedImageCard
        .locator("img")
        .evaluate((image) => (image as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);

  for (const message of [
    queuedMessages[2],
    ...queuedMessages.slice(4),
  ]) {
    const remainingRow = page
      .getByRole("region", { name: "Pending inputs" })
      .getByRole("listitem")
      .filter({ hasText: message });
    await remainingRow
      .getByRole("button", { name: `Delete queued input: ${message}` })
      .click();
    await expect(remainingRow).toHaveCount(0);
  }

  const deliveredRestoredInput = page.waitForResponse(
    (response) => operationKind(response) === "deliver" && response.ok(),
  );
  await selectDeliveryMode(page, "Steer");
  await expect(reloadedComposer).toHaveValue(queuedMessages[1]);
  await page.getByRole("button", { name: "Steer", exact: true }).click();
  await deliveredRestoredInput;
  await expect(reloadedComposer).toHaveValue("");
  const deliveredMessage = page
    .locator('[data-item-kind="user_message"]')
    .filter({ hasText: queuedMessages[1] });
  await expect(deliveredMessage).toBeVisible();
  await expect(
    deliveredMessage.getByText("restore-preview.png", { exact: true }),
  ).toBeVisible();
  await expect(
    deliveredMessage.getByText("restore-notes.txt", { exact: true }),
  ).toBeVisible();
});

test("Pi pending-materialization Steer retains its cleared input until the exact item arrives", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSedesWorkspace(page);
  await createDraftThread(page);
  await fillAndPersistDraft(
    page,
    "Keep the scripted Pi turn active for pending materialization",
  );
  await sendCurrentDraft(page);
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  const armed = await page.request.post("/__e2e/pi/pending-steer/arm");
  expect(armed.status()).toBe(204);
  await selectDeliveryMode(page, "Steer");
  const composer = page.getByRole("textbox", {
    name: "Message Scripted agent",
  });
  const prompt = "Hold this Pi steer after native enqueue acknowledgement";
  await fillAndPersistDraft(page, prompt);
  const pending = page.waitForResponse(
    (response) => operationKind(response) === "deliver" && response.ok(),
  );
  await page.getByRole("button", { name: "Steer", exact: true }).click();
  const pendingResponse = await pending;
  const result = (await pendingResponse.json()) as {
    readonly status?: unknown;
    readonly queuedInputId?: unknown;
  };
  expect(result).toMatchObject({
    status: "delivery_queued",
    queuedInputId: expect.any(String),
  });
  const requestBody = pendingResponse.request().postDataJSON() as {
    readonly mutationId?: unknown;
  };
  if (typeof requestBody.mutationId !== "string") {
    throw new Error("e2e_pi_pending_steer_operation_id_missing");
  }
  const operationId = requestBody.mutationId;

  const pendingRow = page
    .getByRole("region", { name: "Pending inputs" })
    .locator(
      `[data-pending-steer-operation-id="${operationId}"], [data-delivery-operation-id="${operationId}"]`,
    );
  await expect(composer).toHaveValue("");
  await expect(pendingRow).toHaveCount(1);
  await expect(pendingRow).toContainText(prompt);
  await expect(pendingRow).toContainText("Steering");
  await expect(
    page
      .getByRole("region", { name: "Messages" })
      .getByText(prompt, { exact: true }),
  ).toHaveCount(0);

  const released = await page.request.post("/__e2e/pi/pending-steer/release");
  expect(released.status()).toBe(204);
  await expect(pendingRow).toHaveCount(0);
  const materialized = page
    .getByRole("region", { name: "Messages" })
    .locator(`[data-delivery-operation-id="${operationId}"]`);
  await expect(materialized).toHaveCount(1);
  await expect(materialized).toContainText(prompt);
  await expect(composer).toHaveValue("");
});

test("Codex stacks serial Steers and preserves Queue-to-Steer presentation until exact materialization", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSedesWorkspace(page);
  await page
    .getByTestId("desktop-sidebar")
    .getByTestId("new-thread-trigger")
    .click();
  const target = page.getByRole("combobox", {
    name: "Target",
    exact: true,
  });
  await selectRadixOption(page, target, "Codex TCP external · Codex TCP");
  await expect(page.getByRole("combobox", { name: "Agent" })).toHaveText(/Custom/);
  const created = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/threads") &&
      response.status() === 201,
  );
  await page.getByRole("button", { name: "Create thread" }).click();
  await created;
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
  const threadId = new URL(page.url()).pathname.split("/").at(-1);
  if (!threadId) throw new Error("e2e_codex_thread_id_missing");

  const completionArmed = await page.request.post(
    "/__e2e/codex/turn-completion/arm",
  );
  expect(completionArmed.status()).toBe(204);
  await fillAndPersistDraft(
    page,
    "Keep the Codex fixture streaming while several steers materialize",
    "Message Codex",
  );
  await sendCurrentDraft(page);
  await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

  const composer = page.getByRole("textbox", { name: "Message Codex" });
  const queueToSteerText = "Convert this queued input without losing its card";
  await selectDeliveryMode(page, "Queue");
  await fillAndPersistDraft(page, queueToSteerText, "Message Codex");
  const queued = page.waitForResponse(
    (response) => operationKind(response) === "deliver" && response.ok(),
  );
  await page.getByRole("button", { name: "Queue", exact: true }).click();
  await queued;
  const strip = page.getByRole("region", { name: "Pending inputs" });
  const queuedRow = strip
    .getByRole("listitem")
    .filter({ hasText: queueToSteerText });
  await expect(queuedRow).toHaveCount(1);

  const armed = await page.request.post(
    `/__e2e/codex/steer-materialization/arm/${threadId}?count=3`,
  );
  expect(armed.ok()).toBe(true);

  const queueSteerResponse = page.waitForResponse(
    (response) =>
      operationKind(response) === "steer_queued_input" && response.ok(),
  );
  await queuedRow
    .getByRole("button", {
      name: `Steer queued input into active turn: ${queueToSteerText}`,
    })
    .click();
  const queueSteerCard = strip
    .getByRole("listitem")
    .filter({ hasText: queueToSteerText });
  await expect(queueSteerCard).toHaveCount(1);
  await expect(queueSteerCard).toContainText(/Sending steer|Steering/);
  await expect(queueSteerCard.getByRole("button")).toHaveCount(0);
  const queueSteerReceipt = await queueSteerResponse;
  const queueSteerRequest = queueSteerReceipt.request().postDataJSON() as {
    readonly mutationId?: unknown;
  };
  if (typeof queueSteerRequest.mutationId !== "string") {
    throw new Error("e2e_codex_queue_steer_operation_id_missing");
  }

  await selectDeliveryMode(page, "Steer");
  const submitSteer = async (text: string): Promise<string> => {
    await fillAndPersistDraft(page, text, "Message Codex");
    const responsePromise = page.waitForResponse(
      (response) => operationKind(response) === "deliver" && response.ok(),
    );
    await page.getByRole("button", { name: "Steer", exact: true }).click();
    const response = await responsePromise;
    expect(await response.json()).toMatchObject({
      status: "delivery_queued",
      queuedInputId: expect.any(String),
    });
    const request = response.request().postDataJSON() as {
      readonly mutationId?: unknown;
    };
    if (typeof request.mutationId !== "string") {
      throw new Error("e2e_codex_steer_operation_id_missing");
    }
    return request.mutationId;
  };

  const firstSteerText = "First direct steer stays independently visible";
  const secondSteerText = "Second direct steer stacks behind the first";
  const firstSteerOperationId = await submitSteer(firstSteerText);
  const secondSteerOperationId = await submitSteer(secondSteerText);
  expect(firstSteerOperationId).not.toBe(secondSteerOperationId);

  const pendingCards = [
    {
      text: queueToSteerText,
      operationId: queueSteerRequest.mutationId,
    },
    { text: firstSteerText, operationId: firstSteerOperationId },
    { text: secondSteerText, operationId: secondSteerOperationId },
  ];
  for (const pending of pendingCards) {
    const row = strip.getByRole("listitem").filter({ hasText: pending.text });
    await expect(row).toHaveCount(1);
    await expect(row).toContainText(/Pending steer|Steering/);
    await expect(row.getByRole("button")).toHaveCount(0);
    await expect(
      page.locator(
        `[data-pending-steer-operation-id="${pending.operationId}"], [data-delivery-operation-id="${pending.operationId}"]`,
      ),
    ).toHaveCount(1);
    await expect(
      page.locator('[data-item-kind="user_message"]').filter({
        hasText: pending.text,
      }),
    ).toHaveCount(0);
  }
  const held = await page.request.get(
    "/__e2e/codex/steer-materialization/state",
  );
  expect(await held.json()).toMatchObject({
    armed: false,
    held: true,
    heldCount: 3,
  });
  await expect(composer).toHaveValue("");
  await capture(page, testInfo, "pending-steer-accepted-desktop.png");

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoPageOverflow(page);
  await expect(composer).toBeVisible();
  for (const pending of pendingCards) {
    await expect(
      strip.getByRole("listitem").filter({ hasText: pending.text }),
    ).toBeVisible();
  }
  await capture(page, testInfo, "pending-steer-accepted-mobile.png");

  for (const pending of pendingCards) {
    const released = await page.request.post(
      "/__e2e/codex/steer-materialization/release",
    );
    expect(released.ok()).toBe(true);
    await expect(
      strip.getByRole("listitem").filter({ hasText: pending.text }),
    ).toHaveCount(0);
    await expect(
      page.locator(
        `[data-item-kind="user_message"][data-delivery-operation-id="${pending.operationId}"]`,
      ),
    ).toHaveCount(1);
  }
  await expect(composer).toHaveValue("");
  await expectNoPageOverflow(page);
});
