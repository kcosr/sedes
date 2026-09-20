import { chmod, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { configureDeliveryDiagnosticOutput, droppedDeliveryDiagnosticRecords, writeDeliveryDiagnostic } from "../../src/server/diagnostics/delivery-diagnostic-output.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-diagnostic-output-"));
  await chmod(directory, 0o700);
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, "delivery-{pid}.jsonl");
  const actual = filePath.replace("{pid}", String(process.pid));
  vi.stubEnv("SEDES_DEBUG_DELIVERY", "");
  const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
  return { directory, filePath, actual, stderr };
}

it.skipIf(process.platform === "win32")("writes private bounded diagnostic records with explicit daemon opt-in independent of the environment", async () => {
  const f = await fixture();
  const close = configureDeliveryDiagnosticOutput({ enabled: true, filePath: f.filePath }); cleanup.push(close);
  writeDeliveryDiagnostic('[delivery-attachment] {"event":"heartbeat_received"}');
  writeDeliveryDiagnostic("ordinary private log must not be copied");
  writeDeliveryDiagnostic('[delivery-attachment] {"event":"bad"}\nprivate');
  await close();
  expect(await readFile(f.actual, "utf8")).toBe('[delivery-attachment] {"event":"heartbeat_received"}\n');
  expect((await stat(f.actual)).mode & 0o777).toBe(0o600);
  expect(f.stderr).toHaveBeenCalledOnce();
});

it.skipIf(process.platform === "win32")("rotates before one MiB and replaces only its previous archive", async () => {
  const f = await fixture();
  await writeFile(f.actual, "x".repeat(1024 * 1024 - 10), { mode: 0o600 });
  await writeFile(`${f.actual}.1`, "prior archive", { mode: 0o600 });
  const close = configureDeliveryDiagnosticOutput({ enabled: true, filePath: f.filePath }); cleanup.push(close);
  const line = '[delivery-event-loop] {"event":"lag_sample","maxDelayMs":123}';
  writeDeliveryDiagnostic(line);
  await close();
  expect(await readFile(f.actual, "utf8")).toBe(`${line}\n`);
  expect((await stat(`${f.actual}.1`)).size).toBe(1024 * 1024 - 10);
  expect((await stat(`${f.actual}.1`)).mode & 0o777).toBe(0o600);
});

it.skipIf(process.platform === "win32")("bounds queued diagnostics and reports dropped records without blocking callers", async () => {
  const f = await fixture();
  const close = configureDeliveryDiagnosticOutput({ enabled: true, filePath: f.filePath }); cleanup.push(close);
  const line = `[delivery-event-loop] {"event":"${"x".repeat(8000)}"}`;
  for (let index = 0; index < 100; index++) writeDeliveryDiagnostic(line);
  expect(droppedDeliveryDiagnosticRecords()).toBeGreaterThan(0);
  await close();
  expect((await stat(f.actual)).size).toBeLessThanOrEqual(64 * 1024);
});

it.skipIf(process.platform === "win32").each(["symlink", "public_file", "public_directory"] as const)("fails closed for an unsafe diagnostic path: %s", async kind => {
  const f = await fixture();
  const target = path.join(f.directory, "target");
  await writeFile(target, "preserve", { mode: 0o600 });
  if (kind === "symlink") await symlink(target, f.actual);
  if (kind === "public_file") { await writeFile(f.actual, "preserve", { mode: 0o600 }); await chmod(f.actual, 0o644); }
  if (kind === "public_directory") await chmod(f.directory, 0o755);
  const close = configureDeliveryDiagnosticOutput({ enabled: true, filePath: f.filePath }); cleanup.push(close);
  expect(() => writeDeliveryDiagnostic('[delivery-attachment] {"event":"test"}')).not.toThrow();
  await close();
  expect(await readFile(target, "utf8")).toBe("preserve");
  if (kind === "public_file") expect(await readFile(f.actual, "utf8")).toBe("preserve");
  expect(f.stderr.mock.calls.some(([line]) => String(line).includes("diagnostic_file_unavailable"))).toBe(true);
  expect(JSON.stringify(f.stderr.mock.calls)).not.toContain(f.directory);
});

it.skipIf(process.platform === "win32")("refuses a FIFO without blocking a filesystem worker or process shutdown", async () => {
  const f = await fixture();
  const exec = promisify(execFile);
  await exec("mkfifo", [f.actual]);
  // Isolate the regression: a blocking open cannot be cancelled by a promise
  // timeout and must not leave the test runner's libuv worker stuck forever.
  const result = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
    import { configureDeliveryDiagnosticOutput, writeDeliveryDiagnostic } from "./src/server/diagnostics/delivery-diagnostic-output.ts";
    const close = configureDeliveryDiagnosticOutput({ enabled: true, filePath: process.argv[1] });
    writeDeliveryDiagnostic('[delivery-attachment] {"event":"fifo_probe"}');
    await close();
  `, f.actual], { timeout: 5000 });
  expect(result.stderr).toContain("diagnostic_file_unavailable");
  expect(result.stderr).not.toContain(f.actual);
  expect((await stat(f.actual)).isFIFO()).toBe(true);
});
