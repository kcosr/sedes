#!/usr/bin/env node
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
let initialized = false;
let authenticated = false;

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    initialized = true;
    reply(request.id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: true },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
      authMethods: [{ id: "cached_token", name: "Cached token" }],
    });
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", method: "x.ai/unused", params: { secret: "never-retained" } })}\n`,
    );
    return;
  }
  if (!initialized) process.exit(41);
  if (request.method === "authenticate") {
    if (request.params?.methodId !== "cached_token") process.exit(42);
    authenticated = true;
    reply(request.id, {});
    return;
  }
  if (!authenticated) process.exit(43);
  if (request.method === "session/list") {
    reply(request.id, {
      sessions: [],
      ...(process.env.FAKE_GROK_NEXT_CURSOR === "1"
        ? { nextCursor: "fixture-cursor" }
        : {}),
    });
    return;
  }
  process.exit(44);
});

input.on("close", () => process.exit(0));
