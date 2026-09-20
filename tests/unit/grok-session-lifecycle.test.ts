import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { GrokOwnedStdioTransportFactory } from "../../src/server/backends/grok/grok-owned-stdio-transport.js";
import { projectGrokLatestHistory } from "../../src/server/backends/grok/grok-normalized-history.js";
import type { ResolvedGrokWorkspaceRuntimeConfiguration } from "../../src/server/backends/grok/grok-runtime-config.js";
import { GrokSessionLifecycle } from "../../src/server/backends/grok/grok-session-lifecycle.js";
import { GrokSessionRegistry } from "../../src/server/backends/grok/grok-session-registry.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { MAXIMUM_COMPOSER_INPUT_BYTES } from "../../src/shared/protocol/context-excerpts.js";

const fixture = fileURLToPath(
  new URL("../fixtures/grok/fake-grok-lifecycle-peer.mjs", import.meta.url),
);
const scope = Object.freeze({
  tenantId: "tenant-grok",
  principalId: "principal-grok",
});
const executionEnvironmentId = "10000000-0000-4000-8000-000000000020";
const backendInstanceId = "grok-private-lifecycle";
const sessionConfiguration = Object.freeze({
  modelId: "grok-build",
  reasoningEffort: "low",
});
const roots: string[] = [];

function startPromptText(
  lifecycle: GrokSessionLifecycle,
  sessionId: string,
  promptId: string,
  text: string,
  input?: { readonly signal?: AbortSignal },
) {
  return lifecycle.startPrompt(
    sessionId,
    promptId,
    [{ type: "text", text }],
    input,
  );
}

afterEach(async () => {
  await Promise.all(
    roots
      .splice(0)
      .map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Grok provider-private lifecycle", () => {
  it("exposes source-streamed native history through its owned connection", async () => {
    const { lifecycle, workspace } = await openLifecycle("normal", 10);
    try {
      await expect(
        lifecycle.connection.readNativeHistory({
          sessionId: "history-1",
          cwd: workspace,
        }),
      ).resolves.toMatchObject({
        totalCount: 1,
        lastEventId: "native-history-1",
        updates: [
          {
            method: "session/update",
            params: { sessionId: "history-1" },
          },
        ],
      });
      expect(lifecycle.connection.diagnostics().closed).toBe(false);
    } finally {
      await lifecycle.close("test_complete");
    }
  });

  it("aborts a lower-priority native page so Submit can start and later prompts remain usable", async () => {
    const { lifecycle } = await openLifecycle(
      "history_page_prompt_priority",
      41,
    );
    try {
      const created = await lifecycle.newSession({
        configuration: sessionConfiguration,
      });
      const latest = await lifecycle.historyPage(created.state.sessionId, {
        limit: 10,
      });
      const previousCursor = latest.previousCursorByPromptId?.["prompt-2"];
      expect(previousCursor).toBeDefined();
      const older = lifecycle.historyPage(created.state.sessionId, {
        cursor: previousCursor,
        limit: 1,
      });
      await new Promise((resolve) => setTimeout(resolve, 10));

      const prompt = startPromptText(
        lifecycle,
        created.state.sessionId,
        "sedes-grok-test-page-priority",
        "user input wins",
      );
      await expect(older).rejects.toMatchObject({
        code: "grok_native_history_aborted",
        retryable: true,
      });
      await expect(prompt.accepted).resolves.toMatchObject({
        state: { sessionId: created.state.sessionId },
      });
      await expect(prompt.completed).resolves.toMatchObject({
        response: { stopReason: "end_turn" },
      });
      await expect(
        lifecycle.historyPage(created.state.sessionId, {
          cursor: previousCursor,
          limit: 1,
        }),
      ).rejects.toMatchObject({
        code: "grok_native_history_busy",
        retryable: true,
      });
      expect(lifecycle.connection.diagnostics().closed).toBe(false);
    } finally {
      await lifecycle.close("test_complete");
    }
  });

  it("lists a bounded workspace page and atomically commits early create traffic", async () => {
    const { lifecycle, nativeNamespaceKey } = await openLifecycle("normal", 11);
    try {
      await expect(lifecycle.listSessions()).resolves.toEqual([
        {
          nativeNamespaceKey,
          sessionId: "listed-1",
          workspace: expect.stringContaining("/workspace"),
          title: "Listed session",
          updatedAt: "2026-08-16T12:00:00.000Z",
        },
        {
          nativeNamespaceKey,
          sessionId: "listed-2",
          workspace: expect.stringContaining("/workspace"),
          title: "Second session",
          updatedAt: "2026-08-16T12:00:00.000Z",
        },
      ]);

      const created = await lifecycle.newSession({
        configuration: sessionConfiguration,
      });
      expect(created.state).toMatchObject({
        sessionId: "created-1",
        residency: "resident",
        nativeNamespaceKey,
        connectionGeneration: 11,
        processOwnerId: "process-11",
      });
      expect(created.history).toMatchObject([
        {
          kind: "assistant_text",
          sessionId: "created-1",
          text: { text: "early live" },
          replay: true,
        },
      ]);
      expect(lifecycle.history("created-1")).toEqual(created.history);
      await lifecycle.closeSession("created-1");
      await expect(
        lifecycle.newSession({ configuration: sessionConfiguration }),
      ).rejects.toThrow("grok_process_session_cardinality_exceeded");
      expect(lifecycle.connection.diagnostics().closed).toBe(false);
    } finally {
      await lifecycle.close("test_complete");
    }
  });

  it("fails closed when a confirmed create has contradictory native history", async () => {
    const { lifecycle } = await openLifecycle("create_history_invalid", 42);
    try {
      await expect(
        lifecycle.newSession({
          configuration: sessionConfiguration,
        }),
      ).rejects.toMatchObject({
        code: "grok_native_history_data_invalid",
      });
      expect(lifecycle.connection.diagnostics()).toMatchObject({
        closed: true,
        closeReason: "grok_session_create_commit_failed",
      });
    } finally {
      await lifecycle.close("test_complete");
    }
  });

  it("fences a confirmed create when native refresh proves the carrier closed", async () => {
    const registry = new GrokSessionRegistry();
    const { lifecycle, owner } = await openLifecycle(
      "create_refresh_carrier_failure",
      43,
      registry,
    );
    await expect(
      lifecycle.newSession({ configuration: sessionConfiguration }),
    ).rejects.toMatchObject({ code: "acp_binding_closed" });
    expect(registry.state({ ...owner, sessionId: "created-1" })).toMatchObject({
      residency: "lost",
    });
    await lifecycle.close("test_complete");
  });

  it("installs load routing before replay, publishes only after success, and closes to dormant", async () => {
    const registry = new GrokSessionRegistry();
    const { lifecycle, published } = await openLifecycle(
      "normal",
      12,
      registry,
    );
    try {
      const loaded = await lifecycle.loadSession("loaded-1");
      expect(loaded.state.residency).toBe("resident");
      expect(
        loaded.history.map((record) =>
          "text" in record ? record.text.text : record.kind,
        ),
      ).toEqual(["replayedearly live"]);

      await expect(lifecycle.resumeSession("loaded-1")).resolves.toMatchObject({
        residency: "resident",
      });
      expect(lifecycle.history("loaded-1")).toMatchObject([
        { text: { text: "replayedresumed early live" } },
      ]);
      await expect(lifecycle.closeSession("loaded-1")).resolves.toMatchObject({
        residency: "dormant",
      });
      expect(
        published.map((record) => ("text" in record ? record.text.text : "")),
      ).toEqual(["final before close"]);
      await expect(lifecycle.resumeSession("loaded-1")).rejects.toThrow(
        "grok_session_owner_mismatch",
      );
      await expect(lifecycle.loadSession("loaded-1")).resolves.toMatchObject({
        state: { residency: "resident" },
      });
    } finally {
      await lifecycle.close("test_complete");
    }
  });

  it("discards failed replay without publishing or leaving a resident route", async () => {
    const registry = new GrokSessionRegistry();
    const { lifecycle, owner } = await openLifecycle(
      "load_failure",
      13,
      registry,
    );
    try {
      await expect(lifecycle.loadSession("failed-1")).rejects.toMatchObject({
        name: "AcpRemoteError",
        remoteCode: -32603,
      });
      expect(registry.state({ ...owner, sessionId: "failed-1" })).toMatchObject(
        { residency: "dormant" },
      );
      expect(lifecycle.connection.diagnostics().closed).toBe(false);
      expect(() => lifecycle.history("failed-1")).toThrow(
        "grok_session_owner_mismatch",
      );
    } finally {
      await lifecycle.close("test_complete");
    }
  });

  it("fails a create whose staged native ID differs and maps lifecycle authentication loss", async () => {
    const mismatchRegistry = new GrokSessionRegistry();
    const mismatched = await openLifecycle(
      "create_mismatch",
      14,
      mismatchRegistry,
    );
    try {
      await expect(
        mismatched.lifecycle.newSession({
          configuration: sessionConfiguration,
        }),
      ).rejects.toThrow("grok_session_create_notification_mismatch");
      await expect(
        mismatched.lifecycle.connection.closed,
      ).resolves.toMatchObject({ reason: "grok_session_create_commit_failed" });
      expect(
        mismatchRegistry.state({
          ...mismatched.owner,
          sessionId: "created-1",
        }),
      ).toMatchObject({ residency: "lost" });
    } finally {
      await mismatched.lifecycle.close("test_complete");
    }

    const authFailure = await openLifecycle("auth_failure", 15);
    try {
      await expect(authFailure.lifecycle.listSessions()).rejects.toMatchObject({
        name: "GrokAuthenticationRequiredError",
        backendCode: "grok_authentication_required",
        crossedSubmissionBoundary: false,
      });
    } finally {
      await authFailure.lifecycle.close("test_complete");
    }
  });

  it("rejects cyclic and duplicate native discovery walks", async () => {
    const cycle = await openLifecycle("list_cycle", 16);
    try {
      await expect(cycle.lifecycle.listSessions()).rejects.toThrow(
        "grok_session_list_cursor_cycle",
      );
    } finally {
      await cycle.lifecycle.close("test_complete");
    }
    const duplicate = await openLifecycle("list_duplicate", 17);
    try {
      await expect(duplicate.lifecycle.listSessions()).rejects.toThrow(
        "grok_session_list_duplicate_session",
      );
    } finally {
      await duplicate.lifecycle.close("test_complete");
    }
  });

  it("serializes a complete discovery walk against lifecycle mutations", async () => {
    const concurrent = await openLifecycle("normal", 20);
    try {
      const listing = concurrent.lifecycle.listSessions();
      await expect(
        concurrent.lifecycle.newSession({
          configuration: sessionConfiguration,
        }),
      ).rejects.toThrow("grok_session_lifecycle_mutation_in_flight");
      await expect(listing).resolves.toHaveLength(2);
    } finally {
      await concurrent.lifecycle.close("test_complete");
    }
  });

  it("keeps resume independent from incremental publication and closes cleanly", async () => {
    const registry = new GrokSessionRegistry();
    const slow = await openLifecycle("normal", 22, registry, async () => {});
    await slow.lifecycle.loadSession("slow-resume");
    await expect(
      slow.lifecycle.resumeSession("slow-resume"),
    ).resolves.toMatchObject({
      residency: "resident",
    });
    await slow.lifecycle.close("concurrent_close");
    expect(
      registry.state({ ...slow.owner, sessionId: "slow-resume" }),
    ).toBeUndefined();
  });

  it("rejects post-close mutations before changing shared registry state", async () => {
    const registry = new GrokSessionRegistry();
    const closed = await openLifecycle("normal", 25, registry);
    await closed.lifecycle.close("test_closed_guard");

    await expect(
      closed.lifecycle.newSession({ configuration: sessionConfiguration }),
    ).rejects.toThrow("grok_session_lifecycle_closed");
    await expect(
      closed.lifecycle.loadSession("never-contacted"),
    ).rejects.toThrow("grok_session_lifecycle_closed");
    expect(
      registry.state({ ...closed.owner, sessionId: "never-contacted" }),
    ).toBeUndefined();

    const replacement = await openLifecycle("normal", 26, registry);
    try {
      await expect(
        replacement.lifecycle.newSession({
          configuration: sessionConfiguration,
        }),
      ).resolves.toMatchObject({
        state: { residency: "resident" },
      });
    } finally {
      await replacement.lifecycle.close("test_complete");
    }
  });

  it("releases process-owner capacity only after the transport has closed", async () => {
    let lifecycle: GrokSessionLifecycle | undefined;
    let releaseObserved = false;
    class ObservedRegistry extends GrokSessionRegistry {
      override releaseProcessOwner(
        input: Parameters<GrokSessionRegistry["releaseProcessOwner"]>[0],
      ): void {
        expect(lifecycle?.connection.diagnostics().closed).toBe(true);
        releaseObserved = true;
        super.releaseProcessOwner(input);
      }
    }
    const opened = await openLifecycle("normal", 33, new ObservedRegistry());
    lifecycle = opened.lifecycle;
    await lifecycle.newSession({ configuration: sessionConfiguration });
    await lifecycle.close("verify_release_order");
    expect(releaseObserved).toBe(true);
  });

  it("correlates a promptless user echo to a durable direct terminal", async () => {
    const prompted = await openLifecycle("prompt", 27);
    try {
      const created = await prompted.lifecycle.newSession({
        configuration: sessionConfiguration,
      });
      const operation = startPromptText(
        prompted.lifecycle,
        created.state.sessionId,
        "sedes-grok-test-prompt-27",
        "answer without tools",
      );
      const accepted = await operation.accepted;
      expect(accepted.promptId).toBe("sedes-grok-test-prompt-27");
      expect(
        accepted.history
          .flatMap((record) =>
            record.kind === "user_text" ? [record.text.text] : [],
          )
          .join(""),
      ).toBe("answer without tools");
      const result = await operation.completed;
      expect(result.response).toEqual({ stopReason: "end_turn" });
      expect(
        result.history
          .flatMap((record) =>
            record.kind === "user_text" ? [record.text.text] : [],
          )
          .join(""),
      ).toBe("answer without tools");
      expect(
        result.history
          .flatMap((record) =>
            record.kind === "assistant_text" ? [record.text.text] : [],
          )
          .join(""),
      ).toBe("fake answer");
      expect(result.history.at(-1)).toMatchObject({
        kind: "turn_completed",
        stopReason: "end_turn",
        identity: { promptId: result.promptId },
      });
      expect(prompted.published).toHaveLength(4);
    } finally {
      await prompted.lifecycle.close("test_complete");
    }
  });

  it("submits ordered ACP image blocks with optional text and ignores their raw echoes", async () => {
    const prompted = await openLifecycle("prompt_images", 44);
    const rawOne = "Zmlyc3QtaW1hZ2U=";
    const rawTwo = "c2Vjb25kLWltYWdl";
    try {
      const created = await prompted.lifecycle.newSession({
        configuration: sessionConfiguration,
      });
      const mixed = prompted.lifecycle.startPrompt(
        created.state.sessionId,
        "sedes-grok-test-images-mixed",
        [
          { type: "text", text: "compare these" },
          { type: "image", mimeType: "image/png", data: rawOne },
          { type: "image", mimeType: "image/webp", data: rawTwo },
        ],
      );
      const accepted = await mixed.accepted;
      expect(accepted.promptId).toBe("sedes-grok-test-images-mixed");
      expect(
        accepted.history
          .flatMap((record) =>
            record.kind === "user_text" ? [record.text.text] : [],
          )
          .join(""),
      ).toBe("compare these");
      expect(JSON.stringify(accepted.history)).not.toContain(rawOne);
      expect(JSON.stringify(accepted.history)).not.toContain(rawTwo);
      await mixed.completed;

      const imageOnly = prompted.lifecycle.startPrompt(
        created.state.sessionId,
        "sedes-grok-test-image-only",
        [{ type: "image", mimeType: "image/png", data: rawOne }],
      );
      const imageAcceptance = await imageOnly.accepted;
      expect(imageAcceptance.promptId).toBe("sedes-grok-test-image-only");
      expect(
        imageAcceptance.history
          .flatMap((record) =>
            record.kind === "user_text" ? [record.text.text] : [],
          )
          .at(-1),
      ).toBe("");
      expect(JSON.stringify(imageAcceptance.history)).not.toContain(rawOne);
      await imageOnly.completed;
    } finally {
      await prompted.lifecycle.close("test_complete");
    }
  });

  it("settles acceptance only after the bound user projection is published and before completion", async () => {
    let publishStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      publishStarted = resolve;
    });
    let releasePublish!: () => void;
    const release = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    let blocked = false;
    const prompted = await openLifecycle(
      "prompt_delayed_completion",
      35,
      new GrokSessionRegistry(),
      async (record) => {
        if (!blocked && record.kind === "user_text") {
          blocked = true;
          publishStarted();
          await release;
        }
      },
    );
    try {
      const created = await prompted.lifecycle.newSession({
        configuration: sessionConfiguration,
      });
      const operation = startPromptText(
        prompted.lifecycle,
        created.state.sessionId,
        "sedes-grok-test-delayed",
        "split user echo",
      );
      let acceptedSettled = false;
      void operation.accepted.then(() => {
        acceptedSettled = true;
      });
      await started;
      await Promise.resolve();
      expect(acceptedSettled).toBe(false);
      releasePublish();
      const accepted = await operation.accepted;
      expect(
        accepted.history
          .flatMap((record) =>
            record.kind === "user_text" ? [record.text.text] : [],
          )
          .join(""),
      ).toBe("split user echo");
      expect(
        await Promise.race([
          operation.completed.then(() => true),
          new Promise<false>((resolve) => setTimeout(() => resolve(false), 10)),
        ]),
      ).toBe(false);
      await expect(operation.completed).resolves.toMatchObject({
        promptId: "sedes-grok-test-delayed",
        response: { stopReason: "end_turn" },
      });
    } finally {
      releasePublish();
      await prompted.lifecycle.close("test_complete");
    }
  });

  it("keeps exact remote rejection definite and a pre-send abort unfenced", async () => {
    const remote = await openLifecycle("prompt_remote_rejection", 36);
    try {
      const created = await remote.lifecycle.newSession({
        configuration: sessionConfiguration,
      });
      const operation = startPromptText(
        remote.lifecycle,
        created.state.sessionId,
        "sedes-grok-test-remote-rejection",
        "reject me",
      );
      await expect(operation.accepted).rejects.toMatchObject({
        name: "AcpRemoteError",
        remoteCode: -32001,
      });
      await expect(operation.completed).rejects.toMatchObject({
        name: "AcpRemoteError",
        remoteCode: -32001,
      });
      expect(remote.lifecycle.connection.diagnostics().closed).toBe(false);
    } finally {
      await remote.lifecycle.close("test_complete");
    }

    const authentication = await openLifecycle("prompt_auth_rejection", 47);
    try {
      const created = await authentication.lifecycle.newSession({
        configuration: sessionConfiguration,
      });
      const operation = startPromptText(
        authentication.lifecycle,
        created.state.sessionId,
        "sedes-grok-test-auth-rejection",
        "authenticate me",
      );
      await expect(operation.accepted).rejects.toMatchObject({
        name: "GrokAuthenticationRequiredError",
        crossedSubmissionBoundary: false,
      });
      await expect(operation.completed).rejects.toMatchObject({
        name: "GrokAuthenticationRequiredError",
        crossedSubmissionBoundary: false,
      });
      expect(authentication.lifecycle.connection.diagnostics().closed).toBe(
        false,
      );
    } finally {
      await authentication.lifecycle.close("test_complete");
    }

    const aborted = await openLifecycle("prompt", 37);
    try {
      const created = await aborted.lifecycle.newSession({
        configuration: sessionConfiguration,
      });
      const controller = new AbortController();
      controller.abort(new Error("pre_send_abort"));
      const operation = startPromptText(
        aborted.lifecycle,
        created.state.sessionId,
        "sedes-grok-test-not-sent",
        "do not send",
        { signal: controller.signal },
      );
      await expect(operation.accepted).rejects.toMatchObject({
        name: "AcpDeliveryError",
        delivery: "not_sent",
      });
      await expect(operation.completed).rejects.toMatchObject({
        name: "AcpDeliveryError",
        delivery: "not_sent",
      });
      expect(aborted.lifecycle.connection.diagnostics().closed).toBe(false);
    } finally {
      await aborted.lifecycle.close("test_complete");
    }
  });

  it.each([
    "prompt_partial_user_remote",
    "prompt_full_user_remote",
    "prompt_full_user_auth_remote",
    "prompt_conflict_before_remote",
  ])("fences %s as unknown after admitted prompt traffic", async (scenario) => {
    const registry = new GrokSessionRegistry();
    const prompted = await openLifecycle(
      scenario,
      scenario === "prompt_partial_user_remote"
        ? 42
        : scenario === "prompt_full_user_remote"
          ? 43
          : scenario === "prompt_full_user_auth_remote"
            ? 46
            : 45,
      registry,
    );
    const created = await prompted.lifecycle.newSession({
      configuration: sessionConfiguration,
    });
    const operation = startPromptText(
      prompted.lifecycle,
      created.state.sessionId,
      `sedes-grok-test-${scenario}`,
      "remote after user echo",
    );
    await expect(operation.accepted).rejects.toMatchObject({
      name: "GrokPromptOutcomeUnknownError",
      code: "grok_prompt_outcome_unknown",
    });
    await expect(operation.completed).rejects.toMatchObject({
      name: "GrokPromptOutcomeUnknownError",
      code: "grok_prompt_outcome_unknown",
    });
    await expect(prompted.lifecycle.connection.closed).resolves.toMatchObject({
      reason:
        scenario === "prompt_conflict_before_remote"
          ? "grok_prompt_outcome_unknown"
          : "grok_prompt_failed",
    });
    expect(
      registry.state({
        ...prompted.owner,
        sessionId: created.state.sessionId,
      }),
    ).toBeUndefined();
    expect(prompted.published).toEqual([]);
    expect(() => prompted.lifecycle.history(created.state.sessionId)).toThrow(
      "grok_session_owner_mismatch",
    );
  });

  it("accepts multiline text above the former Grok-only limit and rejects blank text before send", async () => {
    const prompted = await openLifecycle("prompt_delayed_completion", 44);
    try {
      const created = await prompted.lifecycle.newSession({
        configuration: sessionConfiguration,
      });
      expect(() =>
        startPromptText(
          prompted.lifecycle,
          created.state.sessionId,
          "sedes-grok-test-blank",
          " \n\t\r\n ",
        ),
      ).toThrow("grok_prompt_content_invalid");
      const text = `line one\r\n\t${"a".repeat(32 * 1_024)}`;
      expect(Buffer.byteLength(text)).toBeGreaterThan(16 * 1_024);
      const operation = startPromptText(
        prompted.lifecycle,
        created.state.sessionId,
        "sedes-grok-test-multiline-boundary",
        text,
      );
      const accepted = await operation.accepted;
      expect(
        accepted.history.find((record) => record.kind === "user_text"),
      ).toMatchObject({
        kind: "user_text",
        text: { text },
        exactTextDigest: createHash("sha256").update(text).digest("base64url"),
      });
      await operation.completed;
    } finally {
      await prompted.lifecycle.close("test_complete");
    }
  });

  it("correlates a split user echo at the shared composer maximum", async () => {
    const prompted = await openLifecycle("prompt_delayed_completion", 56);
    try {
      const created = await prompted.lifecycle.newSession({
        configuration: sessionConfiguration,
      });
      const text = "u".repeat(MAXIMUM_COMPOSER_INPUT_BYTES);
      const operation = startPromptText(
        prompted.lifecycle,
        created.state.sessionId,
        "sedes-grok-test-shared-maximum-echo",
        text,
      );

      const accepted = await operation.accepted;
      expect(
        accepted.history.find((record) => record.kind === "user_text"),
      ).toMatchObject({
        kind: "user_text",
        text: { text },
        exactTextDigest: createHash("sha256").update(text).digest("base64url"),
      });
      await operation.completed;
      expect(prompted.lifecycle.connection.diagnostics()).toMatchObject({
        closed: false,
        protocolFailures: 0,
      });
    } finally {
      await prompted.lifecycle.close("test_complete");
    }
  });

  it("completes after more than one MiB of assistant streaming without retaining a correlation copy", async () => {
    const largeAssistantPeer = await createLargeAssistantPeer();
    const prompted = await openLifecycle(
      "prompt_delayed_completion",
      57,
      new GrokSessionRegistry(),
      undefined,
      undefined,
      largeAssistantPeer,
    );
    try {
      const created = await prompted.lifecycle.newSession({
        configuration: sessionConfiguration,
      });
      const operation = startPromptText(
        prompted.lifecycle,
        created.state.sessionId,
        "sedes-grok-test-large-assistant-stream",
        "stream a large answer",
      );

      await operation.accepted;
      const completed = await operation.completed;
      const assistant = completed.history.find(
        (record) => record.kind === "assistant_text",
      );
      expect(assistant).toMatchObject({
        kind: "assistant_text",
        text: {
          text: "a".repeat(1_200 * 1_024),
        },
      });
      expect(
        assistant?.kind === "assistant_text"
          ? Buffer.byteLength(assistant.text.text)
          : 0,
      ).toBe(1_200 * 1_024);
      expect(
        assistant?.kind === "assistant_text" ? assistant.exactTextDigest : "",
      ).toMatch(/^[A-Za-z0-9_-]{43}$/u);
      expect(prompted.lifecycle.connection.diagnostics()).toMatchObject({
        closed: false,
        protocolFailures: 0,
      });
    } finally {
      await prompted.lifecycle.close("test_complete");
    }
  });

  it("joins and rejects an accepted active completion during lifecycle close", async () => {
    const prompted = await openLifecycle("prompt_hang_after_acceptance", 38);
    const created = await prompted.lifecycle.newSession({
      configuration: sessionConfiguration,
    });
    const operation = startPromptText(
      prompted.lifecycle,
      created.state.sessionId,
      "sedes-grok-test-close-drain",
      "accept then wait",
    );
    await expect(operation.accepted).resolves.toMatchObject({
      promptId: "sedes-grok-test-close-drain",
    });
    await prompted.lifecycle.close("close_active_prompt");
    await expect(operation.completed).rejects.toBeDefined();
    expect(prompted.lifecycle.connection.diagnostics().closed).toBe(true);
  });

  it("validates the caller prompt identity before starting exactly one operation", async () => {
    const prompted = await openLifecycle("prompt_delayed_completion", 39);
    try {
      const created = await prompted.lifecycle.newSession({
        configuration: sessionConfiguration,
      });
      expect(() =>
        startPromptText(
          prompted.lifecycle,
          created.state.sessionId,
          "bad\nidentity",
          "safe",
        ),
      ).toThrow("grok_prompt_id_invalid");
      const operation = startPromptText(
        prompted.lifecycle,
        created.state.sessionId,
        "sedes-grok-test-start-once",
        "safe",
      );
      expect(() =>
        startPromptText(
          prompted.lifecycle,
          created.state.sessionId,
          "sedes-grok-test-second",
          "second",
        ),
      ).toThrow("grok_session_lifecycle_mutation_in_flight");
      await operation.completed;
    } finally {
      await prompted.lifecycle.close("test_complete");
    }
  });

  it("never applies interrupted recovery while the owned lifecycle has an active prompt", async () => {
    const prompted = await openLifecycle("prompt_delayed_completion", 45);
    try {
      const created = await prompted.lifecycle.newSession({
        configuration: sessionConfiguration,
      });
      const promptId = "sedes-grok-test-active-recovery-guard";
      const operation = startPromptText(
        prompted.lifecycle,
        created.state.sessionId,
        promptId,
        "keep this prompt active",
      );
      await expect(
        prompted.lifecycle.recoverInterruptedSedesPrompt(
          created.state.sessionId,
          promptId,
        ),
      ).rejects.toThrow("grok_interrupted_recovery_active_prompt");
      await operation.completed;
      expect(
        prompted.lifecycle
          .history(created.state.sessionId)
          .filter((record) => record.kind === "turn_completed"),
      ).toMatchObject([{ stopReason: "end_turn" }]);
    } finally {
      await prompted.lifecycle.close("test_complete");
    }
  });

  it("reconstructs the same prompt history after a true process restart and load", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "grok-lifecycle-restart-"),
    );
    roots.push(root);
    const shared = {
      root,
      workspace: path.join(root, "workspace"),
      nativeHome: path.join(root, "native-home"),
      storePath: path.join(root, "fake-native-store.json"),
    };
    const registry = new GrokSessionRegistry();
    const first = await openLifecycle(
      "prompt",
      31,
      registry,
      undefined,
      shared,
    );
    const created = await first.lifecycle.newSession({
      configuration: sessionConfiguration,
    });
    const operation = startPromptText(
      first.lifecycle,
      created.state.sessionId,
      "sedes-grok-test-prompt-31",
      "persist\n\tme",
    );
    await operation.accepted;
    const prompted = await operation.completed;
    await first.lifecycle.close("restart_first_process");

    const second = await openLifecycle(
      "prompt",
      32,
      registry,
      undefined,
      shared,
    );
    try {
      const loaded = await second.lifecycle.loadSession(
        created.state.sessionId,
      );
      expect(semanticPromptBlocks(loaded.history)).toEqual(
        semanticPromptBlocks(prompted.history),
      );
    } finally {
      await second.lifecycle.close("test_complete");
    }
  });

  it("retains validated native tool activity for normalized presentation", async () => {
    const prompted = await openLifecycle("prompt_tool", 28);
    const created = await prompted.lifecycle.newSession({
      configuration: sessionConfiguration,
    });
    const operation = startPromptText(
      prompted.lifecycle,
      created.state.sessionId,
      "sedes-grok-test-prompt-tool",
      "safe",
    );
    await expect(operation.accepted).resolves.toMatchObject({
      promptId: "sedes-grok-test-prompt-tool",
    });
    const completion = await operation.completed;
    expect(completion).toMatchObject({
      promptId: "sedes-grok-test-prompt-tool",
    });
    expect(
      completion.history
        .flatMap((record) =>
          record.kind === "assistant_text" ? [record.text.text] : [],
        )
        .join(""),
    ).toBe("fake answer");
    const tools = completion.history.filter((record) => record.kind === "tool");
    expect(tools).toMatchObject([
      {
        toolCallId: "tool-1",
        patch: {
          title: "Read native Grok documentation",
          toolKind: "read",
          status: "completed",
        },
      },
    ]);
    expect(prompted.lifecycle.connection.diagnostics().closed).toBe(false);
    await prompted.lifecycle.close("test_complete");
  });

  it("settles an authenticated prior-prompt background tool while the next prompt runs", async () => {
    const prompted = await openLifecycle("prompt_background_tool", 65);
    try {
      const created = await prompted.lifecycle.newSession({
        configuration: sessionConfiguration,
      });
      const first = startPromptText(
        prompted.lifecycle,
        created.state.sessionId,
        "sedes-grok-test-background-p1",
        "start background work",
      );
      await first.accepted;
      await first.completed;

      const second = startPromptText(
        prompted.lifecycle,
        created.state.sessionId,
        "sedes-grok-test-background-p2",
        "continue while it settles",
      );
      await expect(second.accepted).resolves.toMatchObject({
        promptId: "sedes-grok-test-background-p2",
      });
      await expect(second.completed).resolves.toMatchObject({
        response: { stopReason: "end_turn" },
      });
      expect(
        prompted.lifecycle
          .history(created.state.sessionId)
          .filter(
            (record) =>
              record.kind === "tool" &&
              record.toolCallId.startsWith("background-tool-"),
          ),
      ).toMatchObject([
        {
          kind: "tool",
          toolCallId: "background-tool-1",
          identity: { promptId: "sedes-grok-test-background-p1" },
          patch: { status: "completed" },
        },
        {
          kind: "tool",
          toolCallId: "background-tool-2",
          identity: { promptId: "sedes-grok-test-background-p1" },
          patch: { status: "completed" },
        },
      ]);
      expect(prompted.lifecycle.connection.diagnostics()).toMatchObject({
        closed: false,
        protocolFailures: 0,
      });
    } finally {
      await prompted.lifecycle.close("test_complete");
    }
  });

  it("compacts live Plan replacement and reopens the same provider-native plan identity", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grok-plan-restart-"));
    roots.push(root);
    const shared = {
      root,
      workspace: path.join(root, "workspace"),
      nativeHome: path.join(root, "native-home"),
      storePath: path.join(root, "fake-native-store.json"),
    };
    const registry = new GrokSessionRegistry();
    const prompted = await openLifecycle(
      "prompt_plan",
      66,
      registry,
      undefined,
      shared,
    );
    const created = await prompted.lifecycle.newSession({
      configuration: sessionConfiguration,
    });
    const operation = startPromptText(
      prompted.lifecycle,
      created.state.sessionId,
      "sedes-grok-test-plan",
      "make a plan",
    );
    await expect(operation.accepted).resolves.toMatchObject({
      promptId: "sedes-grok-test-plan",
    });
    const completion = await operation.completed;
    const livePlans = completion.history.filter(
      (record) => record.kind === "plan",
    );
    expect(livePlans).toHaveLength(1);
    expect(livePlans[0]).toMatchObject({
      replacement: {
        eventId: "sedes-grok-test-plan-plan-2",
        entries: [
          { text: { text: "Verify" }, status: "in_progress" },
          { text: { text: "Obsolete" }, status: "cancelled" },
        ],
      },
    });
    const livePlanItem = Object.values(
      projectGrokLatestHistory(completion.history).snapshot.itemsById,
    ).find((item) => item.semanticKind === "plan");
    expect(livePlanItem).toMatchObject({
      semanticKind: "plan",
      status: "completed",
      entries: [
        { text: { text: "Verify" }, status: "completed" },
        { text: { text: "Obsolete" }, status: "cancelled" },
      ],
    });
    await prompted.lifecycle.close("restart_plan_process");

    const reopened = await openLifecycle(
      "prompt_plan",
      68,
      registry,
      undefined,
      shared,
    );
    try {
      const loaded = await reopened.lifecycle.loadSession(
        created.state.sessionId,
      );
      const reopenedPlans = loaded.history.filter(
        (record) => record.kind === "plan",
      );
      expect(reopenedPlans).toHaveLength(1);
      expect(reopenedPlans[0]?.replacement).toMatchObject({
        planId: livePlans[0]?.replacement.planId,
        backendItemId: livePlans[0]?.replacement.backendItemId,
        entries: livePlans[0]?.replacement.entries,
      });
      const reopenedPlanItem = Object.values(
        projectGrokLatestHistory(loaded.history).snapshot.itemsById,
      ).find((item) => item.semanticKind === "plan");
      expect(reopenedPlanItem).toEqual(livePlanItem);
      expect(reopened.lifecycle.connection.diagnostics()).toMatchObject({
        closed: false,
        protocolFailures: 0,
      });
    } finally {
      await reopened.lifecycle.close("test_complete");
    }
  });

  it("projects parent collaboration while ignoring the native reviewer session", async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "grok-subagent-restart-"),
    );
    roots.push(root);
    const shared = {
      root,
      workspace: path.join(root, "workspace"),
      nativeHome: path.join(root, "native-home"),
      storePath: path.join(root, "fake-native-store.json"),
    };
    const registry = new GrokSessionRegistry();
    const prompted = await openLifecycle(
      "prompt_subagent",
      52,
      registry,
      undefined,
      shared,
    );
    const created = await prompted.lifecycle.newSession({
      configuration: sessionConfiguration,
    });
    const operation = startPromptText(
      prompted.lifecycle,
      created.state.sessionId,
      "sedes-grok-test-prompt-subagent",
      "review",
    );
    await expect(operation.accepted).resolves.toMatchObject({
      promptId: "sedes-grok-test-prompt-subagent",
    });
    const completion = await operation.completed;
    expect(
      completion.history
        .flatMap((record) =>
          record.kind === "assistant_text" ? [record.text.text] : [],
        )
        .join(""),
    ).toBe("fake answer");
    expect(completion.history).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "collaboration",
          status: "completed",
          action: "result",
          agentLabel: { text: "reviewer" },
          summary: { text: "Looks good" },
          sessionId: created.state.sessionId,
        }),
      ]),
    );
    const publishedCollaboration = prompted.published.filter(
      (record) => record.kind === "collaboration",
    );
    expect(
      publishedCollaboration.map((record) => ({
        activityId: record.activityId,
        status: record.status,
        action: record.action,
      })),
    ).toMatchObject([
      { status: "streaming", action: "spawn" },
      { status: "streaming", action: "status" },
      { status: "completed", action: "result" },
    ]);
    expect(
      new Set(publishedCollaboration.map((record) => record.activityId)).size,
    ).toBe(1);
    expect(prompted.lifecycle.connection.diagnostics()).toMatchObject({
      closed: false,
      protocolFailures: 0,
      handlerFailures: 0,
    });
    expect(
      prompted.published.some(
        (record) => record.sessionId === "child-reviewer-1",
      ),
    ).toBe(false);
    expect(JSON.stringify(completion.history)).not.toContain(
      "child-reviewer-1",
    );
    const liveItem = Object.values(
      projectGrokLatestHistory(completion.history).snapshot.itemsById,
    ).find((item) => item.semanticKind === "collaboration");
    expect(liveItem).toMatchObject({
      semanticKind: "collaboration",
      status: "completed",
      action: "result",
      summary: { text: "Looks good" },
    });
    await prompted.lifecycle.close("restart_subagent_process");

    const reopened = await openLifecycle(
      "prompt_subagent",
      54,
      registry,
      undefined,
      shared,
    );
    try {
      const loaded = await reopened.lifecycle.loadSession(
        created.state.sessionId,
      );
      const collaborations = loaded.history.filter(
        (record) => record.kind === "collaboration",
      );
      expect(collaborations).toHaveLength(1);
      expect(collaborations[0]).toMatchObject({
        replay: true,
        status: "completed",
        action: "result",
        summary: { text: "Looks good" },
      });
      const reopenedItem = Object.values(
        projectGrokLatestHistory(loaded.history).snapshot.itemsById,
      ).find((item) => item.semanticKind === "collaboration");
      expect(reopenedItem).toEqual(liveItem);
      expect(JSON.stringify(loaded.history)).not.toContain("child-reviewer-1");
    } finally {
      await reopened.lifecycle.close("test_complete");
    }
  });

  it("drains a burst of unowned reviewer frames without closing the parent", async () => {
    const prompted = await openLifecycle("prompt_subagent_burst", 53);
    const created = await prompted.lifecycle.newSession({
      configuration: sessionConfiguration,
    });
    const operation = startPromptText(
      prompted.lifecycle,
      created.state.sessionId,
      "sedes-grok-test-prompt-subagent-burst",
      "review",
    );
    await expect(operation.accepted).resolves.toMatchObject({
      promptId: "sedes-grok-test-prompt-subagent-burst",
    });
    await expect(operation.completed).resolves.toMatchObject({
      response: { stopReason: "end_turn" },
    });
    expect(prompted.lifecycle.connection.diagnostics()).toMatchObject({
      closed: false,
      protocolFailures: 0,
      handlerFailures: 0,
    });
    expect(
      prompted.published.some(
        (record) => record.sessionId === "child-reviewer-1",
      ),
    ).toBe(false);
    await prompted.lifecycle.close("test_complete");
  });

  it("fails an active prompt when later subagent identity evidence contradicts its spawn", async () => {
    const registry = new GrokSessionRegistry();
    const prompted = await openLifecycle(
      "prompt_subagent_identity_conflict",
      55,
      registry,
    );
    const created = await prompted.lifecycle.newSession({
      configuration: sessionConfiguration,
    });
    const operation = startPromptText(
      prompted.lifecycle,
      created.state.sessionId,
      "sedes-grok-test-subagent-identity-conflict",
      "review",
    );

    await expect(operation.accepted).resolves.toMatchObject({
      promptId: "sedes-grok-test-subagent-identity-conflict",
    });
    await expect(operation.completed).rejects.toMatchObject({
      name: "GrokPromptOutcomeUnknownError",
      code: "grok_prompt_outcome_unknown",
    });
    await expect(prompted.lifecycle.connection.closed).resolves.toMatchObject({
      reason: "grok_prompt_outcome_unknown",
    });
    expect(
      registry.state({
        ...prompted.owner,
        sessionId: created.state.sessionId,
      }),
    ).toBeUndefined();
  });

  it("selects one-shot native tool permission without fencing the prompt", async () => {
    const prompted = await openLifecycle("prompt_permission", 29);
    const created = await prompted.lifecycle.newSession({
      configuration: sessionConfiguration,
    });
    const operation = startPromptText(
      prompted.lifecycle,
      created.state.sessionId,
      "sedes-grok-test-prompt-permission",
      "safe",
    );
    await expect(operation.accepted).resolves.toMatchObject({
      promptId: "sedes-grok-test-prompt-permission",
    });
    await expect(operation.completed).resolves.toMatchObject({
      promptId: "sedes-grok-test-prompt-permission",
    });
    expect(prompted.lifecycle.connection.diagnostics().closed).toBe(false);
    await prompted.lifecycle.close("test_complete");
  });

  it.each([
    ["prompt_user_mismatch", "grok_prompt_event_correlation_mismatch"],
    ["prompt_user_text_mismatch", "grok_prompt_user_echo_mismatch"],
    ["prompt_tool_wrong_prompt", "grok_prompt_event_correlation_mismatch"],
    ["prompt_tool_missing_prompt", "grok_prompt_event_correlation_mismatch"],
    ["prompt_plan_mismatch", "grok_prompt_event_correlation_mismatch"],
  ])("fences %s authority activity", async (scenario, expected) => {
    const prompted = await openLifecycle(
      scenario,
      scenario === "prompt_user_mismatch"
        ? 30
        : scenario === "prompt_user_text_mismatch"
          ? 40
          : scenario === "prompt_tool_wrong_prompt"
            ? 54
            : scenario === "prompt_tool_missing_prompt"
              ? 55
              : 67,
    );
    const created = await prompted.lifecycle.newSession({
      configuration: sessionConfiguration,
    });
    const operation = startPromptText(
      prompted.lifecycle,
      created.state.sessionId,
      `sedes-grok-test-${scenario}`,
      "safe",
    );
    await expect(operation.accepted).rejects.toThrow(expected);
    await expect(operation.completed).rejects.toThrow(expected);
    if (
      scenario === "prompt_user_mismatch" ||
      scenario === "prompt_user_text_mismatch"
    ) {
      expect(prompted.published).toEqual([]);
    }
    await expect(prompted.lifecycle.connection.closed).resolves.toMatchObject({
      reason: "grok_prompt_violation",
    });
  });

  it("rejects and suppresses a user chunk after the acceptance boundary", async () => {
    const prompted = await openLifecycle("prompt_user_after_acceptance", 41);
    const created = await prompted.lifecycle.newSession({
      configuration: sessionConfiguration,
    });
    const operation = startPromptText(
      prompted.lifecycle,
      created.state.sessionId,
      "sedes-grok-test-late-user",
      "safe",
    );
    await expect(operation.accepted).resolves.toMatchObject({
      promptId: "sedes-grok-test-late-user",
    });
    await expect(operation.completed).rejects.toThrow(
      "grok_prompt_user_echo_after_acceptance",
    );
    expect(
      prompted.published.some(
        (record) => record.kind === "user_text" && record.text.text === "late",
      ),
    ).toBe(false);
    await expect(prompted.lifecycle.connection.closed).resolves.toMatchObject({
      reason: "grok_prompt_violation",
    });
  });

  it("fails closed on a malformed terminal within the multiplexed live route", async () => {
    const malformed = await openLifecycle("prompt_malformed_terminal", 34);
    const created = await malformed.lifecycle.newSession({
      configuration: sessionConfiguration,
    });
    const operation = startPromptText(
      malformed.lifecycle,
      created.state.sessionId,
      "sedes-grok-test-malformed-terminal",
      "safe",
    );
    await expect(operation.accepted).rejects.toMatchObject({
      name: "AcpDeliveryError",
    });
    await expect(operation.completed).rejects.toMatchObject({
      name: "AcpDeliveryError",
    });
    await expect(malformed.lifecycle.connection.closed).resolves.toMatchObject({
      reason: "acp_notification_invalid",
    });
  });

  it("rejects replay during resident-only resume and fences resident state when the lifecycle closes", async () => {
    const registry = new GrokSessionRegistry();
    const replay = await openLifecycle("resume_replay", 18, registry);
    await replay.lifecycle.loadSession("resume-1");
    await expect(replay.lifecycle.resumeSession("resume-1")).rejects.toThrow();
    expect(
      registry.state({ ...replay.owner, sessionId: "resume-1" }),
    ).toMatchObject({ residency: "lost" });
    await replay.lifecycle.close("test_complete");
    expect(
      registry.state({ ...replay.owner, sessionId: "resume-1" }),
    ).toBeUndefined();
  });

  it("turns replay arriving after the load response cutover into session-local loss", async () => {
    const registry = new GrokSessionRegistry();
    const late = await openLifecycle("load_post_response_replay", 19, registry);
    try {
      await late.lifecycle.loadSession("late-replay-session");
      await waitFor(
        () =>
          registry.state({
            ...late.owner,
            sessionId: "late-replay-session",
          })?.residency === "lost",
      );
      expect(late.lifecycle.connection.diagnostics().closed).toBe(false);
      expect(() => late.lifecycle.history("late-replay-session")).toThrow(
        "grok_session_owner_mismatch",
      );
    } finally {
      await late.lifecycle.close("test_complete");
    }
  });

  it("rejects replay-tagged subagent traffic on the live noReplay route", async () => {
    const registry = new GrokSessionRegistry();
    const late = await openLifecycle(
      "load_post_response_subagent_replay",
      20,
      registry,
    );
    try {
      await late.lifecycle
        .loadSession("late-subagent-replay-session")
        .catch(() => undefined);
      await expect(late.lifecycle.connection.closed).resolves.toMatchObject({
        reason: "acp_notification_handler_failed",
      });
    } finally {
      await late.lifecycle.close("test_complete");
    }
  });
});

async function openLifecycle(
  scenario: string,
  generation: number,
  registry = new GrokSessionRegistry(),
  publishOverride?: (
    record: import("../../src/server/backends/grok/grok-history-projector.js").GrokHistoryRecord,
  ) => void | Promise<void>,
  shared?: {
    readonly root: string;
    readonly workspace: string;
    readonly nativeHome: string;
    readonly storePath: string;
  },
  peerFixture = fixture,
) {
  await chmod(peerFixture, 0o755);
  const root =
    shared?.root ??
    (await mkdtemp(path.join(os.tmpdir(), "grok-lifecycle-peer-")));
  if (!shared) roots.push(root);
  const workspace = shared?.workspace ?? path.join(root, "workspace");
  const nativeHome = shared?.nativeHome ?? path.join(root, "native-home");
  await Promise.all([
    mkdir(workspace, { recursive: true }),
    mkdir(nativeHome, { recursive: true }),
  ]);
  const providerScope = {
    ...scope,
    backendInstanceId,
    executionEnvironmentId,
  };
  const channels = new LocalEnvironmentChannelProvider({
    scope,
    executionEnvironmentId,
    environment: { PATH: process.env.PATH },
  });
  const prepared = await channels.prepareOwnedProcess(providerScope, {
    executablePath: peerFixture,
    workingDirectory: workspace,
  });
  const runtime: ResolvedGrokWorkspaceRuntimeConfiguration = Object.freeze({
    scope,
    backendInstanceId,
    executionEnvironmentId,
    workspace,
    environment: Object.freeze({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: nativeHome,
      GROK_TEST_SCENARIO: scenario,
      ...(shared ? { GROK_TEST_STORE: shared.storePath } : {}),
    }),
    process: prepared,
    executable: Object.freeze({
      path: peerFixture,
      version: "1.0.4",
      build: "d846eb93d9",
      compatibilityRelease: "1.x",
      reviewedProfile: "grok-acp/1.0.4",
      newerThanTested: false,
      assessment: Object.freeze({
        observedVersion: "1.0.4",
        minimumVersion: "1.0.4",
        testedThroughVersion: "1.0.4",
        newerThanTested: false,
      }),
    }),
  });
  const factory = new GrokOwnedStdioTransportFactory({ runtime, channels });
  const transport = await factory.open(
    generation,
    new AbortController().signal,
  );
  const nativeNamespaceKey = "grok-native:test-home";
  const published: Array<
    import("../../src/server/backends/grok/grok-history-projector.js").GrokHistoryRecord
  > = [];
  const owner = Object.freeze({
    scope: factory.scope,
    nativeNamespaceKey,
    workspace,
    connectionGeneration: generation,
    processOwnerId: `process-${generation}`,
  });
  const lifecycle = await GrokSessionLifecycle.open({
    transport,
    owner,
    registry,
    inlineSessionUpdates: publishOverride === undefined,
    publish:
      publishOverride ??
      ((record) => {
        published.push(record);
      }),
  });
  return { lifecycle, nativeNamespaceKey, owner, published, workspace };
}

async function createLargeAssistantPeer(): Promise<string> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "grok-large-assistant-peer-"),
  );
  roots.push(root);
  const executable = path.join(root, "peer.mjs");
  const fixtureUrl = new URL(
    "../fixtures/grok/fake-grok-lifecycle-peer.mjs",
    import.meta.url,
  ).href;
  await writeFile(
    executable,
    `#!/usr/bin/env node
const originalWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = (chunk, ...rest) => {
  if (typeof chunk === "string" && chunk.endsWith("\\n")) {
    try {
      const message = JSON.parse(chunk);
      const update = message?.params?.update;
      if (
        message?.method === "session/update" &&
        update?.sessionUpdate === "agent_message_chunk" &&
        update?.content?.type === "text" &&
        (update.content.text === "fake " || update.content.text === "answer")
      ) {
        update.content.text = "a".repeat(600 * 1024);
        return originalWrite(\`${"${JSON.stringify(message)}"}\\n\`, ...rest);
      }
    } catch {}
  }
  return originalWrite(chunk, ...rest);
};
await import(${JSON.stringify(fixtureUrl)});
`,
    { mode: 0o700 },
  );
  return executable;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("grok_lifecycle_test_timeout");
}

function semanticPromptBlocks(
  records: readonly import("../../src/server/backends/grok/grok-history-projector.js").GrokHistoryRecord[],
) {
  const blocks = new Map<
    string,
    { blockId: string; kind: string; text: string }
  >();
  const terminals: Array<{ promptId?: string; stopReason: string }> = [];
  const toolStates = new Map<string, Record<string, unknown>>();
  for (const record of records) {
    if (record.kind === "turn_completed") {
      terminals.push({
        promptId: record.identity.promptId,
        stopReason: record.stopReason,
      });
      continue;
    }
    const key = `${record.identity.blockId}\0${record.kind}`;
    if (record.kind === "tool") {
      const state = toolStates.get(key) ?? {};
      for (const [field, value] of Object.entries(record.patch)) {
        if (value != null) state[field] = value;
      }
      toolStates.set(key, state);
      blocks.set(key, {
        blockId: record.identity.blockId,
        kind: record.kind,
        text: JSON.stringify({ toolCallId: record.toolCallId, state }),
      });
      continue;
    }
    if (record.kind === "omission") continue;
    const text =
      record.kind === "collaboration"
        ? JSON.stringify({
            action: record.action,
            agentLabel: record.agentLabel,
            summary: record.summary,
          })
        : record.kind === "plan"
          ? JSON.stringify(record.replacement.entries)
          : record.text.text;
    const block = blocks.get(key) ?? {
      blockId: record.identity.blockId,
      kind: record.kind,
      text: "",
    };
    block.text += text;
    blocks.set(key, block);
  }
  return { blocks: [...blocks.values()], terminals };
}
