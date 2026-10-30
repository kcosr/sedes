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
  "0.166.0",
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

describe("Codex 0.166.0 release contract", () => {
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

    expect(packageJson.devDependencies["@openai/codex"]).toBe("0.166.0");
    expect(release).toMatchObject({
      release: "0.166.0",
      git: {
        tag: "rust-v0.166.0",
        tagObject: "593389380740f7b4762771573c447ccfdc59742f",
        commit: "6ff1e1ca3b30fc8b914720681fcf5fe62e95f856",
      },
      npm: {
        version: "0.166.0",
        tarballSha256:
          "67ee6f4069d9328956401f54ac202c20369233159058af9f4ec1af731b87f5b7",
      },
      generation: {
        supportedPlatforms: [
          {
            nodePlatform: "linux",
            nodeArch: "x64",
            nativePackage: "@openai/codex-linux-x64",
            nativePackageVersion: "0.166.0-linux-x64",
            nativePackageTarballSha256:
              "cbc00a26d3d0e2ceefc4be8891f8a81ef1e349b3b175bc0ae308762bc001fd93",
            executableRelativePath:
              "vendor/x86_64-unknown-linux-musl/bin/codex",
            executableSha256:
              "b8a11fedf24b2dfb59a70c9e52b030f9a508dcd49cd2dd0d41956f4c785156b8",
          },
          {
            nodePlatform: "darwin",
            nodeArch: "arm64",
            nativePackage: "@openai/codex-darwin-arm64",
            nativePackageVersion: "0.166.0-darwin-arm64",
            nativePackageTarballSha256:
              "181d2eda8addbeca0b689c996df207293947928bdd9c88a097837ae1c7e69ca5",
            executableRelativePath: "vendor/aarch64-apple-darwin/bin/codex",
            executableSha256:
              "39acf979729dd290f9a24ee38b2914e036c91b65952872e28ae2a6b88a7db7c1",
          },
          {
            nodePlatform: "darwin",
            nodeArch: "x64",
            nativePackage: "@openai/codex-darwin-x64",
            nativePackageVersion: "0.166.0-darwin-x64",
            nativePackageTarballSha256:
              "588aad29a4779badc894daeb2e43757ed01d213366fd931fd9a5ec47f7e31e14",
            executableRelativePath: "vendor/x86_64-apple-darwin/bin/codex",
            executableSha256:
              "1361e18268866b7f9f5e8703fabcea0a2a990a439eedcce03940abb4ba9eaaeb",
          },
        ],
        profiles: ["stable", "experimental"],
        rawJsonSchemaInventories: {
          stable: {
            count: 321,
            pathSetSha256:
              "ff92e345c67fc7dd28d1218a302a38788f33304d56c682a246a2c4927d4bb519",
          },
          experimental: {
            count: 467,
            pathSetSha256:
              "b1e29d0c680598838a838c8a9fa38531d517a9c2af191ac06a4c8a1e107ed8cf",
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
    ).toBe("codex-cli 0.166.0");

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
      "Codex 0.166.0 stable and experimental protocol artifacts are current.",
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
    expect(manifest.methods.clientRequests).toHaveLength(109);
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
    expect(stable.officialArtifacts).toHaveLength(1081);
    expect(stable.officialTreeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(experimental).toMatchObject({
      profile: "experimental",
      experimentalApi: true,
      duplicateCleanGenerationVerified: true,
      officialGenerationEnvironment:
        "fresh empty temporary CODEX_HOME for each generation pass",
    });
    expect(experimental.officialArtifacts).toHaveLength(1388);
    expect(experimental.artifacts).toHaveLength(2);
    expect(experimental.officialTreeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(experimental.methods.clientRequests).toContain(
      "thread/settings/update",
    );
    expect(experimental.methods.clientRequests).toContain("process/spawn");
  });
});
