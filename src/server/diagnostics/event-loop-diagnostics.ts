import { monitorEventLoopDelay } from "node:perf_hooks";
import { configureDeliveryDiagnosticOutput, deliveryDiagnosticsEnabled, droppedDeliveryDiagnosticRecords, writeDeliveryDiagnostic } from "./delivery-diagnostic-output.js";

const SAMPLE_MS = 1000;
const REPORT_DELAY_MS = 100;

/** Process-owned observations only. This neither probes providers nor changes
 * heartbeat deadlines, scheduling priority, recovery, or process liveness. */
export function startDeliveryDiagnostics(role: "main" | "sidecar", options: { readonly enabled?: boolean; readonly filePath?: string } = {}): () => Promise<void> {
  const stopOutput = configureDeliveryDiagnosticOutput(options);
  if (!deliveryDiagnosticsEnabled()) return stopOutput;
  let timer: ReturnType<typeof setInterval> | undefined;
  let histogram: ReturnType<typeof monitorEventLoopDelay> | undefined;
  try {
    histogram = monitorEventLoopDelay({ resolution: 20 });
    histogram.enable();
    let previousCpu = process.cpuUsage();
    let previousTime = performance.now();
    const report = (event: string, fields: Record<string, number> = {}): void => {
      writeDeliveryDiagnostic(`[delivery-event-loop] ${JSON.stringify({ event, timestamp: new Date().toISOString(), role, pid: process.pid, ...fields })}`);
    };
    report("monitor_started");
    timer = setInterval(() => {
      try {
        const now = performance.now();
        const cpu = process.cpuUsage();
        const elapsed = now - previousTime;
        const maximum = Math.max(histogram!.max / 1e6, elapsed - SAMPLE_MS);
        if (maximum >= REPORT_DELAY_MS) report("lag_sample", {
          maxDelayMs: rounded(maximum), meanDelayMs: rounded(histogram!.mean / 1e6), sampleIntervalMs: rounded(elapsed),
          cpuUserMs: rounded((cpu.user - previousCpu.user) / 1000), cpuSystemMs: rounded((cpu.system - previousCpu.system) / 1000),
          rssBytes: process.memoryUsage.rss(), droppedRecords: droppedDeliveryDiagnosticRecords(),
        });
        previousCpu = cpu; previousTime = now;
      } catch { /* Sampling and logging cannot interrupt provider work. */ }
      finally { try { histogram?.reset(); } catch { /* Diagnostics only. */ } }
    }, SAMPLE_MS);
    timer.unref();
  } catch { /* Optional monitor failure never prevents main/daemon startup. */ }
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    if (timer) clearInterval(timer);
    try { histogram?.disable(); } catch { /* Diagnostics only. */ }
    await stopOutput();
  };
}

function rounded(value: number): number { return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0; }
