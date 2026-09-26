import { createHash } from "node:crypto";
import { test, expect } from "./fixtures";
import { normalizedThreadSnapshotSchema } from "../../src/shared/protocol/conversation.js";
import {
  capture,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openSedesWorkspace,
  selectCustomNewThreadTarget,
  selectRadixOption,
  sendCurrentDraft,
} from "./helpers";

const FORBIDDEN_CODEX_VALUES = [
  "FORBIDDEN_NATIVE_ROLLOUT_6f1d7e65a77f",
  "FORBIDDEN_NATIVE_SESSION_2bc9a48f1163",
  "FORBIDDEN_NATIVE_API_KEY_a71e0c84d592",
  "/private/FORBIDDEN_CODEX_UDS_HOME_0fa75541d579",
  "/private/FORBIDDEN_CODEX_UDS_SOCKET_5cfd39db45ed.sock",
  "ws://127.0.0.1:65431",
  "SEDES_CODEX_FORBIDDEN_E2E_TOKEN",
  "canonicalSocketIdentity",
  "environmentChannelIdentity",
  "filesystemIdentity",
  "private_unix_socket",
  "websocketUpgradeVerified",
] as const;

test.describe.serial("normalized Codex thread state", () => {
  let codexThreadPath = "";

  test("two Codex backend targets remain durably bound and client-isolated", async ({
    page,
  }) => {
    type FixtureState = {
      requestCount: number;
      requests: Array<{ method: string; generation: number }>;
    };
    const readFixtureState = async (
      backendInstanceId: "codex-import-e2e" | "codex-uds-e2e",
    ): Promise<FixtureState> => {
      const response = await page.request.get(
        `/__e2e/codex/backends/${backendInstanceId}/state`,
      );
      expect(response.ok()).toBe(true);
      return (await response.json()) as FixtureState;
    };
    const threadStartCount = (state: FixtureState) =>
      state.requests.filter(({ method }) => method === "thread/start").length;
    const openPicker = async () => {
      const newThread = page
        .locator(".desktop-sidebar")
        .getByTestId("new-thread-trigger");
      await expect(newThread).toBeEnabled();
      await newThread.click();
      await expect(page.getByRole("combobox", { name: "Agent" })).toBeVisible();
    };

    await page.goto("/");
    await openSedesWorkspace(page);

    await openPicker();
    const primaryPicker = await selectCustomNewThreadTarget(
      page,
      "Codex TCP external · Codex TCP",
    );
    const primaryTargetId = await primaryPicker.getAttribute("data-target-id");
    if (!primaryTargetId) throw new Error("primary_target_id_missing");
    const primaryBefore = await readFixtureState("codex-import-e2e");
    const udsBeforePrimary = await readFixtureState("codex-uds-e2e");
    const primaryCreated = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/threads") &&
        response.status() === 201,
    );
    await page.getByRole("button", { name: "Create thread" }).click();
    const primaryCreateResponse = await primaryCreated;
    expect(primaryCreateResponse.request().postDataJSON()).toMatchObject({
      configuration: { kind: "custom", targetId: primaryTargetId },
    });
    await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
    const primaryThreadPath = new URL(page.url()).pathname;
    await fillAndPersistDraft(
      page,
      "Exercise the primary Codex backend",
      "Message Codex",
    );
    await sendCurrentDraft(page);
    await expect(
      page.locator(
        '[data-item-kind="assistant_message"][data-item-status="completed"]',
      ),
    ).toContainText(
      "Codex is streaming a browser-neutral normalized response.",
    );
    const primaryAfter = await readFixtureState("codex-import-e2e");
    const udsAfterPrimary = await readFixtureState("codex-uds-e2e");
    expect(threadStartCount(primaryAfter)).toBe(
      threadStartCount(primaryBefore) + 1,
    );
    expect(threadStartCount(udsAfterPrimary)).toBe(
      threadStartCount(udsBeforePrimary),
    );
    await page.reload();
    await expect(
      page.getByRole("textbox", { name: "Message Codex" }),
    ).toBeVisible();
    const primarySnapshotResponse = await page.request.get(
      `/api${primaryThreadPath}?activityDetail=full`,
    );
    expect(primarySnapshotResponse.ok()).toBe(true);

    await page.goto("/");
    await openPicker();
    const udsPicker = await selectCustomNewThreadTarget(
      page,
      "Codex UDS external · Codex UDS",
    );
    const udsTargetId = await udsPicker.getAttribute("data-target-id");
    if (!udsTargetId) throw new Error("uds_target_id_missing");
    expect(udsTargetId).not.toBe(primaryTargetId);
    const primaryBeforeUds = await readFixtureState("codex-import-e2e");
    const udsBefore = await readFixtureState("codex-uds-e2e");
    const udsCreated = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/threads") &&
        response.status() === 201,
    );
    await page.getByRole("button", { name: "Create thread" }).click();
    const udsCreateResponse = await udsCreated;
    expect(udsCreateResponse.request().postDataJSON()).toMatchObject({
      configuration: { kind: "custom", targetId: udsTargetId },
    });
    await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
    const udsThreadPath = new URL(page.url()).pathname;
    await fillAndPersistDraft(
      page,
      "Exercise the external UDS Codex backend",
      "Message Codex UDS",
    );
    await sendCurrentDraft(page);
    await expect(
      page.locator(
        '[data-item-kind="assistant_message"][data-item-status="completed"]',
      ),
    ).toContainText(
      "Codex is streaming a browser-neutral normalized response.",
    );
    const primaryAfterUds = await readFixtureState("codex-import-e2e");
    const udsAfter = await readFixtureState("codex-uds-e2e");
    expect(threadStartCount(primaryAfterUds)).toBe(
      threadStartCount(primaryBeforeUds),
    );
    expect(threadStartCount(udsAfter)).toBe(threadStartCount(udsBefore) + 1);
    await page.reload();
    await expect(
      page.getByRole("textbox", { name: "Message Codex UDS" }),
    ).toBeVisible();
    const udsSnapshotResponse = await page.request.get(
      `/api${udsThreadPath}?activityDetail=full`,
    );
    expect(udsSnapshotResponse.ok()).toBe(true);

    await page.goto(primaryThreadPath);
    await page.reload();
    await expect(
      page.getByRole("textbox", { name: "Message Codex" }),
    ).toBeVisible();

    const applicationSnapshotResponse = await page.request.get(
      "/api/application/snapshot",
    );
    expect(applicationSnapshotResponse.ok()).toBe(true);
    const browserStorage = await page.evaluate(() => ({
      local: { ...localStorage },
      session: { ...sessionStorage },
    }));
    const normalizedBrowserAndApiState = JSON.stringify({
      applicationSnapshot: await applicationSnapshotResponse.json(),
      primaryCreate: await primaryCreateResponse.json(),
      primarySnapshot: await primarySnapshotResponse.json(),
      udsCreate: await udsCreateResponse.json(),
      udsSnapshot: await udsSnapshotResponse.json(),
      browserStorage,
      document: await page.locator("body").innerText(),
    });
    for (const forbidden of FORBIDDEN_CODEX_VALUES) {
      expect(normalizedBrowserAndApiState).not.toContain(forbidden);
    }
    expect(normalizedBrowserAndApiState).not.toContain("unix_websocket");
    expect(normalizedBrowserAndApiState).not.toContain("socketPath");
    expect(normalizedBrowserAndApiState).not.toContain("tcp_websocket");
    expect(normalizedBrowserAndApiState).not.toContain("capability_token");
    expect(normalizedBrowserAndApiState).not.toContain("Authorization");
  });

  test("Codex target creates and durably sends its first prompt", async ({
    page,
  }, testInfo) => {
    await page.goto("/");
    await openSedesWorkspace(page);
    await page
      .getByTestId("desktop-sidebar")
      .getByTestId("new-thread-trigger")
      .click();
    await selectCustomNewThreadTarget(page, "Codex TCP external · Codex TCP");
    const createTitle = "Named Codex browser thread";
    await page.getByRole("textbox", { name: "Thread name" }).fill(createTitle);
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/threads") &&
        response.status() === 201,
    );
    await page.getByRole("button", { name: "Create thread" }).click();
    const createResponse = await created;
    expect(createResponse.request().postDataJSON()).toMatchObject({
      title: createTitle,
    });
    await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
    codexThreadPath = new URL(page.url()).pathname;
    await expect(
      page.getByRole("heading", { name: createTitle }),
    ).toBeVisible();

    const composer = page.getByRole("textbox", { name: /Message/ });
    await expect(composer).toBeVisible();
    const prompt = "Create this Codex thread and complete its first prompt";
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith("/draft") &&
        response.ok(),
    );
    await composer.fill(prompt);
    await saved;
    const accepted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/operations") &&
        response.ok(),
    );
    await page.getByRole("button", { name: "Send message" }).click();
    await accepted;

    await expect(
      page.locator('[data-item-kind="user_message"]').getByText(prompt, {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.locator(
        '[data-item-kind="assistant_message"][data-item-status="completed"]',
      ),
    ).toContainText(
      "Codex is streaming a browser-neutral normalized response.",
    );
    const codexStateResponse = await page.request.get(
      "/__e2e/codex/backends/codex-import-e2e/state",
    );
    expect(codexStateResponse.ok()).toBe(true);
    const codexState = (await codexStateResponse.json()) as {
      requests: Array<{ method: string }>;
    };
    expect(
      codexState.requests.some(({ method }) => method === "thread/name/set"),
    ).toBe(true);
    const snapshotResponse = await page.request.get(
      `/api${new URL(page.url()).pathname}?activityDetail=full`,
    );
    expect(snapshotResponse.ok()).toBe(true);
    const snapshot = normalizedThreadSnapshotSchema.parse(
      await snapshotResponse.json(),
    );
    expect(snapshot.thread.backingState).toBe("bound");
    expect(snapshot.recovery).toBeUndefined();
    await page.reload();
    await expect(page.getByText(prompt, { exact: true })).toBeVisible();
    const desktopThreadConfiguration = page
      .getByTestId("composer")
      .getByTestId("thread-configuration");
    await expect(desktopThreadConfiguration.getByRole("combobox")).toHaveCount(
      2,
    );
    await expect(
      desktopThreadConfiguration.getByRole("combobox", { name: "Model" }),
    ).toBeVisible();
    await expect(
      desktopThreadConfiguration.getByRole("combobox", { name: "Reasoning" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Thread actions" }).click();
    const executionSettings = page.getByLabel("Codex execution settings");
    await expect(executionSettings).toBeVisible();
    await expect(executionSettings.getByRole("combobox")).toHaveCount(4);
    const sandbox = executionSettings.getByRole("combobox", {
      name: "Sandbox",
    });
    const network = executionSettings.getByRole("combobox", {
      name: "Network",
    });
    const approvalPolicy = executionSettings.getByRole("combobox", {
      name: "Approval policy",
    });
    const approvalReviewer = executionSettings.getByRole("combobox", {
      name: "Approval reviewer",
    });
    await expect(sandbox).toContainText("Read only");
    await expect(network).toContainText("Disabled");
    await expect(approvalPolicy).toContainText("Never");
    await expect(approvalReviewer).toContainText("User");
    await expect(approvalReviewer).toBeDisabled();
    const approvalOnRequestApplied = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/operations") &&
        response.ok() &&
        response.request().postDataJSON().operation?.actionId ===
          "set_approval_on_request",
    );
    await selectRadixOption(page, approvalPolicy, "On request");
    await approvalOnRequestApplied;
    await expect(approvalReviewer).toBeEnabled();
    const workspaceApplied = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/operations") &&
        response.ok() &&
        response.request().postDataJSON().operation?.actionId ===
          "set_sandbox_workspace",
    );
    await selectRadixOption(page, sandbox, "Workspace");
    await workspaceApplied;
    await expect(sandbox).toContainText("Workspace");

    const unrestrictedApplied = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/operations") &&
        response.ok() &&
        response.request().postDataJSON().operation?.actionId ===
          "set_sandbox_unrestricted",
    );
    await selectRadixOption(page, sandbox, "Unrestricted");
    await unrestrictedApplied;
    await expect(sandbox).toContainText("Unrestricted");
    await expect(network).toContainText("Enabled");
    await expect(network).toBeDisabled();
    const approvalNeverApplied = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/operations") &&
        response.ok() &&
        response.request().postDataJSON().operation?.actionId ===
          "set_approval_never",
    );
    await selectRadixOption(page, approvalPolicy, "Never");
    await approvalNeverApplied;
    await expect(approvalReviewer).toBeDisabled();
    await expect(page.getByTestId("dialog-overlay")).toHaveCount(0);
    await expect(page.getByText(/no sandbox or approval prompts/i)).toHaveCount(
      0,
    );
    await expect(
      page.getByText(
        /Codex permissions (?:unconfirmed|unavailable)|Settings changed for the next turn|Custom Codex permissions/i,
      ),
    ).toHaveCount(0);
    await expect(
      page.getByText(/Permissions changed in another window/i),
    ).toHaveCount(0);
    await expect(
      page
        .getByTestId("composer")
        .getByText(/Current:|applies (?:on )?(?:the )?next turn/i),
    ).toHaveCount(0);
    await expect(
      executionSettings.locator(".danger, [data-danger='true']"),
    ).toHaveCount(0);
    await capture(page, testInfo, "codex-created-first-send.png");
  });

  test("Codex Fast mode is a quiet persistent composer toggle", async ({
    page,
  }, testInfo) => {
    expect(codexThreadPath).toMatch(/^\/threads\/[0-9a-f-]+$/);
    await page.goto(codexThreadPath);

    const standardToggle = page.getByRole("button", {
      name: "Fast mode, off",
    });
    await expect(standardToggle).toBeVisible();
    await expect(standardToggle).toHaveAttribute("aria-pressed", "false");
    await expect(standardToggle.locator("svg")).toHaveAttribute("fill", "none");
    await capture(page, testInfo, "codex-fast-mode-standard.png");

    await standardToggle.hover();
    await expect(
      page.getByRole("tooltip", {
        name: "Fast mode: about 1.5x speed, higher usage",
      }),
    ).toBeVisible();
    await page.getByRole("textbox", { name: /Message/ }).hover();

    const enabled = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/operations") &&
        response.ok() &&
        response.request().postDataJSON().operation?.feature?.featureId ===
          "codex.fast_mode" &&
        response.request().postDataJSON().operation?.actionId === "enable",
    );
    await standardToggle.click();
    await enabled;

    const fastToggle = page.getByRole("button", { name: "Fast mode, on" });
    await expect(fastToggle).toBeVisible();
    await expect(fastToggle).toHaveAttribute("aria-pressed", "true");
    await expect(fastToggle).toHaveAttribute(
      "data-application-state",
      "applied",
    );
    await expect(fastToggle.locator("svg")).toHaveAttribute(
      "fill",
      "currentColor",
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await capture(page, testInfo, "codex-fast-mode-enabled.png");

    await page.reload();
    await expect(
      page.getByRole("button", { name: "Fast mode, on" }),
    ).toHaveAttribute("data-application-state", "applied");

    await page.setViewportSize({ width: 390, height: 844 });
    const mobileFastToggle = page.getByRole("button", {
      name: "Fast mode, on",
    });
    await expect(mobileFastToggle).toBeVisible();
    await expect(mobileFastToggle).toHaveAttribute("aria-pressed", "true");
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "codex-fast-mode-mobile.png");
  });

  test("mobile Codex thread actions expose all execution controls", async ({
    page,
  }, testInfo) => {
    expect(codexThreadPath).toMatch(/^\/threads\/[0-9a-f-]+$/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(codexThreadPath);

    await page.getByRole("button", { name: "Thread actions" }).click();
    const sheet = page.getByTestId("thread-settings-sheet");
    await expect(sheet).toHaveAccessibleName("Thread settings");
    await expect
      .poll(async () => (await sheet.boundingBox())?.height ?? 0)
      .toBeGreaterThan(800);
    await expect(sheet.getByRole("combobox")).toHaveCount(6);
    await expect(sheet.getByRole("combobox", { name: "Model" })).toBeVisible();
    await expect(
      sheet.getByRole("combobox", { name: "Reasoning" }),
    ).toBeVisible();
    await expect(
      sheet.getByRole("combobox", { name: "Sandbox" }),
    ).toContainText("Unrestricted");
    await expect(
      sheet.getByRole("combobox", { name: "Network" }),
    ).toContainText("Enabled");
    await expect(
      sheet.getByRole("combobox", { name: "Approval policy" }),
    ).toContainText("Never");
    await expect(
      sheet.getByRole("combobox", { name: "Approval reviewer" }),
    ).toBeDisabled();
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "codex-thread-mobile.png");
  });

  test("viewed images arrive after later text and survive reload without the source file", async ({ page }, testInfo) => {
    await page.goto("/");
    await openSedesWorkspace(page);
    await page.getByTestId("desktop-sidebar").getByTestId("new-thread-trigger").click();
    await selectCustomNewThreadTarget(page, "Codex TCP external · Codex TCP");
    const created = page.waitForResponse(response => response.request().method() === "POST" &&
      response.url().endsWith("/api/threads") && response.status() === 201);
    await page.getByRole("button", { name: "Create thread" }).click();
    await created;
    await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
    const threadPath = new URL(page.url()).pathname;
    const threadId = threadPath.split("/").at(-1)!;
    expect((await page.request.post("/__e2e/codex/turn-completion/arm")).status()).toBe(204);
    try {
      await fillAndPersistDraft(page, "View the fixture image and continue describing it", "Message Codex");
      await sendCurrentDraft(page);
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      const emitted = await page.request.post(`/__e2e/codex/viewed-image/${threadId}/emit`);
      expect(emitted.ok(), await emitted.text()).toBe(true);
      const expectedImage = await emitted.json() as { sha256: string; byteSize: number };
      const followingText = page.locator('[data-item-kind="assistant_message"]').filter({ hasText: "The file was viewed; work continues while its preview is captured." });
      await expect(followingText).toBeVisible();
      await expect.poll(async () => (await (await page.request.get("/__e2e/codex/viewed-image/state")).json())).toEqual({ reads: 1 });
      await expect(page.locator('[data-item-kind="image"]')).toHaveCount(0);
      await capture(page, testInfo, "codex-viewed-image-streaming.png");

      // Settling provider work must not wait for the already-open file read.
      expect((await page.request.post("/__e2e/codex/turn-completion/release")).status()).toBe(204);
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
      await expect(page.locator('[data-item-kind="image"]')).toHaveCount(0);
      expect((await page.request.post("/__e2e/codex/viewed-image/release")).status()).toBe(204);
      const image = page.getByRole("img", { name: "Viewed file snapshot", exact: true });
      await expect(image).toBeVisible();
      await expect.poll(() => image.evaluate(element => (element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
      const ordering = await page.locator('[data-item-kind]').evaluateAll(items => items.map(item => ({ kind: item.getAttribute("data-item-kind"), text: item.textContent ?? "" })));
      const imageIndex = ordering.findIndex(item => item.kind === "image");
      const followingIndex = ordering.findIndex(item => item.text.includes("The file was viewed; work continues"));
      expect(imageIndex).toBeGreaterThanOrEqual(0);
      expect(followingIndex).toBeGreaterThan(imageIndex);
      await expectNoPageOverflow(page);
      await capture(page, testInfo, "codex-viewed-image-complete.png");

      const readSnapshot = async () => {
        const response = await page.request.get(`/api${threadPath}?activityDetail=full`);
        expect(response.ok()).toBe(true);
        return normalizedThreadSnapshotSchema.parse(await response.json());
      };
      const snapshot = await readSnapshot();
      const retained = Object.values(snapshot.itemsById).find(item => item.kind === "image");
      if (retained?.kind !== "image" || retained.image.representation !== "artifact") throw new Error("viewed_image_artifact_missing");
      expect(retained.image).toMatchObject(expectedImage);
      expect(JSON.stringify(snapshot)).not.toContain("viewed-image-fixture.png");
      const content = await page.request.get(`/api${threadPath}/output-artifacts/${retained.image.artifactId}/content`);
      expect(content.ok()).toBe(true);
      expect(createHash("sha256").update(await content.body()).digest("hex")).toBe(expectedImage.sha256);
      expect((await page.request.post("/__e2e/codex/viewed-image/remove")).status()).toBe(204);
      await page.goto("/");
      await expect.poll(async () => (await page.request.post(`/__e2e/threads/${threadId}/close-idle-runtime`)).status()).toBe(204);
      await page.goto(threadPath);
      await page.reload();
      await expect(page.getByRole("img", { name: "Viewed file snapshot", exact: true })).toBeVisible();
      const replay = await readSnapshot();
      const replayImage = Object.values(replay.itemsById).find(item => item.kind === "image");
      expect(replayImage?.kind === "image" ? replayImage.image : undefined).toEqual(retained.image);
      expect((await (await page.request.get("/__e2e/codex/viewed-image/state")).json()).reads).toBe(1);
    } finally {
      await page.request.post("/__e2e/codex/viewed-image/release");
      await page.request.post("/__e2e/codex/turn-completion/reset");
    }
  });

  test("active Codex history keeps abandoned paginated turns readable", async ({
    page,
  }) => {
    await page.goto("/");
    await openSedesWorkspace(page);
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
    const threadPath = new URL(page.url()).pathname;
    const threadId = threadPath.split("/").at(-1);
    if (!threadId) throw new Error("e2e_codex_thread_id_missing");

    await fillAndPersistDraft(
      page,
      "Materialize this Codex thread before replacing its history",
      "Message Codex",
    );
    await sendCurrentDraft(page);
    await expect(
      page.locator(
        '[data-item-kind="assistant_message"][data-item-status="completed"]',
      ),
    ).toBeVisible();
    const seeded = await page.request.post(
      `/__e2e/codex/readable-abandoned-history/${threadId}`,
    );
    expect(seeded.ok(), `${seeded.status()} ${await seeded.text()}`).toBe(true);

    await page.goto(threadPath);
    const initialAbandoned = page
      .locator('.conversation-turn[data-turn-status="interrupted"]')
      .filter({ hasText: "Abandoned initial-window Codex turn" });
    await expect(initialAbandoned).toBeVisible();
    await expect(
      page.locator('.conversation-turn[data-turn-status="in_progress"]'),
    ).toHaveCount(1);
    await expect(
      page
        .locator('.conversation-turn[data-turn-status="in_progress"]')
        .filter({ hasText: "Live Codex head remains active" }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

    await page.getByRole("button", { name: "Load more" }).click();
    const olderAbandoned = page
      .locator('.conversation-turn[data-turn-status="interrupted"]')
      .filter({ hasText: "Abandoned older-page Codex turn" });
    await expect(olderAbandoned).toBeVisible();
    await expect(
      page.locator('.conversation-turn[data-turn-status="in_progress"]'),
    ).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(
      0,
    );
  });
});
