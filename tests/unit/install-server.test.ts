import { mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

interface InstallServerOptions {
  argv?: string[];
  sourceRoot?: string;
  prefix?: string;
  binDir?: string;
  homeDirectory?: string;
  environment?: Record<string, string | undefined>;
  platform?: string;
  io?: {
    stdout: { write(value: string): unknown };
    stderr: { write(value: string): unknown };
  };
  installDependencies?: (stagingDirectory: string) => Promise<void>;
  resolveCommit?: (sourceRoot: string) => Promise<string | undefined>;
  now?: () => Date;
  nodeVersion?: string;
}

interface InstallServerModule {
  installServer(options?: InstallServerOptions): Promise<number>;
  unitMarker: string;
}

// scripts/ is plain ESM JavaScript, so the module is loaded through its URL
// rather than a typed static import.
const { installServer, unitMarker } = (await import(
  new URL("../../scripts/install-server-lib.mjs", import.meta.url).href
)) as InstallServerModule;

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
    `${JSON.stringify({ name: "sedes", version, private: true, dependencies: {} }, null, 2)}\n`,
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
        sourceRoot,
        prefix,
        binDir,
        homeDirectory: home,
        environment: { HOME: home, PATH: `${binDir}${path.delimiter}/usr/bin` },
        platform: "linux",
        io: io.io,
        resolveCommit: async () => "0123456789abcdef0123456789abcdef01234567",
        nodeVersion: "v24.18.0",
        installDependencies: async (stagingDirectory: string) => {
          await mkdir(path.join(stagingDirectory, "node_modules"), { recursive: true });
          await writeFile(path.join(stagingDirectory, "node_modules", ".stub"), "stub\n", "utf8");
        },
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

    const result = await installation.run([]);

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

  it("skips the unit file with --no-systemd", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const installation = await createInstallation(sourceRoot);

    const result = await installation.run(["--no-systemd"]);

    expect(result.exitCode).toBe(0);
    await expect(readFile(installation.unitFile, "utf8")).rejects.toThrow();
    expect(result.stdout).toContain("Skipped the systemd unit file");
  });
});

describe("install:server refusals", () => {
  it("refuses a platform other than Linux", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const installation = await createInstallation(sourceRoot);

    const result = await installation.run([], { platform: "darwin" });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Linux only");
    expect(result.stderr).toContain("darwin");
    await expect(readdir(installation.prefix)).rejects.toThrow();
  });

  it("refuses a source tree that has not been built", async () => {
    const broken = await createSourceRoot("1.2.3");
    const installation = await createInstallation(broken);
    await rm(path.join(broken, "dist", "cli", "sedes-cli-main.js"));

    const result = await installation.run([]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("dist/cli/sedes-cli-main.js");
    expect(result.stderr).toContain("npm run build");
  });

  it("refuses to install the same version twice without --force", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const newerSourceRoot = await createSourceRoot("1.3.0");
    const installation = await createInstallation(sourceRoot);
    expect((await installation.run([])).exitCode).toBe(0);

    const active = await installation.run([]);
    expect(active.exitCode).toBe(1);
    expect(active.stderr).toContain("active release");

    expect((await installation.run([], { sourceRoot: newerSourceRoot })).exitCode).toBe(0);
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
    expect((await installation.run([], { sourceRoot: newerSourceRoot })).exitCode).toBe(0);

    const result = await installation.run(["--force"], {
      installDependencies: async (stagingDirectory: string) => {
        await mkdir(path.join(stagingDirectory, "node_modules"), { recursive: true });
        await writeFile(path.join(stagingDirectory, "node_modules", ".stub"), "replaced\n", "utf8");
      },
    });

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

    const result = await installation.run(["--no-activate"], { sourceRoot: newerSourceRoot });

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
    expect((await installation.run([])).exitCode).toBe(0);
    expect((await installation.run(["--no-activate"], { sourceRoot: newerSourceRoot })).exitCode).toBe(0);

    const result = await installation.run(["--activate", "1.3.0"]);

    expect(result.exitCode).toBe(0);
    expect(await readlink(path.join(installation.prefix, "current"))).toBe(path.join("releases", "1.3.0"));
    expect(await readlink(path.join(installation.binDir, "sedes"))).toBe(
      path.join(installation.prefix, "current", "bin", "sedes"),
    );
    expect(result.stdout).toContain("systemctl --user restart sedes.service");

    const rollback = await installation.run(["--activate", "1.2.3"]);
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
  it("rewrites an installer-managed unit file but keeps an edited one", async () => {
    const sourceRoot = await createSourceRoot("1.2.3");
    const newerSourceRoot = await createSourceRoot("1.3.0");
    const installation = await createInstallation(sourceRoot);
    expect((await installation.run([])).exitCode).toBe(0);
    expect(await readFile(installation.unitFile, "utf8")).toContain(unitMarker);

    await writeFile(installation.unitFile, (await readFile(installation.unitFile, "utf8")).replace(/^ExecStart=.*$/m, "ExecStart=/stale"), "utf8");
    const upgrade = await installation.run([], { sourceRoot: newerSourceRoot });
    expect(upgrade.exitCode).toBe(0);
    expect(upgrade.stdout).toContain("Updated");
    expect(await readFile(installation.unitFile, "utf8")).toContain(
      `ExecStart=${path.join(installation.prefix, "current", "bin", "sedes-server")}`,
    );
    expect(upgrade.stdout).toContain("systemctl --user restart sedes.service");

    const edited = "[Unit]\nDescription=Operator managed sedes\n";
    await writeFile(installation.unitFile, edited, "utf8");
    const third = await installation.run([], { sourceRoot: await createSourceRoot("1.4.0") });

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
    expect((await installation.run(["--no-activate"], { sourceRoot: await createSourceRoot("1.3.0") })).exitCode).toBe(
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
    expect((await installation.run([])).exitCode).toBe(0);
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
    expect((await installation.run([])).exitCode).toBe(0);
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
      expect((await installation.run(["--no-activate"], { sourceRoot: newerSource })).exitCode).toBe(0);
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
        const result = await installation.run([...argv], { sourceRoot });
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

    const result = await installation.run(["--activate", "1.2.3"]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(await readFile(installation.configFile, "utf8"))).toEqual(exampleConfiguration);
    expect(await readFile(installation.unitFile, "utf8")).toContain(unitMarker);
    expect(await readlink(path.join(installation.prefix, "current"))).toBe("releases/1.2.3");
    expect(result.stdout).toContain("systemctl --user daemon-reload");
    expect(result.stdout).toContain("systemctl --user enable --now sedes.service");
    expect(result.stdout).not.toContain("systemctl --user restart sedes.service");
  });

  it.each(["stored_skip", "activation_override"] as const)(
    "honors --no-systemd during staged activation (%s)",
    async (mode) => {
      const installation = await createInstallation(await createSourceRoot("1.2.3"));
      const stageArgs = mode === "stored_skip" ? ["--no-activate", "--no-systemd"] : ["--no-activate"];
      expect((await installation.run(stageArgs)).exitCode).toBe(0);
      const metadata = JSON.parse(await readFile(path.join(installation.prefix, "releases", "1.2.3", "RELEASE.json"), "utf8"));
      expect(metadata.systemd).toBe(mode !== "stored_skip");

      const result = await installation.run([
        "--activate", "1.2.3", ...(mode === "activation_override" ? ["--no-systemd"] : []),
      ]);

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(await readFile(installation.configFile, "utf8"))).toEqual(exampleConfiguration);
      await expect(stat(installation.unitFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect(result.stdout).not.toContain("systemctl --user restart");
      expect(result.stdout).not.toContain("systemctl --user enable");
    },
  );

  it("rejects activation and uninstall while the same prefix has a force install in progress", async () => {
    const installation = await createInstallation(await createSourceRoot("1.2.3"));
    expect((await installation.run([])).exitCode).toBe(0);
    expect((await installation.run([], { sourceRoot: await createSourceRoot("1.3.0") })).exitCode).toBe(0);
    let entered!: () => void;
    let release!: () => void;
    const stagingEntered = new Promise<void>((resolve) => { entered = resolve; });
    const stagingRelease = new Promise<void>((resolve) => { release = resolve; });
    const staging = installation.run(["--force", "--no-activate"], {
      installDependencies: async (directory) => {
        entered();
        await stagingRelease;
        await mkdir(path.join(directory, "node_modules"));
        await writeFile(path.join(directory, "node_modules", ".stub"), "replacement");
      },
    });
    try {
      await Promise.race([
        stagingEntered,
        staging.then(() => { throw new Error("Staging ended before reaching dependency installation."); }),
      ]);
      for (const argv of [["--activate", "1.2.3"], ["--uninstall"]]) {
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
    expect((await installation.run(["--activate", "1.2.3"])).exitCode).toBe(0);
    expect(await readFile(path.join(installation.prefix, "current", "node_modules", ".stub"), "utf8")).toBe("replacement");
  });

  it("uninstalls a second prefix without removing the first prefix's managed unit", async () => {
    const installation = await createInstallation(await createSourceRoot("1.2.3"));
    expect((await installation.run([])).exitCode).toBe(0);
    const originalUnit = await readFile(installation.unitFile, "utf8");
    const second = { prefix: path.join(installation.home, "second-prefix"), binDir: path.join(installation.home, "second-bin") };
    expect((await installation.run(["--no-systemd"], second)).exitCode).toBe(0);

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
    expect((await installation.run([])).exitCode).toBe(0);
    const originalUnit = await readFile(installation.unitFile, "utf8");
    const second = { prefix: path.join(installation.home, "second-prefix"), binDir: path.join(installation.home, "second-bin") };

    const result = await installation.run([], second);

    expect(result.exitCode).toBe(1);
    expect(await readFile(installation.unitFile, "utf8")).toBe(originalUnit);
    expect(await readlink(path.join(installation.prefix, "current"))).toBe("releases/1.2.3");
    await expect(stat(path.join(second.prefix, "current"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});


describe("install:server staging failure recovery", () => {
  it("preserves installed releases and releases mutation locks after dependency preparation fails", async () => {
    const installation = await createInstallation(await createSourceRoot("1.2.3"));
    expect((await installation.run([])).exitCode).toBe(0);
    expect((await installation.run([], { sourceRoot: await createSourceRoot("1.3.0") })).exitCode).toBe(0);
    const unitBefore = await readFile(installation.unitFile, "utf8");

    const result = await installation.run(["--force"], {
      installDependencies: async (directory) => {
        await mkdir(path.join(directory, "node_modules"));
        await writeFile(path.join(directory, "node_modules", ".partial"), "partial");
        throw new Error("Native dependency preparation failed");
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Native dependency preparation failed");
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
