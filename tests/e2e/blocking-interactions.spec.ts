import path from "node:path";
import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import { capture, openSedesWorkspace, selectRadixOption } from "./helpers";

const repositoryDisplayName = path.basename(process.cwd());
const importedCodexTitle = `Imported Codex history — ${repositoryDisplayName}`;
const SECRET_FIXTURE_VALUE = "E2E_SECRET_MUST_STAY_REDACTED_47c123";

type InteractionScenario =
  | "decision_standard"
  | "mcp_invocation"
  | "mcp_form"
  | "questionnaire_full"
  | "questionnaire_durable"
  | "mixed_decision_questionnaire";

type InteractionFixtureRecord = {
  readonly requestId: number;
  readonly scenario: InteractionScenario;
  readonly kind: "decision" | "questionnaire" | "confirmation" | "form";
  readonly state: "pending" | "response_received" | "confirmed" | "failed";
  readonly safeResponse?: {
    readonly kind: "decision" | "questionnaire" | "confirmation" | "form";
    readonly action?: string;
    readonly content?: unknown;
    readonly decision?: string;
    readonly answeredQuestionCount?: number;
    readonly answerEntryCounts?: readonly number[];
  };
};

type ApplicationDecisionFixtureRecord = {
  readonly requestId: number;
  readonly applicationThreadId: string;
  readonly state: "pending" | "resolved" | "cancelled" | "failed";
  readonly decision?: "allow" | "deny";
  readonly failure?: string;
};

test.describe.serial("blocking interaction panel", () => {
  let codexThreadPath = "";

  test.beforeEach(async ({ page }) => {
    const reset = await page.request.post("/__e2e/interactions/reset");
    expect(reset.ok()).toBe(true);
  });

  test.afterEach(async ({ page }) => {
    const reset = await page.request.post("/__e2e/interactions/reset");
    expect(reset.ok()).toBe(true);
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toHaveCount(0, { timeout: 5_000 });
  });

  test("decision menu is one-click, pending until confirmed, and restores focus", async ({
    page,
  }, testInfo) => {
    codexThreadPath = await openImportedCodexThread(page);
    const threadId = threadIdFromPath(codexThreadPath);
    await startCodexFixtureTurn(page, "Exercise the decision takeover");

    const composer = page.getByTestId("composer").locator("textarea");
    const retainedDraft = "Keep this draft while approval is open";
    await fillDraft(page, composer, retainedDraft);
    await composer.focus();

    const [requestId] = await openScenario(page, threadId, "decision_standard");
    const dialog = page.getByRole("dialog", { name: "Command approval" });
    await expect(dialog).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        dialog.evaluate((element) => element.contains(document.activeElement)),
      )
      .toBe(true);
    const covered = page.getByTestId("thread-presentation-content");
    await expect(covered).not.toHaveAttribute("inert");
    await expect(covered).not.toHaveAttribute("aria-hidden");
    expect(
      await composer.evaluate((element) => {
        element.focus();
        return document.activeElement === element;
      }),
    ).toBe(true);
    await expect(dialog.locator("kbd")).toHaveCount(0);
    await expect(dialog.getByText("Codex", { exact: true })).toHaveCount(0);
    await expect(
      dialog.getByTestId("interaction-prompt-message"),
    ).toHaveJSProperty("tagName", "P");
    await expect(dialog.getByTestId("interaction-prompt-code")).toContainText(
      "npm run typecheck",
    );

    const menuTrigger = dialog.getByRole("button", {
      name: "More approval options",
    });
    await menuTrigger.focus();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("menuitem", { name: /Approve for session/ }),
    ).toBeVisible();
    const menu = page.locator(
      '[data-slot="dropdown-menu-content"].interaction-action-menu',
    );
    const [composerBox, menuBox] = await Promise.all([
      page.getByTestId("composer").boundingBox(),
      menu.boundingBox(),
    ]);
    expect(composerBox).not.toBeNull();
    expect(menuBox).not.toBeNull();
    expect(menuBox!.width).toBeLessThanOrEqual(composerBox!.width + 1);
    await expect(
      menu.getByText("Approve and remember similar commands", { exact: true }),
    ).toHaveAttribute("title", "Approve and remember similar commands");
    await capture(page, testInfo, "blocking-decision-menu-desktop.png");
    await page.keyboard.press("Escape");
    await expect(
      page.getByRole("menuitem", { name: /Approve for session/ }),
    ).toHaveCount(0);
    await expect(dialog).toBeVisible();

    await menuTrigger.click();
    await page.getByRole("menuitem", { name: /Approve for session/ }).click();
    await expect(dialog.getByTestId("interaction-pending")).toBeVisible();
    expect(
      await dialog
        .getByRole("button")
        .evaluateAll((buttons) =>
          buttons.every((button) => button.hasAttribute("disabled")),
        ),
    ).toBe(true);
    await expect
      .poll(async () => (await fixtureRecord(page, requestId)).state)
      .toBe("response_received");
    await capture(page, testInfo, "blocking-decision-chat-desktop.png");

    await releaseInteraction(page, requestId);
    await expect(dialog).toHaveCount(0);
    await expect(composer).toHaveValue(retainedDraft);
    await expect(composer).toBeFocused();
    expect((await fixtureRecord(page, requestId)).safeResponse).toMatchObject({
      kind: "decision",
      decision: "acceptForSession",
    });
  });

  test("MCP approval and typed form remain usable after reload", async ({
    page,
  }, testInfo) => {
    codexThreadPath = await ensureImportedThread(page, codexThreadPath);
    const threadId = threadIdFromPath(codexThreadPath);
    expect((await page.request.post("/__e2e/codex/turn-completion/arm")).ok()).toBe(true);
    try {
      await startCodexFixtureTurn(page, "Review generic MCP invocation parameters");
      const [requestId] = await openScenario(page, threadId, "mcp_invocation");
      const title = "Allow the fixture_catalog MCP server to run inspect_catalog?";
      const dialog = page.getByRole("dialog", { name: title });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Invocation parameters");
      await expect(dialog).toContainText("local models");
      await expect(dialog).toContainText("maxResults");
      await expect(dialog.getByRole("textbox")).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Allow", exact: true })).toBeEnabled();
      await expect(dialog.getByRole("button", { name: "Allow", exact: true })).toBeInViewport({ ratio: 1 });

      // A new client must receive the same answerable waiting state from the
      // retained server checkpoint, without a draft mutation repairing it.
      await page.reload();
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("local models");
      await expect(dialog.getByRole("textbox")).toHaveCount(0);
      await expect(dialog.getByRole("button", { name: "Allow", exact: true })).toBeEnabled();
      await expect(dialog.getByRole("button", { name: "Allow", exact: true })).toBeInViewport({ ratio: 1 });
      expect(await dialog.textContent()).not.toContain("FORBIDDEN_NATIVE_API_KEY_a71e0c84d592");
      await capture(page, testInfo, "blocking-mcp-invocation-desktop.png");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(dialog.getByRole("button", { name: "Allow", exact: true })).toBeInViewport({ ratio: 1 });
      await capture(page, testInfo, "blocking-mcp-invocation-mobile.png");

      await dialog.getByRole("button", { name: "Allow", exact: true }).click();
      await expect.poll(async () => (await fixtureRecord(page, requestId)).state).toBe("response_received");
      expect((await fixtureRecord(page, requestId)).safeResponse).toEqual({
        kind: "confirmation", action: "accept", content: {},
      });
      await releaseInteraction(page, requestId);
      await expect(dialog).toHaveCount(0);

      // The same running turn can next request actual data. Those fields are
      // independent of the preceding tool's read-only invocation parameters.
      await page.setViewportSize({ width: 1440, height: 1000 });
      const [formRequestId] = await openScenario(page, threadId, "mcp_form");
      const form = page.getByRole("dialog", { name: "Catalog request details" });
      await expect(form).toBeVisible();
      const submit = form.getByRole("button", { name: "Continue", exact: true });
      await submit.click();
      await expect(form.getByRole("textbox", { name: "Project", exact: true })).toHaveAttribute("aria-invalid", "true");
      expect((await fixtureRecord(page, formRequestId)).state).toBe("pending");
      await expect(form.getByRole("spinbutton", { name: "Result limit", exact: true })).toHaveValue("10");
      await expect(form.getByRole("combobox", { name: "Include archived", exact: true })).toHaveValue("false");
      await expect(form.getByRole("checkbox", { name: "local", exact: true })).toBeChecked();
      await form.getByRole("textbox", { name: "Project", exact: true }).fill("A");
      await submit.click();
      await expect(form.getByRole("textbox", { name: "Project", exact: true })).toHaveAttribute("aria-invalid", "true");
      await form.getByRole("textbox", { name: "Project", exact: true }).fill("Research");
      await form.getByRole("spinbutton", { name: "Result limit", exact: true }).fill("0");
      await submit.click();
      await expect(form.getByRole("spinbutton", { name: "Result limit", exact: true })).toHaveAttribute("aria-invalid", "true");
      expect((await fixtureRecord(page, formRequestId)).state).toBe("pending");
      await form.getByRole("spinbutton", { name: "Result limit", exact: true }).fill("20");
      await form.getByRole("combobox", { name: "Region", exact: true }).selectOption({ label: "eu" });
      await form.getByRole("checkbox", { name: "hosted", exact: true }).check();
      await expect(submit).toBeEnabled();
      await expect(submit).toBeInViewport({ ratio: 1 });
      await form.locator(".interaction-fields-scroll").evaluate(element => { element.scrollTop = 0; });
      await capture(page, testInfo, "blocking-mcp-form-desktop.png");
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(submit).toBeInViewport({ ratio: 1 });
      // Responsive pane reparenting can restart the card's entrance transform.
      // Wait for the actual mobile hit target rather than sampling that motion.
      await expect
        .poll(async () =>
          (await form
            .getByRole("textbox", { name: "Project", exact: true })
            .boundingBox())?.height ?? 0,
        )
        .toBeGreaterThanOrEqual(44);
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      await capture(page, testInfo, "blocking-mcp-form-mobile.png");
      await form.locator(".interaction-fields-scroll").evaluate(element => { element.scrollTop = element.scrollHeight; });
      await expect(submit).toBeInViewport({ ratio: 1 });
      await capture(page, testInfo, "blocking-mcp-form-options-mobile.png");
      await submit.click();
      await expect.poll(async () => (await fixtureRecord(page, formRequestId)).state).toBe("response_received");
      expect((await fixtureRecord(page, formRequestId)).safeResponse).toEqual({
        kind: "form", action: "accept", content: {
          project: "Research", limit: 20, includeArchived: false, region: "eu", tags: ["local", "hosted"],
        },
      });
      await releaseInteraction(page, formRequestId);
      await expect(form).toHaveCount(0);
    } finally {
      expect((await page.request.post("/__e2e/codex/turn-completion/reset")).ok()).toBe(true);
    }
  });

  test("force reset replaces a stuck runtime and reveals the next approval", async ({
    page,
  }, testInfo) => {
    codexThreadPath = await ensureImportedThread(page, codexThreadPath);
    const threadId = threadIdFromPath(codexThreadPath);
    // Keep the provider turn alive while force reset retires the first approval.
    // Otherwise its completion timer races opening the replacement approval.
    expect(
      (await page.request.post("/__e2e/codex/turn-completion/arm")).ok(),
    ).toBe(true);
    try {
      await startCodexFixtureTurn(page, "Exercise stuck approval force reset");
      const [stuckRequestId] = await openScenario(
        page,
        threadId,
        "decision_standard",
      );
      const approval = page.getByRole("dialog", { name: "Command approval" });
      await expect(approval).toBeVisible();

      const sidebarThread = page
        .getByTestId("desktop-sidebar")
        .getByTestId("thread-row-link")
        .filter({ hasText: importedCodexTitle });
      await sidebarThread.click({ button: "right" });
      await page.getByRole("menuitem", { name: "Force reset…" }).click();
      const reset = page.getByRole("dialog", {
        name: "Force reset Sedes state?",
      });
      await expect(reset).toContainText("1 pending approval or question");
      await expect(reset).toContainText("1 conversation runtime");
      await capture(page, testInfo, "blocking-force-reset-approval-desktop.png");

      let resetResponded = false;
      const committed = page
        .waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().endsWith(`/api/threads/${threadId}/force-reset`) &&
            response.ok(),
        )
        .finally(() => {
          resetResponded = true;
        });
      await reset.getByRole("button", { name: "Force reset" }).click();
      // After the durable commit, Sedes cancels the abandoned approval at the
      // provider with Codex's native cancel decision, never as an approval.
      await expect
        .poll(async () => (await fixtureRecord(page, stuckRequestId)).state)
        .toBe("response_received");
      expect((await fixtureRecord(page, stuckRequestId)).safeResponse).toEqual({
        kind: "decision",
        decision: "cancel",
      });
      await expect(approval).toHaveCount(0);
      // The reset waits, within its bound, for the provider to confirm the
      // cancellation before it replaces the runtime.
      expect(resetResponded).toBe(false);
      await releaseInteraction(page, stuckRequestId);
      await committed;
      await expect(reset).toHaveCount(0);
      expect((await fixtureRecord(page, stuckRequestId)).state).toBe(
        "confirmed",
      );

      const [nextRequestId] = await openScenario(
        page,
        threadId,
        "decision_standard",
      );
      await expect(approval).toBeVisible();
      await approval.getByTestId("decision-primary-action").click();
      await expect
        .poll(async () => (await fixtureRecord(page, nextRequestId)).state)
        .toBe("response_received");
      await releaseInteraction(page, nextRequestId);
      await expect(approval).toHaveCount(0);
    } finally {
      expect(
        (await page.request.post("/__e2e/codex/turn-completion/reset")).ok(),
      ).toBe(true);
    }
  });

  test("cross-environment approval uses application-owned allow, deny, and cancellation", async ({
    page,
  }, testInfo) => {
    codexThreadPath = await ensureImportedThread(page, codexThreadPath);
    const threadId = threadIdFromPath(codexThreadPath);
    expect(
      (await page.request.post("/__e2e/codex/turn-completion/arm")).ok(),
    ).toBe(true);
    await startCodexFixtureTurn(page, "Exercise application-owned approval");

    try {
      const allowRequestId = await openApplicationDecision(page, threadId);
      const approval = page.getByRole("dialog", {
        name: "Allow Open workspace?",
      });
      await expect(approval).toBeVisible();
      await expect(approval).toContainText(
        "This tool wants to access Review environment for the review workspace.",
      );
      await expect(
        approval.getByTestId("interaction-prompt-code"),
      ).toContainText("workspace.open@1 · write");
      await expect(
        approval.getByRole("button", { name: "Allow once", exact: true }),
      ).toBeVisible();
      await expect(
        approval.getByRole("button", { name: "Deny", exact: true }),
      ).toBeVisible();
      await capture(
        page,
        testInfo,
        "blocking-application-environment-approval-desktop.png",
      );
      await approval
        .getByRole("button", { name: "Allow once", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await applicationDecisionRecord(page, allowRequestId)).state,
        )
        .toBe("resolved");
      expect(
        (await applicationDecisionRecord(page, allowRequestId)).decision,
      ).toBe("allow");
      await expect(approval).toHaveCount(0);

      const denyRequestId = await openApplicationDecision(page, threadId);
      await expect(approval).toBeVisible();
      await approval.getByRole("button", { name: "Deny", exact: true }).click();
      await expect
        .poll(
          async () =>
            (await applicationDecisionRecord(page, denyRequestId)).state,
        )
        .toBe("resolved");
      expect(
        (await applicationDecisionRecord(page, denyRequestId)).decision,
      ).toBe("deny");
      await expect(approval).toHaveCount(0);

      const cancelledRequestId = await openApplicationDecision(page, threadId);
      await expect(approval).toBeVisible();
      expect(
        (
          await page.request.post(
            `/__e2e/interactions/cancel-application/${cancelledRequestId}`,
          )
        ).ok(),
      ).toBe(true);
      await expect
        .poll(
          async () =>
            (await applicationDecisionRecord(page, cancelledRequestId)).state,
        )
        .toBe("cancelled");
      await expect(approval).toHaveCount(0);
    } finally {
      expect(
        (await page.request.post("/__e2e/codex/turn-completion/release")).ok(),
      ).toBe(true);
    }
  });

  test("multi-question answers preserve Other notes, secrets, and unanswered drafts", async ({
    page,
  }, testInfo) => {
    codexThreadPath = await ensureImportedThread(page, codexThreadPath);
    const threadId = threadIdFromPath(codexThreadPath);
    await startCodexFixtureTurn(page, "Exercise the questionnaire takeover");
    const [requestId] = await openScenario(
      page,
      threadId,
      "questionnaire_full",
    );

    const dialog = page.getByRole("dialog", { name: "Questions" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId("questionnaire-progress")).toContainText(
      "Question 1 of 3",
    );
    await dialog.getByRole("radio", { name: /None of the above/ }).click();
    await dialog
      .getByRole("textbox", { name: "Note for Environment" })
      .fill("Use the isolated review environment");
    await dialog.getByRole("button", { name: /Next/ }).click();

    await expect(dialog.getByTestId("questionnaire-progress")).toContainText(
      "Question 2 of 3",
    );
    await dialog.getByRole("button", { name: /Next/ }).click();
    const secret = dialog.getByLabel("Enter the temporary secret.");
    await secret.fill(SECRET_FIXTURE_VALUE);
    await expect(secret).toHaveJSProperty("tagName", "TEXTAREA");
    await expect(secret).toHaveAttribute("data-masked", "true");
    await dialog.getByRole("button", { name: "Show response" }).click();
    await expect(secret).toHaveAttribute("data-masked", "false");
    await dialog.getByRole("button", { name: "Hide response" }).click();
    await expect(secret).toHaveAttribute("data-masked", "true");

    await dialog.getByRole("button", { name: /Submit answers/ }).click();
    const unanswered = dialog.getByRole("alertdialog", {
      name: "Submit unanswered questions?",
    });
    await expect(unanswered).toBeVisible();
    await capture(
      page,
      testInfo,
      "blocking-questionnaire-secret-unanswered-desktop.png",
    );
    await unanswered.getByRole("button", { name: "Go back" }).click();
    await expect(dialog.getByTestId("questionnaire-progress")).toContainText(
      "Question 2 of 3",
    );
    await dialog
      .getByRole("textbox", { name: "What should the agent keep in mind?" })
      .fill("Retain the current workspace settings");
    await dialog.getByRole("button", { name: /Next/ }).click();
    await expect(secret).toHaveValue(SECRET_FIXTURE_VALUE);
    await capture(page, testInfo, "blocking-questionnaire-choice-desktop.png");
    await dialog.getByRole("button", { name: /Submit answers/ }).click();

    await expect(dialog.getByTestId("interaction-pending")).toBeVisible();
    await expect
      .poll(async () => (await fixtureRecord(page, requestId)).state)
      .toBe("response_received");
    const serializedState = JSON.stringify(await interactionFixtureState(page));
    expect(serializedState).not.toContain(SECRET_FIXTURE_VALUE);
    expect((await fixtureRecord(page, requestId)).safeResponse).toEqual({
      kind: "questionnaire",
      answeredQuestionCount: 3,
      answerEntryCounts: [2, 1, 1],
    });
    await releaseInteraction(page, requestId);
    await expect(dialog).toHaveCount(0);
  });

  test("mixed queue advances without blocking the composer and recovers a proven failure", async ({
    browserDiagnostics,
    page,
  }, testInfo) => {
    codexThreadPath = await ensureImportedThread(page, codexThreadPath);
    const threadId = threadIdFromPath(codexThreadPath);
    await startCodexFixtureTurn(page, "Exercise the mixed interaction queue");
    const mixedRequestIds = await openScenario(
      page,
      threadId,
      "mixed_decision_questionnaire",
    );
    expect(mixedRequestIds).toHaveLength(2);
    const decisionId = mixedRequestIds[0];
    const questionnaireId = mixedRequestIds[1]!;

    const decision = page.getByRole("dialog", { name: "Command approval" });
    await expect(decision.getByLabel("Interaction 1 of 2")).toBeVisible();
    await decision.getByTestId("decision-primary-action").click();
    await expect
      .poll(async () => (await fixtureRecord(page, decisionId)).state)
      .toBe("response_received");
    await releaseInteraction(page, decisionId);

    const questionnaire = page.getByRole("dialog", {
      name: "Questions",
    });
    await expect(questionnaire).toBeVisible();
    await expect(page.getByTestId("interaction-queue-position")).toHaveCount(0);
    await expect(
      page.getByTestId("thread-presentation-content"),
    ).not.toHaveAttribute("inert");

    let failQuestionnaireOnce = true;
    await page.route(`**/api/threads/${threadId}/operations`, async (route) => {
      const body = route.request().postDataJSON() as {
        response?: { kind?: string };
      };
      if (failQuestionnaireOnce && body.response?.kind === "questionnaire") {
        failQuestionnaireOnce = false;
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: {
              code: "backend_rejected",
              message: "The fixture proved that the response was not applied.",
              retryable: true,
            },
          }),
        });
        return;
      }
      await route.continue();
    });
    await questionnaire
      .getByRole("textbox", {
        name: "Add context before the fixture continues.",
      })
      .fill("Retry this bounded response");
    browserDiagnostics.allowNetworkFailures = true;
    await questionnaire.getByRole("button", { name: /Submit answers/ }).click();
    await expect(questionnaire.getByTestId("interaction-error")).toContainText(
      "proved that the response was not applied",
    );
    await expect(
      questionnaire.getByRole("button", { name: /Submit answers/ }),
    ).toBeEnabled();
    expect((await fixtureRecord(page, questionnaireId)).state).toBe("pending");
    await capture(page, testInfo, "blocking-mixed-queue-error-desktop.png");
    browserDiagnostics.allowNetworkFailures = false;

    await questionnaire.getByRole("button", { name: "Dismiss" }).click();
    await questionnaire.getByRole("button", { name: /Submit answers/ }).click();
    await expect
      .poll(async () => (await fixtureRecord(page, questionnaireId)).state)
      .toBe("response_received");
    await capture(page, testInfo, "blocking-mixed-queue-pending-desktop.png");
    await releaseInteraction(page, questionnaireId);
    await expect(questionnaire).toHaveCount(0);
  });

  test("narrow questionnaire remains available after elapsed time", async ({
    page,
  }, testInfo) => {
    codexThreadPath = await ensureImportedThread(page, codexThreadPath);
    const threadId = threadIdFromPath(codexThreadPath);
    await startCodexFixtureTurn(page, "Exercise the durable questionnaire");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.clock.install({ time: Date.now() });
    const [requestId] = await openScenario(
      page,
      threadId,
      "questionnaire_durable",
    );
    const dialog = page.getByRole("dialog", { name: "Questions" });
    await expect(dialog).toBeVisible();

    await page.clock.fastForward(7 * 24 * 60 * 60 * 1_000);
    await expect(
      dialog.getByText(/expires|submits unanswered|expired/i),
    ).toHaveCount(0);
    expect((await fixtureRecord(page, requestId)).state).toBe("pending");
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.x).toBeGreaterThan(0);
    expect(dialogBox!.width).toBeLessThan(390);
    expect(dialogBox!.x).toBeCloseTo(9, 0);
    expect(dialogBox!.width).toBeCloseTo(372, 0);
    const composerCard = page.getByTestId("composer");
    const [dialogStyle, composerStyle] = await Promise.all([
      dialog.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          borderRadius: style.borderRadius,
          borderColors: [
            style.borderTopColor,
            style.borderRightColor,
            style.borderBottomColor,
            style.borderLeftColor,
          ],
          borderWidths: [
            style.borderTopWidth,
            style.borderRightWidth,
            style.borderBottomWidth,
            style.borderLeftWidth,
          ],
        };
      }),
      composerCard.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          backgroundColor: style.backgroundColor,
          borderRadius: style.borderRadius,
        };
      }),
    ]);
    expect(dialogStyle.backgroundColor).toBe(composerStyle.backgroundColor);
    expect(dialogStyle.borderRadius).toBe(composerStyle.borderRadius);
    expect([...new Set(dialogStyle.borderColors)]).toHaveLength(1);
    expect(dialogStyle.borderWidths).toEqual(["1px", "1px", "1px", "1px"]);
    for (const button of await dialog.getByRole("button").all()) {
      const box = await button.boundingBox();
      if (box) expect(box.height!).toBeGreaterThanOrEqual(44);
    }
    await capture(page, testInfo, "blocking-questionnaire-mobile-durable.png");

    await dialog
      .getByRole("textbox", {
        name: "Add context before the fixture continues.",
      })
      .fill("Answer after elapsed time");
    await dialog.getByRole("button", { name: /Submit answers/ }).click();
    await expect
      .poll(async () => (await fixtureRecord(page, requestId)).state)
      .toBe("response_received");
    await releaseInteraction(page, requestId);
    await expect(dialog).toHaveCount(0);
  });
});

async function openImportedCodexThread(page: Page): Promise<string> {
  await page.goto("/");
  await openSedesWorkspace(page);
  const row = page
    .getByTestId("desktop-sidebar")
    .getByTestId("thread-row-link")
    .filter({ hasText: importedCodexTitle });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
  return new URL(page.url()).pathname;
}

async function ensureImportedThread(
  page: Page,
  pathName: string,
): Promise<string> {
  if (!pathName) return openImportedCodexThread(page);
  await page.goto(pathName);
  await expect(
    page
      .getByTestId("composer")
      .getByRole("textbox", { name: /^Message Codex/ }),
  ).toBeVisible();
  return pathName;
}

async function startCodexFixtureTurn(page: Page, text: string): Promise<void> {
  const composer = page
    .getByTestId("composer")
    .getByRole("textbox", { name: /^Message Codex/ });
  const send = page.getByRole("button", { name: "Send message" });
  await expect(send).toBeVisible({ timeout: 10_000 });
  if (await send.isDisabled()) {
    const model = page
      .getByTestId("composer")
      .getByRole("combobox", { name: "Model" });
    await selectRadixOption(page, model, "GPT-5.6 Codex");
    await expect(model).toContainText("GPT-5.6 Codex");
  }
  await fillDraft(page, composer, text);
  await expect(send).toBeEnabled();
  const accepted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/operations") &&
      response.ok(),
  );
  await send.click();
  await accepted;
  await expect(
    page.getByRole("button", { name: "Stop", exact: true }),
  ).toBeVisible();
}

async function fillDraft(
  page: Page,
  composer: Locator,
  text: string,
): Promise<void> {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith("/draft") &&
      response.ok(),
  );
  await composer.fill(text);
  await saved;
}

async function openScenario(
  page: Page,
  threadId: string,
  scenario: InteractionScenario,
): Promise<readonly [number, ...number[]]> {
  const response = await page.request.post(
    `/__e2e/interactions/open/${threadId}/${scenario}`,
  );
  expect(response.status()).toBe(202);
  const result = (await response.json()) as {
    readonly requestIds: readonly number[];
  };
  expect(result.requestIds.length).toBeGreaterThan(0);
  return result.requestIds as readonly [number, ...number[]];
}

async function releaseInteraction(
  page: Page,
  requestId: number,
): Promise<void> {
  const response = await page.request.post(
    `/__e2e/interactions/release/${requestId}`,
  );
  expect(response.ok()).toBe(true);
}

async function openApplicationDecision(
  page: Page,
  threadId: string,
): Promise<number> {
  const response = await page.request.post(
    `/__e2e/interactions/open-application/${threadId}`,
  );
  expect(response.status()).toBe(202);
  const result = (await response.json()) as { readonly requestId: number };
  return result.requestId;
}

async function applicationDecisionRecord(
  page: Page,
  requestId: number,
): Promise<ApplicationDecisionFixtureRecord> {
  const response = await page.request.get(
    "/__e2e/interactions/application-state",
  );
  expect(response.ok()).toBe(true);
  const state = (await response.json()) as {
    readonly records: readonly ApplicationDecisionFixtureRecord[];
  };
  const record = state.records.find(
    (candidate) => candidate.requestId === requestId,
  );
  if (!record) {
    throw new Error(`e2e_application_decision_record_missing:${requestId}`);
  }
  return record;
}

async function interactionFixtureState(
  page: Page,
): Promise<{ readonly records: readonly InteractionFixtureRecord[] }> {
  const response = await page.request.get("/__e2e/interactions/state");
  expect(response.ok()).toBe(true);
  return response.json();
}

async function fixtureRecord(
  page: Page,
  requestId: number,
): Promise<InteractionFixtureRecord> {
  const record = (await interactionFixtureState(page)).records.find(
    (candidate) => candidate.requestId === requestId,
  );
  if (!record) throw new Error(`e2e_interaction_record_missing:${requestId}`);
  return record;
}

function threadIdFromPath(pathName: string): string {
  const id = pathName.split("/").at(-1);
  if (!id) throw new Error("e2e_thread_id_missing");
  return id;
}
