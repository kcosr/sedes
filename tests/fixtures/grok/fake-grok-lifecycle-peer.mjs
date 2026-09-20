#!/usr/bin/env node
import readline from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const input = readline.createInterface({ input: process.stdin });
const scenario = process.env.GROK_TEST_SCENARIO ?? "normal";
const storePath = process.env.GROK_TEST_STORE;
let permissionPrompt;
let backgroundPromptId;

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sessionConfiguration(modelId = "grok-build", reasoningEffort = "low") {
  return {
    "x.ai/sessionConfig": {
      options: [
        { id: modelId, category: "model", selected: true },
        { id: reasoningEffort, category: "mode", selected: true },
      ],
    },
  };
}

function update(sessionId, eventId, text, replay = false) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
      _meta: { eventId, ...(replay ? { isReplay: true } : {}) },
    },
  });
}

function textUpdate(sessionId, eventId, kind, text, promptId, replay = false) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: kind, content: { type: "text", text } },
      _meta: {
        eventId,
        ...(promptId ? { promptId } : {}),
        ...(replay ? { isReplay: true } : {}),
      },
    },
  });
}

function planUpdate(sessionId, eventId, promptId, entries) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "plan", entries },
      ...(eventId === undefined && promptId === undefined
        ? {}
        : {
            _meta: {
              ...(eventId === undefined ? {} : { eventId }),
              ...(promptId === undefined ? {} : { promptId }),
            },
          }),
    },
  });
}

function terminal(sessionId, promptId, replay = false) {
  send({
    jsonrpc: "2.0",
    method: replay ? "_x.ai/session/update" : "_x.ai/session_notification",
    params: {
      sessionId,
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: promptId,
        stop_reason: "end_turn",
      },
      _meta: {
        eventId: replay
          ? `replay-${promptId}-terminal`
          : `${promptId}-terminal`,
        promptId,
        ...(replay ? { isReplay: true } : {}),
      },
    },
  });
}

function passiveXai(sessionId, replay = false) {
  send({
    jsonrpc: "2.0",
    method: replay ? "_x.ai/session/update" : "_x.ai/session_notification",
    params: {
      sessionId,
      update: { sessionUpdate: "retry_state", additive: "ignored" },
    },
  });
}

function subagentSpawned(sessionId, promptId, childSessionId, replay = false) {
  send({
    jsonrpc: "2.0",
    method: replay ? "_x.ai/session/update" : "_x.ai/session_notification",
    params: {
      sessionId,
      update: {
        sessionUpdate: "subagent_spawned",
        subagent_id: childSessionId,
        parent_session_id: sessionId,
        parent_prompt_id: promptId,
        child_session_id: childSessionId,
        subagent_type: "reviewer",
        description: "Review fixture",
      },
      _meta: {
        eventId: `${promptId}-subagent-spawned`,
        ...(replay ? { isReplay: true } : {}),
      },
    },
  });
}

function subagentProgress(sessionId, childSessionId) {
  send({
    jsonrpc: "2.0",
    method: "_x.ai/session_notification",
    params: {
      sessionId,
      update: {
        sessionUpdate: "subagent_progress",
        subagent_id: childSessionId,
        parent_session_id: sessionId,
        child_session_id: childSessionId,
        duration_ms: 125,
        turn_count: 1,
        tool_call_count: 2,
        tokens_used: 300,
        context_window_tokens: 131072,
        context_usage_pct: 12,
        tools_used: ["Read", "Bash"],
        error_count: 0,
      },
    },
  });
}

function subagentFinished(sessionId, promptId, childSessionId) {
  send({
    jsonrpc: "2.0",
    method: "_x.ai/session_notification",
    params: {
      sessionId,
      update: {
        sessionUpdate: "subagent_finished",
        subagent_id: childSessionId,
        child_session_id: childSessionId,
        status: "completed",
        tool_calls: 2,
        turns: 1,
        duration_ms: 250,
        tokens_used: 400,
        output: "Looks good",
        will_wake: false,
      },
      _meta: { eventId: `${promptId}-subagent-finished` },
    },
  });
}

function rejectPrompt(message, code = -32001) {
  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code, message: "prompt rejected" },
  });
}

function finishPrompt(message, userAlreadySent = false) {
  const { sessionId } = message.params;
  const promptId = message.params._meta.promptId;
  const promptText = message.params.prompt
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ");
  const promptImages = message.params.prompt.filter(
    (block) => block.type === "image",
  );
  const userEcho =
    scenario === "prompt_user_text_mismatch" ? `${promptText}!` : promptText;
  const userBoundary = Math.max(1, Math.ceil(userEcho.length / 2));
  if (!userAlreadySent)
    textUpdate(
      sessionId,
      `${promptId}-user-1`,
      "user_message_chunk",
      userEcho.slice(0, userBoundary),
      scenario === "prompt_user_mismatch" ? "wrong-prompt" : undefined,
    );
  if (scenario === "prompt_conflict_before_remote") {
    textUpdate(
      sessionId,
      `${promptId}-user-1`,
      "user_message_chunk",
      "conflicting duplicate",
      undefined,
    );
    rejectPrompt(message);
    return;
  }
  if (scenario === "prompt_partial_user_remote") {
    rejectPrompt(message);
    return;
  }
  if (!userAlreadySent && userBoundary < userEcho.length)
    textUpdate(
      sessionId,
      `${promptId}-user-2`,
      "user_message_chunk",
      userEcho.slice(userBoundary),
      undefined,
    );
  for (const [index, image] of promptImages.entries()) {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: { sessionUpdate: "user_message_chunk", content: image },
        _meta: { eventId: `${promptId}-user-image-${index}`, promptId },
      },
    });
  }
  if (
    scenario === "prompt_full_user_remote" ||
    scenario === "prompt_full_user_auth_remote"
  ) {
    rejectPrompt(
      message,
      scenario === "prompt_full_user_auth_remote" ? -32000 : -32001,
    );
    return;
  }
  if (scenario === "prompt_plan_mismatch") {
    planUpdate(sessionId, `${promptId}-plan-wrong`, "another-prompt", [
      { content: "Wrong prompt", priority: "high", status: "in_progress" },
    ]);
    return;
  }
  if (scenario === "prompt_plan") {
    planUpdate(sessionId, `${promptId}-plan-1`, promptId, [
      { content: "Inspect", priority: "high", status: "completed" },
      { content: "Implement", priority: "medium", status: "in_progress" },
    ]);
    planUpdate(sessionId, `${promptId}-plan-2`, promptId, [
      { content: "Verify", priority: "high", status: "in_progress" },
      {
        content: "Obsolete",
        priority: "low",
        status: "completed",
        _meta: { cancelled: true },
      },
    ]);
    // Grok's turn-end cosmetic cleanup is metadata-free and non-durable.
    planUpdate(sessionId, undefined, undefined, [
      { content: "Verify", priority: "high", status: "completed" },
      {
        content: "Obsolete",
        priority: "low",
        status: "completed",
        _meta: { cancelled: true },
      },
    ]);
  }
  passiveXai(sessionId);
  if (scenario === "prompt_background_tool") {
    if (backgroundPromptId === undefined) {
      backgroundPromptId = promptId;
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "background-tool-1",
            title: "Background tool",
            status: "in_progress",
          },
          _meta: { eventId: `${promptId}-background-start`, promptId },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "background-tool-2",
            title: "Promptless background tool",
            status: "in_progress",
          },
          _meta: { eventId: `${promptId}-background-start-2`, promptId },
        },
      });
    } else {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "background-tool-1",
            status: "completed",
            rawOutput: { result: "settled during later prompt" },
          },
          _meta: {
            eventId: `${backgroundPromptId}-background-complete`,
            promptId: backgroundPromptId,
          },
        },
      });
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "background-tool-2",
            status: "completed",
            rawOutput: { result: "promptless settlement" },
          },
          _meta: {
            eventId: `${backgroundPromptId}-background-complete-2`,
          },
        },
      });
    }
  }
  if (
    scenario === "prompt_tool_wrong_prompt" ||
    scenario === "prompt_tool_missing_prompt"
  ) {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "mis-correlated-tool",
          title: "Wrong prompt tool",
          status: "in_progress",
        },
        _meta: {
          eventId: `${promptId}-wrong-tool`,
          ...(scenario === "prompt_tool_wrong_prompt"
            ? { promptId: "another-prompt" }
            : {}),
        },
      },
    });
    return;
  }
  if (scenario === "prompt_malformed_terminal") {
    send({
      jsonrpc: "2.0",
      method: "_x.ai/session_notification",
      params: {
        sessionId,
        update: { sessionUpdate: "turn_completed", stop_reason: "end_turn" },
        _meta: { eventId: `${promptId}-malformed-terminal` },
      },
    });
    return;
  }
  if (scenario === "prompt_tool") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "tool-1",
          title: "read_file",
          kind: "other",
          status: "pending",
          rawInput: {},
        },
        _meta: { eventId: `${promptId}-tool`, promptId },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-1",
          title: "Read native Grok documentation",
          kind: "read",
          status: "completed",
          rawInput: {},
        },
        // Exact Grok may omit promptId from sparse updates after the initial
        // prompt-correlated tool event. The toolCallId is the continuity key.
        _meta: { eventId: `${promptId}-tool-update` },
      },
    });
  }
  if (
    scenario === "prompt_subagent" ||
    scenario === "prompt_subagent_burst" ||
    scenario === "prompt_subagent_identity_conflict"
  ) {
    const childSessionId = "child-reviewer-1";
    const childPromptId = "child-reviewer-prompt-1";
    subagentSpawned(sessionId, promptId, childSessionId);
    if (scenario === "prompt_subagent_identity_conflict") {
      send({
        jsonrpc: "2.0",
        method: "_x.ai/session_notification",
        params: {
          sessionId,
          update: {
            sessionUpdate: "subagent_finished",
            subagent_id: "conflicting-reviewer",
            child_session_id: childSessionId,
            status: "completed",
            tool_calls: 1,
            turns: 1,
            duration_ms: 25,
            tokens_used: 10,
            output: "contradictory identity",
            will_wake: false,
          },
          _meta: {
            eventId: `${promptId}-subagent-finished-conflict`,
            promptId,
          },
        },
      });
      return;
    }
    subagentProgress(sessionId, childSessionId);
    textUpdate(
      childSessionId,
      `${childPromptId}-user`,
      "user_message_chunk",
      "Review the change",
      undefined,
    );
    textUpdate(
      childSessionId,
      `${childPromptId}-thought`,
      "agent_thought_chunk",
      "Reviewing",
      childPromptId,
    );
    if (scenario === "prompt_subagent_burst") {
      for (let index = 0; index < 512; index += 1) {
        textUpdate(
          childSessionId,
          `${childPromptId}-burst-${index}`,
          "agent_thought_chunk",
          "reviewing",
          childPromptId,
        );
      }
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: childSessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "child-tool-1",
          title: "Inspect diff",
          kind: "execute",
          status: "completed",
          rawOutput: { output: [111, 107] },
        },
        _meta: { eventId: `${childPromptId}-tool`, promptId: childPromptId },
      },
    });
    terminal(childSessionId, childPromptId);
    subagentFinished(sessionId, promptId, childSessionId);
  }
  textUpdate(
    sessionId,
    `${promptId}-assistant-1`,
    "agent_message_chunk",
    "fake ",
    promptId,
  );
  if (scenario === "prompt_subagent_burst") {
    for (let index = 0; index < 256; index += 1) {
      textUpdate(
        sessionId,
        `${promptId}-parent-burst-${index}`,
        "agent_thought_chunk",
        "reviewing",
        promptId,
      );
    }
  }
  if (scenario === "prompt_user_after_acceptance") {
    textUpdate(
      sessionId,
      `${promptId}-late-user`,
      "user_message_chunk",
      "late",
      promptId,
    );
    return;
  }
  if (scenario === "prompt_hang_after_acceptance") return;
  const complete = () => {
    textUpdate(
      sessionId,
      `${promptId}-assistant-2`,
      "agent_message_chunk",
      "answer",
      promptId,
    );
    send({
      jsonrpc: "2.0",
      method: "_x.ai/session/prompt_complete",
      params: { sessionId, stopReason: "end_turn" },
    });
    terminal(sessionId, promptId);
    if (storePath)
      writeFileSync(
        storePath,
        JSON.stringify({ sessionId, promptId, promptText, scenario }),
      );
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn" },
    });
  };
  if (scenario === "prompt_delayed_completion") setTimeout(complete, 50);
  else complete();
}

input.on("line", (line) => {
  const message = JSON.parse(line);
  if (
    permissionPrompt &&
    message.id === "permission-1" &&
    message.method === undefined
  ) {
    if (
      JSON.stringify(message.result) !==
      JSON.stringify({ outcome: { outcome: "selected", optionId: "allow" } })
    ) {
      process.exitCode = 2;
      input.close();
      return;
    }
    const pending = permissionPrompt;
    permissionPrompt = undefined;
    finishPrompt(pending, true);
    return;
  }
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {
            embeddedContext: true,
            ...(scenario === "prompt_images" ? { image: true } : {}),
          },
          sessionCapabilities: { list: {}, resume: {}, close: {} },
        },
        authMethods: [{ id: "cached_token", name: "Cached token" }],
        _meta: {
          modelState: {
            currentModelId: "grok-build",
            availableModels: [
              {
                modelId: "grok-build",
                name: "Grok Build",
                _meta: {
                  supportsReasoningEffort: true,
                  reasoningEffort: "low",
                  reasoningEfforts: [
                    { value: "low", default: true },
                    { value: "high", default: false },
                  ],
                },
              },
            ],
          },
        },
      },
    });
    return;
  }
  if (message.method === "authenticate") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "_x.ai/session/updates") {
    const sessionId = message.params.sessionId;
    if (scenario === "create_refresh_carrier_failure") {
      process.exit(24);
      return;
    }
    if (scenario === "history_page_prompt_priority") {
      const updates = Array.from({ length: 12 }, (_, index) => ({
        timestamp: index,
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `history-${index}` },
          },
          _meta: { eventId: `history-${index}`, promptId: `prompt-${index}` },
        },
      }));
      if (message.params.offset !== undefined) return;
      for (const [index, stored] of updates.entries()) {
        send({
          jsonrpc: "2.0",
          method: "_x.ai/session/updates/chunk",
          params: {
            sessionId,
            index,
            updates: [stored],
            done: index === updates.length - 1,
          },
        });
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          totalCount: updates.length,
          chunkCount: updates.length,
          promptStarts: updates.map((_, index) => index),
        },
      });
      return;
    }
    const text =
      sessionId === "created-1" && scenario === "normal"
        ? "early live"
        : sessionId === "created-1" && scenario === "create_history_invalid"
          ? "invalid history"
          : sessionId === "history-1"
            ? "native history"
            : sessionId.startsWith("created-")
              ? undefined
              : "replayed";
    const promptId = `stored-${sessionId}`;
    const saved =
      storePath && existsSync(storePath)
        ? JSON.parse(readFileSync(storePath, "utf8"))
        : undefined;
    const updates = saved
      ? [
          {
            timestamp: 1,
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "user_message_chunk",
                content: { type: "text", text: saved.promptText },
              },
              _meta: {
                eventId: `stored-${saved.promptId}-user`,
                promptId: saved.promptId,
              },
            },
          },
          {
            timestamp: 2,
            method: "session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: "fake answer" },
              },
              _meta: {
                eventId: `stored-${saved.promptId}-agent`,
                promptId: saved.promptId,
              },
            },
          },
          {
            timestamp: 3,
            method: "_x.ai/session/update",
            params: {
              sessionId,
              update: {
                sessionUpdate: "turn_completed",
                prompt_id: saved.promptId,
                stop_reason: "end_turn",
              },
              _meta: {
                eventId: `stored-${saved.promptId}-terminal`,
                promptId: saved.promptId,
              },
            },
          },
        ]
      : text === undefined
        ? []
        : [
            {
              timestamp: 1,
              method: "session/update",
              params: {
                sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text },
                },
                _meta: { eventId: `stored-${sessionId}-agent`, promptId },
              },
            },
          ];
    if (saved?.scenario === "prompt_plan") {
      updates.splice(1, 0, {
        timestamp: 2,
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: "Verify", priority: "high", status: "in_progress" },
              {
                content: "Obsolete",
                priority: "low",
                status: "completed",
                _meta: { cancelled: true },
              },
            ],
          },
          _meta: {
            eventId: `stored-${saved.promptId}-plan`,
            promptId: saved.promptId,
          },
        },
      });
    }
    if (saved?.scenario === "prompt_subagent") {
      const childSessionId = "child-reviewer-1";
      updates.splice(
        1,
        0,
        {
          timestamp: 2,
          method: "_x.ai/session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "subagent_spawned",
              subagent_id: childSessionId,
              parent_session_id: sessionId,
              parent_prompt_id: saved.promptId,
              child_session_id: childSessionId,
              subagent_type: "reviewer",
              description: "Review fixture",
            },
            _meta: { eventId: `${saved.promptId}-subagent-spawned` },
          },
        },
        {
          timestamp: 3,
          method: "_x.ai/session/update",
          params: {
            sessionId,
            update: {
              sessionUpdate: "subagent_finished",
              subagent_id: childSessionId,
              child_session_id: childSessionId,
              status: "completed",
              tool_calls: 2,
              turns: 1,
              duration_ms: 250,
              tokens_used: 400,
              output: "Looks good",
              will_wake: false,
            },
            _meta: { eventId: `${saved.promptId}-subagent-finished` },
          },
        },
      );
    }
    if (scenario === "create_history_invalid" && updates[0]) {
      updates[0].params._meta.isReplay = false;
    }
    const start = message.params.offset ?? 0;
    const selected = updates.slice(
      start,
      message.params.limit === undefined
        ? undefined
        : start + message.params.limit,
    );
    for (const [index, stored] of selected.entries()) {
      send({
        jsonrpc: "2.0",
        method: "_x.ai/session/updates/chunk",
        params: {
          sessionId,
          index,
          updates: [stored],
          done: index === selected.length - 1,
        },
      });
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        totalCount: updates.length,
        chunkCount: selected.length,
        lastEventId: "native-history-1",
        promptStarts: updates.length === 0 ? [] : [0],
      },
    });
    return;
  }
  if (scenario === "auth_failure" && message.method === "session/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32000, message: "authentication required" },
    });
    return;
  }
  if (message.method === "session/list") {
    const secondPage = message.params.cursor === "next-page";
    const duplicate = scenario === "list_duplicate";
    const cycle = scenario === "list_cycle";
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessions: [
          {
            sessionId: secondPage && !duplicate ? "listed-2" : "listed-1",
            cwd: message.params.cwd,
            title: secondPage ? "Second session" : "Listed session",
            updatedAt: "2026-08-16T12:00:00.000Z",
          },
        ],
        ...(secondPage && !cycle ? {} : { nextCursor: "next-page" }),
      },
    });
    return;
  }
  if (message.method === "session/new") {
    const notificationSession =
      scenario === "create_mismatch" ? "wrong-session" : "created-1";
    if (!scenario.startsWith("prompt"))
      update(notificationSession, "new-early", "early live");
    setTimeout(
      () =>
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            sessionId: "created-1",
            _meta: sessionConfiguration(
              message.params._meta?.modelId,
              message.params._meta?.reasoningEffort,
            ),
          },
        }),
      5,
    );
    return;
  }
  if (message.method === "session/load") {
    if (message.params._meta?.noReplay !== true) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "noReplay required" },
      });
      return;
    }
    if (storePath && existsSync(storePath)) {
      const saved = JSON.parse(readFileSync(storePath, "utf8"));
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { _meta: sessionConfiguration() },
      });
      return;
    }
    textUpdate(
      message.params.sessionId,
      "load-live",
      "agent_message_chunk",
      "early live",
      `stored-${message.params.sessionId}`,
    );
    if (scenario === "load_failure") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32603, message: "load failed" },
      });
    } else {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { _meta: sessionConfiguration() },
      });
      if (scenario === "load_post_response_replay") {
        update(message.params.sessionId, "late-replay", "late replay", true);
      } else if (scenario === "load_post_response_subagent_replay") {
        subagentSpawned(
          message.params.sessionId,
          "late-replay-prompt",
          "late-replay-child",
          true,
        );
      }
    }
    return;
  }
  if (message.method === "session/resume") {
    textUpdate(
      message.params.sessionId,
      "resume-early",
      "agent_message_chunk",
      "resumed early live",
      `stored-${message.params.sessionId}`,
      scenario === "resume_replay",
    );
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { _meta: sessionConfiguration() },
    });
    return;
  }
  if (message.method === "session/close") {
    update(message.params.sessionId, "close-final", "final before close");
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "session/prompt") {
    if (scenario === "prompt_auth_rejection") {
      rejectPrompt(message, -32000);
      return;
    }
    if (scenario === "prompt_remote_rejection") {
      rejectPrompt(message);
      return;
    }
    if (scenario === "prompt_permission") {
      permissionPrompt = message;
      textUpdate(
        message.params.sessionId,
        `${message.params._meta.promptId}-user-permission`,
        "user_message_chunk",
        message.params.prompt[0].text,
        undefined,
      );
      send({
        jsonrpc: "2.0",
        id: "permission-1",
        method: "session/request_permission",
        params: {
          sessionId: message.params.sessionId,
          toolCall: {
            toolCallId: "tool-1",
            title: "forbidden",
            kind: "other",
            status: "pending",
            rawInput: {},
          },
          options: [
            { optionId: "always", name: "Always", kind: "allow_always" },
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "deny", name: "Deny", kind: "reject_once" },
          ],
        },
      });
      return;
    }
    finishPrompt(message);
  }
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => process.exit(0));
}
