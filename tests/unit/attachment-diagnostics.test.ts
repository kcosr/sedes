import { afterEach, expect, it, vi } from "vitest";
import { attachmentDiagnostic, attachmentDiagnosticError } from "../../src/server/diagnostics/attachment-diagnostics.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("retains Claude machine codes while excluding provider exception text", () => {
  expect(attachmentDiagnosticError(new Error("claude_sdk_initialization_timeout")))
    .toEqual([{ name: "Error", code: "claude_sdk_initialization_timeout" }]);
  expect(attachmentDiagnosticError(new Error("Claude rejected private prompt text")))
    .toEqual([{ name: "Error" }]);
});

it("does not inspect diagnostic fields while disabled", () => {
  vi.stubEnv("SEDES_DEBUG_DELIVERY", "");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const fields = { get reason(): string { throw new Error("must not inspect"); } };
  expect(() => attachmentDiagnostic("attachment_lost", fields)).not.toThrow();
  expect(log).not.toHaveBeenCalled();
});

it("records bounded causes and known classes without exception text, stacks, or arbitrary properties", () => {
  const root = new Error("sidecar_unavailable");
  const database = Object.assign(new Error("SQL failed at /private/session with prompt-secret"), { name: "SqliteError", code: "SQLITE_CONSTRAINT_CHECK" });
  const remote = Object.assign(new Error("private-provider-content"), { name: "CodexRpcRemoteError", code: -32603, data: "private-payload" });
  root.cause = new AggregateError([database, remote, root], "private-aggregate-message");
  const result = attachmentDiagnosticError(root);
  expect(result).toEqual([{ name: "Error", code: "sidecar_unavailable" }, { name: "AggregateError" },
    { name: "SqliteError", code: "SQLITE_CONSTRAINT_CHECK" }, { name: "CodexRpcRemoteError", code: -32603 }]);
  expect(JSON.stringify(result)).not.toMatch(/private|prompt|stack/u);
  const chain = new Error("not-a-code");
  let current = chain;
  for (let index = 0; index < 20; index++) { current.cause = new Error("sidecar_closed"); current = current.cause as Error; }
  expect(attachmentDiagnosticError(chain)).toHaveLength(4);
});

it("redacts unsafe close reasons, signals and classes and ignores unrecognized fields", () => {
  vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  attachmentDiagnostic("attachment_lost", { reason: "/private/token", signal: "SECRET", backendInstanceId: "backend", durationMs: 12.346,
    ...{ payload: "must-not-serialize" } }, Object.assign(new Error("/private/token"), { name: "SecretClass" }));
  expect(log).toHaveBeenCalledOnce();
  expect(JSON.parse(String(log.mock.calls[0]![0]).replace("[delivery-attachment] ", ""))).toMatchObject({
    event: "attachment_lost", reason: "redacted", signal: "redacted", backendInstanceId: "backend", durationMs: 12.35, errors: [{ name: "Error" }],
  });
  expect(log.mock.calls[0]![0]).not.toMatch(/private|SECRET|SecretClass|must-not-serialize/u);
});

it("never throws when exception inspection or the log sink fails", () => {
  vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
  const error = new Error("private");
  Object.defineProperty(error, "name", { get() { throw new Error("getter failed"); } });
  expect(attachmentDiagnosticError(error)).toEqual([{ name: "DiagnosticUnavailable" }]);
  vi.spyOn(console, "error").mockImplementation(() => { throw new Error("logger failed"); });
  expect(() => attachmentDiagnostic("attachment_lost", {}, error)).not.toThrow();
});
