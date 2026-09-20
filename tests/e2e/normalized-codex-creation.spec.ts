import { test, expect } from "./fixtures";
import { normalizedThreadSnapshotSchema } from "../../src/shared/protocol/conversation.js";
import {
  openSettingsPage,
  returnFromSettings,
  capture,
  openSedesWorkspace,
  selectCustomNewThreadTarget,
} from "./helpers";

test.describe.serial("normalized Codex creation surfaces", () => {
  test("account settings reveal OpenAI composer skills across Codex", async ({
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

    await page.getByRole("button", { name: "Choose skill" }).click();
    let picker = page.getByRole("dialog", { name: "Choose a skill" });
    await expect(
      picker.getByText("Review Changes", { exact: true }),
    ).toBeVisible();
    await expect(
      picker.getByText("OpenAI Template", { exact: true }),
    ).toHaveCount(0);
    await expect(picker.getByText("OpenAI Sites", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      picker.getByText("OpenAI Visualize", { exact: true }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");

    await openSettingsPage(page, "general");
    const toggle = page.getByTestId("show-openai-composer-skills-toggle");
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute("data-state", "unchecked");
    const enabled = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith("/api/application/preferences") &&
        response.ok(),
    );
    await toggle.click();
    expect((await enabled).request().postDataJSON()).toEqual({
      showOpenAIComposerSkills: true,
      expectedRevision: 0,
    });
    await returnFromSettings(page);

    await page.getByRole("button", { name: "Choose skill" }).click();
    picker = page.getByRole("dialog", { name: "Choose a skill" });
    await expect(
      picker.getByText("OpenAI Template", { exact: true }),
    ).toBeVisible();
    await expect(
      picker.getByText("OpenAI Sites", { exact: true }),
    ).toBeVisible();
    await expect(
      picker.getByText("OpenAI Visualize", { exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");

    await openSettingsPage(page, "general");
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute("data-state", "checked");
    const disabled = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith("/api/application/preferences") &&
        response.ok(),
    );
    await toggle.click();
    expect((await disabled).request().postDataJSON()).toEqual({
      showOpenAIComposerSkills: false,
      expectedRevision: 1,
    });
    await returnFromSettings(page);
  });

  test("selects Fast on a Codex draft and carries it into first submission", async ({
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

    const fastOff = page.getByRole("button", {
      name: "Fast mode, off, pending",
    });
    await expect(fastOff).toBeVisible();
    const selected = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/operations") &&
        response.ok(),
    );
    await fastOff.click();
    await selected;
    await expect(
      page.getByRole("button", { name: "Fast mode, on, pending" }),
    ).toBeVisible();

    await page.reload();
    await expect(
      page.getByRole("button", { name: "Fast mode, on, pending" }),
    ).toBeVisible();

    const composer = page.getByRole("textbox", { name: /Message/ });
    const draftSaved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith("/draft") &&
        response.ok(),
    );
    await composer.fill("Start this Codex thread in Fast mode");
    await draftSaved;
    const submitted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/operations") &&
        response.ok(),
    );
    await page.getByRole("button", { name: "Send message" }).click();
    await submitted;
    await expect(
      page.locator(
        '[data-item-kind="assistant_message"][data-item-status="completed"]',
      ),
    ).toContainText(
      "Codex is streaming a browser-neutral normalized response.",
    );

    const stateResponse = await page.request.get("/__e2e/codex/state");
    expect(stateResponse.ok()).toBe(true);
    const state = (await stateResponse.json()) as {
      threadStarts: Array<{
        generation: number;
        serviceTier: string | null;
      }>;
    };
    expect(state.threadStarts.at(-1)).toEqual({
      generation: expect.any(Number),
      serviceTier: "priority",
    });
  });

  test("uncertain Codex creation is presented without automatic retry", async ({
    page,
  }, testInfo) => {
    await page.goto("/");
    await openSedesWorkspace(page);
    await page
      .getByTestId("desktop-sidebar")
      .getByTestId("new-thread-trigger")
      .click();
    await selectCustomNewThreadTarget(page, "Codex TCP external · Codex TCP");
    await page.getByRole("button", { name: "Create thread" }).click();
    await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);

    const composer = page.getByRole("textbox", { name: /Message/ });
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith("/draft") &&
        response.ok(),
    );
    await composer.fill("Exercise uncertain Codex creation presentation");
    await saved;
    const armed = await page.request.post(
      "/__e2e/codex/arm-create-outcome-unknown",
    );
    expect(armed.status()).toBe(204);
    const completed = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/operations") &&
        response.ok(),
    );
    await page.getByRole("button", { name: "Send message" }).click();
    await completed;
    // The uncertain response is durable even if the event stream and mutation
    // response race. Reload through the public snapshot boundary to prove the
    // recovery presentation survives reconnect.
    await page.reload();

    const recovery = page.getByRole("alert").filter({
      hasText: "Submission status needs attention.",
    });
    await expect(recovery).toBeVisible();
    await expect(recovery).toContainText("outcome is unknown");
    await expect(
      page.getByRole("heading", { name: "Thread creation needs attention" }),
    ).toBeVisible();
    const snapshotResponse = await page.request.get(
      `/api${new URL(page.url()).pathname}?activityDetail=full`,
    );
    const snapshot = normalizedThreadSnapshotSchema.parse(
      await snapshotResponse.json(),
    );
    expect(snapshot.thread.backingState).toBe("creation_unknown");
    expect(snapshot.recovery).toMatchObject({
      kind: "conversation_creation",
      phase: "recovery_required",
      submissionMayHaveBeenAccepted: false,
      recoverable: false,
    });
    await expect(
      recovery.getByRole("button", { name: "Resume submission" }),
    ).toHaveCount(0);
    await expect(
      page
        .getByTestId("composer")
        .getByText(/Current:|applies (?:on )?(?:the )?next turn/i),
    ).toHaveCount(0);
    await capture(page, testInfo, "codex-create-unknown.png");

    const quarantinedResponse = await page.request.get("/__e2e/codex/state");
    expect(quarantinedResponse.ok()).toBe(true);
    const quarantined = (await quarantinedResponse.json()) as {
      generation: number;
      ready: boolean;
      createFaultArmed: boolean;
      retirements: Array<{
        generation: number;
        reason: string;
        replacementGeneration: number;
        requestCountAtRetirement: number;
      }>;
      requestsAfterLastRetirement: Array<{
        method: string;
        generation: number;
      }>;
    };
    const retirement = quarantined.retirements.at(-1);
    if (!retirement) throw new Error("Codex generation was not retired");
    expect(retirement).toEqual({
      generation: expect.any(Number),
      reason: "codex_create_outcome_unknown",
      replacementGeneration: expect.any(Number),
      requestCountAtRetirement: expect.any(Number),
    });
    expect(retirement.replacementGeneration).toBeGreaterThan(
      retirement.generation,
    );
    expect(quarantined).toMatchObject({
      generation: retirement.replacementGeneration,
      ready: true,
      createFaultArmed: false,
    });
    expect(
      quarantined.requestsAfterLastRetirement.every(
        ({ generation }) => generation === retirement.replacementGeneration,
      ),
    ).toBe(true);
    expect(
      quarantined.requestsAfterLastRetirement.some(
        ({ method }) => method === "thread/start" || method === "turn/start",
      ),
    ).toBe(false);

    // Later Codex work must bind exclusively to the replacement generation.
    await page
      .getByTestId("desktop-sidebar")
      .getByTestId("new-thread-trigger")
      .click();
    await selectCustomNewThreadTarget(page, "Codex TCP external · Codex TCP");
    await page.getByRole("button", { name: "Create thread" }).click();
    await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
    const replacementComposer = page.getByRole("textbox", { name: /Message/ });
    const replacementDraftSaved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith("/draft") &&
        response.ok(),
    );
    await replacementComposer.fill("Prove Codex replacement generation work");
    await replacementDraftSaved;
    const replacementAccepted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/operations") &&
        response.ok(),
    );
    await page.getByRole("button", { name: "Send message" }).click();
    await replacementAccepted;
    await expect(
      page.locator(
        '[data-item-kind="assistant_message"][data-item-status="completed"]',
      ),
    ).toContainText(
      "Codex is streaming a browser-neutral normalized response.",
    );

    const replacementStateResponse =
      await page.request.get("/__e2e/codex/state");
    const replacementState = (await replacementStateResponse.json()) as {
      requestsAfterLastRetirement: Array<{
        method: string;
        generation: number;
      }>;
    };
    expect(replacementState.requestsAfterLastRetirement).toEqual(
      expect.arrayContaining([
        {
          method: "thread/start",
          generation: retirement.replacementGeneration,
        },
        {
          method: "turn/start",
          generation: retirement.replacementGeneration,
        },
      ]),
    );
    expect(
      replacementState.requestsAfterLastRetirement.every(
        ({ generation }) => generation === retirement.replacementGeneration,
      ),
    ).toBe(true);
  });
});
