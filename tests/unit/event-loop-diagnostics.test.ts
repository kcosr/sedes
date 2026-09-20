import { afterEach, expect, it, vi } from "vitest";

const histogram = vi.hoisted(() => ({ enable: vi.fn(), disable: vi.fn(), reset: vi.fn(), max: 0, mean: 0 }));
const createMonitor = vi.hoisted(() => vi.fn(() => histogram));
vi.mock("node:perf_hooks", () => ({ monitorEventLoopDelay: createMonitor }));
import { startDeliveryDiagnostics } from "../../src/server/diagnostics/event-loop-diagnostics.js";
import { attachmentDiagnostic } from "../../src/server/diagnostics/attachment-diagnostics.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers();
  createMonitor.mockClear(); histogram.enable.mockClear(); histogram.disable.mockClear(); histogram.reset.mockClear();
  histogram.max = 0; histogram.mean = 0;
});

it("does not create a monitor when diagnostics are disabled", () => {
  vi.stubEnv("SEDES_DEBUG_DELIVERY", "");
  cleanup.push(startDeliveryDiagnostics("main"));
  expect(createMonitor).not.toHaveBeenCalled();
});

it("reports bounded delay, interval CPU and RSS only when lag crosses the threshold, then cleans up", async () => {
  vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
  vi.useFakeTimers();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  vi.spyOn(process, "cpuUsage").mockReturnValueOnce({ user: 1000, system: 2000 })
    .mockReturnValueOnce({ user: 3000, system: 3000 }).mockReturnValue({ user: 153000, system: 63000 });
  vi.spyOn(process.memoryUsage, "rss").mockReturnValue(123_456);
  const stop = startDeliveryDiagnostics("main"); cleanup.push(stop);
  histogram.max = 20e6; histogram.mean = 15e6;
  elapsed = 1000; await vi.advanceTimersByTimeAsync(1000);
  expect(log).toHaveBeenCalledTimes(1); // The startup record proves the monitor is enabled.
  histogram.max = 150e6; histogram.mean = 60e6;
  elapsed = 2000; await vi.advanceTimersByTimeAsync(1000);
  const record = JSON.parse(String(log.mock.calls[1]![0]).replace("[delivery-event-loop] ", ""));
  expect(record).toMatchObject({ event: "lag_sample", role: "main", pid: process.pid, maxDelayMs: 150, meanDelayMs: 60,
    sampleIntervalMs: 1000, cpuUserMs: 150, cpuSystemMs: 60, rssBytes: 123_456, droppedRecords: 0 });
  expect(histogram.reset).toHaveBeenCalledTimes(2);
  await stop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(log).toHaveBeenCalledTimes(2);
  expect(histogram.disable).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("observes delayed sampling even before the native histogram has a sample and permits private daemon opt-in", async () => {
  vi.stubEnv("SEDES_DEBUG_DELIVERY", ""); vi.useFakeTimers();
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  let elapsed = 0;
  vi.spyOn(performance, "now").mockImplementation(() => elapsed);
  cleanup.push(startDeliveryDiagnostics("sidecar", { enabled: true }));
  attachmentDiagnostic("sidecar_heartbeat_trace", { role: "sidecar", stage: "received" });
  histogram.mean = NaN;
  elapsed = 1400; await vi.advanceTimersByTimeAsync(1000);
  expect(log.mock.calls.some(([line]) => String(line).includes('"maxDelayMs":400'))).toBe(true);
  expect(log.mock.calls.some(([line]) => String(line).startsWith("[delivery-attachment]"))).toBe(true);
});

it("continues sampling after diagnostic output fails", async () => {
  vi.stubEnv("SEDES_DEBUG_DELIVERY", "1"); vi.useFakeTimers();
  vi.spyOn(console, "error").mockImplementation(() => { throw new Error("unavailable log sink"); });
  cleanup.push(startDeliveryDiagnostics("main"));
  histogram.max = 500e6;
  await expect(vi.advanceTimersByTimeAsync(2000)).resolves.toBeDefined();
  expect(histogram.reset).toHaveBeenCalledTimes(2);
});
