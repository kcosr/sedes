#!/usr/bin/env node
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

// Synthetic stand-in for the exact binary's one bounded, unused startup frame.
send({ jsonrpc: "2.0", method: "fixture/unknown_startup", params: {} });
process.stderr.write(
  `fixture paths ${process.env.GROK_HOME} ${process.env.HOME} ${process.cwd()}\n`,
);

input.on("line", (line) => {
  const message = JSON.parse(line);
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
            image: false,
            audio: false,
            futureField: "project-away",
          },
          sessionCapabilities: {
            list: {},
            resume: {},
            close: {},
          },
        },
        authMethods: [
          { id: "cached_token", name: "Cached token" },
          { id: "grok.com", name: "Grok.com" },
        ],
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
        futureField: "project-away",
      },
    });
    return;
  }
  if (message.method === "_x.ai/session/updates") {
    const sessionId = message.params.sessionId;
    if (message.params.offset === 777) {
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            totalCount: 0,
            chunkCount: 0,
            promptStarts: [],
          },
        });
      }, 100);
      return;
    }
    if (message.params.offset === 778) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          totalCount: 0,
          chunkCount: 0,
          promptStarts: [],
        },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "history-barrier" },
        },
      },
    });
    for (let index = 0; index < 2; index += 1) {
      send({
        jsonrpc: "2.0",
        method: "_x.ai/session/updates/chunk",
        params: {
          sessionId,
          index,
          updates: [
            {
              timestamp: index + 1,
              method: "session/update",
              params: {
                sessionId,
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: { type: "text", text: `history-${index + 1}` },
                },
              },
            },
          ],
          done: index === 1,
        },
      });
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        totalCount: 2,
        chunkCount: 2,
        lastEventId: "history-2",
        promptStarts: [],
      },
    });
    return;
  }
  if (message.method !== "authenticate") return;
  if (process.env.GROK_TEST_AUTH_FAILURE === "1") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      error: {
        code: -32000,
        message: "authentication required",
      },
    });
    return;
  }
  send({ jsonrpc: "2.0", id: message.id, result: {} });
  setTimeout(() => {
    const largeImage = "A".repeat(2 * 1024 * 1024);
    for (let index = 0; index < 300; index += 1) {
      send({
        jsonrpc: "2.0",
        method: "_x.ai/session_notification",
        params: {
          sessionId: "session-allowed",
          update: {
            sessionUpdate: "retry_state",
            attempt: index,
          },
        },
      });
    }
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-allowed",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-allowed",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "tool-output-regression",
          title: "Bounded terminal output",
          kind: "execute",
          status: "completed",
          rawOutput: {
            type: "Bash",
            output: Array.from({ length: 2_049 }, (_, index) => index % 256),
            output_for_prompt: "",
            exit_code: 0,
            command: "emit bounded output",
            truncated: false,
            signal: null,
            timed_out: false,
            description: "Emit bounded output",
            current_dir: "/workspace",
            output_file: "",
            total_bytes: 2_049,
          },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: "session-allowed",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "large-image-output-regression",
          status: "completed",
          content: [
            {
              type: "content",
              content: {
                type: "image",
                data: largeImage,
                mimeType: "image/jpeg",
              },
            },
          ],
          rawOutput: {
            type: "ImageContent",
            ImageContent: {
              data: largeImage,
              mime_type: "image/jpeg",
            },
          },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      method: "_x.ai/session/prompt_complete",
      params: {
        sessionId: "session-allowed",
        promptId: "prompt-1",
        stopReason: "end_turn",
        agentResult: null,
        additive: "project-away",
      },
    });
    send({
      jsonrpc: "2.0",
      method: "x.ai/session/update",
      params: {
        sessionId: "session-allowed",
        update: {
          sessionUpdate: "turn_completed",
          prompt_id: "prompt-1",
          stop_reason: "end_turn",
          agent_result: null,
          additive: "project-away",
        },
      },
    });
  }, 15);
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => process.exit(0));
}
