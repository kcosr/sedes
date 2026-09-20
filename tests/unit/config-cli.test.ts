import { existsSync } from "node:fs";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runConfigCli } from "../../src/cli/config-cli.js";

const exampleConfigurationFile = fileURLToPath(
  new URL("../../config/server.example.json", import.meta.url),
);

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: {
      stdout: { write: (value: string) => stdout.push(value) },
      stderr: { write: (value: string) => stderr.push(value) },
    },
    stdout: () => stdout.join(""),
    stderr: () => stderr.join(""),
  };
}

async function temporaryDirectory(): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), "sedes-config-cli-"));
}

async function writeConfiguration(value: unknown): Promise<{ directory: string; filename: string }> {
  const directory = await temporaryDirectory();
  const filename = path.join(directory, "server.json");
  await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return { directory, filename };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("sedes config validate", () => {
  it("accepts the checked-in example configuration", async () => {
    const io = capture();
    const stateDirectory = path.join(await temporaryDirectory(), "state");

    const exitCode = await runConfigCli(["validate", "--file", exampleConfigurationFile], {
      environment: { APP_STATE_DIR: stateDirectory },
      io: io.io,
    });

    expect(io.stderr()).toBe("");
    expect(exitCode).toBe(0);
    expect(io.stdout()).toContain(exampleConfigurationFile);
    expect(io.stdout()).toContain("schemaVersion 11");
    expect(io.stdout().trimEnd().split("\n")).toHaveLength(1);
  });

  it("reports the field path of an unknown field", async () => {
    const io = capture();
    const { filename } = await writeConfiguration({
      schemaVersion: 11,
      packagedClients: [],
      listen: { host: "127.0.0.1", port: 4784, bogusListenField: 1 },
      bogusTopLevelField: true,
    });

    const exitCode = await runConfigCli(["validate", "--file", filename], {
      environment: { APP_STATE_DIR: "/tmp/sedes-config-cli-state" },
      io: io.io,
    });

    expect(exitCode).toBe(1);
    expect(io.stdout()).toBe("");
    expect(io.stderr().trimEnd().split("\n")).toEqual([
      "listen.bogusListenField: Unrecognized key.",
      "bogusTopLevelField: Unrecognized key.",
    ]);
  });

  it("reports cross-field startup checks with their field path", async () => {
    const io = capture();
    const { filename } = await writeConfiguration({
      schemaVersion: 11,
      packagedClients: [],
      listen: { port: 80 },
    });

    const exitCode = await runConfigCli(["validate", "--file", filename], {
      environment: { APP_STATE_DIR: "/tmp/sedes-config-cli-state" },
      io: io.io,
    });

    expect(exitCode).toBe(1);
    expect(io.stderr()).toContain("listen.port:");
  });

  it("rejects a listener that startup would reject across fields", async () => {
    const io = capture();
    const { filename } = await writeConfiguration({
      schemaVersion: 11,
      packagedClients: [],
      listen: { host: "0.0.0.0", port: 4784 },
    });

    const exitCode = await runConfigCli(["validate", "--file", filename], {
      environment: { APP_STATE_DIR: "/tmp/sedes-config-cli-state" },
      io: io.io,
    });

    expect(exitCode).toBe(1);
    expect(io.stderr()).toContain("requires at least one configured packaged client");
  });

  it("fails clearly for a missing file", async () => {
    const io = capture();
    const missing = path.join(await temporaryDirectory(), "absent.json");

    const exitCode = await runConfigCli(["validate", "--file", missing], {
      environment: { APP_STATE_DIR: "/tmp/sedes-config-cli-state" },
      io: io.io,
    });

    expect(exitCode).toBe(1);
    expect(io.stderr()).toContain(`Server configuration file not found at "${missing}"`);
  });

  it("fails clearly for a file that is not valid JSON", async () => {
    const io = capture();
    const directory = await temporaryDirectory();
    const filename = path.join(directory, "server.json");
    await writeFile(filename, "{ not json", "utf8");

    const exitCode = await runConfigCli(["validate", "--file", filename], {
      environment: { APP_STATE_DIR: "/tmp/sedes-config-cli-state" },
      io: io.io,
    });

    expect(exitCode).toBe(1);
    expect(io.stderr()).toContain("is not valid JSON");
  });

  it("validates the SEDES_CONFIG_FILE default path and lets --file override it", async () => {
    const environmentDefault = await writeConfiguration({
      schemaVersion: 11,
      packagedClients: [],
      listen: { host: "127.0.0.1", port: 4784 },
    });
    const overridden = await writeConfiguration({
      schemaVersion: 11,
      packagedClients: [],
      listen: { host: "127.0.0.1", port: 5000 },
    });
    const environment = {
      SEDES_CONFIG_FILE: environmentDefault.filename,
      APP_STATE_DIR: "/tmp/sedes-config-cli-state",
    };

    const fromEnvironment = capture();
    expect(await runConfigCli(["validate"], { environment, io: fromEnvironment.io })).toBe(0);
    expect(fromEnvironment.stdout()).toContain(environmentDefault.filename);
    expect(fromEnvironment.stdout()).toContain("127.0.0.1:4784");

    const fromFlag = capture();
    expect(
      await runConfigCli(["validate", "--file", overridden.filename], { environment, io: fromFlag.io }),
    ).toBe(0);
    expect(fromFlag.stdout()).toContain(overridden.filename);
    expect(fromFlag.stdout()).toContain("127.0.0.1:5000");
    expect(fromFlag.stdout()).not.toContain(environmentDefault.filename);
  });

  it("reports the state directory startup would use and honours --state-directory", async () => {
    const io = capture();
    const stateDirectory = path.join(await temporaryDirectory(), "explicit-state");

    const exitCode = await runConfigCli(
      ["validate", "--file", exampleConfigurationFile, "--state-directory", stateDirectory],
      { environment: { APP_STATE_DIR: "/tmp/sedes-config-cli-unused" }, io: io.io },
    );

    expect(exitCode).toBe(0);
    expect(io.stdout()).toContain(stateDirectory);
    expect(existsSync(stateDirectory)).toBe(false);
  });

  it("rejects --state-directory when the bootstrap file sets a different stateDirectory", async () => {
    const io = capture();
    const fileState = path.join(await temporaryDirectory(), "file-state");
    const flagState = path.join(await temporaryDirectory(), "flag-state");
    const { filename } = await writeConfiguration({
      schemaVersion: 11,
      packagedClients: [],
      stateDirectory: fileState,
    });

    const exitCode = await runConfigCli(
      ["validate", "--file", filename, "--state-directory", flagState],
      { environment: {}, io: io.io },
    );

    expect(exitCode).toBe(1);
    expect(io.stderr()).toContain(`stateDirectory: the bootstrap file sets "${fileState}"`);
    expect(io.stderr()).toContain(flagState);
    expect(io.stdout()).toBe("");
    expect(existsSync(fileState)).toBe(false);
    expect(existsSync(flagState)).toBe(false);
  });

  it("accepts --state-directory that matches the bootstrap stateDirectory", async () => {
    const io = capture();
    const fileState = path.join(await temporaryDirectory(), "same-state");
    const { filename } = await writeConfiguration({
      schemaVersion: 11,
      packagedClients: [],
      stateDirectory: fileState,
    });

    const exitCode = await runConfigCli(
      ["validate", "--file", filename, "--state-directory", fileState],
      { environment: {}, io: io.io },
    );

    expect(exitCode).toBe(0);
    expect(io.stdout()).toContain(fileState);
  });

  it("rejects a relative --state-directory", async () => {
    const io = capture();

    const exitCode = await runConfigCli(
      ["validate", "--file", exampleConfigurationFile, "--state-directory", "relative/state"],
      { environment: {}, io: io.io },
    );

    expect(exitCode).toBe(1);
    expect(io.stderr()).toContain("--state-directory must be an absolute path.");
  });

  it("exits 2 with usage for an unknown flag, an unknown command, and no command", async () => {
    for (const args of [["validate", "--bogus"], ["bogus"], []]) {
      const io = capture();
      expect(await runConfigCli(args, { environment: {}, io: io.io })).toBe(2);
      expect(io.stderr()).toContain("sedes config validate [--file PATH] [--state-directory PATH]");
      expect(io.stdout()).toBe("");
    }
  });

  it("prints usage on stdout for --help", async () => {
    const io = capture();

    expect(await runConfigCli(["--help"], { environment: {}, io: io.io })).toBe(0);
    expect(await runConfigCli(["validate", "--help"], { environment: {}, io: io.io })).toBe(0);
    expect(io.stdout()).toContain("sedes config validate");
    expect(io.stderr()).toBe("");
  });

  it("creates no state directory, database, or network traffic", async () => {
    const io = capture();
    const root = await temporaryDirectory();
    const stateDirectory = path.join(root, "state");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("sedes config validate must not use the network.");
    });

    const exitCode = await runConfigCli(
      ["validate", "--file", exampleConfigurationFile, "--state-directory", stateDirectory],
      { environment: {}, io: io.io },
    );

    expect(exitCode).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(stateDirectory)).toBe(false);
    expect(await readdir(root)).toEqual([]);
  });
});
