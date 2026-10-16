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
  "0.163.0",
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

describe("Codex 0.163.0 release contract", () => {
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

    expect(packageJson.devDependencies["@openai/codex"]).toBe("0.163.0");
    expect(release).toMatchObject({
      release: "0.163.0",
      git: {
        tag: "rust-v0.163.0",
        tagObject: "129b8ec7ee6f4511557a4856279f529025c25af4",
        commit: "83086188ae0614bd882818ff1aa23f3194962012",
      },
      npm: {
        version: "0.163.0",
        tarballSha256:
          "1a71db36560bb446d2c2e63ae675c4a3018c38ace38ca533f8d1b25d3e6555b4",
      },
      generation: {
        supportedPlatforms: [
          {
            nodePlatform: "linux",
            nodeArch: "x64",
            nativePackage: "@openai/codex-linux-x64",
            nativePackageVersion: "0.163.0-linux-x64",
            nativePackageTarballSha256:
              "30efc97738b975940d78b59a9bea115fa34040b732807d54ec35ae6b7528de94",
            executableRelativePath:
              "vendor/x86_64-unknown-linux-musl/bin/codex",
            executableSha256:
              "399ff69c431c066e40de318fba45c2b07f45a76b19939d247ee4828fc70c4215",
          },
          {
            nodePlatform: "darwin",
            nodeArch: "arm64",
            nativePackage: "@openai/codex-darwin-arm64",
            nativePackageVersion: "0.163.0-darwin-arm64",
            nativePackageTarballSha256:
              "1193ff4ce72387a5d6c34820b54a9dc57d007c67a958e8acb4715924facd3c31",
            executableRelativePath: "vendor/aarch64-apple-darwin/bin/codex",
            executableSha256:
              "8813367285524ac798dd96d1b071aea30d58708c7226fd236cd275cf1cfdee31",
          },
          {
            nodePlatform: "darwin",
            nodeArch: "x64",
            nativePackage: "@openai/codex-darwin-x64",
            nativePackageVersion: "0.163.0-darwin-x64",
            nativePackageTarballSha256:
              "74267d7b7a18a5029fbefc85b003a2c56a7b3bbee1418162208dab5b6babf0da",
            executableRelativePath: "vendor/x86_64-apple-darwin/bin/codex",
            executableSha256:
              "73697f229103f463acaafd8659976caaa4892ec11e2c246c7fa97f93d523f90e",
          },
        ],
        profiles: ["stable", "experimental"],
        rawJsonSchemaInventories: {
          stable: {
            count: 318,
            pathSetSha256:
              "d9f2869f5ade65b0c8541f469fd691225f8e4330dd2718c0477538cc25f9c65b",
          },
          experimental: {
            count: 452,
            pathSetSha256:
              "9f25c530495bc9b90cd6468f686c9fd05c4a87b190e6f81bdfa5f8b86ad38fff",
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
    ).toBe("codex-cli 0.163.0");

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
      "Codex 0.163.0 stable and experimental protocol artifacts are current.",
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
    expect(manifest.methods.clientRequests).toHaveLength(108);
    expect(manifest.methods.serverRequests).toHaveLength(10);
    expect(manifest.methods.serverNotifications).toHaveLength(87);
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
    expect(stable.officialArtifacts).toHaveLength(1065);
    expect(stable.officialTreeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(experimental).toMatchObject({
      profile: "experimental",
      experimentalApi: true,
      duplicateCleanGenerationVerified: true,
      officialGenerationEnvironment:
        "fresh empty temporary CODEX_HOME for each generation pass",
    });
    expect(experimental.officialArtifacts).toHaveLength(1348);
    expect(experimental.artifacts).toHaveLength(2);
    expect(experimental.officialTreeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(experimental.methods.clientRequests).toContain(
      "thread/settings/update",
    );
    expect(experimental.methods.clientRequests).toContain("process/spawn");
  });
});
