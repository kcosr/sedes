import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertCodexRuntimePlatformSupported,
  CODEX_APP_SERVER_RELEASE,
  CODEX_RUNTIME_MINIMUM_SUPPORTED_RELEASE,
  CODEX_RUNTIME_TESTED_THROUGH_RELEASE,
  haveSameCodexRuntimeVersionPrecedence,
  isCodexRuntimeReleaseExcluded,
  verifyCodexRuntimeExecutable,
  verifyCodexRuntimeVersion,
} from "../../src/server/backends/codex/codex-release-guard.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  while (temporaryRoots.length > 0) {
    const root = temporaryRoots.pop();
    if (root) await rm(root, { recursive: true, force: true });
  }
});

async function writeProbeScript(body: string): Promise<string> {
  const root = await mkdtemp(path.join(os.homedir(), ".sedes-codex-version-"));
  temporaryRoots.push(root);
  const filename = path.join(root, "codex");
  await writeFile(filename, body, { mode: 0o755 });
  return filename;
}

describe("Codex runtime version policy", () => {
  it("admits the reviewed Linux, macOS, and Windows runtime platforms", () => {
    expect(() =>
      assertCodexRuntimePlatformSupported("linux", "x64"),
    ).not.toThrow();
    expect(() =>
      assertCodexRuntimePlatformSupported("darwin", "arm64"),
    ).not.toThrow();
    expect(() =>
      assertCodexRuntimePlatformSupported("darwin", "x64"),
    ).not.toThrow();
    expect(() =>
      assertCodexRuntimePlatformSupported("win32", "x64"),
    ).not.toThrow();
    expect(() =>
      assertCodexRuntimePlatformSupported("win32", "arm64"),
    ).not.toThrow();
    expect(() => assertCodexRuntimePlatformSupported("linux", "arm64")).toThrow(
      "codex_executable_architecture_mismatch",
    );
    expect(() => assertCodexRuntimePlatformSupported("darwin", "ia32")).toThrow(
      "codex_executable_architecture_mismatch",
    );
    expect(() => assertCodexRuntimePlatformSupported("win32", "ia32")).toThrow(
      "codex_executable_architecture_mismatch",
    );
  });

  it("publishes independent runtime floor and tested-through thresholds", () => {
    expect(CODEX_RUNTIME_MINIMUM_SUPPORTED_RELEASE).toBe("0.153.0");
    expect(CODEX_RUNTIME_TESTED_THROUGH_RELEASE).toBe("0.154.0");
  });

  it("accepts the exact generated runtime version", async () => {
    const executable = await writeProbeScript(
      "#!/bin/sh\necho 'codex-cli 0.153.0'\n",
    );
    const verified = await verifyCodexRuntimeExecutable(executable);
    expect(verified).toEqual({
      path: expect.stringContaining("codex"),
      version: CODEX_APP_SERVER_RELEASE,
      newerThanTested: false,
    });
  });

  it("accepts later stable runtimes and assesses tested evidence by precedence", () => {
    expect(verifyCodexRuntimeVersion("0.153.0")).toEqual({
      version: "0.153.0",
      newerThanTested: false,
    });
    expect(verifyCodexRuntimeVersion("0.153.0+vendor.7")).toEqual({
      version: "0.153.0+vendor.7",
      newerThanTested: false,
    });
    for (const version of [
      "0.153.1",
      "0.153.4",
      "0.153.5",
      "0.154.0",
      "0.154.0+vendor.7",
    ]) {
      expect(verifyCodexRuntimeVersion(version)).toEqual({
        version,
        newerThanTested: false,
      });
    }
    expect(verifyCodexRuntimeVersion("0.154.1")).toEqual({
      version: "0.154.1",
      newerThanTested: true,
    });
    expect(verifyCodexRuntimeVersion("0.155.0")).toEqual({
      version: "0.155.0",
      newerThanTested: true,
    });
    expect(verifyCodexRuntimeVersion("0.999.999+build.1")).toEqual({
      version: "0.999.999+build.1",
      newerThanTested: true,
    });
    expect(verifyCodexRuntimeVersion("1.0.0")).toEqual({
      version: "1.0.0",
      newerThanTested: true,
    });
  });

  it("compares semantic precedence without treating build metadata as identity", () => {
    expect(
      haveSameCodexRuntimeVersionPrecedence(
        "0.153.0+owned.1",
        "0.153.0+daemon.2",
      ),
    ).toBe(true);
    expect(haveSameCodexRuntimeVersionPrecedence("0.153.0", "0.154.0")).toBe(
      false,
    );
  });

  it("does not allow build metadata to bypass a known-bad exclusion", () => {
    expect(isCodexRuntimeReleaseExcluded("0.152.0", ["0.152.0"])).toBe(true);
    expect(isCodexRuntimeReleaseExcluded("0.152.0+vendor.7", ["0.152.0"])).toBe(
      true,
    );
    expect(isCodexRuntimeReleaseExcluded("0.152.1+vendor.7", ["0.152.0"])).toBe(
      false,
    );
  });

  it("rejects runtimes below the stable compatibility floor", async () => {
    for (const version of [
      "0.147.0",
      "0.150.1",
      "0.152.1",
      "0.153.0-rc.1",
    ] as const) {
      const executable = await writeProbeScript(
        `#!/bin/sh\necho 'codex-cli ${version}'\n`,
      );
      await expect(verifyCodexRuntimeExecutable(executable)).rejects.toThrow(
        "codex_executable_version_unsupported",
      );
    }
  });

  it("rejects an older version", async () => {
    const executable = await writeProbeScript(
      "#!/bin/sh\necho 'codex-cli 0.145.0'\n",
    );
    await expect(verifyCodexRuntimeExecutable(executable)).rejects.toThrow(
      "codex_executable_version_unsupported",
    );
  });

  it("rejects malformed, multi-line, nonzero, timeout, and oversized probes", async () => {
    await expect(
      verifyCodexRuntimeExecutable(
        await writeProbeScript("#!/bin/sh\necho 'not-a-version'\n"),
      ),
    ).rejects.toThrow("codex_executable_version_malformed");

    await expect(
      verifyCodexRuntimeExecutable(
        await writeProbeScript(
          "#!/bin/sh\necho 'codex-cli 0.153.0'\necho 'extra'\n",
        ),
      ),
    ).rejects.toThrow("codex_executable_version_malformed");

    await expect(
      verifyCodexRuntimeExecutable(
        await writeProbeScript("#!/bin/sh\necho 'codex-cli 0.153.0'\nexit 2\n"),
      ),
    ).rejects.toThrow("codex_executable_version_probe_nonzero_exit");

    await expect(
      verifyCodexRuntimeExecutable(
        await writeProbeScript("#!/bin/sh\nsleep 2\n"),
        { probeTimeoutMilliseconds: 50 },
      ),
    ).rejects.toThrow("codex_executable_version_probe_timeout");

    const oversized = "x".repeat(5_000);
    await expect(
      verifyCodexRuntimeExecutable(
        await writeProbeScript(`#!/bin/sh\necho '${oversized}'\n`),
      ),
    ).rejects.toThrow("codex_executable_version_probe_output_too_large");

    await expect(
      verifyCodexRuntimeExecutable(
        await writeProbeScript("#!/bin/sh\necho 'codex-cli 01.147.0'\n"),
      ),
    ).rejects.toThrow("codex_executable_version_invalid");

    await expect(
      verifyCodexRuntimeExecutable(
        await writeProbeScript("#!/bin/sh\necho 'codex-cli 0.153.0'\n"),
        { probeTimeoutMilliseconds: 0 },
      ),
    ).rejects.toThrow("codex_executable_version_probe_timeout_invalid");
  });

  it("kills and reaps the complete probe process group after timeout", async () => {
    const executable = await writeProbeScript(
      [
        "#!/bin/sh",
        'pid_file="$(dirname "$0")/descendant.pid"',
        "sleep 30 &",
        'echo "$!" > "$pid_file"',
        "wait",
        "",
      ].join("\n"),
    );
    await expect(
      verifyCodexRuntimeExecutable(executable, {
        probeTimeoutMilliseconds: 100,
      }),
    ).rejects.toThrow("codex_executable_version_probe_timeout");

    const descendantPid = Number(
      await readFile(
        path.join(path.dirname(executable), "descendant.pid"),
        "utf8",
      ),
    );
    expect(Number.isSafeInteger(descendantPid)).toBe(true);
    await expectProcessGone(descendantPid);
  });

  it("requires a runnable regular file", async () => {
    const root = await mkdtemp(
      path.join(os.homedir(), ".sedes-codex-missing-"),
    );
    temporaryRoots.push(root);
    await expect(
      verifyCodexRuntimeExecutable(path.join(root, "missing")),
    ).rejects.toThrow();

    const directory = path.join(root, "dir");
    await writeFile(path.join(root, "placeholder"), "");
    // Directory path as executable must fail as not a regular file after realpath.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(directory);
    await expect(verifyCodexRuntimeExecutable(directory)).rejects.toThrow(
      "codex_executable_not_regular_file",
    );
  });

  it("still launches the real version probe through spawn", async () => {
    const executable = await writeProbeScript(
      "#!/bin/sh\necho 'codex-cli 0.153.0'\n",
    );
    const child = spawn(executable, ["--version"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = await new Promise<string>((resolve, reject) => {
      let value = "";
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        value += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) resolve(value.trim());
        else reject(new Error(`exit:${String(code)}`));
      });
    });
    expect(output).toBe("codex-cli 0.153.0");
  });

  it("does not reject a group-writable owner path for version verification", async () => {
    const root = await mkdtemp(
      path.join(os.homedir(), ".sedes-codex-group-writable-"),
    );
    temporaryRoots.push(root);
    const executable = path.join(root, "codex");
    await writeFile(executable, "#!/bin/sh\necho 'codex-cli 0.153.0'\n", {
      mode: 0o755,
    });
    await chmod(root, 0o775);
    const verified = await verifyCodexRuntimeExecutable(executable);
    expect(verified.version).toBe("0.153.0");
    expect(verified.newerThanTested).toBe(false);
  });
});

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`probe_descendant_still_running:${String(pid)}`);
}
