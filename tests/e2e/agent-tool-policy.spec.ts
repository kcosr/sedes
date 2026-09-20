import { randomUUID } from "node:crypto";
import { test, expect } from "./fixtures";
import { normalizedThreadSnapshotSchema } from "../../src/shared/protocol/conversation.js";
import {
  openSettingsPage,
  capture,
  createDraftThread,
  expectNoPageOverflow,
  fillAndPersistDraft,
  openSedesWorkspace,
  selectRadixOption,
  sendCurrentDraft,
} from "./helpers";

test.describe.serial("agent tool policy", () => {
  let threadPath = "";

  test("saves one idle Pi policy and converges across clients", async ({
    browser,
    page,
  }, testInfo) => {
    await openSedesWorkspace(page);
    threadPath = await createDraftThread(page);

    const secondPage = await browser.newPage();
    await secondPage.goto(threadPath);
    await expect(
      secondPage.getByRole("textbox", { name: "Message Scripted agent" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Thread actions" }).click();
    const agentToolsRow = page.getByRole("button", {
      name: /Agent tools…\s*Off/,
    });
    const [labelBounds, summaryBounds] = await Promise.all([
      agentToolsRow.locator(".agent-tool-menu-label").boundingBox(),
      agentToolsRow.locator(".agent-tool-menu-summary").boundingBox(),
    ]);
    expect(labelBounds).not.toBeNull();
    expect(summaryBounds).not.toBeNull();
    expect(summaryBounds!.y).toBeGreaterThanOrEqual(
      labelBounds!.y + labelBounds!.height,
    );
    await agentToolsRow.click();
    const settings = page.getByRole("dialog", { name: "Agent tools" });
    await expect(settings).toBeVisible();
    await expect(
      settings.getByRole("checkbox", { name: "Enable agent tools" }),
    ).not.toBeChecked();
    await expect(
      settings.getByRole("combobox", { name: "Agent tool surface" }),
    ).toContainText("Native tools");
    await expect(
      settings.getByRole("combobox", { name: "Agent tool presentation" }),
    ).toContainText("Progressive");
    await expect(
      settings.getByRole("combobox", {
        name: "Access boundary",
      }),
    ).toContainText("Ask outside this environment");
    await expect(
      settings.getByRole("checkbox", { name: "Agent context" }),
    ).toBeEnabled();
    await capture(page, testInfo, "agent-tools-idle.png");

    await secondPage.getByRole("button", { name: "Thread actions" }).click();
    await secondPage
      .getByRole("button", { name: /Agent tools…\s*Off/ })
      .click();
    const secondSettings = secondPage.getByRole("dialog", {
      name: "Agent tools",
    });
    await expect(secondSettings).toBeVisible();

    let policyMutationCount = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith("/operations") &&
        request.postDataJSON()?.kind === "set_agent_tool_policy"
      ) {
        policyMutationCount += 1;
      }
    });

    await settings
      .getByRole("checkbox", { name: "Enable agent tools" })
      .click();
    await settings.getByRole("checkbox", { name: "Agent context" }).click();
    await selectRadixOption(
      page,
      settings.getByRole("combobox", {
        name: "Access boundary",
      }),
      /^Allow without asking/,
    );
    const accessBoundary = settings.getByRole("combobox", {
      name: "Access boundary",
    });
    await accessBoundary.click();
    await expect(
      page.getByText(
        "Enabled Sedes tools may read or change any principal-owned environment without a Sedes environment prompt.",
      ),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(accessBoundary).toContainText(
      "Allow without asking",
    );
    await selectRadixOption(
      page,
      settings.getByRole("combobox", { name: "Agent tool surface" }),
      "Sedes CLI",
    );
    await selectRadixOption(
      page,
      settings.getByRole("combobox", { name: "Agent tool surface" }),
      "Native tools",
    );
    expect(policyMutationCount).toBe(0);

    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings).toContainText(
      "The next turn may miss prompt cache and cost more.",
    );

    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/operations") &&
        response.ok() &&
        response.request().postDataJSON()?.kind === "set_agent_tool_policy",
    );
    await settings.getByRole("button", { name: "Save changes" }).click();
    const savedResponse = await saved;
    expect(savedResponse.request().postDataJSON()).toMatchObject({
      kind: "set_agent_tool_policy",
      enabled: true,
      enabledToolIds: ["agent.context"],
      presentation: { surface: "native", mode: "progressive" },
      accessBoundary: "unrestricted",
    });
    expect(policyMutationCount).toBe(1);

    await expect(
      secondSettings.getByRole("checkbox", { name: "Enable agent tools" }),
    ).toBeChecked();
    await expect(
      secondSettings.getByRole("checkbox", { name: "Agent context" }),
    ).toBeChecked();
    await secondSettings.getByRole("button", { name: "Threads" }).click();
    await expect(
      secondSettings.getByRole("checkbox", { name: "Thread status" }),
    ).not.toBeChecked();
    await expect(
      secondSettings.getByRole("combobox", {
        name: "Agent tool presentation",
      }),
    ).toContainText("Progressive");
    await expect(
      secondSettings.getByRole("combobox", {
        name: "Access boundary",
      }),
    ).toContainText("Allow without asking");

    await page.reload();
    await page.getByRole("button", { name: "Thread actions" }).click();
    const persistedSummary = page.getByRole("button", {
      name: /Agent tools…\s*1 enabled · Allow without asking/,
    });
    await expect(persistedSummary).toBeVisible();
    await persistedSummary.click();
    const reloadedSettings = page.getByRole("dialog", { name: "Agent tools" });
    await expect(
      reloadedSettings.getByRole("checkbox", { name: "Enable agent tools" }),
    ).toBeChecked();
    await expect(
      reloadedSettings.getByRole("checkbox", { name: "Agent context" }),
    ).toBeChecked();
    await expect(
      reloadedSettings.getByRole("combobox", {
        name: "Agent tool presentation",
      }),
    ).toContainText("Progressive");
    await expect(
      reloadedSettings.getByRole("combobox", {
        name: "Access boundary",
      }),
    ).toContainText("Allow without asking");
    await secondPage.close();
  });

  test("disables controls and rejects direct policy mutation in flight", async ({
    page,
  }, testInfo) => {
    await page.goto(threadPath);
    await fillAndPersistDraft(
      page,
      "Hold agent tools steady while this turn runs",
    );
    await sendCurrentDraft(page);
    await expect(page.getByRole("button", { name: "Stop" })).toBeVisible();

    await page.getByRole("button", { name: "Thread actions" }).click();
    await page.getByRole("button", { name: /Agent tools…/ }).click();
    const settings = page.getByRole("dialog", { name: "Agent tools" });
    await expect(settings).toBeVisible();
    await expect(
      settings.getByRole("checkbox", { name: "Enable agent tools" }),
    ).toBeDisabled();
    await expect(
      settings.getByRole("combobox", { name: "Agent tool surface" }),
    ).toBeDisabled();
    await expect(
      settings.getByRole("combobox", { name: "Agent tool presentation" }),
    ).toBeDisabled();
    await expect(
      settings.getByRole("combobox", {
        name: "Access boundary",
      }),
    ).toBeDisabled();
    await expect(settings.getByRole("button", { name: "Save" })).toBeDisabled();
    await expect(settings).toContainText(
      "Agent tools can be changed when the thread is idle.",
    );
    await capture(page, testInfo, "agent-tools-in-flight.png");

    const threadId = threadPath.split("/").at(-1);
    expect(threadId).toBeTruthy();
    const [sessionResponse, snapshotResponse] = await Promise.all([
      page.request.get("/api/application/session"),
      page.request.get(`/api/threads/${threadId}?activityDetail=full`),
    ]);
    expect(sessionResponse.ok()).toBe(true);
    expect(snapshotResponse.ok()).toBe(true);
    const session = (await sessionResponse.json()) as { csrfToken: string };
    const snapshot = normalizedThreadSnapshotSchema.parse(
      await snapshotResponse.json(),
    );
    const mutationResponse = await page.request.post(
      `/api/threads/${threadId}/operations`,
      {
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": session.csrfToken,
        },
        data: {
          kind: "set_agent_tool_policy",
          mutationId: randomUUID(),
          expectedPolicyRevision: snapshot.agentTools.revision,
          enabled: false,
          enabledToolIds: [],
          presentation: { surface: "native", mode: "progressive" },
          accessBoundary: snapshot.agentTools.accessBoundary,
        },
      },
    );
    expect(mutationResponse.status()).toBe(400);
    expect(await mutationResponse.json()).toMatchObject({
      error: {
        code: "invalid_transition",
        message:
          "Agent tool exposure can change only while the thread is idle.",
        retryable: false,
      },
    });

    await page.keyboard.press("Escape");
    await expect(
      page.locator(
        '[data-item-kind="assistant_message"][data-item-status="completed"]',
      ),
    ).toBeVisible({ timeout: 20_000 });
  });

  test("changes CLI access during a turn without interrupting it and converges across clients", async ({
    browser,
    page,
  }, testInfo) => {
    await openSedesWorkspace(page);
    const cliThreadPath = await createDraftThread(page);
    const threadId = cliThreadPath.split("/").at(-1)!;
    const settings = page.getByRole("dialog", { name: "Agent tools" });
    const openSettings = async () => {
      await page.getByRole("button", { name: "Thread actions" }).click();
      await page.getByRole("button", { name: /Agent tools…/ }).click();
      await expect(settings).toBeVisible();
    };
    const saveSettings = async () => {
      const [saved] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === "POST" &&
            response.url().endsWith("/operations") &&
            response.request().postDataJSON()?.kind === "set_agent_tool_policy",
          { timeout: 10_000 },
        ),
        settings.getByRole("button", { name: "Save", exact: true }).click(),
      ]);
      expect(saved.ok()).toBe(true);
      await expect(settings).toBeHidden();
    };
    await openSettings();
    await selectRadixOption(
      page,
      settings.getByRole("combobox", { name: "Agent tool surface" }),
      "Sedes CLI",
    );
    await saveSettings();

    const secondPage = await browser.newPage();
    await secondPage.goto(cliThreadPath);
    await expect(secondPage.getByRole("textbox", { name: "Message Scripted agent" })).toBeVisible();
    await secondPage.getByRole("button", { name: "Thread actions" }).click();
    await secondPage.getByRole("button", { name: /Agent tools…/ }).click();
    const secondSettings = secondPage.getByRole("dialog", { name: "Agent tools" });
    await expect(secondSettings).toBeVisible();

    expect((await page.request.post("/__e2e/pi/turn-response/arm")).ok()).toBe(true);
    await fillAndPersistDraft(page, "Keep running while CLI permissions change");
    await sendCurrentDraft(page);
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
    try {
      await openSettings();
      await expect(settings.getByRole("checkbox", { name: "Enable agent tools" })).toBeEnabled();
      await expect(settings.getByRole("combobox", { name: "Agent tool surface" })).toBeDisabled();
      await expect(settings.getByRole("combobox", { name: "Agent tool presentation" })).toBeDisabled();
      await settings.getByRole("checkbox", { name: "Enable agent tools" }).check();
      await settings.getByRole("checkbox", { name: "Agent context" }).check();
      await capture(page, testInfo, "agent-tools-cli-in-flight.png");
      await saveSettings();
      await expect(secondSettings.getByRole("checkbox", { name: "Enable agent tools" })).toBeChecked();
      await expect(secondSettings.getByRole("checkbox", { name: "Agent context" })).toBeChecked();

      await openSettings();
      await settings.getByRole("checkbox", { name: "Agent context" }).uncheck();
      await settings.getByRole("button", { name: "Threads", exact: true }).click();
      await settings.getByRole("checkbox", { name: "Thread status" }).check();
      await saveSettings();
      await expect(secondSettings.getByRole("checkbox", { name: "Agent context" })).not.toBeChecked();
      await secondSettings.getByRole("button", { name: "Threads", exact: true }).click();
      await expect(secondSettings.getByRole("checkbox", { name: "Thread status" })).toBeChecked();

      await openSettings();
      await settings.getByRole("checkbox", { name: "Enable agent tools" }).uncheck();
      await saveSettings();
      await expect(secondSettings.getByRole("checkbox", { name: "Enable agent tools" })).not.toBeChecked();
      await openSettings();
      await settings.getByRole("checkbox", { name: "Enable agent tools" }).check();
      await saveSettings();
      await expect(secondSettings.getByRole("checkbox", { name: "Enable agent tools" })).toBeChecked();

      const session = await (await page.request.get("/api/application/session")).json() as { csrfToken: string };
      const snapshot = normalizedThreadSnapshotSchema.parse(
        await (await page.request.get(`/api/threads/${threadId}?activityDetail=full`)).json(),
      );
      for (const presentation of [
        { surface: "native", mode: "progressive" },
        { surface: "cli", mode: "individual" },
      ]) {
        const rejected = await page.request.post(`/api/threads/${threadId}/operations`, {
          headers: { "X-CSRF-Token": session.csrfToken },
          data: {
            kind: "set_agent_tool_policy",
            mutationId: randomUUID(),
            expectedPolicyRevision: snapshot.agentTools.revision,
            enabled: snapshot.agentTools.enabled,
            enabledToolIds: snapshot.agentTools.groups.flatMap((group) =>
              group.tools.filter((tool) => tool.enabled).map((tool) => tool.id),
            ),
            accessBoundary: snapshot.agentTools.accessBoundary,
            presentation,
          },
        });
        expect(rejected.status()).toBe(400);
        expect(await rejected.json()).toMatchObject({ error: { code: "invalid_transition" } });
      }
      await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
      await expect(page.locator('[data-item-kind="assistant_message"][data-item-status="completed"]')).toHaveCount(0);
    } finally {
      expect((await page.request.post("/__e2e/pi/turn-response/release")).ok()).toBe(true);
      await secondPage.close();
    }
    await expect(page.locator('[data-item-kind="assistant_message"][data-item-status="streaming"]')).toBeVisible({ timeout: 20_000 });
    await capture(page, testInfo, "agent-tools-cli-streaming-after-changes.png");
    await expect(page.locator('[data-item-kind="assistant_message"][data-item-status="completed"]')).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeHidden();
  });

  test("keeps grouped settings and confirmation actions usable in short mobile landscape", async ({
    page,
  }, testInfo) => {
    await openSedesWorkspace(page);
    await createDraftThread(page);
    await page.setViewportSize({ width: 390, height: 430 });
    await page.getByRole("button", { name: "Thread actions" }).click();
    await page.getByRole("button", { name: /Agent tools…/ }).click();

    const settings = page.getByRole("dialog", { name: "Agent tools" });
    await expect(settings).toBeVisible();
    await settings
      .getByRole("checkbox", { name: "Enable agent tools" })
      .click();
    const accessBoundary = settings.getByRole("combobox", {
      name: "Access boundary",
    });
    await accessBoundary.scrollIntoViewIfNeeded();
    await expect(
      accessBoundary,
    ).toBeInViewport();
    await settings.getByRole("button", { name: "Automations" }).click();
    await expect(
      settings.getByRole("checkbox", {
        name: "Run automation now (starts model work)",
      }),
    ).toBeVisible();
    await settings
      .getByRole("checkbox", { name: "Run automation now (starts model work)" })
      .click();
    const save = settings.getByRole("button", { name: "Save", exact: true });
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeVisible();
    await save.click();
    const confirm = settings.getByRole("button", { name: "Save changes" });
    await confirm.scrollIntoViewIfNeeded();
    await expect(confirm).toBeVisible();
    await expect(confirm).toBeFocused();

    const bounds = await settings.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(430);
    await capture(page, testInfo, "agent-tools-mobile.png");
  });

  test("creates, masks, rotates, disables, and revokes a principal Tool client", async ({
    page,
  }, testInfo) => {
    await openSedesWorkspace(page);
    await openSettingsPage(page, "tool_clients");
    const settings = page.getByTestId("settings-view");
    await expect(
      settings.getByRole("heading", { name: "Tool clients" }),
    ).toBeVisible();
    await settings.getByRole("button", { name: "New client" }).click();
    await settings.getByLabel("Tool client name").fill("E2E external CLI");
    await settings.getByRole("checkbox", { name: "Thread status" }).click();

    const createdResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/tool-clients") &&
        response.status() === 201,
    );
    await settings.getByRole("button", { name: "Create client" }).click();
    const created = (await createdResponse).json() as Promise<{
      readonly credential: string;
    }>;
    const issuedCredential = (await created).credential;
    expect(issuedCredential).toMatch(/^hatc1_/u);

    const credentialDialog = page.getByRole("dialog", {
      name: "Save this credential now",
    });
    await expect(credentialDialog).toBeVisible();
    await expect(credentialDialog).not.toContainText(issuedCredential);
    await expect(credentialDialog.getByText(/hatc1_••/u)).toBeVisible();
    await capture(page, testInfo, "tool-client-credential-masked.png");

    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoPageOverflow(page);
    const mobileBounds = await credentialDialog.boundingBox();
    expect(mobileBounds).not.toBeNull();
    expect(mobileBounds!.x).toBeGreaterThanOrEqual(0);
    expect(mobileBounds!.x + mobileBounds!.width).toBeLessThanOrEqual(390);
    await capture(page, testInfo, "tool-client-credential-mobile-masked.png");
    await page.setViewportSize({ width: 1280, height: 720 });

    await credentialDialog
      .getByRole("checkbox", {
        name: "Acknowledge cleartext credential risk",
      })
      .check();
    await credentialDialog
      .getByRole("button", { name: "I saved it — close" })
      .click();
    await expect(credentialDialog).toHaveCount(0);

    const enabled = settings.getByRole("checkbox", {
      name: "Enable tool client",
    });
    await expect(enabled).toBeChecked();
    await enabled.click();
    const disabledResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        /\/api\/tool-clients\/[0-9a-f-]+$/u.test(response.url()) &&
        response.ok(),
    );
    await settings.getByRole("button", { name: "Save" }).click();
    await disabledResponse;
    await expect(
      settings.getByRole("button", { name: /E2E external CLI Disabled/u }),
    ).toBeVisible();

    await settings.getByRole("button", { name: "Rotate credential" }).click();
    const rotateConfirmation = page.getByRole("dialog", {
      name: "Rotate credential?",
    });
    const rotatedResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/rotate") &&
        response.ok(),
    );
    await rotateConfirmation
      .getByRole("button", { name: "Rotate credential" })
      .click();
    const rotated = (await rotatedResponse).json() as Promise<{
      readonly credential: string;
    }>;
    const rotatedCredential = (await rotated).credential;
    const rotatedDialog = page.getByRole("dialog", {
      name: "Save this credential now",
    });
    await expect(rotatedDialog).not.toContainText(rotatedCredential);
    await rotatedDialog
      .getByRole("checkbox", {
        name: "Acknowledge cleartext credential risk",
      })
      .check();
    await rotatedDialog
      .getByRole("button", { name: "I saved it — close" })
      .click();

    await settings.getByRole("button", { name: "Revoke" }).click();
    const revokeConfirmation = page.getByRole("dialog", {
      name: "Revoke tool client?",
    });
    const revokedResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/revoke") &&
        response.ok(),
    );
    await revokeConfirmation
      .getByRole("button", { name: "Revoke permanently" })
      .click();
    await revokedResponse;
    await expect(
      settings.getByRole("button", { name: /E2E external CLI Revoked/u }),
    ).toBeVisible();
  });
});
