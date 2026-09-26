import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { persistentSidecarDiagnosticOptions } from "../../src/server/sidecar/persistent-sidecar-diagnostics.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")("persistent sidecar diagnostic opt-in", () => {
  it("stays off without a local configuration file and creates no output directory", async () => {
    const directory = await fixture();
    expect(await persistentSidecarDiagnosticOptions(directory)).toBeUndefined();
    await expect(lstat(path.join(directory, "diagnostics"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("admits only the private service-local opt-in and chooses a fixed per-process output", async () => {
    const directory = await fixture('{"delivery":true}');
    expect(await persistentSidecarDiagnosticOptions(directory)).toEqual({
      enabled: true,
      filePath: path.join(directory, "diagnostics", `delivery-${process.pid}.jsonl`),
    });
    expect((await lstat(path.join(directory, "diagnostics"))).mode & 0o777).toBe(0o700);
    expect(await readFile(path.join(directory, "diagnostics.json"), "utf8")).toBe('{"delivery":true}');
  });

  it.each([
    '{"delivery":false}',
    '{"delivery":"true"}',
    '{"delivery":true,"filePath":"/tmp/other"}',
    '{"delivery":true,"environment":{"TOKEN":"value"}}',
    '[{"delivery":true}]',
    'null',
    '{',
    ' '.repeat(1_024) + '{"delivery":true}',
  ])("ignores unsupported or malformed configuration without preventing startup: %s", async (content) => {
    const directory = await fixture(content);
    expect(await persistentSidecarDiagnosticOptions(directory)).toBeUndefined();
    await expect(lstat(path.join(directory, "diagnostics"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a readable-by-others configuration", async () => {
    const directory = await fixture('{"delivery":true}');
    await chmod(path.join(directory, "diagnostics.json"), 0o644);
    expect(await persistentSidecarDiagnosticOptions(directory)).toBeUndefined();
  });

  it("rejects hard-linked configuration", async () => {
    const directory = await fixture('{"delivery":true}');
    await link(path.join(directory, "diagnostics.json"), path.join(directory, "other.json"));
    expect(await persistentSidecarDiagnosticOptions(directory)).toBeUndefined();
  });

  it("does not follow configuration symlinks", async () => {
    const directory = await fixture();
    await writeFile(path.join(directory, "elsewhere.json"), '{"delivery":true}', { mode: 0o600 });
    await symlink(path.join(directory, "elsewhere.json"), path.join(directory, "diagnostics.json"));
    expect(await persistentSidecarDiagnosticOptions(directory)).toBeUndefined();
  });

  it("does not follow an output-directory symlink or change its target", async () => {
    const directory = await fixture('{"delivery":true}');
    const target = await fixture();
    await symlink(target, path.join(directory, "diagnostics"));
    expect(await persistentSidecarDiagnosticOptions(directory)).toBeUndefined();
    await expect(lstat(path.join(target, `delivery-${process.pid}.jsonl`))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not follow an alternate service namespace symlink", async () => {
    const directory = await fixture('{"delivery":true}');
    const parent = await fixture();
    const alias = path.join(parent, "service");
    await symlink(directory, alias);
    expect(await persistentSidecarDiagnosticOptions(alias)).toBeUndefined();
  });

  it("bounds earlier daemons' captures while keeping this and live PIDs", async () => {
    const directory = await fixture('{"delivery":true}');
    const captures = path.join(directory, "diagnostics");
    await mkdir(captures, { mode: 0o700 });
    const write = async (name: string, ageSeconds: number) => {
      const file = path.join(captures, name);
      await writeFile(file, "{}\n", { mode: 0o600 });
      const time = new Date(Date.now() - ageSeconds * 1_000);
      await utimes(file, time, time);
    };
    // Six exited daemons, newest first; PIDs above the kernel maximum never run.
    const exited = [2_147_000_001, 2_147_000_002, 2_147_000_003, 2_147_000_004, 2_147_000_005, 2_147_000_006];
    for (const [index, pid] of exited.entries()) {
      await write(`delivery-${pid}.jsonl`, 100 + index * 10);
      await write(`delivery-${pid}.jsonl.1`, 105 + index * 10);
    }
    await write(`delivery-${process.pid}.jsonl`, 10_000);
    await write(`delivery-${process.ppid}.jsonl`, 20_000);
    await write("notes.txt", 30_000);
    await symlink(path.join(directory, "diagnostics.json"), path.join(captures, "delivery-2147000007.jsonl"));

    expect(await persistentSidecarDiagnosticOptions(directory)).toMatchObject({ enabled: true });
    expect((await readdir(captures)).sort()).toEqual([
      ...exited.slice(0, 4).flatMap((pid) => [`delivery-${pid}.jsonl`, `delivery-${pid}.jsonl.1`]),
      `delivery-${process.pid}.jsonl`,
      "delivery-2147000007.jsonl",
      `delivery-${process.ppid}.jsonl`,
      "notes.txt",
    ].sort());
  });

  it("rejects a non-private service or output directory", async () => {
    const directory = await fixture('{"delivery":true}');
    await chmod(directory, 0o755);
    expect(await persistentSidecarDiagnosticOptions(directory)).toBeUndefined();
    await chmod(directory, 0o700);
    await mkdir(path.join(directory, "diagnostics"), { mode: 0o755 });
    expect(await persistentSidecarDiagnosticOptions(directory)).toBeUndefined();
  });
});

async function fixture(content?: string): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "sedes-sidecar-diagnostics-"));
  temporaryDirectories.push(directory);
  if (content !== undefined) await writeFile(path.join(directory, "diagnostics.json"), content, { mode: 0o600 });
  return directory;
}
