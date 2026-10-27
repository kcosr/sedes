import { afterEach, expect, it, vi } from "vitest";
import { PiNativeReadDiagnostics } from "../../src/server/backends/pi/native/diagnostics.js";
import { PiNativeError } from "../../src/server/backends/pi/native/port.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it("records read-failure transitions once per path and one recovery without retaining provider content", () => {
  vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const diagnostics = new PiNativeReadDiagnostics({ applicationThreadId: "thread", handleId: "handle" });
  for (let i = 0; i < 100; i++) diagnostics.failed("observe", new PiNativeError("pi_native_session_ended"));
  diagnostics.failed("control", new PiNativeError("pi_native_session_ended"));
  diagnostics.failed("observe", new PiNativeError("pi_native_observation_continuity_lost"));
  diagnostics.succeeded("observe"); diagnostics.succeeded("observe");
  diagnostics.failed("observe", new PiNativeError("pi_native_session_ended"));
  expect(log).toHaveBeenCalledTimes(5);
  const records = log.mock.calls.map(([line]) => JSON.parse(String(line).replace("[delivery-attachment] ", "")));
  expect(records.map(({ event, stage }) => [event, stage])).toEqual([
    ["pi_native_read_failed", "observe"], ["pi_native_read_failed", "control"], ["pi_native_read_failed", "observe"],
    ["pi_native_read_recovered", "observe"], ["pi_native_read_failed", "observe"],
  ]);
  expect(records[0]).toMatchObject({ applicationThreadId: "thread", handleId: "handle", errors: [{ code: "pi_native_session_ended" }] });
  log.mockClear();
  diagnostics.failed("control", new Error("private prompt one"));
  diagnostics.failed("control", new Error("private prompt two"));
  expect(log).toHaveBeenCalledOnce();
  expect(log.mock.calls[0]![0]).not.toMatch(/private|prompt/u);
});

it("is inert while disabled and cannot fail polling when error inspection or logging fails", () => {
  vi.stubEnv("SEDES_DEBUG_DELIVERY", "");
  const log = vi.spyOn(console, "error").mockImplementation(() => { throw new Error("sink failed"); });
  const diagnostics = new PiNativeReadDiagnostics({ applicationThreadId: "thread" });
  const getter = vi.fn(() => { throw new Error("must not inspect"); });
  const failure = new Error(); Object.defineProperty(failure, "name", { get: getter });
  diagnostics.failed("observe", failure); diagnostics.succeeded("observe");
  expect(getter).not.toHaveBeenCalled(); expect(log).not.toHaveBeenCalled();
  vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
  expect(() => diagnostics.failed("observe", failure)).not.toThrow();
  expect(() => diagnostics.succeeded("observe")).not.toThrow();
});
