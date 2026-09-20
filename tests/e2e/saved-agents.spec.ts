import { test, expect } from "./fixtures";
import { normalizedThreadSnapshotSchema } from "../../src/shared/protocol/conversation.js";
import {
  capture,
  expectNoPageOverflow,
  openSedesWorkspace,
  repositoryLabel,
  selectProjectIfNeeded,
  selectRadixOption,
} from "./helpers";

test.describe.serial("Saved Agents and thread bootstrap", () => {
  let agentId = "";
  let threadPath = "";

  test.afterEach(async ({ page }) => {
    const reset = await page.request.post(
      "/__e2e/saved-agents/pi-targets/reset",
    );
    expect(reset.status()).toBe(204);
  });

  test("creates and edits a complete Agent in the responsive management UI", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openSedesWorkspace(page);
    await page
      .getByTestId("desktop-sidebar")
      .getByRole("button", { name: "More" })
      .click();
    await page.getByRole("menuitem", { name: "Agents", exact: true }).click();
    await expect(page).toHaveURL("/agents");
    await expect(page.getByText("No Agents yet.")).toBeVisible();
    await page.getByRole("button", { name: "Create Agent" }).click();
    await expect(page).toHaveURL("/agents/new");

    await page.getByRole("textbox", { name: "Name" }).fill("Careful reviewer");
    await page
      .getByRole("textbox", { name: "Description" })
      .fill("Reviews changes with explicit reasoning and bounded tools.");
    await selectProjectIfNeeded(page, repositoryLabel);
    await selectRadixOption(
      page,
      page.getByRole("combobox", { name: "Configure using" }),
      "Pi SDK",
    );

    const overrideModel = page.getByRole("checkbox", {
      name: "Override Model",
    });
    await expect(overrideModel).toBeEnabled();
    await overrideModel.click();
    await expect(page.getByRole("combobox", { name: "Model" })).toContainText(
      "Conformance model",
    );

    const overrideThinking = page.getByRole("checkbox", {
      name: "Override Thinking",
    });
    await expect(overrideThinking).toBeEnabled();
    await overrideThinking.click();
    await selectRadixOption(
      page,
      page.getByRole("combobox", { name: "Thinking" }),
      /^High$/,
    );

    const overrideToolAccess = page.getByRole("checkbox", {
      name: "Override Tool access",
    });
    await expect(overrideToolAccess).toBeEnabled();
    await overrideToolAccess.click();
    await selectRadixOption(
      page,
      page.getByRole("combobox", { name: "Tool access" }),
      "Ask before changes",
    );

    const useDefaultTools = page.getByRole("checkbox", {
      name: "Use default tool policy",
    });
    await expect(useDefaultTools).toBeEnabled();
    await useDefaultTools.click();
    const enableTools = page.getByRole("checkbox", {
      name: "Enable Sedes tools",
    });
    await expect(enableTools).toBeEnabled();
    await enableTools.click();
    const agentContext = page.getByRole("checkbox", { name: "Agent context" });
    await expect(agentContext).toBeEnabled();
    await agentContext.click();
    await selectRadixOption(
      page,
      page.getByRole("combobox", {
        name: "Access boundary",
      }),
      "Allow without asking",
    );
    await expect(page.getByRole("status")).toContainText(
      "Threads created from this Agent may use enabled Sedes tools in other environments without asking",
    );

    const variables = page.getByRole("region", { name: "Agent environment variables" });
    await variables.getByRole("button", { name: "Add variable" }).click();
    await variables.getByLabel("New variable name", { exact: true }).fill("CI");
    await variables.getByLabel("Value for new variable", { exact: true }).fill("true");
    await variables.getByRole("button", { name: "Add", exact: true }).click();
    await expect(variables.getByLabel("Value for CI", { exact: true })).toHaveValue("true");

    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/agents") &&
        response.status() === 201,
    );
    await page.getByRole("button", { name: "Create Agent" }).click();
    const createResponse = await created;
    const createBody = createResponse.request().postDataJSON();
    expect(createBody).toMatchObject({
      name: "Careful reviewer",
      environmentVariables: { CI: { kind: "literal", value: "true" } },
      backendOverrides: [
        { id: "model" },
        { id: "thinking_level", value: "high" },
        { id: "tool_access", value: "ask" },
      ],
      sedesTools: {
        enabled: true,
        enabledToolIds: ["agent.context"],
        presentation: { surface: "native", mode: "progressive" },
        accessBoundary: "unrestricted",
      },
    });
    const createdAgent = (await createResponse.json()) as {
      agent: { id: string };
    };
    agentId = createdAgent.agent.id;
    await expect(page).toHaveURL(`/agents/${agentId}`);
    await expect(
      page.getByRole("heading", { name: "Careful reviewer" }),
    ).toBeVisible();
    await selectRadixOption(
      page,
      page.getByRole("combobox", { name: "Configure using" }),
      "Pi SDK",
    );
    await expect(
      page.getByRole("combobox", {
        name: "Access boundary",
      }),
    ).toContainText("Allow without asking");
    await expect(
      page.getByRole("button", {
        name: /Careful reviewer.*1 enabled · Allow without asking/,
      }),
    ).toBeVisible();
    await capture(page, testInfo, "saved-agent-editor-desktop.png");

    const name = page.getByRole("textbox", { name: "Name" });
    await name.fill("Careful reviewer updated");
    const updated = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/api/agents/${agentId}`) &&
        response.ok(),
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await updated;
    await expect(
      page.getByRole("heading", { name: "Careful reviewer updated" }),
    ).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoPageOverflow(page);
    await capture(page, testInfo, "saved-agent-editor-mobile.png");
    await page.setViewportSize({ width: 390, height: 430 });
    await expectNoPageOverflow(page);
    const cancel = page.getByRole("button", { name: "Cancel", exact: true });
    const save = page.getByRole("button", { name: "Save", exact: true });
    await cancel.scrollIntoViewIfNeeded();
    await expect(cancel).toBeInViewport();
    await expect(save).toBeInViewport();
    await capture(page, testInfo, "saved-agent-editor-short-mobile.png");
  });

  test("uses the selected target, copies exact settings and tools, then severs the Agent relationship", async ({
    page,
    browserDiagnostics,
  }, testInfo) => {
    expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/");
    await page
      .getByTestId("desktop-sidebar")
      .getByTestId("new-thread-trigger")
      .click();
    await selectProjectIfNeeded(page, repositoryLabel);
    const runOn = page.getByRole("combobox", {
      name: "Target",
      exact: true,
    });
    await selectRadixOption(page, runOn, "Pi SDK");
    const agentPicker = page.getByRole("combobox", { name: "Agent" });
    await agentPicker.click();
    await page
      .getByRole("option", { name: /Careful reviewer updated/ })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Sedes tools: Allow without asking.",
    );
    await page.getByRole("button", { name: /1 effective variables/ }).click();
    const variables = page.getByRole("dialog", { name: "Environment variables", exact: true });
    await expect(variables.getByText("Inherited from agent", { exact: true })).toBeVisible();
    await variables.getByLabel("Action for CI", { exact: true }).selectOption("override");
    await variables.getByLabel("Value for CI", { exact: true }).fill("false");
    await capture(page, testInfo, "thread-environment-variables-before-create.png");
    await variables.getByRole("button", { name: "Use these values" }).click();
    await expect(variables).not.toBeVisible();
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/threads") &&
        response.status() === 201,
    );
    await page.getByRole("button", { name: "Create thread" }).click();
    const response = await created;
    expect(response.request().postDataJSON()).toMatchObject({
      environmentVariables: { CI: { kind: "literal", value: "false" } },
      environmentVariablesRevision: { configurationRevision: expect.any(Number), agentRevision: expect.any(Number) },
      configuration: {
        kind: "saved_agent",
        agentId,
        targetId: expect.any(String),
      },
    });
    const result = (await response.json()) as { threadId: string };
    threadPath = `/threads/${result.threadId}`;
    await expect(page).toHaveURL(threadPath);

    const snapshotResponse = await page.request.get(
      `/api${threadPath}?activityDetail=full`,
    );
    expect(snapshotResponse.ok()).toBe(true);
    const snapshot = normalizedThreadSnapshotSchema.parse(
      await snapshotResponse.json(),
    );
    const desired = Object.fromEntries(
      snapshot.settings.values.map(({ id, desiredValue }) => [
        id,
        desiredValue,
      ]),
    );
    expect(desired).toMatchObject({
      model: "memory/conformance-model",
      thinking_level: "high",
      tool_access: "ask",
    });
    expect(snapshot.agentTools).toMatchObject({
      enabled: true,
      presentation: { surface: "native", mode: "progressive" },
      accessBoundary: "unrestricted",
    });
    const enabledToolIds = snapshot.agentTools.groups.flatMap(({ tools }) =>
      tools.filter(({ enabled }) => enabled).map(({ id }) => id),
    );
    expect(enabledToolIds).toEqual(["agent.context"]);
    await page.getByRole("button", { name: "Thread actions" }).click();
    await expect(
      page.getByRole("combobox", { name: "Thinking" }),
    ).toContainText("High");
    await capture(page, testInfo, "saved-agent-bootstrapped-thread.png");
    await page.getByRole("button", { name: /Environment variables…/ }).click();
    const savedVariables = page.getByRole("dialog", { name: "Environment variables", exact: true });
    await expect(savedVariables.getByText("false", { exact: true })).toBeVisible();
    await expect(savedVariables.getByLabel("Value for CI", { exact: true })).toHaveCount(0);
    await expect(savedVariables.getByText(/Saved at creation/)).toBeVisible();
    await capture(page, testInfo, "thread-environment-variables-snapshot.png");
    await savedVariables.getByRole("button", { name: "Done", exact: true }).click();


    await page.goto(`/agents/${agentId}`);
    await selectRadixOption(
      page,
      page.getByRole("combobox", { name: "Configure using" }),
      "Pi SDK",
    );
    await expect(
      page.getByRole("combobox", {
        name: "Access boundary",
      }),
    ).toContainText("Allow without asking");
    await selectRadixOption(
      page,
      page.getByRole("combobox", {
        name: "Access boundary",
      }),
      "Ask outside this environment",
    );
    await page.getByLabel("Value for CI", { exact: true }).fill("updated-agent-value");
    const policyUpdated = page.waitForResponse(
      (updateResponse) =>
        updateResponse.request().method() === "PATCH" &&
        updateResponse.url().endsWith(`/api/agents/${agentId}`) &&
        updateResponse.ok(),
    );
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const policyUpdateResponse = await policyUpdated;
    expect(policyUpdateResponse.request().postDataJSON()).toMatchObject({
      environmentVariables: { CI: { kind: "literal", value: "updated-agent-value" } },
      sedesTools: {
        accessBoundary: "environment",
      },
    });
    await expect(
      page.getByRole("button", {
        name: /Careful reviewer updated.*1 enabled · Ask outside this environment/,
      }),
    ).toBeVisible();

    const retainedVariablesResponse = await page.request.get(`/api${threadPath}/environment-variables`);
    expect(retainedVariablesResponse.ok()).toBe(true);
    expect(await retainedVariablesResponse.json()).toMatchObject({ editable: false, snapshot: { layers: {
      agent: { CI: { kind: "literal", value: "true" } }, thread: { CI: { kind: "literal", value: "false" } },
    } } });

    const retainedAfterAgentEditResponse = await page.request.get(
      `/api${threadPath}?activityDetail=full`,
    );
    expect(retainedAfterAgentEditResponse.ok()).toBe(true);
    const retainedAfterAgentEdit = normalizedThreadSnapshotSchema.parse(
      await retainedAfterAgentEditResponse.json(),
    );
    expect(retainedAfterAgentEdit.agentTools.accessBoundary).toEqual("unrestricted");

    await page.getByRole("button", { name: "Delete" }).click();
    const deleted = page.waitForResponse(
      (deleteResponse) =>
        deleteResponse.request().method() === "DELETE" &&
        deleteResponse.url().endsWith(`/api/agents/${agentId}`) &&
        deleteResponse.ok(),
    );
    const agentsListed = page.waitForResponse(
      (listResponse) =>
        listResponse.request().method() === "GET" &&
        listResponse.url().includes("/api/agents?") &&
        listResponse.ok(),
    );
    // Deleting while the list route mounts intentionally cancels its first
    // stale query before issuing the post-delete list request.
    browserDiagnostics.allowNetworkFailures = true;
    await page.getByRole("button", { name: "Delete Agent" }).click();
    await deleted;
    await expect(page).toHaveURL("/agents");
    await agentsListed;
    browserDiagnostics.allowNetworkFailures = false;
    await expect(page.getByText("No Agents yet.")).toBeVisible();

    const retainedResponse = await page.request.get(
      `/api${threadPath}?activityDetail=full`,
    );
    const retained = normalizedThreadSnapshotSchema.parse(
      await retainedResponse.json(),
    );
    expect(retained.settings.values).toEqual(snapshot.settings.values);
    expect(retained.agentTools.enabled).toBe(true);
    expect(retained.agentTools.accessBoundary).toEqual("unrestricted");
    expect(
      retained.agentTools.groups.flatMap(({ tools }) =>
        tools.filter(({ enabled }) => enabled).map(({ id }) => id),
      ),
    ).toEqual(["agent.context"]);
  });

  test("creates blank independent threads from both thread menus", async ({
    page,
  }) => {
    expect(threadPath).toMatch(/^\/threads\/[0-9a-f-]{36}$/u);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(threadPath);
    const sourceThreadId = threadPath.split("/").at(-1)!;
    const sourceResponse = await page.request.get(
      `/api${threadPath}?activityDetail=full`,
    );
    expect(sourceResponse.ok()).toBe(true);
    const source = normalizedThreadSnapshotSchema.parse(
      await sourceResponse.json(),
    );

    const sourceRow = page
      .getByTestId("desktop-sidebar")
      .locator(`[data-thread-id="${sourceThreadId}"]`);
    await sourceRow.click({ button: "right" });
    let releaseCopy!: () => void;
    const copyGate = new Promise<void>((resolve) => { releaseCopy = resolve; });
    await page.route(`**/api/threads/${sourceThreadId}/configuration-copies`, async (route) => {
      await copyGate;
      await route.continue();
    });
    const copied = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response
          .url()
          .endsWith(`/api/threads/${sourceThreadId}/configuration-copies`) &&
        response.status() === 201,
    );
    await page
      .getByRole("menuitem", { name: "New thread with same settings" })
      .click();
    await expect(page.getByRole("dialog", { name: "Creating thread…" })).toBeVisible();
    await expect(sourceRow.locator(".thread-row-status")).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "Creating thread…" }).getByRole("button")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Creating thread…" })).toBeVisible();
    releaseCopy();
    const copyResponse = await copied;
    const result = (await copyResponse.json()) as {
      threadId: string;
      workspaceId: string;
      targetId: string;
    };
    expect(result.threadId).not.toBe(sourceThreadId);
    await expect(page).toHaveURL(`/threads/${result.threadId}`);

    const childResponse = await page.request.get(
      `/api/threads/${result.threadId}?activityDetail=full`,
    );
    expect(childResponse.ok()).toBe(true);
    const child = normalizedThreadSnapshotSchema.parse(
      await childResponse.json(),
    );
    expect(result).toMatchObject({
      workspaceId: source.thread.workspaceId,
      targetId: source.thread.targetId,
    });
    expect(child.thread).toMatchObject({
      workspaceId: source.thread.workspaceId,
      targetId: source.thread.targetId,
      backingState: "unbound",
    });
    expect(
      Object.fromEntries(
        child.settings.values.map(({ id, desiredValue }) => [id, desiredValue]),
      ),
    ).toEqual(
      Object.fromEntries(
        source.settings.values.map(({ id, desiredValue }) => [
          id,
          desiredValue,
        ]),
      ),
    );
    expect(child.agentTools).toMatchObject({
      enabled: source.agentTools.enabled,
      presentation: source.agentTools.presentation,
      accessBoundary: source.agentTools.accessBoundary,
      revision: 0,
    });
    expect(
      child.agentTools.groups.flatMap(({ tools }) =>
        tools.filter(({ enabled }) => enabled).map(({ id }) => id),
      ),
    ).toEqual(
      source.agentTools.groups.flatMap(({ tools }) =>
        tools.filter(({ enabled }) => enabled).map(({ id }) => id),
      ),
    );
    expect(child.backendSessionId).toBeUndefined();
    expect(child).toMatchObject({
      draft: {
        text: "",
        contextExcerpts: [],
        attachments: [],
        taskReferences: [],
        revision: 0,
      },
      stashes: [],
      orderedTurnIds: [],
      turnsById: {},
      itemsById: {},
      queue: [],
    });
    expect(child.thread.automation).toBeNull();
    const snapshotResponse = await page.request.get(
      "/api/application/snapshot",
    );
    expect(snapshotResponse.ok()).toBe(true);
    const snapshot = (await snapshotResponse.json()) as {
      forkOrigins: Array<{ childThreadId: string }>;
    };
    expect(
      snapshot.forkOrigins.some(
        ({ childThreadId }) => childThreadId === result.threadId,
      ),
    ).toBe(false);

    const thinking = page.getByRole("combobox", { name: "Thinking" });
    await expect(thinking).toContainText("High");
    const changed = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/operations") &&
        response.ok() &&
        response.request().postDataJSON().operation?.settingId ===
          "thinking_level",
    );
    await selectRadixOption(page, thinking, /^Low$/u);
    await changed;
    const unchangedSourceResponse = await page.request.get(
      `/api${threadPath}?activityDetail=full`,
    );
    const unchangedSource = normalizedThreadSnapshotSchema.parse(
      await unchangedSourceResponse.json(),
    );
    expect(
      unchangedSource.settings.values.find(({ id }) => id === "thinking_level")
        ?.desiredValue,
    ).toBe("high");

    await page.goto(threadPath);
    await page.getByRole("button", { name: "Thread actions" }).click();
    const headerCopied = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response
          .url()
          .endsWith(`/api/threads/${sourceThreadId}/configuration-copies`) &&
        response.status() === 201,
    );
    await page
      .getByTestId("thread-actions-menu")
      .getByRole("button", { name: "New thread with same settings" })
      .click();
    const headerResult = (await (await headerCopied).json()) as {
      threadId: string;
      workspaceId: string;
      targetId: string;
    };
    expect(headerResult.threadId).not.toBe(sourceThreadId);
    expect(headerResult.threadId).not.toBe(result.threadId);
    expect(headerResult).toMatchObject({
      workspaceId: source.thread.workspaceId,
      targetId: source.thread.targetId,
    });
    await expect(page).toHaveURL(`/threads/${headerResult.threadId}`);
  });

  test("shows unique and zero-compatible resolution without fallback", async ({
    page,
  }) => {
    // Recreate a minimal Agent directly through the management UI after the
    // linkage test deleted the original preset.
    await openSedesWorkspace(page);
    await page.goto("/agents/new");
    await page.getByRole("textbox", { name: "Name" }).fill("Health probe");
    await selectProjectIfNeeded(page, repositoryLabel);
    await selectRadixOption(
      page,
      page.getByRole("combobox", { name: "Configure using" }),
      "Pi SDK",
    );
    await page.getByRole("checkbox", { name: "Override Model" }).click();
    await page.getByRole("checkbox", { name: "Override Thinking" }).click();
    await selectRadixOption(
      page,
      page.getByRole("combobox", { name: "Thinking" }),
      /^Low$/,
    );
    const created = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/agents") &&
        response.status() === 201,
    );
    await page.getByRole("button", { name: "Create Agent" }).click();
    const healthAgentId = (
      (await (await created).json()) as {
        agent: { id: string };
      }
    ).agent.id;

    expect(
      (
        await page.request.post(
          "/__e2e/saved-agents/pi-targets/pi-sdk-alternate/unavailable",
        )
      ).status(),
    ).toBe(204);
    await page.goto("/");
    await page
      .getByTestId("desktop-sidebar")
      .getByTestId("new-thread-trigger")
      .click();
    await selectProjectIfNeeded(page, repositoryLabel);
    await selectRadixOption(
      page,
      page.getByRole("combobox", { name: "Target", exact: true }),
      "Pi SDK",
    );
    await page.getByRole("combobox", { name: "Agent" }).click();
    await page.getByRole("option", { name: /Health probe/ }).click();
    await expect(page.getByRole("status")).toContainText("Runs on Pi SDK.");
    await expect(
      page.getByRole("combobox", { name: "Target", exact: true }),
    ).toContainText("Pi SDK");
    await page.getByRole("button", { name: "Cancel" }).click();

    expect(
      (
        await page.request.post(
          "/__e2e/saved-agents/pi-targets/pi-sdk-local/unavailable",
        )
      ).status(),
    ).toBe(204);
    await page
      .getByTestId("desktop-sidebar")
      .getByTestId("new-thread-trigger")
      .click();
    await selectProjectIfNeeded(page, repositoryLabel);
    await selectRadixOption(
      page,
      page.getByRole("combobox", { name: "Target", exact: true }),
      "Codex stdio owned · Codex stdio",
    );
    await page.getByRole("combobox", { name: "Agent" }).click();
    await expect(
      page.getByRole("option", { name: /Health probe/ }),
    ).toHaveCount(0);

    // Keep the ID live in the test so an accidental selection by display name
    // cannot satisfy the contract assertion above.
    expect(healthAgentId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
