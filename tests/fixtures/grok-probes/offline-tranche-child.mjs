#!/usr/bin/env node
import readline from "node:readline";

const [scenario = "o1-quiet"] = process.argv.slice(2);

if (scenario === "o1-stdout") {
  process.stdout.write('{"unexpected":true}\n');
} else if (scenario === "o1-partial-stdout") {
  process.stdout.write("unexpected-partial-stdout");
  process.stdin.resume();
} else if (scenario === "exit") {
  process.exitCode = 0;
} else if (
  scenario === "o2a" ||
  scenario === "o2a-extra-cancel" ||
  scenario === "o2a-unsafe-meta" ||
  scenario === "o2a-exit-after-response" ||
  scenario === "o2a-unused-notification" ||
  scenario === "o2a-unused-notification-first" ||
  scenario === "o2a-unused-notification-overflow"
) {
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const request = JSON.parse(line);
    if (request.method !== "initialize") process.exit(71);
    const initializeResponseLine = `${JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: {
            image: true,
            audio: false,
            embeddedContext: true,
            _meta: {
              "unknown-prompt-secret-label": { private: "not-projected" },
            },
          },
          mcpCapabilities: { http: true, sse: false, acp: true },
          sessionCapabilities: {
            list: {},
            fork: {},
            resume: {},
            close: {},
          },
          auth: { logout: {} },
          providers: {},
          _meta:
            scenario === "o2a-unsafe-meta"
              ? { "unsafe key": true }
              : {
                  "x.ai/hooks": { private: "not-projected" },
                  "unknown-capability-secret-label": {
                    private: "not-projected",
                  },
                },
        },
        authMethods: [
          { id: "private-agent-id", name: "private agent" },
          {
            id: "private-env-id",
            name: "private env",
            type: "env_var",
            vars: [{ name: "PRIVATE_TOKEN" }],
          },
        ],
        agentInfo: {
          name: "fixture-provider-private-string",
          version: "fixture-provider-private-version",
        },
        _meta: {
          grokShell: { private: "not-projected" },
          "x.ai/pluginDirs": ["/private/provider/plugin"],
          "unknown-response-secret-label": { private: "not-projected" },
        },
      },
    })}\n`;
    const unusedNotificationLine = `${JSON.stringify({
      jsonrpc: "2.0",
      method: "fixture/private-unused-notification",
      params: { private: "fixture-private-unused-content" },
    })}\n`;
    if (scenario === "o2a-unused-notification-first") {
      process.stdout.write(unusedNotificationLine + initializeResponseLine);
      continue;
    }
    process.stdout.write(initializeResponseLine);
    if (scenario === "o2a-extra-cancel") {
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "$/cancel_request",
          params: { requestId: 999 },
        })}\n`,
      );
    }
    if (scenario === "o2a-unused-notification") {
      process.stdout.write(unusedNotificationLine);
    }
    if (scenario === "o2a-unused-notification-overflow") {
      process.stdout.write(unusedNotificationLine + unusedNotificationLine);
    }
    if (scenario === "o2a-exit-after-response") {
      await new Promise((resolve) => process.stdout.write("", resolve));
      process.exit(0);
    }
  }
} else if (scenario === "o2a-hang") {
  process.stdin.resume();
} else {
  process.stdin.resume();
}
