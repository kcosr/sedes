import { execFile, spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPiBubblewrapArguments } from "../../src/server/pi-sandbox/bubblewrap-policy.js";

const execute = promisify(execFile);
const roots: string[] = [];
const describeRealBubblewrap = describe.runIf(process.platform === "linux");

describeRealBubblewrap("Pi sandbox real Bubblewrap boundary", () => {
  let bubblewrapPath: string;
  let nodePath: string;

  beforeAll(async () => {
    bubblewrapPath = await requiredExecutable("/usr/bin/bwrap");
    nodePath = await requiredExecutable(process.execPath);
  });

  afterAll(async () => {
    await Promise.all(
      roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("hides host paths, keeps the clone writable, and enforces network profiles", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedes-pi-bwrap-live-"));
    roots.push(root);
    const home = path.join(root, "allocation", "home");
    const workspace = path.join(home, "workspace");
    const sourceSentinel = path.join(root, "source", "source-secret");
    const hostSentinel = path.join(root, "host-home", "host-secret");
    const worker = path.join(root, "boundary-worker.mjs");
    await Promise.all([
      mkdir(workspace, { recursive: true, mode: 0o700 }),
      mkdir(path.dirname(sourceSentinel), { recursive: true, mode: 0o700 }),
      mkdir(path.dirname(hostSentinel), { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      writeFile(sourceSentinel, "source-only", { mode: 0o600 }),
      writeFile(hostSentinel, "host-only", { mode: 0o600 }),
      writeFile(worker, boundaryWorkerSource(), { mode: 0o700 }),
    ]);
    await chmod(worker, 0o700);

    const server = createServer((socket) => {
      socket.on("error", () => undefined);
      socket.end("reachable");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("pi_sandbox_test_listener_unavailable");
    }

    try {
      for (const networkMode of ["isolated", "execution_host"] as const) {
        const resultName = `result-${networkMode}.json`;
        const arguments_ = [
          ...buildPiBubblewrapArguments({
            hostHomePath: home,
            hostWorkspacePath: workspace,
            workerArtifactPath: worker,
            workerNodePath: nodePath,
            workspaceAccess: "writable_clone",
            networkMode,
            systemMounts: ["/usr", "/bin", "/lib", "/lib64"],
          }),
          networkMode,
          sourceSentinel,
          hostSentinel,
          String(address.port),
          resultName,
        ];
        await execute(bubblewrapPath, arguments_, {
          timeout: 10_000,
          maxBuffer: 64 * 1024,
        });
        const result = JSON.parse(
          await readFile(path.join(home, resultName), "utf8"),
        ) as Record<string, unknown>;
        expect(result).toEqual({
          home: "/home/agent",
          cwd: "/home/agent",
          sourceVisible: false,
          hostVisible: false,
          networkReachable: networkMode === "execution_host",
        });
        await expect(
          readFile(path.join(workspace, `written-${networkMode}`), "utf8"),
        ).resolves.toBe("sandbox-write");
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps the private home writable while mounting the live source read-only", async () => {
    const root = await mkdtemp(
      path.join(tmpdir(), "sedes-pi-bwrap-read-only-"),
    );
    roots.push(root);
    const home = path.join(root, "allocation", "home");
    const placeholder = path.join(home, "workspace");
    const source = path.join(root, "source");
    const worker = path.join(root, "read-only-worker.mjs");
    await Promise.all([
      mkdir(placeholder, { recursive: true, mode: 0o700 }),
      mkdir(source, { recursive: true, mode: 0o700 }),
    ]);
    await Promise.all([
      writeFile(path.join(source, "original.txt"), "original\n", {
        mode: 0o600,
      }),
      writeFile(worker, readOnlyWorkerSource(), { mode: 0o700 }),
    ]);

    await execute(
      bubblewrapPath,
      [
        ...buildPiBubblewrapArguments({
          hostHomePath: home,
          hostWorkspacePath: source,
          workspaceAccess: "read_only",
          workerArtifactPath: worker,
          workerNodePath: nodePath,
          networkMode: "isolated",
          systemMounts: ["/usr", "/bin", "/lib", "/lib64"],
        }),
        "result.json",
      ],
      { timeout: 10_000, maxBuffer: 64 * 1024 },
    );

    expect(
      JSON.parse(await readFile(path.join(home, "result.json"), "utf8")),
    ).toEqual({
      cwd: "/home/agent",
      source: "original\n",
      writeCode: "EROFS",
    });
    await expect(readFile(path.join(home, "output.txt"), "utf8")).resolves.toBe(
      "home-write",
    );
    await expect(
      readFile(path.join(source, "original.txt"), "utf8"),
    ).resolves.toBe("original\n");
  });

  it("tears down sandbox descendants when the Bubblewrap worker is killed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedes-pi-bwrap-kill-"));
    roots.push(root);
    const home = path.join(root, "allocation", "home");
    const workspace = path.join(home, "workspace");
    const worker = path.join(root, "cleanup-worker.mjs");
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    await writeFile(worker, cleanupWorkerSource(), { mode: 0o700 });
    await chmod(worker, 0o700);

    const child = spawn(
      bubblewrapPath,
      buildPiBubblewrapArguments({
        hostHomePath: home,
        hostWorkspacePath: workspace,
        workerArtifactPath: worker,
        workerNodePath: nodePath,
        workspaceAccess: "writable_clone",
        networkMode: "isolated",
        systemMounts: ["/usr", "/bin", "/lib", "/lib64"],
      }),
      { stdio: "ignore" },
    );
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    await waitForFile(path.join(home, "descendant-started"));
    child.kill("SIGKILL");
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 800));
    await expect(
      access(path.join(home, "descendant-survived")),
    ).rejects.toThrow();
  });
});

async function requiredExecutable(candidate: string): Promise<string> {
  const canonical = await realpath(candidate).catch(() => "");
  if (!canonical) throw new Error(`required_executable_missing:${candidate}`);
  await access(canonical).catch(() => {
    throw new Error(`required_executable_unavailable:${candidate}`);
  });
  return canonical;
}

function boundaryWorkerSource(): string {
  return String.raw`
import { existsSync, writeFileSync } from "node:fs";
import { connect } from "node:net";

const [networkMode, sourceSentinel, hostSentinel, portText, resultName] = process.argv.slice(2);
const networkReachable = await new Promise((resolve) => {
  const socket = connect({ host: "127.0.0.1", port: Number(portText) });
  const finish = (value) => {
    socket.destroy();
    resolve(value);
  };
  socket.setTimeout(500, () => finish(false));
  socket.once("connect", () => finish(true));
  socket.once("error", () => finish(false));
});
writeFileSync("/home/agent/workspace/written-" + networkMode, "sandbox-write");
writeFileSync("/home/agent/" + resultName, JSON.stringify({
  home: process.env.HOME,
  cwd: process.cwd(),
  sourceVisible: existsSync(sourceSentinel),
  hostVisible: existsSync(hostSentinel),
  networkReachable,
}));
`;
}

function cleanupWorkerSource(): string {
  return String.raw`
import { spawn } from "node:child_process";

spawn("/runtime/node", ["-e", "const fs = require('node:fs'); fs.writeFileSync('/home/agent/descendant-started', 'started'); setTimeout(() => fs.writeFileSync('/home/agent/descendant-survived', 'bad'), 750)"], {
  detached: true,
  stdio: "ignore",
});
setInterval(() => {}, 10_000);
`;
}

function readOnlyWorkerSource(): string {
  return String.raw`
import { readFileSync, writeFileSync } from "node:fs";

const [resultName] = process.argv.slice(2);
let writeCode = "none";
try {
  writeFileSync("/home/agent/workspace/original.txt", "changed\n");
} catch (error) {
  writeCode = error.code;
}
writeFileSync("/home/agent/output.txt", "home-write");
writeFileSync("/home/agent/" + resultName, JSON.stringify({
  cwd: process.cwd(),
  source: readFileSync("/home/agent/workspace/original.txt", "utf8"),
  writeCode,
}));
`;
}

async function waitForFile(candidate: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (
      await access(candidate).then(
        () => true,
        () => false,
      )
    )
      return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("pi_sandbox_descendant_did_not_start");
}
