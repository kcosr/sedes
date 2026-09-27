import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import { startOpenCodeOwnedProcess } from "../../src/server/backends/opencode/opencode-owned-process.js";
import { OPENCODE_PROCESS_MARKER } from "../../src/server/backends/opencode/opencode-release.js";

const enabled = process.platform === "linux" && process.env.SEDES_RUN_REAL_OPENCODE === "1";
async function alive(pid: number): Promise<boolean> {
  try {
    const value = await readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(value.slice(value.lastIndexOf(")") + 2).split(" ")[0]!);
  } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false; throw cause; }
}
async function fake(source: string, version = "2.0.18") {
  const root = await mkdtemp(path.join(os.tmpdir(), "sedes-opencode-launch-"));
  const executablePath = path.join(root, "opencode2");
  const evidence = path.join(root, "pid.json");
  await mkdir(path.join(root, "config"));
  await writeFile(executablePath, `#!${process.execPath}\nif(process.argv.includes("--version")){console.log("opencode v${version}");process.exit(0)}\nrequire("node:fs").writeFileSync(${JSON.stringify(evidence)},JSON.stringify({pid:process.pid}));\n${source}\n`);
  await chmod(executablePath, 0o700);
  return { root, evidence, input: { processMarker: randomBytes(32).toString("hex"), executablePath, workingDirectory: root, nativeStorePath: path.join(root, "opencode.db"),
    configDirectory: path.join(root, "config"), environment: { HOME: root, PATH: process.env.PATH, SHELL: "/bin/sh" } } };
}

it.skipIf(!enabled).each([
  ["malformed startup frame", 'console.log("not-json");process.stdin.resume();process.stdin.on("end",()=>process.exit(0))', "opencode_startup_frame_invalid"],
  ["startup EOF", 'process.stdout.end();process.stdin.resume();process.stdin.on("end",()=>process.exit(0))', "opencode_startup_exited"],
  ["early exit", "process.exit(1)", "opencode_startup_exited"],
  ["startup deadline", 'process.stdin.resume();process.stdin.on("end",()=>process.exit(0))', "opencode_startup_timeout"],
])("owned launcher cleans up %s without retaining native output", async (_name, source, error) => {
  const fixture = await fake(source);
  let proved = false;
  try {
    await expect(startOpenCodeOwnedProcess(fixture.input)).rejects.toThrow(error);
    const { pid } = JSON.parse(await readFile(fixture.evidence, "utf8")) as { pid: number };
    expect(await alive(pid)).toBe(false); proved = true;
  } finally { if (proved) await rm(fixture.root, { recursive: true, force: true }); }
});

it.skipIf(!enabled)("owned launcher rejects the old v1 executable before server launch", async () => {
  const fixture = await fake("process.exit(99)", "1.0.0");
  try { await expect(startOpenCodeOwnedProcess(fixture.input)).rejects.toThrow("opencode_release_incompatible"); }
  finally { await rm(fixture.root, { recursive: true, force: true }); }
});

it.skipIf(!enabled)("owned process cleanup kills detached descendants after root exit with a full native cleanup grace", async () => {
  const fixture = await fake(`
const {spawn}=require("node:child_process");
const code=${JSON.stringify(`const fs=require("node:fs");process.on("SIGTERM",()=>fs.writeFileSync(process.env.TERM_EVIDENCE,"received"));fs.writeFileSync(process.env.CHILD_EVIDENCE,String(process.pid));process.send("ready");process.disconnect();setInterval(()=>{},1000)`)};
const child=spawn(process.execPath,["-e",code],{cwd:"/",env:process.env,detached:true,stdio:["ignore","ignore","ignore","ipc"]});
child.once("message",()=>console.log(JSON.stringify({url:"http://127.0.0.1:4096"})));child.unref();
process.stdin.resume();process.stdin.on("end",()=>process.exit(0));`);
  const childEvidence = path.join(fixture.root, "child");
  const termEvidence = path.join(fixture.root, "term");
  let owner: Awaited<ReturnType<typeof startOpenCodeOwnedProcess>> | undefined;
  let childPid: number | undefined;
  let unrelated: ChildProcess | undefined;
  let proved = false;
  try {
    owner = await startOpenCodeOwnedProcess({ ...fixture.input,
      environment: { ...fixture.input.environment, CHILD_EVIDENCE: childEvidence, TERM_EVIDENCE: termEvidence } });
    childPid = Number(await readFile(childEvidence, "utf8"));
    unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd: "/", stdio: "ignore", detached: true,
      env: { PATH: process.env.PATH, [OPENCODE_PROCESS_MARKER]: "unrelated" } });
    process.kill(owner.pid, "SIGKILL");
    await owner.exited;
    expect(await alive(childPid)).toBe(true);
    const started = Date.now();
    await owner.stop(); proved = true;
    expect(Date.now() - started).toBeGreaterThanOrEqual(5000);
    expect(await readFile(termEvidence, "utf8")).toBe("received");
    expect(await alive(childPid)).toBe(false);
    expect(await alive(unrelated.pid!)).toBe(true);
  } finally {
    if (childPid && await alive(childPid)) process.kill(childPid, "SIGKILL");
    if (unrelated?.pid && await alive(unrelated.pid)) unrelated.kill("SIGKILL");
    if (owner && !proved) await owner.stop();
    if (proved) await rm(fixture.root, { recursive: true, force: true });
    // Allow only the explicitly started unrelated child to settle before the
    // next machine-wide ownership scan; never search or kill by command name.
    if (unrelated?.pid) for (let count = 0; count < 100 && await alive(unrelated.pid); count += 1) await delay(10);
  }
});
