import { mkdtemp, readFile, readdir, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSidecarAbandonmentArchive } from "../../src/server/sidecar/sidecar-abandonment-archive.js";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
const scope = { installationId: "installation", tenantId: "tenant", principalId: "principal", executionEnvironmentId: "remote" };
it("archives scoped abandoned identities privately without changing unknown delivery to success", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "abandonment-")); directories.push(root);
  const directory = path.join(root, "archive");
  const onError = vi.fn();
  const archive = createSidecarAbandonmentArchive({ directory, scope, serviceIncarnation: () => "service", onError });
  await archive({ resourceId: "runtime", kind: "codex_app_server", reason: "operator_stop",
    evidence: { operations: [{ operationId: "operation", delivery: "sent_outcome_unknown" }] } });
  const entries = await readdir(directory);
  expect(entries).toHaveLength(1);
  const filename = path.join(directory, entries[0]!);
  expect(JSON.parse(await readFile(filename, "utf8"))).toMatchObject({ scope, serviceIncarnation: "service", resourceId: "runtime",
    disposition: "operator_abandoned", evidence: { operations: [{ operationId: "operation", delivery: "sent_outcome_unknown" }] } });
  if (process.platform !== "win32") {
    expect((await lstat(directory)).mode & 0o777).toBe(0o700);
    expect((await lstat(filename)).mode & 0o777).toBe(0o600);
  }
  expect(onError).not.toHaveBeenCalled();
});
it("reports archive failure without blocking Stop or changing an unsafe directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "abandonment-")); directories.push(root);
  const directory = path.join(root, "absent-parent", "archive");
  const onError = vi.fn();
  const archive = createSidecarAbandonmentArchive({ directory, scope, serviceIncarnation: () => "service", onError });
  await expect(archive({ resourceId: "runtime", kind: "claude_agent_sdk", reason: "operator_stop", evidence: {} })).resolves.toBeUndefined();
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "sidecar_abandonment_archive_failed" }));
});
it("bounds archived evidence without silently dropping the original size and digest", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "abandonment-")); directories.push(root);
  const directory = path.join(root, "archive");
  const archive = createSidecarAbandonmentArchive({ directory, scope, serviceIncarnation: () => "service", onError: vi.fn() });
  await archive({ resourceId: "runtime", kind: "workspace_files", reason: "operator_stop", evidence: { data: "x".repeat(1024 * 1024 + 1) } });
  const filename = path.join(directory, (await readdir(directory))[0]!);
  const record = JSON.parse(await readFile(filename, "utf8"));
  expect(record.evidence).toMatchObject({ omitted: "size_limit", sha256: expect.stringMatching(/^[a-f0-9]{64}$/u) });
  expect((await lstat(filename)).size).toBeLessThan(4096);
});

it("reports capacity exhaustion without deleting existing evidence or blocking Stop", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "abandonment-")); directories.push(root);
  const directory = path.join(root, "archive");
  await mkdir(directory, {mode: 0o700});
  await Promise.all(Array.from({length: 128}, (_, index) => writeFile(path.join(directory, `${index}.json`), "{}", {mode: 0o600})));
  const onError = vi.fn();
  const archive = createSidecarAbandonmentArchive({directory, scope, serviceIncarnation: () => "service", onError});
  await expect(archive({resourceId: "runtime", kind: "codex_app_server", reason: "operator_stop", evidence: {}})).resolves.toBeUndefined();
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({message: "sidecar_abandonment_capacity_exceeded"}));
  expect(await readdir(directory)).toHaveLength(128);
});
