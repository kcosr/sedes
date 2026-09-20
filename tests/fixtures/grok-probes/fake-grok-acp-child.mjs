#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

// The probe runner appends its own canary after fixture-specific arguments.
const [scenario = "report", ...fixtureArguments] = process.argv.slice(2);
const hostCanaryPath = fixtureArguments.at(-1) ?? "";
const hostHomeCanaryPath = fixtureArguments.length > 1 ? fixtureArguments[0] : undefined;

if (scenario === "descendant") {
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
  setInterval(() => {}, 1_000);
} else if (scenario === "hang-with-descendant") {
  const descendant = spawn(
    process.execPath,
    [import.meta.filename, "descendant"],
    {
      detached: false,
      stdio: "ignore",
    },
  );
  await writeFile(
    path.join(process.cwd(), "descendant.pid"),
    `${descendant.pid}\n`,
  );
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1_000);
} else if (scenario === "stdout-flood") {
  process.stdout.write(
    `${JSON.stringify({ flood: "x".repeat(512 * 1024) })}\n`,
  );
} else if (scenario === "stderr-flood") {
  process.stderr.write("e".repeat(512 * 1024));
} else if (scenario === "file-flood") {
  for (let index = 0; index < 64; index += 1) {
    await writeFile(path.join(process.cwd(), `file-${index}`), "x");
  }
} else if (scenario === "echo-argument") {
  process.stdout.write(`${JSON.stringify({ value: process.argv[3] })}\n`);
} else if (scenario === "trailing-output") {
  process.stdout.write(`${JSON.stringify({ sequence: 1 })}\n`);
  process.on("exit", () => {
    fs.writeSync(1, `${JSON.stringify({ sequence: 2 })}\n`);
  });
} else if (scenario === "echo-input") {
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const frame = JSON.parse(line);
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: frame.id, result: { method: frame.method } })}\n`,
    );
  }
} else if (scenario === "initialize") {
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const frame = JSON.parse(line);
    await createSandboxFiles();
    process.stdout.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: frame.id,
        result: {
          protocolVersion: 1,
          observedMethod: frame.method,
          environment: selectedEnvironment(),
        },
      })}\n`,
    );
  }
} else {
  await createSandboxFiles();
  process.stdout.write(
    `${JSON.stringify({
      event: "startup",
      cwd: process.cwd(),
      uid: process.getuid?.(),
      environment: selectedEnvironment(),
      networkInterfaces: Object.keys(os.networkInterfaces()).sort(),
      hostCanary: await attemptRead(hostCanaryPath),
      ...(hostHomeCanaryPath ? { hostHome: await attemptRead(hostHomeCanaryPath) } : {}),
      ambientCanaries: await Promise.all(
        [
          "/etc/grok/.sedes-grok-probe-canary",
          "/home/probe/.claude/.sedes-grok-probe-canary",
          "/home/probe/.config/grok/.sedes-grok-probe-canary",
          "/home/probe/.grok/.sedes-grok-probe-canary",
          "/mnt/workspace/.claude/.sedes-grok-probe-canary",
          "/mnt/workspace/.grok/hooks/.sedes-grok-probe-canary",
          "/mnt/workspace/.grok/plugins/.sedes-grok-probe-canary",
          "/mnt/workspace/.sedes-grok-probe-mcp-canary",
        ].map(async (file) => ({ file, result: await attemptRead(file) })),
      ),
      baselineConfig: await attemptRead("/home/probe/.grok/config.toml"),
      rootWrite: await attemptWrite("/etc/sedes-grok-probe-write"),
      executableWrite: await attemptAppend(process.execPath),
      executableMode: (await stat(process.execPath)).mode & 0o777,
    })}\n`,
  );
}

async function createSandboxFiles() {
  const files = [
    [path.join(process.env.HOME, "home-created"), "home"],
    [path.join(process.env.GROK_HOME, "grok-created"), "grok"],
    [path.join(process.env.XDG_STATE_HOME, "state-created"), "state"],
    [path.join(process.cwd(), "workspace-created"), "workspace"],
    ["/tmp/tmp-created", "tmp"],
  ];
  for (const [file, value] of files) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, value);
  }
}

function selectedEnvironment() {
  return Object.fromEntries(
    Object.entries(process.env)
      .filter(([name]) =>
        [
          "ALL_PROXY",
          "DO_NOT_TRACK",
          "HOME",
          "GROK_HOME",
          "PATH",
          "TMPDIR",
          "XDG_CACHE_HOME",
          "XDG_CONFIG_HOME",
          "XDG_DATA_HOME",
          "XDG_STATE_HOME",
          "LANG",
          "LC_ALL",
          "TZ",
          "DISABLE_TELEMETRY",
          "GROK_DISABLE_AUTOUPDATER",
          "GROK_PROMPT_SUGGESTIONS",
          "GROK_TELEMETRY_ENABLED",
          "GROK_TURN_SUMMARY",
          "SEDES_GROK_PROBE_HOST_SECRET",
          "HTTPS_PROXY",
          "HTTP_PROXY",
          "NO_PROXY",
          "NO_COLOR",
          "OTEL_SDK_DISABLED",
        ].includes(name),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

async function attemptRead(file) {
  try {
    return { ok: true, value: await readFile(file, "utf8") };
  } catch (error) {
    return { ok: false, code: error.code };
  }
}

async function attemptWrite(file) {
  try {
    await writeFile(file, "unexpected");
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error.code };
  }
}

async function attemptAppend(file) {
  try {
    await appendFile(file, "unexpected");
    return { ok: true };
  } catch (error) {
    return { ok: false, code: error.code };
  }
}
