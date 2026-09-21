import { mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface InstallServerOptions {
  argv?: string[];
  packageRoot?: string;
  prefix?: string;
  binDir?: string;
  homeDirectory?: string;
  environment?: Record<string, string | undefined>;
  platform?: string;
  io?: {
    stdout: { write(value: string): unknown };
    stderr: { write(value: string): unknown };
  };
  verifyPackage?: (stagingDirectory: string, environment: Record<string, string | undefined>, options: Record<string, unknown>) => Promise<{source: {commit: string}, target: {label: string}}>;
  arch?: string;
  nodeAbi?: string;
  now?: () => Date;
  nodeVersion?: string;
}

interface InstallServerModule {
  installServer(options?: InstallServerOptions): Promise<number>;
  unitMarker: string;
  writeServerWrappers(root: string): Promise<void>;
}

// scripts/ is plain ESM JavaScript, so the module is loaded through its URL
// rather than a typed static import.
const { installServer, unitMarker, writeServerWrappers } = (await import(
  new URL("../../scripts/install-server-lib.mjs", import.meta.url).href
)) as InstallServerModule;

const { writePackageIntegrity, verifyPackageIntegrity } = await import(
  new URL("../../scripts/server-package-integrity.mjs", import.meta.url).href
);

const { verifyServerRelease } = await import(
  new URL("../../scripts/install-server-runtime.mjs", import.meta.url).href
);

const exampleConfiguration = {
  schemaVersion: 11,
  packagedClients: [],
  listen: { host: "127.0.0.1", port: 4784 },
};

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

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true }),
  ));
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "sedes-install-server-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createSourceRoot(version: string): Promise<string> {
  const root = await temporaryDirectory();
  await mkdir(path.join(root, "dist", "server"), { recursive: true });
  await mkdir(path.join(root, "dist", "cli"), { recursive: true });
  await mkdir(path.join(root, "dist", "client"), { recursive: true });
  await mkdir(path.join(root, "config"), { recursive: true });
  await writeFile(path.join(root, "dist", "server", "index.js"), "// server\n", "utf8");
  await writeFile(path.join(root, "dist", "cli", "sedes-cli-main.js"), "// cli\n", "utf8");
  await writeFile(path.join(root, "dist", "cli", "automation-cli.js"), "// automation\n", "utf8");
  await writeFile(path.join(root, "dist", "client", "index.html"), "<!doctype html>\n", "utf8");
  await writeFile(
    path.join(root, "package.json"),
    `${JSON.stringify({ name: "@sedes/server-runtime", version, private: true, dependencies: {} }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(root, "package-lock.json"),
    `${JSON.stringify({ name: "sedes", version, lockfileVersion: 3 }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(
    path.join(root, "config", "server.example.json"),
    `${JSON.stringify(exampleConfiguration, null, 2)}\n`,
    "utf8",
  );
  await mkdir(path.join(root, "node_modules"));
  await writeFile(path.join(root, "node_modules", ".stub"), "stub\n");
  await writeFile(path.join(root, "BUILD-INFO.json"), JSON.stringify({
    format: 1, version,
    source: { commit: "0123456789abcdef0123456789abcdef01234567" },
    target: { platform: "linux", arch: "x64", label: "linux-x86_64" },
    node: { minimum: "24.18.0", version: "24.18.0", abi: process.versions.modules },
  }));
  await writeServerWrappers(root);
  await writePackageIntegrity(root);
  return root;
}

interface Installation {
  home: string;
  prefix: string;
  binDir: string;
  configFile: string;
  unitFile: string;
  run(
    argv: string[],
    overrides?: InstallServerOptions,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

async function createInstallation(sourceRoot: string): Promise<Installation> {
  const root = await temporaryDirectory();
  const home = path.join(root, "home");
  const prefix = path.join(root, "share", "sedes");
  const binDir = path.join(home, ".local", "bin");
  await mkdir(home, { recursive: true });
  return {
    home,
    prefix,
    binDir,
    configFile: path.join(home, ".config", "sedes", "server.json"),
    unitFile: path.join(home, ".config", "systemd", "user", "sedes.service"),
    async run(argv, overrides = {}) {
      const io = capture();
      const exitCode = await installServer({
        argv,
        packageRoot: sourceRoot,
        prefix,
        binDir,
        homeDirectory: home,
        environment: { HOME: home, PATH: `${binDir}${path.delimiter}/usr/bin` },
        platform: "linux",
        io: io.io,
        arch: "x64",
        nodeVersion: "v24.18.0",
        verifyPackage: async (directory, _environment, options) => verifyPackageIntegrity(directory, options),
        ...overrides,
      });
      return { exitCode, stdout: io.stdout(), stderr: io.stderr() };
    },
  };
}

async function permissions(filename: string): Promise<number> {
  return (await stat(filename)).mode & 0o777;
}

describe("install:server fresh install", () => {
  it("creates the versioned layout, symlinks, wrappers, config, and unit file", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const installation = await createInstallation(sourceRoot);

    const result = await installation.run(["--systemd"]);

    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);

    const releaseDirectory = path.join(installation.prefix, "releases", "1.2.3");
    expect(await readFile(path.join(releaseDirectory, "package.json"), "utf8")).toContain("1.2.3");
    expect(await readFile(path.join(releaseDirectory, "package-lock.json"), "utf8")).toContain("lockfileVersion");
    expect(await readFile(path.join(releaseDirectory, "dist", "server", "index.js"), "utf8")).toBe("// server\n");
    expect(await readFile(path.join(releaseDirectory, "dist", "client", "index.html"), "utf8")).toContain("doctype");
    expect(await readFile(path.join(releaseDirectory, "node_modules", ".stub"), "utf8")).toBe("stub\n");

    expect(JSON.parse(await readFile(path.join(releaseDirectory, "RELEASE.json"), "utf8"))).toMatchObject({
      version: "1.2.3",
      commit: "0123456789abcdef0123456789abcdef01234567",
      node: "v24.18.0",
    });
    const installedAt = JSON.parse(await readFile(path.join(releaseDirectory, "RELEASE.json"), "utf8")).installedAt;
    expect(Number.isNaN(Date.parse(installedAt))).toBe(false);

    const cliWrapper = await readFile(path.join(releaseDirectory, "bin", "sedes"), "utf8");
    expect(cliWrapper.startsWith("#!/bin/sh\n")).toBe(true);
    expect(cliWrapper).toContain("dist/cli/sedes-cli-main.js");
    expect(await readFile(path.join(releaseDirectory, "bin", "sedes-automation"), "utf8")).toContain(
      "dist/cli/automation-cli.js",
    );
    const serverWrapper = await readFile(path.join(releaseDirectory, "bin", "sedes-server"), "utf8");
    expect(serverWrapper).toContain("NODE_ENV=production");
    expect(serverWrapper).toContain("dist/server/index.js");
    for (const name of ["sedes", "sedes-automation", "sedes-server"]) {
      expect(await permissions(path.join(releaseDirectory, "bin", name))).toBe(0o755);
    }

    expect(await readlink(path.join(installation.prefix, "current"))).toBe(path.join("releases", "1.2.3"));
    expect(await readlink(path.join(installation.binDir, "sedes"))).toBe(
      path.join(installation.prefix, "current", "bin", "sedes"),
    );
    expect(await readlink(path.join(installation.binDir, "sedes-automation"))).toBe(
      path.join(installation.prefix, "current", "bin", "sedes-automation"),
    );

    expect(JSON.parse(await readFile(installation.configFile, "utf8"))).toEqual(exampleConfiguration);

    const unit = await readFile(installation.unitFile, "utf8");
    expect(unit.startsWith(`${unitMarker}\n`)).toBe(true);
    expect(unit).toContain(`ExecStart=${path.join(installation.prefix, "current", "bin", "sedes-server")}`);
    expect(unit).toContain(`WorkingDirectory=${path.join(installation.prefix, "current")}`);
    expect(unit).toContain("TimeoutStopSec=45");
    expect(unit).toContain("KillSignal=SIGTERM");
    expect(unit).toContain("Environment=NODE_ENV=production");
    expect(unit).toContain("# Environment=SEDES_CONFIG_FILE=");
    expect(unit).toContain("WantedBy=default.target");

    expect(result.stdout).toContain("systemctl --user daemon-reload");
    expect(result.stdout).toContain("systemctl --user enable --now sedes.service");
    expect(result.stdout).toContain("Back up the complete state directory");
    expect(result.stdout).toContain("older");

    // No staging directory is left behind.
    expect((await readdir(path.join(installation.prefix, "releases"))).sort()).toEqual(["1.2.3"]);
  });

  it("keeps an existing configuration file", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const installation = await createInstallation(sourceRoot);
    await mkdir(path.dirname(installation.configFile), { recursive: true });
    await writeFile(installation.configFile, '{"schemaVersion":11,"operator":"kept"}\n', "utf8");

    const result = await installation.run([]);

    expect(result.exitCode).toBe(0);
    expect(await readFile(installation.configFile, "utf8")).toBe('{"schemaVersion":11,"operator":"kept"}\n');
    expect(result.stdout).toContain("Kept existing");
  });

  it("warns when the bin directory is not on PATH", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const installation = await createInstallation(sourceRoot);

    const result = await installation.run([], {
      environment: { HOME: installation.home, PATH: "/usr/bin" },
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("is not on PATH");
  });

  it("installs without creating systemd directories or instructions by default", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const installation = await createInstallation(sourceRoot);

    const result = await installation.run([]);

    expect(result.exitCode).toBe(0);
    await expect(readFile(installation.unitFile, "utf8")).rejects.toThrow();
    expect(result.stdout).toContain("Left systemd unchanged");
    expect(result.stdout).not.toContain("systemctl");
    await expect(stat(path.dirname(installation.unitFile))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("install:server refusals", () => {
  it("refuses a platform other than Linux or macOS", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const installation = await createInstallation(sourceRoot);

    const result = await installation.run([], { platform: "win32" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("supports Linux and macOS");
    expect(result.stderr).toContain("win32");
    await expect(readdir(installation.prefix)).rejects.toThrow();
  });

  it("refuses an incomplete extracted package", async () => {
    const broken = await createSourceRoot("1.2.3");
    const installation = await createInstallation(broken);
    await rm(path.join(broken, "dist", "cli", "sedes-cli-main.js"));

    const result = await installation.run([]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("dist/cli/sedes-cli-main.js");
    expect(result.stderr).toContain("npm run package:server");
  });

  it("refuses to install the same version twice without --force", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const newerSourceRoot = await createSourceRoot("1.3.0");
    const installation = await createInstallation(sourceRoot);
    expect((await installation.run([])).exitCode).toBe(0);

    const active = await installation.run([]);
    expect(active.exitCode).toBe(1);
    expect(active.stderr).toContain("active release");

    expect((await installation.run([], { packageRoot: newerSourceRoot })).exitCode).toBe(0);
    const result = await installation.run([]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("already exists; pass --force to replace it.");
    expect(await readlink(path.join(installation.prefix, "current"))).toBe(path.join("releases", "1.3.0"));
  });

  it("refuses to replace the active release even with --force", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const installation = await createInstallation(sourceRoot);
    expect((await installation.run([])).exitCode).toBe(0);

    const result = await installation.run(["--force"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("active release");
    expect(result.stderr).toContain("--activate");
    expect(await readFile(path.join(installation.prefix, "releases", "1.2.3", "node_modules", ".stub"), "utf8")).toBe(
      "stub\n",
    );
  });

  it("exits 2 with usage on an unknown argument", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const installation = await createInstallation(sourceRoot);

    const result = await installation.run(["--bogus"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("Unknown argument: --bogus");
    expect(result.stderr).toContain("Usage:");
  });

  it("exits 2 when a value flag has no value", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const installation = await createInstallation(sourceRoot);

    const result = await installation.run(["--activate"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--activate requires a value.");
  });

  it("exits 2 when install-only flags are combined with --list", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const installation = await createInstallation(sourceRoot);

    const result = await installation.run(["--list", "--force"]);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("--force");
  });
});

describe("install:server staging and activation", () => {
  it("replaces a release that is not active with --force", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const newerSourceRoot = await createSourceRoot("1.3.0");
    const installation = await createInstallation(sourceRoot);
    expect((await installation.run([])).exitCode).toBe(0);
    expect((await installation.run([], { packageRoot: newerSourceRoot })).exitCode).toBe(0);

    await writeFile(path.join(sourceRoot, "node_modules", ".stub"), "replaced\n");
    await writePackageIntegrity(sourceRoot);
    const result = await installation.run(["--force"]);

    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(installation.prefix, "releases", "1.2.3", "node_modules", ".stub"), "utf8")).toBe(
      "replaced\n",
    );
    expect(await readlink(path.join(installation.prefix, "current"))).toBe(path.join("releases", "1.2.3"));
    expect((await readdir(path.join(installation.prefix, "releases"))).sort()).toEqual(["1.2.3", "1.3.0"]);
  });

  it("stages without touching current when --no-activate is given", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const newerSourceRoot = await createSourceRoot("1.3.0");
    const installation = await createInstallation(sourceRoot);
    expect((await installation.run([])).exitCode).toBe(0);

    const result = await installation.run(["--no-activate"], { packageRoot: newerSourceRoot });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("--activate 1.3.0");
    expect(await readlink(path.join(installation.prefix, "current"))).toBe(path.join("releases", "1.2.3"));
    expect(await readFile(path.join(installation.prefix, "releases", "1.3.0", "RELEASE.json"), "utf8")).toContain(
      "1.3.0",
    );
  });

  it("activates an existing release and refreshes the bin symlinks", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const newerSourceRoot = await createSourceRoot("1.3.0");
    const installation = await createInstallation(sourceRoot);
    expect((await installation.run(["--systemd"])).exitCode).toBe(0);
    expect((await installation.run(["--no-activate"], { packageRoot: newerSourceRoot })).exitCode).toBe(0);

    const result = await installation.run(["--activate", "1.3.0", "--systemd"]);

    expect(result.exitCode).toBe(0);
    expect(await readlink(path.join(installation.prefix, "current"))).toBe(path.join("releases", "1.3.0"));
    expect(await readlink(path.join(installation.binDir, "sedes"))).toBe(
      path.join(installation.prefix, "current", "bin", "sedes"),
    );
    expect(result.stdout).toContain("systemctl --user restart sedes.service");

    const rollback = await installation.run(["--activate", "1.2.3", "--systemd"]);
    expect(rollback.exitCode).toBe(0);
    expect(await readlink(path.join(installation.prefix, "current"))).toBe(path.join("releases", "1.2.3"));
  });

  it("treats activating the active release as a no-op", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const installation = await createInstallation(sourceRoot);
    expect((await installation.run([])).exitCode).toBe(0);

    const result = await installation.run(["--activate", "1.2.3"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("already the active release");
    expect(await readlink(path.join(installation.prefix, "current"))).toBe(path.join("releases", "1.2.3"));
  });

  it("refuses to activate a release that is not installed", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const installation = await createInstallation(sourceRoot);
    expect((await installation.run([])).exitCode).toBe(0);

    const result = await installation.run(["--activate", "9.9.9"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("9.9.9");
    expect(await readlink(path.join(installation.prefix, "current"))).toBe(path.join("releases", "1.2.3"));
  });
});

describe("install:server unit file management", () => {
  it("leaves an existing managed unit unchanged during default upgrade and rollback", async () => {
    const installation = await createInstallation(await createSourceRoot("1.2.3"));
    expect((await installation.run(["--systemd"])).exitCode).toBe(0);
    const unit = (await readFile(installation.unitFile, "utf8")).replace(/^ExecStart=.*$/m, "ExecStart=/operator-command");
    await writeFile(installation.unitFile, unit);

    const upgrade = await installation.run([], { packageRoot: await createSourceRoot("1.3.0") });
    expect(upgrade.exitCode).toBe(0);
    expect(await readFile(installation.unitFile, "utf8")).toBe(unit);
    expect(upgrade.stdout).not.toContain("systemctl");
    expect(upgrade.stdout).toContain("start or restart the server through your chosen supervisor");
    const rollback = await installation.run(["--activate", "1.2.3"]);
    expect(rollback.exitCode).toBe(0);
    expect(await readFile(installation.unitFile, "utf8")).toBe(unit);
    expect(rollback.stdout).not.toContain("systemctl");
    expect(rollback.stdout).toContain("start or restart the server through your chosen supervisor");
    expect(await readlink(path.join(installation.prefix, "current"))).toBe("releases/1.2.3");
  });

  it("rewrites an installer-managed unit file but keeps an edited one", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const newerSourceRoot = await createSourceRoot("1.3.0");
    const installation = await createInstallation(sourceRoot);
    expect((await installation.run(["--systemd"])).exitCode).toBe(0);
    expect(await readFile(installation.unitFile, "utf8")).toContain(unitMarker);

    await writeFile(installation.unitFile, (await readFile(installation.unitFile, "utf8")).replace(/^ExecStart=.*$/m, "ExecStart=/stale"), "utf8");
    const upgrade = await installation.run(["--systemd"], { packageRoot: newerSourceRoot });
    expect(upgrade.exitCode).toBe(0);
    expect(upgrade.stdout).toContain("Updated");
    expect(await readFile(installation.unitFile, "utf8")).toContain(
      `ExecStart=${path.join(installation.prefix, "current", "bin", "sedes-server")}`,
    );
    expect(upgrade.stdout).toContain("systemctl --user restart sedes.service");

    const edited = "[Unit]\nDescription=Operator managed sedes\n";
    await writeFile(installation.unitFile, edited, "utf8");
    const third = await installation.run(["--systemd"], { packageRoot: await createSourceRoot("1.4.0") });

    expect(third.exitCode).toBe(0);
    expect(third.stderr).toContain("not installer-managed");
    expect(await readFile(installation.unitFile, "utf8")).toBe(edited);
  });
});

describe("install:server --list", () => {
  it("lists installed releases and marks the active one", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const installation = await createInstallation(sourceRoot);

    const empty = await installation.run(["--list"]);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toContain("No releases installed");

    expect((await installation.run([])).exitCode).toBe(0);
    expect((await installation.run(["--no-activate"], { packageRoot: await createSourceRoot("1.3.0") })).exitCode).toBe(
      0,
    );

    const result = await installation.run(["--list"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trimEnd().split("\n").slice(1)).toEqual(["* 1.2.3 (active)", "  1.3.0"]);
  });
});

describe("install:server --uninstall", () => {
  it("removes releases, links, and the managed unit while leaving state and configuration", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const installation = await createInstallation(sourceRoot);
    expect((await installation.run(["--systemd"])).exitCode).toBe(0);
    const stateDirectory = path.join(installation.home, ".local", "state", "sedes");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(path.join(stateDirectory, "overlay.sqlite"), "state\n", "utf8");

    const result = await installation.run(["--uninstall", "--purge"]);

    expect(result.exitCode).toBe(0);
    await expect(readdir(path.join(installation.prefix, "releases"))).rejects.toThrow();
    await expect(readlink(path.join(installation.prefix, "current"))).rejects.toThrow();
    await expect(readlink(path.join(installation.binDir, "sedes"))).rejects.toThrow();
    await expect(readlink(path.join(installation.binDir, "sedes-automation"))).rejects.toThrow();
    await expect(readFile(installation.unitFile, "utf8")).rejects.toThrow();

    expect(await readFile(path.join(stateDirectory, "overlay.sqlite"), "utf8")).toBe("state\n");
    expect(JSON.parse(await readFile(installation.configFile, "utf8"))).toEqual(exampleConfiguration);
    expect(result.stdout).toContain("never removes application state or configuration");
    expect(result.stdout).toContain("systemctl --user disable --now sedes.service");
  });

  it("leaves foreign bin entries and an edited unit file alone", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const installation = await createInstallation(sourceRoot);
    expect((await installation.run(["--systemd"])).exitCode).toBe(0);
    await rm(path.join(installation.binDir, "sedes"));
    await writeFile(path.join(installation.binDir, "sedes"), "#!/bin/sh\n# operator script\n", "utf8");
    await writeFile(installation.unitFile, "[Unit]\nDescription=Operator managed\n", "utf8");

    const result = await installation.run(["--uninstall"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("not a symlink");
    expect(result.stderr).toContain("not installer-managed");
    expect(await readFile(path.join(installation.binDir, "sedes"), "utf8")).toContain("operator script");
    expect(await readFile(installation.unitFile, "utf8")).toContain("Operator managed");
  });
});


describe("install:server lifecycle regression coverage", () => {
  it.each([
    ["file", "sedes"], ["foreign_symlink", "sedes"], ["file", "sedes-automation"],
  ] as const)(
    "refuses a %s at %s before changing the active release or other launchers",
    async (kind, name) => {
      const installation = await createInstallation(await createSourceRoot("1.2.3"));
      expect((await installation.run([])).exitCode).toBe(0);
      const newerSource = await createSourceRoot("1.3.0");
      expect((await installation.run(["--no-activate"], { packageRoot: newerSource })).exitCode).toBe(0);
      const launcher = path.join(installation.binDir, name);
      const otherName = name === "sedes" ? "sedes-automation" : "sedes";
      const otherLauncher = path.join(installation.binDir, otherName);
      const originalOtherTarget = await readlink(otherLauncher);
      const foreign = path.join(installation.home, "foreign-sedes");
      await rm(launcher);
      if (kind === "file") await writeFile(launcher, "operator-owned launcher");
      else await symlink(foreign, launcher);

      for (const [argv, sourceRoot] of [
        [["--activate", "1.3.0"], newerSource],
        [[], await createSourceRoot("1.4.0")],
      ] as const) {
        const result = await installation.run([...argv], { packageRoot: sourceRoot });
        expect(result.exitCode).toBe(1);
        expect(await readlink(path.join(installation.prefix, "current"))).toBe("releases/1.2.3");
        expect(await readlink(otherLauncher)).toBe(originalOtherTarget);
        if (kind === "file") expect(await readFile(launcher, "utf8")).toBe("operator-owned launcher");
        else expect(await readlink(launcher)).toBe(foreign);
      }
    },
  );

  it("completes a first staged installation without the original source checkout", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const installation = await createInstallation(sourceRoot);
    expect((await installation.run(["--no-activate"])).exitCode).toBe(0);
    await expect(stat(installation.configFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(installation.unitFile)).rejects.toMatchObject({ code: "ENOENT" });
    await rm(sourceRoot, { recursive: true });

    const result = await installation.run(["--activate", "1.2.3", "--systemd"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(installation.configFile, "utf8"))).toEqual(exampleConfiguration);
    expect(await readFile(installation.unitFile, "utf8")).toContain(unitMarker);
    expect(await readlink(path.join(installation.prefix, "current"))).toBe("releases/1.2.3");
    expect(result.stdout).toContain("systemctl --user daemon-reload");
    expect(result.stdout).toContain("systemctl --user enable --now sedes.service");
    expect(result.stdout).not.toContain("systemctl --user restart sedes.service");
  });

  it.each([
    [false, false], [true, false], [false, true], [true, true],
  ])("uses the activation's explicit opt-in (staged=%s, activation=%s)", async (stagedSystemd, activationSystemd) => {
    const installation = await createInstallation(await createSourceRoot("1.2.3"));
    expect((await installation.run(["--no-activate", ...(stagedSystemd ? ["--systemd"] : [])])).exitCode).toBe(0);
    await expect(stat(installation.unitFile)).rejects.toMatchObject({ code: "ENOENT" });

    const result = await installation.run(["--activate", "1.2.3", ...(activationSystemd ? ["--systemd"] : [])]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(installation.configFile, "utf8"))).toEqual(exampleConfiguration);
    if (activationSystemd) {
      expect(await readFile(installation.unitFile, "utf8")).toContain(unitMarker);
      expect(result.stdout).toContain("systemctl --user enable --now");
    } else {
      await expect(stat(installation.unitFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect(result.stdout).not.toContain("systemctl");
    }
  });

  it.each([true, false])("ignores an obsolete stored systemd=%s preference during activation", async (storedSystemd) => {
    const installation = await createInstallation(await createSourceRoot("1.2.3"));
    expect((await installation.run(["--no-activate"])).exitCode).toBe(0);
    const metadataFile = path.join(installation.prefix, "releases", "1.2.3", "RELEASE.json");
    const metadata = JSON.parse(await readFile(metadataFile, "utf8"));
    await writeFile(metadataFile, JSON.stringify({ ...metadata, systemd: storedSystemd }));

    const result = await installation.run(["--activate", "1.2.3", ...(storedSystemd ? [] : ["--systemd"])]);

    expect(result.exitCode).toBe(0);
    if (storedSystemd) {
      await expect(stat(path.dirname(installation.unitFile))).rejects.toMatchObject({ code: "ENOENT" });
      expect(result.stdout).not.toContain("systemctl");
    } else {
      expect(await readFile(installation.unitFile, "utf8")).toContain(unitMarker);
    }
  });

  it("rejects activation and uninstall while the same prefix has a force install in progress", async () => {
    const installation = await createInstallation(await createSourceRoot("1.2.3"));
    expect((await installation.run(["--systemd"])).exitCode).toBe(0);
    expect((await installation.run(["--systemd"], { packageRoot: await createSourceRoot("1.3.0") })).exitCode).toBe(0);
    let entered!: () => void;
    let release!: () => void;
    const stagingEntered = new Promise<void>((resolve) => { entered = resolve; });
    const stagingRelease = new Promise<void>((resolve) => { release = resolve; });
    const staging = installation.run(["--force", "--no-activate"], {
      verifyPackage: async (directory, _environment, options) => {
        entered();
        await stagingRelease;
        return await verifyPackageIntegrity(directory, options);
      },
    });
    try {
      await Promise.race([
        stagingEntered,
        staging.then(() => { throw new Error("Staging ended before reaching package verification."); }),
      ]);
      for (const argv of [["--activate", "1.2.3", "--systemd"], ["--uninstall"]]) {
        const blocked = await installation.run(argv);
        expect(blocked.exitCode).toBe(1);
        expect(blocked.stderr).toMatch(/busy/i);
        expect(await readlink(path.join(installation.prefix, "current"))).toBe("releases/1.3.0");
        expect(await readFile(installation.unitFile, "utf8")).toContain(unitMarker);
      }
    } finally {
      release();
      await staging;
    }
    expect((await staging).exitCode).toBe(0);
    expect((await installation.run(["--activate", "1.2.3", "--systemd"])).exitCode).toBe(0);
    expect(await readFile(path.join(installation.prefix, "current", "node_modules", ".stub"), "utf8")).toBe("stub\n");
  });

  it("uninstalls a second prefix without removing the first prefix's managed unit", async () => {
    const installation = await createInstallation(await createSourceRoot("1.2.3"));
    expect((await installation.run(["--systemd"])).exitCode).toBe(0);
    const originalUnit = await readFile(installation.unitFile, "utf8");
    const second = { prefix: path.join(installation.home, "second-prefix"), binDir: path.join(installation.home, "second-bin") };
    expect((await installation.run([], second)).exitCode).toBe(0);

    const result = await installation.run(["--uninstall"], second);

    expect(result.exitCode).toBe(0);
    expect(await readFile(installation.unitFile, "utf8")).toBe(originalUnit);
    expect(await readlink(path.join(installation.prefix, "current"))).toBe("releases/1.2.3");
    expect(await readlink(path.join(installation.binDir, "sedes"))).toBe(path.join(installation.prefix, "current", "bin", "sedes"));
    await expect(stat(path.join(second.prefix, "releases"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(result.stdout).not.toContain("systemctl --user disable --now sedes.service");
  });

  it("does not replace a service unit owned by another installation prefix", async () => {
    const installation = await createInstallation(await createSourceRoot("1.2.3"));
    expect((await installation.run(["--systemd"])).exitCode).toBe(0);
    const originalUnit = await readFile(installation.unitFile, "utf8");
    const second = { prefix: path.join(installation.home, "second-prefix"), binDir: path.join(installation.home, "second-bin") };

    const result = await installation.run(["--systemd"], second);

    expect(result.exitCode).toBe(1);
    expect(await readFile(installation.unitFile, "utf8")).toBe(originalUnit);
    expect(await readlink(path.join(installation.prefix, "current"))).toBe("releases/1.2.3");
    await expect(stat(path.join(second.prefix, "current"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});


describe("install:server staging failure recovery", () => {
  it("preserves installed releases and releases mutation locks after package verification fails", async () => {
    const installation = await createInstallation(await createSourceRoot("1.2.3"));
    expect((await installation.run(["--systemd"])).exitCode).toBe(0);
    expect((await installation.run(["--systemd"], { packageRoot: await createSourceRoot("1.3.0") })).exitCode).toBe(0);
    const unitBefore = await readFile(installation.unitFile, "utf8");

    const result = await installation.run(["--force"], {
      verifyPackage: async (directory, _environment, options) => {
        await writeFile(path.join(directory, "node_modules", ".partial"), "partial");
        throw new Error("Package verification failed");
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Package verification failed");
    expect(await readlink(path.join(installation.prefix, "current"))).toBe("releases/1.3.0");
    expect(await readFile(installation.unitFile, "utf8")).toBe(unitBefore);
    expect((await readdir(path.join(installation.prefix, "releases"))).sort()).toEqual(["1.2.3", "1.3.0"]);
    for (const version of ["1.2.3", "1.3.0"]) {
      expect(await readFile(path.join(installation.prefix, "releases", version, "node_modules", ".stub"), "utf8")).toBe("stub\n");
    }
    for (const lock of [
      path.join(installation.prefix, ".installer.lock"),
      path.join(installation.binDir, ".sedes-installer.lock"),
      path.join(installation.home, ".config", "sedes", ".installer.lock"),
    ]) await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await installation.run(["--force"])).exitCode).toBe(0);
    expect(await readlink(path.join(installation.prefix, "current"))).toBe("releases/1.2.3");
  });
});

describe("install:server package interface", () => {
  it.each(["install", "activate"])("rejects --systemd on macOS before %s mutates the installation", async (mode) => {
    const installation = await createInstallation(await createSourceRoot("1.2.3"));
    const result = await installation.run(["--systemd", ...(mode === "activate" ? ["--activate", "1.2.3"] : [])], { platform: "darwin" });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("--systemd is supported only on Linux");
    await expect(stat(installation.prefix)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["--no-systemd"], ["--systemd=true"], ["--list", "--systemd"], ["--uninstall", "--systemd"],
  ])("rejects obsolete or invalid systemd arguments: %s", async (...argv) => {
    const installation = await createInstallation(await createSourceRoot("1.2.3"));
    expect((await installation.run(argv)).exitCode).toBe(2);
    await expect(stat(installation.prefix)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("takes the extracted package explicitly, without using the checkout dependency tree", async () => {
    const installation = await createInstallation(await temporaryDirectory());
    const release = await createSourceRoot("1.2.3");
    const result = await installation.run(["--package", release]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Verifying copied server package offline");
    expect(result.stdout).not.toContain("npm ci");
    expect(await readFile(path.join(installation.prefix, "current", "FILES.json"), "utf8")).toBe(await readFile(path.join(release, "FILES.json"), "utf8"));
  });

  it.each(["corruption", "abi"])("refuses rollback after %s changes and preserves current", async (reason) => {
    const installation = await createInstallation(await createSourceRoot("1.2.3"));
    expect((await installation.run([])).exitCode).toBe(0);
    expect((await installation.run([], { packageRoot: await createSourceRoot("1.3.0") })).exitCode).toBe(0);
    if (reason === "corruption") await writeFile(path.join(installation.prefix, "releases", "1.2.3", "dist", "server", "index.js"), "damaged");
    const result = await installation.run(["--activate", "1.2.3"], reason === "abi" ? { nodeAbi: "other" } : {});
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/mismatch|does not match/);
    expect(await readlink(path.join(installation.prefix, "current"))).toBe("releases/1.3.0");
  });

  it("supports macOS packages without service flags", async () => {
    const root = await createSourceRoot("1.2.3");
    const info = JSON.parse(await readFile(path.join(root, "BUILD-INFO.json"), "utf8"));
    info.target = { platform: "darwin", arch: "arm64", label: "macos-arm64" };
    await writeFile(path.join(root, "BUILD-INFO.json"), JSON.stringify(info));
    await writePackageIntegrity(root);
    const installation = await createInstallation(root);
    expect((await installation.run([], { platform: "darwin", arch: "arm64" })).exitCode).toBe(0);
    await expect(stat(installation.unitFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(path.join(installation.prefix, "current", "bin", "sedes"), "utf8")).not.toContain("readlink -f");
  });

  it("rejects version traversal and package options on non-install modes", async () => {
    const installation = await createInstallation(await createSourceRoot("1.2.3"));
    expect((await installation.run(["--activate", "../elsewhere"])).stderr).toContain("Invalid release version");
    expect((await installation.run(["--list", "--package", "/somewhere"])).exitCode).toBe(2);
  });
});


describe("install:server inventory upgrade boundary", () => {
  it.each(["BUILD-INFO.json", "FILES.json", "SHA256SUMS"])("explains that a release missing %s must be rebuilt before activation", async (missing) => {
    const installation = await createInstallation(await createSourceRoot("1.2.3"));
    expect((await installation.run(["--systemd"])).exitCode).toBe(0);
    expect((await installation.run(["--systemd"], { packageRoot: await createSourceRoot("1.3.0") })).exitCode).toBe(0);
    const unit = await readFile(installation.unitFile, "utf8");
    await rm(path.join(installation.prefix, "releases", "1.2.3", missing));
    const result = await installation.run(["--activate", "1.2.3"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("predates dedicated server package inventories or is incomplete");
    expect(result.stderr).toContain(`missing ${missing}`);
    expect(result.stderr).toContain("Rebuild this revision with npm run package:server");
    expect(result.stderr).not.toContain("ENOENT");
    expect(await readlink(path.join(installation.prefix, "current"))).toBe("releases/1.3.0");
    expect(await readFile(installation.unitFile, "utf8")).toBe(unit);
  });
});


describe("install:server verifier completion boundary", () => {
  it("keeps current unchanged when activation through a symlinked prefix reaches a silent verifier", async () => {
    const installation = await createInstallation(await createSourceRoot("1.2.3"));
    await mkdir(installation.prefix, { recursive: true });
    const prefix = path.join(await temporaryDirectory(), "prefix-alias");
    await symlink(installation.prefix, prefix);
    expect((await installation.run(["--systemd"], { prefix })).exitCode).toBe(0);
    const candidate = await createSourceRoot("1.3.0");
    await mkdir(path.join(candidate, "scripts"));
    await writeFile(path.join(candidate, "scripts", "verify-server-package.mjs"), "process.exitCode = 0;\n");
    await writePackageIntegrity(candidate);
    // Stage the fixture with its byte inventory; activation must additionally
    // require the real verifier's completion report.
    expect((await installation.run(["--no-activate"], { prefix, packageRoot: candidate })).exitCode).toBe(0);
    const unit = await readFile(installation.unitFile, "utf8");
    const result = await installation.run(["--activate", "1.3.0", "--systemd"], { prefix, verifyPackage: verifyServerRelease });
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("server_package_verifier_report_invalid");
    expect(await readlink(path.join(installation.prefix, "current"))).toBe("releases/1.2.3");
    expect(await readFile(installation.unitFile, "utf8")).toBe(unit);
  });
});
