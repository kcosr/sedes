import { test, expect } from "./fixtures";
import { normalizedThreadSnapshotSchema } from "../../src/shared/protocol/conversation.js";
import { respondToQuestionResultSchema } from "../../src/shared/protocol/api.js";
import {
  capture,
  expectNoPageOverflow,
  openSedesWorkspace,
  sendCurrentDraft,
  selectRadixOption,
} from "./helpers";

test("nonblocking questions navigate oldest first, send individual answers, and retain response styling", async ({
  page,
}, testInfo) => {
  await openSedesWorkspace(page);
  await page
    .getByTestId("desktop-sidebar")
    .getByTestId("thread-row-link")
    .filter({ hasText: "Imported Codex history" })
    .click();
  await expect(page).toHaveURL(/\/threads\/[0-9a-f-]+$/);
  const threadPath = new URL(page.url()).pathname;
  const threadId = threadPath.split("/").at(-1)!;
  const composer = page.getByRole("textbox", { name: /Message/ });
  await expect(composer).toBeFocused();
  await selectRadixOption(
    page,
    page.getByRole("combobox", { name: "Model", exact: true }),
    "GPT-5.6 Codex",
  );
  await expect(
    page.getByRole("combobox", { name: "Reasoning", exact: true }),
  ).toContainText(/low/i);
  const saveDraft = async (text: string) => {
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith("/draft") &&
        response.ok(),
    );
    await composer.fill(text);
    await saved;
  };
  const list = async () => {
    const response = await page.request.get(`/api${threadPath}/questions`);
    expect(response.ok()).toBe(true);
    return (await response.json()) as { requests: Array<{ id: string }> };
  };
  const armSteerMaterialization = async () => {
    expect(
      (await page.request.post(`/__e2e/codex/steer-materialization/arm/${threadId}`)).status(),
    ).toBe(204);
  };
  const releaseSteerMaterialization = async () => {
    await expect.poll(async () => {
      const response = await page.request.get("/__e2e/codex/steer-materialization/state");
      return (await response.json()).heldCount;
    }).toBe(1);
    expect(
      (await page.request.post("/__e2e/codex/steer-materialization/release")).status(),
    ).toBe(204);
  };
  const banner = page.getByTestId("question-attention");
  const panel = page.getByRole("region", {
    name: "Open questions",
    exact: true,
  });
  const questionTab = page.getByRole("button", {
    name: /^Open questions, \d+ pending$/,
  });
  // Imported native question history must not create an unsolicited inbox backlog.
  expect((await list()).requests).toEqual([]);
  await expect(banner).toHaveCount(0);
  await expect(questionTab).toHaveCount(0);
  expect(
    (await page.request.post("/__e2e/codex/turn-completion/arm")).status(),
  ).toBe(204);
  try {
    await saveDraft("Keep working while I consider your questions.");
    await sendCurrentDraft(page);
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    await composer.focus();
    expect(
      (await page.request.post(`/__e2e/codex/questions/${threadId}`)).status(),
    ).toBe(204);
    await expect.poll(async () => (await list()).requests.length).toBe(2);
    await expect(banner).toContainText("3 open questions");
    await expect(panel).toBeVisible();
    await expect(composer).toBeFocused();
    const requestRows = page.getByTestId("question-transcript-disclosure");
    const regionRequests = requestRows.filter({ hasText: "Which deployment region?" });
    const regionRequest = regionRequests.last();
    const noteRequest = requestRows.filter({ hasText: "Should I prepare a rollout note?" }).last();
    await expect(regionRequests.first()).toHaveAttribute("data-question-status", "unknown");
    await expect(regionRequest).toHaveAttribute("data-question-status", "pending");
    await expect(noteRequest.locator(".question-disclosure-count")).toHaveCount(0);
    await page.getByTestId("desktop-sidebar").getByTestId("view-options-trigger").click();
    await page.getByRole("radiogroup", { name: "Group by" }).getByRole("radio", { name: "State", exact: true }).click();
    await expect(page.getByTestId("desktop-sidebar").getByRole("button", { name: /^Needs attention/ })).toBeVisible();
    const cards = panel.locator("[data-question-request-id]");
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText("Which deployment region?");
    await expect(panel.getByRole("textbox")).toHaveCount(0);
    await expect(
      panel.getByRole("navigation", { name: "Question requests" }),
    ).toContainText("1 of 2");
    await expect(
      panel.getByRole("button", { name: "Previous question request" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    await capture(page, testInfo, "question-inbox-desktop-streaming.png");
    await expectNoPageOverflow(page);
    await page.keyboard.press("Escape");
    const sidebarQuestions = page.getByTestId("desktop-sidebar")
      .getByRole("button", { name: "3 unanswered questions", exact: true });
    await expect(sidebarQuestions).toBeVisible();
    await sidebarQuestions.hover();
    await expect(sidebarQuestions).toBeVisible();
    await sidebarQuestions.click();
    await expect(panel).toBeVisible();
    await panel.getByRole("button", { name: "Close questions" }).click();
    // An ordinary later message is independent of unresolved nonblocking questions.
    expect(
      (
        await page.request.post("/__e2e/codex/turn-completion/release")
      ).status(),
    ).toBe(204);
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeVisible();
    await composer.fill(
      "Continue with the inspection; I will answer separately.",
    );
    await sendCurrentDraft(page);
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeVisible();
    await expect.poll(async () => (await list()).requests.length).toBe(2);
    await expect(panel).toHaveCount(0);
    await page.getByRole("button", { name: "Thread actions" }).click();
    await page.getByTestId("thread-actions-menu")
      .getByRole("button", { name: "Archive", exact: true }).click();
    const archiveDialog = page.getByRole("dialog", { name: "Archive this thread" });
    await expect(archiveDialog).toContainText("3 unanswered questions");
    await capture(page, testInfo, "question-archive-confirmation.png");
    await archiveDialog.getByRole("button", { name: "Cancel", exact: true }).click();
    expect((await list()).requests).toHaveLength(2);
    await saveDraft("Keep this unrelated draft intact.");
    await page.getByTestId("desktop-sidebar").getByRole("button", { name: "More" }).click();
    await page.getByRole("menuitem", { name: "Archived threads" }).click();
    await expect(page).toHaveURL("/archived");
    await page.goBack();
    await expect(page).toHaveURL(threadPath);
    await expect(banner).toContainText("3 open questions");
    await expect(panel).toHaveCount(0);
    await page.reload();
    await expect(composer).toHaveValue("Keep this unrelated draft intact.");
    await expect(panel).toBeVisible();
    await expect(cards).toHaveCount(1);
    await expect(cards).toContainText("Which deployment region?");
    await expect(cards.getByRole("textbox")).toHaveCount(0);
    // Navigating retains an unfinished custom reply without sending it.
    await cards.getByRole("button", { name: "Other…", exact: true }).click();
    const regionAnswer = cards.getByRole("textbox", {
      name: "Answer: Which deployment region?",
    });
    await regionAnswer.fill("ap-southeast-2");
    await panel.getByRole("button", { name: "Next question request" }).click();
    await expect(cards).toContainText("Should I prepare a rollout note?");
    await expect(
      panel.getByRole("navigation", { name: "Question requests" }),
    ).toContainText("2 of 2");
    await panel
      .getByRole("button", { name: "Previous question request" })
      .click();
    await expect(regionAnswer).toHaveValue("ap-southeast-2");
    // A suggestion sends immediately; its unanswered batch sibling stays open.
    // Hold the new turn so the next answer deterministically takes the steer path.
    expect(
      (await page.request.post("/__e2e/codex/turn-completion/arm")).status(),
    ).toBe(204);
    let releaseReply!: () => void;
    const replyGate = new Promise<void>((resolve) => {
      releaseReply = resolve;
    });
    const replyRoute = `**${threadPath}/questions/*/respond`;
    await page.route(
      replyRoute,
      async (route) => {
        await replyGate;
        await route.continue();
      },
      { times: 1 },
    );
    try {
      await cards.getByRole("button", { name: "eu-west-1", exact: true }).click();
      const sending = page.locator("[data-pending-question-reply-id]");
      await expect(sending).toHaveCount(1);
      await expect(sending).toContainText("Question answered");
      await expect(sending).toContainText("Which deployment region?: eu-west-1");
      await expect(sending.getByRole("status")).toHaveText("Sending");
      await expect(sending).not.toContainText("User responded to a question:");
      await expect(composer).toHaveValue("Keep this unrelated draft intact.");
      await capture(page, testInfo, "question-reply-sending.png");
      await expectNoPageOverflow(page);
    } finally {
      releaseReply();
    }
    await expect(cards).not.toContainText("Which deployment region?");
    await expect(cards).toContainText("What should I keep in mind?");
    await expect(banner).toContainText("2 open questions");
    await expect(regionRequest).toHaveAttribute("data-question-status", "pending");
    await expect(regionRequest.locator(".question-disclosure-preview")).toHaveText("What should I keep in mind?");
    await expect(cards.getByRole("textbox")).toHaveCount(0);
    await expect(composer).toHaveValue("Keep this unrelated draft intact.");
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    await armSteerMaterialization();
    await cards
      .getByRole("button", { name: "Write an answer…", exact: true })
      .click();
    await cards
      .getByRole("textbox", { name: "Answer: What should I keep in mind?" })
      .fill("Keep the migration reversible.");
    await cards
      .getByRole("button", { name: "Send reply", exact: true })
      .click();
    await expect(cards).toContainText("Should I prepare a rollout note?");
    await expect(banner).toContainText("1 open question");
    await expect(questionTab).toHaveText("Question");
    await expect(regionRequest).toHaveAttribute("data-question-status", "answered");
    await expect(composer).toHaveValue("Keep this unrelated draft intact.");
    await releaseSteerMaterialization();
    await panel.getByRole("button", { name: "Close questions" }).click();
    const responses = page
      .locator('[data-message-role="user"] details')
      .filter({ hasText: "Question answered" });
    await expect(responses).toHaveCount(2);
    await expect(regionRequest).toHaveAttribute("data-question-status", "answered");
    await responses.first().locator("summary").click();
    await expect(responses.first()).toContainText("Which deployment region?");
    await expect(responses.first()).toContainText("eu-west-1");
    await expect(responses.first()).not.toContainText("ap-southeast-2");
    expect(
      (await page.request.post("/__e2e/codex/turn-completion/release")).status(),
    ).toBe(204);
    await expect(
      page.getByRole("button", { name: "Send message", exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(responses).toHaveCount(2);
    const snapshotResponse = await page.request.get(
      `/api${threadPath}?activityDetail=full`,
    );
    expect(snapshotResponse.ok()).toBe(true);
    const snapshot = normalizedThreadSnapshotSchema.parse(
      await snapshotResponse.json(),
    );
    const replyItems = Object.values(snapshot.itemsById).filter(
      (item) =>
        item.kind === "user_message" &&
        item.origin?.kind === "question_response",
    );
    expect(replyItems).toHaveLength(2);
    expect(
      replyItems.map((item) =>
        item.kind === "user_message"
          ? item.content
              .filter((part) => part.kind === "text")
              .map((part) => part.text.text)
              .join("\n")
          : "",
      ),
    ).toEqual(
      expect.arrayContaining([
        "User responded to a question:\nQuestion: Which deployment region?\nAnswer: eu-west-1",
        "User responded to a question:\nQuestion: What should I keep in mind?\nAnswer: Keep the migration reversible.",
      ]),
    );
    await responses.last().locator("summary").click();
    await expect(responses.last()).toContainText("What should I keep in mind?");
    await expect(responses.last()).toContainText(
      "Keep the migration reversible.",
    );
    await regionRequest.scrollIntoViewIfNeeded();
    await expect(regionRequest).toHaveAttribute("data-question-status", "answered");
    await capture(page, testInfo, "question-inline-resolved.png");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(panel).toBeVisible();
    await expect(cards).toHaveCount(1);
    await expect(cards.getByRole("textbox")).toHaveCount(0);
    await cards.getByRole("button", { name: "Other…", exact: true }).click();
    await expect(
      cards.getByRole("textbox", {
        name: "Answer: Should I prepare a rollout note?",
      }),
    ).toBeVisible();
    // The mobile panel shares the composer instead of opening a modal sheet.
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(composer).toBeVisible();
    await capture(page, testInfo, "question-inbox-mobile.png");
    await expectNoPageOverflow(page);
    await cards.getByRole("button", { name: "Dismiss", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(banner).toHaveCount(0);
    await expect(questionTab).toHaveCount(0);
    await expect.poll(async () => (await list()).requests.length).toBe(0);
    await expect(noteRequest).toHaveAttribute("data-question-status", "dismissed");
    await page.reload();
    await expect(banner).toHaveCount(0);
    await expect(questionTab).toHaveCount(0);
    await expect(responses).toHaveCount(2);
    await expect(noteRequest).toHaveAttribute("data-question-status", "dismissed");
    await expect(
      page
        .locator('[data-message-role="user"]')
        .filter({ hasText: "Should I prepare a rollout note?" }),
    ).toHaveCount(0);
    await expect(composer).toHaveValue("Keep this unrelated draft intact.");

    // A later turn must bring the hidden attention UI back without a reload.
    expect(
      (await page.request.post("/__e2e/codex/turn-completion/arm")).status(),
    ).toBe(204);
    await sendCurrentDraft(page);
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    expect(
      (await page.request.post(`/__e2e/codex/questions/${threadId}`)).status(),
    ).toBe(204);
    await expect(banner).toContainText("3 open questions");
    await expect(questionTab).toBeVisible();
    await expect(panel).toBeVisible();
    await expect(cards).toContainText("Which deployment region?");
    await expect(
      panel.getByRole("navigation", { name: "Question requests" }),
    ).toContainText("1 of 2");
    const activeReply = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes(`${threadPath}/questions/`) &&
        response.url().endsWith("/respond"),
    );
    await armSteerMaterialization();
    await cards.getByRole("button", { name: "us-east-1", exact: true }).click();
    const activeReplyResponse = await activeReply;
    expect(activeReplyResponse.ok()).toBe(true);
    const receipt = respondToQuestionResultSchema.parse(
      await activeReplyResponse.json(),
    );
    expect(receipt.queuedInput?.resolvedDeliveryMode).toBe("steer");
    await expect(banner).toContainText("2 open questions");
    await releaseSteerMaterialization();
    await expect(responses).toHaveCount(3);
    await expect(
      page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
  } finally {
    await page.request.post("/__e2e/codex/turn-completion/reset");
    await page.request.post("/__e2e/codex/steer-materialization/reset");
  }
});
