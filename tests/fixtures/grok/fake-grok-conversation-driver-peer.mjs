#!/usr/bin/env node
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

if (process.argv[2] === "version" && process.argv[3] === "--json") {
  process.stdout.write(
    `${JSON.stringify({ currentVersion: "1.0.4 (d846eb93d9)" })}\n`,
  );
  process.exit(0);
}

const statePath = path.join(process.cwd(), ".fake-grok-driver-state.json");
await mutate((state) => {
  state.processStarts = (state.processStarts ?? 0) + 1;
  state.observedSedesAuthority ??= [];
  state.observedSedesAuthority.push({
    endpointPresent: process.env.SEDES_AGENT_TOOL_ENDPOINT !== undefined,
    sourceCapabilityPresent:
      process.env.SEDES_AGENT_TOOL_SOURCE_CAPABILITY !== undefined,
    clientTokenPresent:
      process.env.SEDES_AGENT_TOOL_CLIENT_TOKEN !== undefined,
  });
});
const input = readline.createInterface({ input: process.stdin });
const activePrompts = new Map();

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

function update(sessionId, kind, eventId, text, promptId, replay = true) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: kind,
        content: { type: "text", text },
      },
      _meta: {
        eventId,
        ...(replay ? { isReplay: true } : {}),
        ...(promptId ? { promptId } : {}),
      },
    },
  });
}

function updateAttachment(
  sessionId,
  eventId,
  attachment,
  promptId,
  replay = true,
) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "user_message_chunk",
        content: attachment,
      },
      _meta: {
        eventId,
        ...(replay ? { isReplay: true } : {}),
        ...(promptId ? { promptId } : {}),
      },
    },
  });
}

function terminal(
  sessionId,
  promptId,
  replay = true,
  eventId = "event-terminal",
  stopReason = "end_turn",
) {
  send({
    jsonrpc: "2.0",
    method: replay ? "_x.ai/session/update" : "_x.ai/session_notification",
    params: {
      sessionId,
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: promptId,
        stop_reason: stopReason,
      },
      _meta: {
        eventId,
        promptId,
        ...(replay ? { isReplay: true } : {}),
      },
    },
  });
}

function storedText(sessionId, kind, eventId, text, promptId) {
  return {
    timestamp: 0,
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: kind, content: { type: "text", text } },
      _meta: { eventId, ...(promptId ? { promptId } : {}) },
    },
  };
}

function storedAttachment(sessionId, eventId, content, promptId) {
  return {
    timestamp: 0,
    method: "session/update",
    params: {
      sessionId,
      update: { sessionUpdate: "user_message_chunk", content },
      _meta: { eventId, promptId },
    },
  };
}

function storedTerminal(sessionId, promptId, eventId, stopReason = "end_turn") {
  return {
    timestamp: 0,
    method: "_x.ai/session/update",
    params: {
      sessionId,
      update: {
        sessionUpdate: "turn_completed",
        prompt_id: promptId,
        stop_reason: stopReason,
      },
      _meta: { eventId, promptId },
    },
  };
}

function storedHistory(session) {
  const updates = [];
  const promptStarts = [];
  if (session.history === "correlated") {
    promptStarts.push(updates.length);
    updates.push(
      storedText(
        session.sessionId,
        "user_message_chunk",
        "event-user",
        "hello",
        "prompt-1",
      ),
      storedText(
        session.sessionId,
        "agent_thought_chunk",
        "event-reasoning",
        "thinking",
        "prompt-1",
      ),
      storedText(
        session.sessionId,
        "agent_message_chunk",
        "event-agent",
        "world",
        "prompt-1",
      ),
      storedTerminal(session.sessionId, "prompt-1", "event-terminal"),
    );
  } else if (session.history === "uncorrelated") {
    updates.push(
      storedText(
        session.sessionId,
        "user_message_chunk",
        "event-uncorrelated",
        "uncorrelated",
      ),
    );
  }
  for (const [index, submission] of (session.submissions ?? []).entries()) {
    const suffix = `${index}-${submission.promptId.slice(-8)}`;
    promptStarts.push(updates.length);
    if (submission.ignored === true) {
      updates.push({
        timestamp: 0,
        method: "_x.ai/session/update",
        params: {
          sessionId: session.sessionId,
          update: { sessionUpdate: "retry_state", additive: "ignored" },
          _meta: {
            eventId: `submission-ignored-${suffix}`,
            promptId: submission.promptId,
          },
        },
      });
      continue;
    }
    if (submission.text) {
      updates.push(
        storedText(
          session.sessionId,
          "user_message_chunk",
          `submission-user-${suffix}`,
          submission.text,
          submission.promptId,
        ),
      );
    }
    for (const [imageIndex, image] of (submission.images ?? []).entries()) {
      updates.push(
        storedAttachment(
          session.sessionId,
          `submission-image-${suffix}-${imageIndex}`,
          image,
          submission.promptId,
        ),
      );
    }
    for (const [resourceIndex, resource] of (
      submission.resourceLinks ?? []
    ).entries()) {
      updates.push(
        storedAttachment(
          session.sessionId,
          `submission-resource-${suffix}-${resourceIndex}`,
          resource,
          submission.promptId,
        ),
      );
    }
    updates.push(
      storedText(
        session.sessionId,
        "agent_thought_chunk",
        `submission-thought-${suffix}`,
        "thinking",
        submission.promptId,
      ),
    );
    if (submission.completed) {
      if (submission.stopReason !== "cancelled") {
        updates.push(
          storedText(
            session.sessionId,
            "agent_message_chunk",
            `submission-agent-${suffix}`,
            submission.answer ?? "done",
            submission.promptId,
          ),
        );
      }
      updates.push(
        storedTerminal(
          session.sessionId,
          submission.promptId,
          `submission-terminal-${suffix}`,
          submission.stopReason ?? "end_turn",
        ),
      );
    }
  }
  return { updates, promptStarts };
}

input.on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.method === "session/cancel") {
    const sessionId = message.params?.sessionId;
    const active = activePrompts.get(sessionId);
    let ignoreCancel = false;
    await mutate((state) => {
      const session = state.sessions.find(
        (candidate) => candidate.sessionId === sessionId,
      );
      if (session) {
        session.cancelCalls = (session.cancelCalls ?? 0) + 1;
        ignoreCancel = session.ignoreCancel === true;
      }
    });
    if (active && !active.cancelled && !ignoreCancel) {
      active.cancelled = true;
      active.resolve();
    }
    return;
  }
  if (message.id === undefined) return;
  if (message.method === "initialize") {
    const state = await readState();
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { embeddedContext: true },
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
                  ...(typeof state.modelImageInput === "boolean"
                    ? { acceptsImages: state.modelImageInput }
                    : {}),
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
    const state = await readState();
    const session = state.sessions.find(
      ({ sessionId }) => sessionId === message.params.sessionId,
    );
    if (!session) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "unknown session" },
      });
      return;
    }
    const native = storedHistory(session);
    let start = message.params.offset ?? 0;
    if (
      message.params.turnIndex !== undefined &&
      native.promptStarts.length >= message.params.turnIndex
    ) {
      start = native.promptStarts.at(-message.params.turnIndex);
    }
    const selected = native.updates.slice(
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
          sessionId: session.sessionId,
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
        totalCount: native.updates.length,
        chunkCount: selected.length,
        promptStarts: native.promptStarts,
      },
    });
    return;
  }
  if (message.method === "session/list") {
    const state = await readState();
    const offset = message.params.cursor
      ? Number(message.params.cursor.replace("offset-", ""))
      : 0;
    const session = state.sessions[offset];
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        sessions: session
          ? [
              {
                sessionId: session.sessionId,
                cwd: process.cwd(),
                title: session.title,
                updatedAt: session.updatedAt,
              },
            ]
          : [],
        ...(offset + 1 < state.sessions.length
          ? { nextCursor: `offset-${offset + 1}` }
          : {}),
      },
    });
    return;
  }
  if (message.method === "session/new") {
    let created;
    let invalidResponse = false;
    await mutate((state) => {
      invalidResponse = state.createResponseInvalid === true;
      created = {
        sessionId: `created-${state.nextId++}`,
        title: "",
        updatedAt: "2026-08-16T12:00:00.000Z",
        history: "empty",
        closeCount: 0,
      };
      state.sessions.push(created);
    });
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: invalidResponse
        ? { sessionId: 42 }
        : {
            sessionId: created.sessionId,
            _meta: sessionConfiguration(
              message.params._meta?.modelId,
              message.params._meta?.reasoningEffort,
            ),
          },
    });
    return;
  }
  if (message.method === "_x.ai/session/rename") {
    const before = await readState();
    const session = before.sessions.find(
      ({ sessionId }) => sessionId === message.params?.sessionId,
    );
    if (
      !session ||
      message.params?.cwd !== process.cwd() ||
      message.params?.kind !== "build" ||
      message.params?.resetToAuto !== false ||
      typeof message.params?.title !== "string"
    ) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "invalid rename" },
      });
      return;
    }
    if (session.renameBehavior === "remote_error") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "rename rejected" },
      });
      return;
    }
    await mutate((state) => {
      const current = state.sessions.find(
        ({ sessionId }) => sessionId === message.params.sessionId,
      );
      if (current) {
        current.title = message.params.title;
        current.renameCalls = (current.renameCalls ?? 0) + 1;
        current.lastRenameRequest = message.params;
      }
    });
    if (session.renameBehavior === "unknown_after_apply") {
      process.exitCode = 24;
      input.close();
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: { success: true } });
    return;
  }
  if (message.method === "session/load") {
    const state = await readState();
    const session = state.sessions.find(
      ({ sessionId }) => sessionId === message.params.sessionId,
    );
    if (!session) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "unknown session" },
      });
      return;
    }
    if (session.history === "method_missing") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "method not found" },
      });
      return;
    }
    if (message.params._meta?.noReplay !== true) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "noReplay required" },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { _meta: sessionConfiguration() },
    });
    if (session.history === "post_response") {
      update(
        session.sessionId,
        "agent_message_chunk",
        "event-live-agent",
        "after response",
        "prompt-live",
        false,
      );
    } else if (session.history === "post_response_forged") {
      setTimeout(() => {
        update(
          session.sessionId,
          "agent_message_chunk",
          "event-live-forged",
          "forged",
          "sedes-grok:v1:malformed",
          false,
        );
      }, 20);
    }
    return;
  }
  if (message.method === "session/prompt") {
    const state = await readState();
    const session = state.sessions.find(
      ({ sessionId }) => sessionId === message.params.sessionId,
    );
    if (!session) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "unknown session" },
      });
      return;
    }
    const behavior =
      session.promptBehavior ?? state.promptBehavior ?? "complete";
    await mutate((next) => {
      const current = next.sessions.find(
        ({ sessionId }) => sessionId === message.params.sessionId,
      );
      if (current) current.promptCalls = (current.promptCalls ?? 0) + 1;
    });
    if (behavior === "remote_error") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "prompt rejected" },
      });
      return;
    }
    const promptId = message.params._meta?.promptId;
    const prompt = message.params.prompt ?? [];
    const text = prompt
      .filter((content) => content.type === "text")
      .map((content) => content.text)
      .join(" ");
    const images = prompt.filter((content) => content.type === "image");
    const resourceLinks = prompt.filter(
      (content) => content.type === "resource_link",
    );
    await mutate((next) => {
      const current = next.sessions.find(
        ({ sessionId }) => sessionId === message.params.sessionId,
      );
      if (!current) return;
      current.submissions ??= [];
      current.submissions.push({
        promptId,
        text,
        images,
        resourceLinks,
        prompt,
        completed: false,
      });
    });
    if (behavior === "unknown") {
      process.exitCode = 23;
      input.close();
      return;
    }
    if (
      behavior === "remote_after_user" ||
      behavior === "remote_after_partial_user"
    ) {
      update(
        session.sessionId,
        "user_message_chunk",
        `live-user-${promptId.slice(-8)}`,
        behavior === "remote_after_partial_user"
          ? text.slice(0, Math.max(1, Math.floor(text.length / 2)))
          : text,
        promptId,
        false,
      );
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "prompt rejected after traffic" },
      });
      return;
    }
    if (text) {
      update(
        session.sessionId,
        "user_message_chunk",
        `live-user-${promptId.slice(-8)}`,
        text,
        promptId,
        false,
      );
    }
    for (const [imageIndex, image] of images.entries()) {
      updateAttachment(
        session.sessionId,
        `live-image-${promptId.slice(-8)}-${imageIndex}`,
        image,
        promptId,
        false,
      );
    }
    for (const [resourceIndex, resource] of resourceLinks.entries()) {
      updateAttachment(
        session.sessionId,
        `live-resource-${promptId.slice(-8)}-${resourceIndex}`,
        resource,
        promptId,
        false,
      );
    }
    const promptChunkCount = session.promptChunkCount ?? 1;
    for (let index = 0; index < promptChunkCount; index += 1) {
      update(
        session.sessionId,
        "agent_thought_chunk",
        `live-thought-${promptId.slice(-8)}-${index}`,
        promptChunkCount === 1 ? "thinking" : "x",
        promptId,
        false,
      );
    }
    if (session.emitRelativeToolLocation === true) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: `tool-relative-location-${promptId.slice(-8)}`,
            title: "Inspect repository file",
            kind: "read",
            status: "in_progress",
            rawInput: {},
            locations: [{ path: "src/example.ts" }],
          },
          _meta: {
            eventId: `live-tool-${promptId.slice(-8)}`,
            promptId,
          },
        },
      });
    }
    if (behavior === "invalid_after_acceptance") {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: 42 },
          },
        },
      });
      return;
    }
    let resolveCancellation;
    const cancellation = new Promise((resolve) => {
      resolveCancellation = resolve;
    });
    const activePrompt = {
      promptId,
      cancelled: false,
      resolve: resolveCancellation,
    };
    activePrompts.set(session.sessionId, activePrompt);
    let timer;
    const delay = new Promise((resolve) => {
      timer = setTimeout(
        resolve,
        session.promptDelayMs ?? state.promptDelayMs ?? 25,
      );
    });
    await Promise.race([delay, cancellation]);
    clearTimeout(timer);
    if (activePrompts.get(session.sessionId) === activePrompt) {
      activePrompts.delete(session.sessionId);
    }
    if (activePrompt.cancelled) {
      terminal(
        session.sessionId,
        promptId,
        false,
        `live-terminal-${promptId.slice(-8)}`,
        "cancelled",
      );
      await mutate((next) => {
        const current = next.sessions.find(
          ({ sessionId }) => sessionId === message.params.sessionId,
        );
        const submission = current?.submissions?.findLast(
          (candidate) => candidate.promptId === promptId,
        );
        if (submission) {
          submission.completed = true;
          submission.stopReason = "cancelled";
          submission.answer = null;
        }
      });
      if (session.promptResponseDelayMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, session.promptResponseDelayMs),
        );
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { stopReason: "cancelled" },
      });
      return;
    }
    if (session.emitRelativeToolLocation === true) {
      send({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: `tool-relative-location-${promptId.slice(-8)}`,
            status: "completed",
            rawOutput: {
              type: "Bash",
              output: [111, 107],
              output_for_prompt: "ok",
              exit_code: 0,
              command: "printf ok",
              truncated: false,
              signal: null,
              timed_out: false,
              description: "Emit a short result",
              current_dir: "/workspace",
              output_file: "",
              total_bytes: 2,
            },
          },
          _meta: {
            eventId: `live-tool-complete-${promptId.slice(-8)}`,
            promptId,
          },
        },
      });
    }
    update(
      session.sessionId,
      "agent_message_chunk",
      `live-agent-${promptId.slice(-8)}`,
      "done",
      promptId,
      false,
    );
    terminal(
      session.sessionId,
      promptId,
      false,
      `live-terminal-${promptId.slice(-8)}`,
    );
    await mutate((next) => {
      const current = next.sessions.find(
        ({ sessionId }) => sessionId === message.params.sessionId,
      );
      const submission = current?.submissions?.findLast(
        (candidate) => candidate.promptId === promptId,
      );
      if (submission) {
        submission.completed = true;
        submission.stopReason = "end_turn";
        submission.answer = "done";
      }
    });
    if (session.promptResponseDelayMs) {
      await new Promise((resolve) =>
        setTimeout(resolve, session.promptResponseDelayMs),
      );
    }
    if (session.omitPromptResponse === true) return;
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn" },
    });
    return;
  }
  if (message.method === "session/close") {
    const before = await readState();
    const closing = before.sessions.find(
      ({ sessionId }) => sessionId === message.params.sessionId,
    );
    if (closing?.closeBehavior === "remote_error") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32602, message: "close rejected" },
      });
      return;
    }
    await mutate((state) => {
      const session = state.sessions.find(
        ({ sessionId }) => sessionId === message.params.sessionId,
      );
      if (session) session.closeCount = (session.closeCount ?? 0) + 1;
    });
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});

async function readState() {
  try {
    return normalize(JSON.parse(await readFile(statePath, "utf8")));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return normalize({});
  }
}

async function mutate(apply) {
  const state = await readState();
  apply(state);
  const temporary = `${statePath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, statePath);
}

function normalize(value) {
  return {
    nextId: Number.isSafeInteger(value.nextId) ? value.nextId : 1,
    processStarts: Number.isSafeInteger(value.processStarts)
      ? value.processStarts
      : 0,
    createResponseInvalid: value.createResponseInvalid === true,
    promptBehavior:
      typeof value.promptBehavior === "string"
        ? value.promptBehavior
        : undefined,
    promptDelayMs: Number.isSafeInteger(value.promptDelayMs)
      ? value.promptDelayMs
      : undefined,
    modelImageInput:
      typeof value.modelImageInput === "boolean"
        ? value.modelImageInput
        : undefined,
    observedSedesAuthority: Array.isArray(value.observedSedesAuthority)
      ? value.observedSedesAuthority
      : [],
    sessions: Array.isArray(value.sessions) ? value.sessions : [],
  };
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => process.exit(0));
}
