import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { spawnWindowsOwnedProcess } from "../../src/server/execution/windows-owned-process.js";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
};
const waitFor = async (predicate: () => Promise<boolean>) => {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    if (Date.now() >= deadline)
      throw new Error("native_windows_fixture_deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe.skipIf(process.platform !== "win32")(
  "native Windows Job ownership",
  () => {
    it("cleans descendants after their root exits, preserving bytes, arguments, cwd and environment", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-job-"));
      const pidFile = path.join(directory, "child.pid");
      const exitFile = path.join(directory, "exit");
      let descendant: number | undefined;
      let owned:
        Awaited<ReturnType<typeof spawnWindowsOwnedProcess>> | undefined;
      try {
        const args = ["", 'quotes" and slash\\', "日本語"];
        const source = `const fs=require('node:fs'); const child=require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',detached:true}); fs.writeFileSync(process.argv[1],String(child.pid)); process.stdout.write(JSON.stringify({args:process.argv.slice(3),cwd:process.cwd(),token:process.env.TEST_TOKEN,control:process.env.SEDES_WINDOWS_JOB_CONTROL})); process.stderr.write(Buffer.from([0,255,1,128])); child.unref(); const timer=setInterval(()=>{if(fs.existsSync(process.argv[2]))process.exit(7)},10);`;
        owned = await spawnWindowsOwnedProcess({
          executable: process.execPath,
          arguments: ["-e", source, pidFile, exitFile, ...args],
          cwd: directory,
          environment: {
            ...Object.fromEntries(
              Object.entries(process.env).filter(
                (entry): entry is [string, string] => entry[1] !== undefined,
              ),
            ),
            TEST_TOKEN: "secret 日本語",
          },
          signal: new AbortController().signal,
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        owned.child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        owned.child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
        await waitFor(async () => {
          try {
            descendant = Number(await readFile(pidFile, "utf8"));
            return true;
          } catch {
            return false;
          }
        });
        expect(alive(descendant!)).toBe(true);
        await writeFile(exitFile, "exit");
        const closure = await owned.closed;
        expect(closure.exitCode).toBe(7);
        await owned.close(5_000);
        expect(alive(descendant!)).toBe(false);
        expect(JSON.parse(Buffer.concat(stdout).toString())).toEqual({
          args,
          cwd: directory,
          token: "secret 日本語",
        });
        expect(Buffer.concat(stderr)).toEqual(Buffer.from([0, 255, 1, 128]));
      } finally {
        await owned?.close(5_000).catch(() => undefined);
        if (descendant && alive(descendant)) process.kill(descendant);
        await rm(directory, { recursive: true, force: true });
      }
    }, 45_000);

    it("kills the whole job when the supervising process is lost, without claiming a cleanup receipt", async () => {
      const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-job-"));
      let pid: number | undefined;
      let owned:
        Awaited<ReturnType<typeof spawnWindowsOwnedProcess>> | undefined;
      try {
        const pidFile = path.join(directory, "pid");
        owned = await spawnWindowsOwnedProcess({
          executable: process.execPath,
          arguments: [
            "-e",
            "require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)",
            pidFile,
          ],
          cwd: directory,
          environment: Object.fromEntries(
            Object.entries(process.env).filter(
              (entry): entry is [string, string] => entry[1] !== undefined,
            ),
          ),
          signal: new AbortController().signal,
        });
        owned.child.stdout.resume();
        owned.child.stderr.resume();
        await waitFor(async () => {
          try {
            pid = Number(await readFile(pidFile, "utf8"));
            return true;
          } catch {
            return false;
          }
        });
        owned.child.kill();
        await expect(owned.close(5_000)).rejects.toThrow(
          "windows_job_cleanup_unconfirmed",
        );
        await waitFor(async () => !alive(pid!));
      } finally {
        await owned?.close(5_000).catch(() => undefined);
        if (pid && alive(pid)) process.kill(pid);
        await rm(directory, { recursive: true, force: true });
      }
    }, 45_000);
  },
);
