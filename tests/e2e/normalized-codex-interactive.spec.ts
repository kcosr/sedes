import path from "node:path";
import { test, expect } from "./fixtures";
import { normalizedThreadSnapshotSchema } from "../../src/shared/protocol/conversation.js";
import { capture, openSedesWorkspace, selectRadixOption } from "./helpers";

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

const CODEX_C2_OPERATION_IDS = new Set([
  "rename",
  "compact",
  "interrupt",
  "archive",
  "settle",
  "snooze",
  "acknowledge_attention",
  "recover_uncertain",
  "attach_automation",
]);

const repositoryDisplayName = path.basename(process.cwd());
const CODEX_ASYNC_QUESTION_FALLBACK =
  "Which deployment region?\n- us-east-1\n- eu-west-1\n\nWhat should I keep in mind?";

test.describe.serial("normalized interactive Codex projection", () => {
  test("interactive Pi and imported Codex streaming coexist", async ({
    page,
  }, testInfo) => {
    await page.goto("/");
    await openSedesWorkspace(page);

    const sidebar = page.getByTestId("desktop-sidebar");
    const importedTitle = `Imported Codex history — ${repositoryDisplayName}`;
    const renamedTitle = `Interactive Codex — ${repositoryDisplayName}`;
    await expect(
      sidebar.getByText(importedTitle, { exact: true }),
    ).toBeVisible();
    await expect(
      sidebar.getByText("New thread", { exact: true }).first(),
    ).toBeVisible();

    await sidebar.getByTestId("new-thread-trigger").click();
    const targetPicker = page.getByRole("combobox", {
      name: "Target",
      exact: true,
    });
    await targetPicker.click();
    await expect(page.getByRole("option")).toHaveCount(6);
    await expect(page.getByRole("option")).toHaveText([
      "Claude subscription · Claude",
      "Codex stdio owned · Codex stdio",
      "Codex TCP external · Codex TCP",
      "Codex UDS external · Codex UDS",
      "Alternate scripted agent · Pi SDK",
      "Pi SDK",
    ]);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Cancel" }).click();

    await sidebar
      .getByTestId("thread-row-link")
      .filter({ hasText: importedTitle })
      .click();
    await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
    const importedThreadPath = new URL(page.url()).pathname;
    const threadSnapshotResponse = await page.request.get(
      `/api${importedThreadPath}?activityDetail=full`,
    );
    expect(threadSnapshotResponse.ok()).toBe(true);
    const serializedThreadSnapshot = await threadSnapshotResponse.text();
    const threadSnapshot = normalizedThreadSnapshotSchema.parse(
      JSON.parse(serializedThreadSnapshot),
    );
    expect(
      threadSnapshot.capabilities.operations
        .map(({ id }) => id)
        .filter((id) => !CODEX_C2_OPERATION_IDS.has(id)),
    ).toEqual([]);
    expect(threadSnapshot.capabilities.settings.map(({ id }) => id)).toEqual([
      "model",
      "thinking_level",
    ]);
    const initialProviderFeatureIds =
      threadSnapshot.capabilities.providerFeatures.map(
        ({ ref }) => ref.featureId,
      );
    expect(initialProviderFeatureIds).toEqual(
      expect.arrayContaining(["codex.execution", "codex.tui"]),
    );
    expect(
      initialProviderFeatureIds.every((featureId) =>
        ["codex.execution", "codex.fast_mode", "codex.tui"].includes(featureId),
      ),
    ).toBe(true);
    expect(threadSnapshot.composerCommands).toEqual([]);
    await expect(
      page.getByRole("heading", { name: importedTitle }),
    ).toBeVisible();
    await expect(
      page
        .locator('[data-item-kind="user_message"]')
        .getByText(
          "Explain how this imported Codex conversation is preserved.",
          { exact: true },
        ),
    ).toBeVisible();
    const asyncQuestionItem = Object.values(threadSnapshot.itemsById).find(
      (item) =>
        item.kind === "assistant_message" &&
        item.nonblockingQuestions !== undefined,
    );
    expect(asyncQuestionItem).toMatchObject({
      kind: "assistant_message",
      markdown: { text: CODEX_ASYNC_QUESTION_FALLBACK },
    });
    const questionDisclosure = page.getByTestId(
      "question-transcript-disclosure",
    );
    await expect(questionDisclosure).toHaveCount(1);
    await questionDisclosure.locator("summary").click();
    await expect(questionDisclosure.locator("li")).toHaveText([
      "Which deployment region?",
      "What should I keep in mind?",
    ]);
    await expect(questionDisclosure.getByRole("textbox")).toHaveCount(0);
    await questionDisclosure.locator("summary").click();
    // Historical question payloads remain readable without resurrecting inbox work.
    const historicalInbox = await page.request.get(
      `/api${importedThreadPath}/questions`,
    );
    expect(historicalInbox.ok()).toBe(true);
    expect((await historicalInbox.json()).requests).toEqual([]);
    await expect(page.getByTestId("question-attention")).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^Open questions, \d+ pending$/ }),
    ).toHaveCount(0);
    const composer = page.getByRole("textbox", { name: /Message/ });
    await expect(composer).toBeVisible();
    const turnContainers = page.locator("[data-turn-id]");
    const ordinaryReply =
      "1. Which deployment region?\nus-west-2\n\n2. What should I keep in mind?\nKeep the migration reversible.";
    await composer.fill(ordinaryReply);
    await page
      .getByTestId("activity-group")
      .first()
      .getByRole("button", { name: /^Activity/ })
      .click();
    const mcpDetails = page.getByRole("button", { name: /inspect_history/ });
    await expect(mcpDetails).toBeVisible();
    await mcpDetails.click();
    await expect(
      page.getByText("Safe fixture result", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Sensitive value redacted", { exact: true }),
    ).toBeVisible();

    const browserHtml = await page.content();
    for (const forbidden of FORBIDDEN_CODEX_VALUES) {
      expect(serializedThreadSnapshot).not.toContain(forbidden);
      expect(browserHtml).not.toContain(forbidden);
      await expect(page.getByText(forbidden, { exact: false })).toHaveCount(0);
    }

    const titleButton = page
      .getByTestId("thread-heading")
      .getByRole("button", { name: importedTitle });
    await expect(titleButton).toBeEnabled();
    await titleButton.click();
    const titleInput = page.getByRole("textbox", { name: "Thread title" });
    await titleInput.fill(renamedTitle);
    await titleInput.press("Enter");
    await expect(
      page.getByRole("heading", { name: renamedTitle }),
    ).toBeVisible();

    // Thread settings render as composer pills on desktop (Phase 4); the
    // actions menu opens afterwards for the execution settings below.
    const threadConfiguration = page
      .getByTestId("composer")
      .getByTestId("thread-configuration");
    await expect(threadConfiguration).toHaveCount(1);
    await expect(threadConfiguration.getByRole("combobox")).toHaveCount(2);
    await expect(
      threadConfiguration.getByRole("combobox", { name: "Model" }),
    ).toBeVisible();
    await expect(
      threadConfiguration.getByRole("combobox", { name: "Reasoning" }),
    ).toBeVisible();
    const modelSetting = threadConfiguration.getByRole("combobox", {
      name: "Model",
    });
    if (!(await modelSetting.textContent())?.includes("GPT-5.6 Codex")) {
      const modelSelectionResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().endsWith("/operations") &&
          response.ok() &&
          response.request().postDataJSON().kind === "perform" &&
          response.request().postDataJSON().operation?.action ===
            "set_setting" &&
          response.request().postDataJSON().operation?.settingId === "model",
      );
      await selectRadixOption(page, modelSetting, "GPT-5.6 Codex");
      await modelSelectionResponse;
    }
    await expect(
      threadConfiguration.getByRole("combobox", { name: "Model" }),
    ).toContainText("GPT-5.6 Codex");
    await expect(
      threadConfiguration.getByRole("combobox", { name: "Reasoning" }),
    ).toContainText(/low/i);
    await page.getByRole("button", { name: "Thread actions" }).click();
    const desktopThreadControls = page.getByTestId("thread-controls");
    await expect(desktopThreadControls).toBeVisible();
    const executionSettings = page.getByLabel("Codex execution settings");
    await expect(executionSettings).toBeVisible();
    await expect(executionSettings.getByRole("combobox")).toHaveCount(4);
    await expect(
      executionSettings.getByRole("combobox", { name: "Sandbox" }),
    ).toContainText("Read only");
    await expect(
      executionSettings.getByRole("combobox", { name: "Network" }),
    ).toContainText("Disabled");
    await expect(
      executionSettings.getByRole("combobox", { name: "Approval policy" }),
    ).toContainText("Never");
    await expect(
      executionSettings.getByRole("combobox", { name: "Approval reviewer" }),
    ).toBeDisabled();
    await expect(
      threadConfiguration.getByText(
        /Current:|applies (?:on )?(?:the )?next turn/i,
      ),
    ).toHaveCount(0);
    const compact = page.getByRole("button", { name: "Compact context" });
    await expect(compact).toBeEnabled();
    await expect(page.getByRole("button", { name: "Automate…" })).toBeEnabled();
    await expect(page.getByText(/Approve/)).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Thread actions" }).click();
    await page.getByRole("button", { name: "Automate…" }).click();
    const automation = page.getByRole("dialog", {
      name: `Automation settings for ${renamedTitle}`,
    });
    await expect(automation).toBeVisible();
    await expect(
      automation.getByRole("radio", { name: /Continue in this thread/ }),
    ).toBeChecked();
    await expect(
      automation.getByRole("radio", {
        name: /Start a new cloned thread for each run/,
      }),
    ).toBeEnabled();
    await automation
      .getByRole("textbox", { name: "Canned prompt" })
      .fill("Review this thread on schedule");
    const saveAutomation = automation.getByRole("button", { name: "Save" });
    await expect(saveAutomation).toBeEnabled();
    await saveAutomation.click();
    await expect(automation.getByText("paused")).toBeVisible();
    await automation
      .getByRole("button", { name: "Close automation settings" })
      .click();
    const automationSettings = page.getByRole("button", {
      name: "Automation settings",
    });
    await expect(automationSettings).toBeVisible();
    await automationSettings.click();
    await expect(automation).toBeVisible();
    await expect(
      automation.getByRole("textbox", { name: "Canned prompt" }),
    ).toHaveValue("Review this thread on schedule");
    page.once("dialog", (dialog) => void dialog.accept());
    await automation.getByRole("button", { name: "Delete automation" }).click();
    await expect(automation).toBeHidden();
    await page.getByRole("button", { name: "Thread actions" }).click();
    await expect(page.getByRole("button", { name: "Automate…" })).toBeEnabled();
    await page.keyboard.press("Escape");

    await expect(composer).toBeVisible();
    const turnCountBeforeSend = await turnContainers.count();
    const submitMaterializationArmed = await page.request.post(
      "/__e2e/codex/submit-materialization/arm",
    );
    expect(submitMaterializationArmed.status()).toBe(204);
    // Keep the command and turn active until their streaming UI is inspected.
    const turnCompletionArmed = await page.request.post(
      "/__e2e/codex/turn-completion/arm",
    );
    expect(turnCompletionArmed.status()).toBe(204);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(turnContainers).toHaveCount(turnCountBeforeSend + 1);
    const stagedUserMessage = page
      .getByRole("region", { name: "Messages" })
      .locator('[data-message-role="user"]')
      .filter({ hasText: "Which deployment region?" });
    await expect(stagedUserMessage).toHaveCount(1);
    await expect(stagedUserMessage).toHaveAttribute(
      "data-client-provisional",
      "true",
    );
    await expect(stagedUserMessage).toContainText("us-west-2");
    await expect(stagedUserMessage).toContainText(
      "Keep the migration reversible.",
    );
    const submitMaterializationReleased = await page.request.post(
      "/__e2e/codex/submit-materialization/release",
    );
    expect(submitMaterializationReleased.status()).toBe(204);
    await expect(stagedUserMessage).not.toHaveAttribute(
      "data-client-provisional",
    );
    await expect(stagedUserMessage).toHaveCount(1);
    const submittedTurn = turnContainers.nth(turnCountBeforeSend);
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();
    const activityToggle = submittedTurn
      .getByTestId("activity-group")
      .getByRole("button", { name: /^Activity/ });
    await expect(activityToggle).toBeVisible();
    await activityToggle.click();
    const streamingCommand = submittedTurn.locator(
      '[data-item-kind="command"][data-item-status="streaming"]',
    );
    await expect(streamingCommand).toBeVisible();
    await streamingCommand.getByRole("button", { name: /Command/ }).click();
    await expect(streamingCommand).toContainText("Codex stream started");
    await expect(streamingCommand).toContainText(
      "Normalized Codex tool output",
    );
    await page.getByRole("button", { name: "Thread actions" }).click();
    const streamingExecutionSettings = page.getByLabel(
      "Codex execution settings",
    );
    await expect(streamingExecutionSettings.getByRole("combobox")).toHaveCount(
      4,
    );
    const approvalPolicy = streamingExecutionSettings.getByRole("combobox", {
      name: "Approval policy",
    });
    const streamingSnapshotResponse = await page.request.get(
      `/api${importedThreadPath}?activityDetail=full`,
    );
    expect(streamingSnapshotResponse.ok()).toBe(true);
    const streamingSnapshot = normalizedThreadSnapshotSchema.parse(
      await streamingSnapshotResponse.json(),
    );
    expect(streamingSnapshot.runState).toBe("running");
    expect(
      streamingSnapshot.capabilities.providerFeatures.find(
        ({ ref }) => ref.featureId === "codex.execution",
      ),
    ).toMatchObject({
      availability: "read_only",
      unavailableReason: {
        text: "This feature cannot change while the thread has active, queued, or uncertain work.",
      },
    });
    await expect(approvalPolicy).toBeDisabled();
    await expect(approvalPolicy).toContainText("Never");
    await expect(streamingCommand).toBeVisible();
    await capture(page, testInfo, "codex-normalized-streaming.png");
    await page.keyboard.press("Escape");
    const turnCompletionReleased = await page.request.post(
      "/__e2e/codex/turn-completion/release",
    );
    expect(turnCompletionReleased.status()).toBe(204);
    await expect(
      submittedTurn.locator(
        '[data-item-kind="command"][data-item-status="completed"]',
      ),
    ).toContainText("Normalized Codex tool output");
    await expect(
      submittedTurn.locator(
        '[data-item-kind="assistant_message"][data-item-status="completed"]',
      ),
    ).toContainText(
      "Codex is streaming a browser-neutral normalized response.",
    );
    await expect
      .poll(async () => {
        const response = await page.request.get(
          `/api${importedThreadPath}?activityDetail=full`,
        );
        expect(response.ok()).toBe(true);
        return normalizedThreadSnapshotSchema
          .parse(await response.json())
          .capabilities.providerFeatures.map(({ ref }) => ref.featureId);
      })
      .toEqual(["codex.execution", "codex.fast_mode", "codex.tui"]);
    await expect(
      page.getByRole("button", { name: "Send message" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Automation settings" }),
    ).toHaveCount(0);
    await page.getByRole("button", { name: "Thread actions" }).click();
    await expect(approvalPolicy).toBeEnabled();
    const approvalChanged = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/operations") &&
        response.ok() &&
        response.request().postDataJSON().operation?.actionId ===
          "set_approval_on_request",
    );
    await selectRadixOption(page, approvalPolicy, "On request");
    await approvalChanged;
    await expect(approvalPolicy).toContainText("On request");
    const approvalRestored = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/operations") &&
        response.ok() &&
        response.request().postDataJSON().operation?.actionId ===
          "set_approval_never",
    );
    await selectRadixOption(page, approvalPolicy, "Never");
    await approvalRestored;
    await expect(approvalPolicy).toContainText("Never");
    await expect(
      page.getByRole("button", { name: "Compact context" }),
    ).toBeEnabled();
    await expect(page.getByRole("button", { name: "Automate…" })).toBeEnabled();
    await page.keyboard.press("Escape");
    await capture(page, testInfo, "mixed-backend-interactive-codex.png");
  });
});
