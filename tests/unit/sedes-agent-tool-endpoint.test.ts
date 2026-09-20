import { describe, expect, it } from "vitest";
import {
  SEDES_AGENT_TOOL_MAXIMUM_UNIX_SOCKET_PATH_BYTES,
  normalizeSedesAgentToolEndpoint,
} from "../../src/cli/sedes-agent-tool-endpoint.js";

describe("Sedes agent-tool endpoint", () => {
  it("normalizes strict HTTP(S) origins", () => {
    expect(normalizeSedesAgentToolEndpoint("http://127.0.0.1:4784")).toEqual({
      type: "http",
      origin: new URL("http://127.0.0.1:4784"),
    });
    expect(
      normalizeSedesAgentToolEndpoint("https://sedes.example"),
    ).toEqual({ type: "http", origin: new URL("https://sedes.example") });
  });

  it("accepts only canonical absolute bounded Unix socket URLs", () => {
    expect(
      normalizeSedesAgentToolEndpoint("unix:///run/user/1000/sedes.sock"),
    ).toEqual({ type: "unix", socketPath: "/run/user/1000/sedes.sock" });

    for (const value of [
      "unix://remote/run/sedes.sock",
      "unix:///run/../tmp/sedes.sock",
      "unix:///run//sedes.sock",
      "unix:///run/sedes.sock?x=1",
      "unix:///run/sedes%20socket",
      `unix:///${"x".repeat(SEDES_AGENT_TOOL_MAXIMUM_UNIX_SOCKET_PATH_BYTES)}`,
    ]) {
      expect(() => normalizeSedesAgentToolEndpoint(value), value).toThrow(
        /canonical absolute Unix socket URL/u,
      );
    }
  });

  it("rejects missing, credentialed, routed, and unsupported endpoints", () => {
    for (const value of [
      undefined,
      "ftp://127.0.0.1/tool",
      "http://user:secret@127.0.0.1:4784",
      "http://127.0.0.1:4784/api",
      "https://sedes.example/?x=1",
      "https://sedes.example/#fragment",
    ]) {
      expect(() => normalizeSedesAgentToolEndpoint(value)).toThrow(
        /SEDES_AGENT_TOOL_ENDPOINT/u,
      );
    }
  });
});

it("requires an exact capability-bound Windows named pipe endpoint", async () => {
  const { createAgentToolCliNamedPipeEndpoint, parseAgentToolCliNamedPipeEndpoint, isAgentToolCliEndpoint } = await import("../../src/internal/agent-tool-cli-protocol/local-endpoint.js");
  const url = createAgentToolCliNamedPipeEndpoint();
  const endpoint = parseAgentToolCliNamedPipeEndpoint(url)!;
  expect(endpoint.socketPath).toMatch(/^\\\\\.\\pipe\\sedes-agent-tools-[0-9a-f]{64}$/u);
  expect(normalizeSedesAgentToolEndpoint(url)).toEqual(endpoint);
  expect(isAgentToolCliEndpoint(url)).toBe(true);
  for (const invalid of [
    url.replace("npipe://./", "npipe://other/"),
    url.replace("/pipe/", "/PIPE/"),
    url.replace("sedes-agent-tools-", "arbitrary-"),
    url.split("#")[0]!,
    `${url.split("#")[0]}#${"0".repeat(64)}`,
    url.toUpperCase(),
    `${url}?query=1`,
    "npipe://./pipe/arbitrary",
    "unix://C:/pipe/sedes",
    "unix:///C:/pipe/sedes\\socket",
  ]) {
    expect(isAgentToolCliEndpoint(invalid), invalid).toBe(false);
    expect(() => normalizeSedesAgentToolEndpoint(invalid), invalid).toThrow();
  }
});
