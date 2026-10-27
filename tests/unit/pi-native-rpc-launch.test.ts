import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";
import { createPiNativeSessionProcess } from "../../src/server/backends/pi/native/rpc/pi-native-launch.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const action of cleanup.splice(0).reverse()) await action(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe.skipIf(process.platform === "win32")("native Pi owned launch", () => {
  it("correlates native exit status with initialization failure without retaining stderr or session paths", async () => {
    vi.stubEnv("SEDES_DEBUG_DELIVERY", "1");
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const directory = await mkdtemp(path.join(tmpdir(), "pi-exit-test-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const executablePath = path.join(directory, "pi.mjs"), bridgeDirectory = path.join(directory, "bridge");
    await mkdir(bridgeDirectory, { mode: 0o700 });
    await writeFile(executablePath, `#!${process.execPath}\nif (process.argv[2] === "--version") console.log("1.4.0"); else { console.error("private credential and provider text"); process.exitCode = 23; }\n`);
    await chmod(executablePath, 0o700);
    const scope = { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "local", backendInstanceId: "pi" };
    const environment = { PATH: process.env.PATH, HOME: directory };
    const channels = new LocalEnvironmentChannelProvider({ scope, executionEnvironmentId: scope.executionEnvironmentId, environment });
    cleanup.push(async () => channels.close());
    await expect(createPiNativeSessionProcess({ runtime: { ...scope, executablePath, initializationTimeoutMs: 2000, projectTrusted: false },
      cwd: directory, channels, environment, authenticationKey: Buffer.alloc(32, 1), bridgeDirectory,
      diagnostic: { runtimeId: "runtime", handleId: "handle", handleGeneration: "generation" },
    })).rejects.toThrow("pi_native_initialization_exited");
    const records = log.mock.calls.map(([line]) => JSON.parse(String(line).replace("[delivery-attachment] ", "")));
    const launch = records.find(record => record.event === "pi_native_launch_started");
    expect(records).toContainEqual(expect.objectContaining({ event: "pi_native_process_exited", reason: "exit", exitCode: 23, signal: null,
      attachmentId: launch.attachmentId, runtimeId: "runtime", handleId: "handle", handleGeneration: "generation" }));
    expect(records).toContainEqual(expect.objectContaining({ event: "pi_native_launch_failed", attachmentId: launch.attachmentId,
      errors: [{ name: "Error", code: "pi_native_initialization_exited" }] }));
    expect(JSON.stringify(records)).not.toContain(directory);
    expect(JSON.stringify(records)).not.toContain("private");
    expect((await readdir(bridgeDirectory)).some(name => name.startsWith("bootstrap-"))).toBe(false);
  });

  it("applies startup and explicit execution variables after sanitization, including deletions", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-env-test-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const executablePath = path.join(directory, "pi.mjs");
    const captured = path.join(directory, "captured.jsonl");
    const bridgeDirectory = path.join(directory, "bridge");
    await mkdir(bridgeDirectory, { mode: 0o700 });
    await writeFile(executablePath, `#!${process.execPath}
import { appendFileSync } from "node:fs";
const names = ["CUSTOM", "SECRET", "SECRET_SOURCE", "OPENAI_API_KEY", "PRIVATE_INHERITED", "SEDES_SERVER_TOKEN"];
appendFileSync(${JSON.stringify(captured)}, JSON.stringify({ args: process.argv.slice(2), managedEnvironment: Object.fromEntries(Object.entries(process.env).filter(([name]) => name.startsWith("SEDES_PI_"))), environment: Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])) }) + "\\n");
if (process.argv[2] === "--version") console.log("1.4.0");
`);
    await chmod(executablePath, 0o700);
    const scope = { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "local", backendInstanceId: "pi" };
    const environment = { PATH: process.env.PATH, HOME: directory, OPENAI_API_KEY: "removed", SECRET_SOURCE: "startup-secret", PRIVATE_INHERITED: "private", SEDES_SERVER_TOKEN: "private-token" };
    const channels = new LocalEnvironmentChannelProvider({ scope, executionEnvironmentId: scope.executionEnvironmentId, environment });
    cleanup.push(async () => channels.close());
    await expect(createPiNativeSessionProcess({ runtime: { ...scope, executablePath, initializationTimeoutMs: 2000, projectTrusted: false,
      startupEnvironmentVariables: { CUSTOM: { kind: "literal", value: "startup" }, SECRET: { kind: "secret", source: { kind: "environment", name: "SECRET_SOURCE" } } } },
      cwd: directory, channels, environment, executionEnvironment: { CUSTOM: "per-thread", OPENAI_API_KEY: null,
        SEDES_PI_AUTHENTICATION_KEY: "caller-key", SEDES_PI_BRIDGE_TOKEN: "caller-token" },
      authenticationKey: Buffer.alloc(32, 1), bridgeDirectory,
    })).rejects.toThrow("pi_native_initialization_exited");
    const launches = (await readFile(captured, "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(launches).toHaveLength(2);
    expect(launches[0].args).toEqual(["--version"]);
    expect(launches[1].args).toEqual(["--mode", "rpc", "--no-extensions", "-e", expect.any(String), "--no-approve", "--no-session"]);
    for (const launch of launches) expect(launch.environment).toEqual({ CUSTOM: "per-thread", SECRET: "startup-secret" });
    expect(launches[0].managedEnvironment).toEqual({});
    expect(launches[1].managedEnvironment).toEqual({ SEDES_PI_BOOTSTRAP_FILE: expect.stringContaining(`${bridgeDirectory}/bootstrap-`) });
    expect(JSON.stringify(launches)).not.toContain(Buffer.alloc(32, 1).toString("base64url"));
    expect((await readdir(bridgeDirectory)).some(name => name.startsWith("bootstrap-"))).toBe(false);
  });
});
