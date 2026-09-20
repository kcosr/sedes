import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const releaseRoot = path.join(
  repositoryRoot,
  "protocol",
  "codex-app-server",
  "0.153.0",
);
const codexBinary = path.join(
  repositoryRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "codex.cmd" : "codex",
);

function readJson(filename: string): unknown {
  return JSON.parse(readFileSync(filename, "utf8"));
}

describe("Codex 0.153.0 release contract", () => {
  it("pins the exact package, source release, and installed native executable", () => {
    const packageJson = readJson(path.join(repositoryRoot, "package.json")) as {
      devDependencies: Record<string, string>;
    };
    const release = readJson(path.join(releaseRoot, "release.json")) as {
      release: string;
      git: { tag: string; tagObject: string; commit: string };
      npm: {
        version: string;
        resolved: string;
        integrity: string;
        tarballSha256: string;
      };
      generation: {
        supportedPlatforms: Array<{
          nodePlatform: string;
          nodeArch: string;
          nativePackage: string;
          nativePackageVersion: string;
          nativePackageResolved: string;
          nativePackageIntegrity: string;
          nativePackageTarballSha256: string;
          executableRelativePath: string;
          executableSha256: string;
        }>;
        profiles: string[];
        rawJsonSchemaInventories: {
          stable: { count: number; pathSetSha256: string };
          experimental: { count: number; pathSetSha256: string };
        };
      };
    };
    const packageLock = readJson(
      path.join(repositoryRoot, "package-lock.json"),
    ) as {
      packages: Record<
        string,
        {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
          version?: string;
          resolved?: string;
          integrity?: string;
        }
      >;
    };

    expect(packageJson.devDependencies["@openai/codex"]).toBe("0.153.0");
    expect(release).toMatchObject({
      release: "0.153.0",
      git: {
        tag: "rust-v0.153.0",
        tagObject: "6bc50f104dcc0192e696cdeae721dfc19b507391",
        commit: "41e22fee981a63b3698df7ed36bad393cda24715",
      },
      npm: {
        version: "0.153.0",
        tarballSha256:
          "0dc1968cc6075929d70d7ab1421122743a9f8237a8cc9ac69e2e8f2768798fef",
      },
      generation: {
        supportedPlatforms: [
          {
            nodePlatform: "linux",
            nodeArch: "x64",
            nativePackage: "@openai/codex-linux-x64",
            nativePackageVersion: "0.153.0-linux-x64",
            nativePackageTarballSha256:
              "856f408ea61b44a381b7d6fb7c82365dfcef649ae2a340fc01282cf63c30cd8a",
            executableRelativePath:
              "vendor/x86_64-unknown-linux-musl/bin/codex",
            executableSha256:
              "fce635028842bfe9257140e8b7d53162732945e2f356fc35225be0702b4974be",
          },
          {
            nodePlatform: "darwin",
            nodeArch: "arm64",
            nativePackage: "@openai/codex-darwin-arm64",
            nativePackageVersion: "0.153.0-darwin-arm64",
            nativePackageTarballSha256:
              "ce03d32fe1cb0c4a02bf86a139a43519bb791c2ba6fe56d665c34fcadcbc7c00",
            executableRelativePath: "vendor/aarch64-apple-darwin/bin/codex",
            executableSha256:
              "a29d9e86eef88cbbd69f97ce8c590b1d0a287c8f77424f5eef226b883d7eaa22",
          },
          {
            nodePlatform: "darwin",
            nodeArch: "x64",
            nativePackage: "@openai/codex-darwin-x64",
            nativePackageVersion: "0.153.0-darwin-x64",
            nativePackageTarballSha256:
              "c636191070281854d869b3ff3f6efe506db81c9eb7035930440c8afb29d626a4",
            executableRelativePath: "vendor/x86_64-apple-darwin/bin/codex",
            executableSha256:
              "2a13d23097031d374c070df40c765abb7f336c99b3946697739a68335747ded8",
          },
        ],
        profiles: ["stable", "experimental"],
        rawJsonSchemaInventories: {
          stable: {
            count: 304,
            pathSetSha256:
              "74012ba6e3eb3e983fb166a5da123601ffa93e2cf2f243c2db10d6282cd475a9",
          },
          experimental: {
            count: 416,
            pathSetSha256:
              "f27c771f9f080e16adf7847652554698e477db9dacd9ca80e87b28bc8da2a417",
          },
        },
      },
    });
    expect(packageLock.packages[""]?.devDependencies?.["@openai/codex"]).toBe(
      release.npm.version,
    );
    expect(packageLock.packages["node_modules/@openai/codex"]).toMatchObject({
      version: release.npm.version,
      resolved: release.npm.resolved,
      integrity: release.npm.integrity,
    });
    for (const platform of release.generation.supportedPlatforms) {
      const nativePackage =
        packageLock.packages[`node_modules/${platform.nativePackage}`];
      expect(nativePackage).toMatchObject({
        version: platform.nativePackageVersion,
        resolved: platform.nativePackageResolved,
        integrity: platform.nativePackageIntegrity,
      });
      expect(platform.nativePackageTarballSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(platform.executableSha256).toMatch(/^[a-f0-9]{64}$/u);
    }
    expect(
      execFileSync(codexBinary, ["--version"], { encoding: "utf8" }).trim(),
    ).toBe("codex-cli 0.153.0");

    const platform = release.generation.supportedPlatforms.find(
      (candidate) =>
        candidate.nodePlatform === process.platform &&
        candidate.nodeArch === process.arch,
    );
    expect(platform).toBeDefined();
    if (platform === undefined) throw new Error("test_platform_unsupported");
    const nativeExecutable = path.join(
      repositoryRoot,
      "node_modules",
      platform.nativePackage,
      ...platform.executableRelativePath.split("/"),
    );
    const digest = createHash("sha256")
      .update(readFileSync(nativeExecutable))
      .digest("hex");
    expect(digest).toBe(platform.executableSha256);
  });

  it("regenerates the stable and experimental protocol trees without drift", () => {
    const output = execFileSync(
      process.execPath,
      [
        path.join(repositoryRoot, "scripts/generate-codex-protocol.mjs"),
        "--check",
      ],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
      },
    );
    expect(output).toContain(
      "Codex 0.153.0 stable and experimental protocol artifacts are current.",
    );
  }, 15_000);

  it("records the released stable method inventory and creation correlations", () => {
    const manifest = readJson(
      path.join(releaseRoot, "protocol-manifest.json"),
    ) as {
      experimentalApi: boolean;
      artifacts: unknown[];
      treeSha256: string;
      methods: {
        clientRequests: string[];
        serverRequests: string[];
        serverNotifications: string[];
        clientNotifications: string[];
      };
    };
    expect(manifest.experimentalApi).toBe(false);
    expect(manifest.artifacts).toHaveLength(2);
    expect(manifest.treeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.methods.clientRequests).toHaveLength(102);
    expect(manifest.methods.serverRequests).toHaveLength(10);
    expect(manifest.methods.serverNotifications).toHaveLength(83);
    expect(manifest.methods.clientNotifications).toEqual(["initialized"]);
    expect(manifest.methods.clientRequests).toContain("thread/start");
    expect(manifest.methods.clientRequests).toContain("turn/start");
    expect(manifest.methods.clientRequests).toContain("thread/items/list");
    expect(manifest.methods.clientRequests).toContain("thread/turns/list");
    expect(manifest.methods.clientRequests).toContain("thread/revert");
    expect(manifest.methods.clientRequests).toContain("thread/section/move");
    expect(manifest.methods.clientRequests).toContain("threadSection/create");
    expect(manifest.methods.clientRequests).toContain("threadSection/delete");
    expect(manifest.methods.clientRequests).toContain("threadSection/list");
    expect(manifest.methods.clientRequests).toContain("threadSection/update");
    expect(manifest.methods.serverNotifications).toContain("thread/started");
    expect(manifest.methods.clientRequests).not.toContain("process/spawn");
    expect(manifest.methods.clientRequests).not.toContain(
      "thread/settings/update",
    );

    const threadStart = readFileSync(
      path.join(
        releaseRoot,
        "official/stable/typescript/v2/ThreadStartParams.ts",
      ),
      "utf8",
    );
    const turnStart = readFileSync(
      path.join(
        releaseRoot,
        "official/stable/typescript/v2/TurnStartParams.ts",
      ),
      "utf8",
    );
    const requestUserInput = readFileSync(
      path.join(
        releaseRoot,
        "official/stable/typescript/v2/ToolRequestUserInputParams.ts",
      ),
      "utf8",
    );
    expect(threadStart).toContain("threadSource?: ThreadSource");
    expect(threadStart).not.toContain("dynamicTools");
    expect(threadStart).not.toContain("idempotency");
    expect(threadStart).not.toContain("clientUserMessageId");
    expect(turnStart).toContain("clientUserMessageId?: string");
    expect(requestUserInput).toContain("isBlocking: boolean");
    expect(requestUserInput).toContain("autoResolutionMs: number | null");
  });

  it("records separate official and canonical experimental provenance", () => {
    const stable = readJson(
      path.join(releaseRoot, "protocol-manifest.json"),
    ) as {
      profile: string;
      experimentalApi: boolean;
      duplicateCleanGenerationVerified: boolean;
      officialGenerationEnvironment: string;
      officialArtifacts: unknown[];
      officialTreeSha256: string;
    };
    const experimental = readJson(
      path.join(releaseRoot, "protocol-manifest-experimental.json"),
    ) as typeof stable & {
      methods: { clientRequests: string[] };
      artifacts: unknown[];
    };

    expect(stable).toMatchObject({
      profile: "stable",
      experimentalApi: false,
      duplicateCleanGenerationVerified: true,
      officialGenerationEnvironment:
        "fresh empty temporary CODEX_HOME for each generation pass",
    });
    expect(stable.officialArtifacts).toHaveLength(1_010);
    expect(stable.officialTreeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(experimental).toMatchObject({
      profile: "experimental",
      experimentalApi: true,
      duplicateCleanGenerationVerified: true,
      officialGenerationEnvironment:
        "fresh empty temporary CODEX_HOME for each generation pass",
    });
    expect(experimental.officialArtifacts).toHaveLength(1_243);
    expect(experimental.artifacts).toHaveLength(2);
    expect(experimental.officialTreeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(experimental.methods.clientRequests).toContain(
      "thread/settings/update",
    );
    expect(experimental.methods.clientRequests).toContain("process/spawn");
  });
});
