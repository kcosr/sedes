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
  "0.162.1",
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

describe("Codex 0.162.1 release contract", () => {
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

    expect(packageJson.devDependencies["@openai/codex"]).toBe("0.162.1");
    expect(release).toMatchObject({
      release: "0.162.1",
      git: {
        tag: "rust-v0.162.1",
        tagObject: "7a078f6bb4ce0dc2a81408b334ce52979d92c603",
        commit: "092d3acd6bec3e3a14bdc7e7a2810ab628ab759d",
      },
      npm: {
        version: "0.162.1",
        tarballSha256:
          "0b4b2e33a65883e4f69c903484d8dd7770b3cb8b324f520068b6fd85d42b65ea",
      },
      generation: {
        supportedPlatforms: [
          {
            nodePlatform: "linux",
            nodeArch: "x64",
            nativePackage: "@openai/codex-linux-x64",
            nativePackageVersion: "0.162.1-linux-x64",
            nativePackageTarballSha256:
              "7417711678b464eee70664126e39e88bb3c84c2928da0e71f14b56e04ff5c09f",
            executableRelativePath:
              "vendor/x86_64-unknown-linux-musl/bin/codex",
            executableSha256:
              "628e35487d888a28f0427fc37501da529dd3d81fcbad7a2c3421c1e8670d92e1",
          },
          {
            nodePlatform: "darwin",
            nodeArch: "arm64",
            nativePackage: "@openai/codex-darwin-arm64",
            nativePackageVersion: "0.162.1-darwin-arm64",
            nativePackageTarballSha256:
              "fe0370027a05237adc0152b482ad8502321f6f9aff1baca3bfa56588923ba9ad",
            executableRelativePath: "vendor/aarch64-apple-darwin/bin/codex",
            executableSha256:
              "74c6a6d263f40d65f99c27a815275f5b4ed0bcc2baecc396b4cf3255498bdfc0",
          },
          {
            nodePlatform: "darwin",
            nodeArch: "x64",
            nativePackage: "@openai/codex-darwin-x64",
            nativePackageVersion: "0.162.1-darwin-x64",
            nativePackageTarballSha256:
              "e4f53d69d399f1086eb35bc3a47786cbd03dd1f92c85e8217258e36f1470f5ec",
            executableRelativePath: "vendor/x86_64-apple-darwin/bin/codex",
            executableSha256:
              "f86b8cfd3de94dc70763d251da3ff292e94f4a53ad41b81faab3619a7bcb626c",
          },
        ],
        profiles: ["stable", "experimental"],
        rawJsonSchemaInventories: {
          stable: {
            count: 317,
            pathSetSha256:
              "82a0ac9dddbd14082843012aeac05b28782b8f746d484b66a92b5a78db2e4a2b",
          },
          experimental: {
            count: 447,
            pathSetSha256:
              "4c7ad7e50f969218bd74d4e6427c205ad1c9d0b29fc29c8026f3c32887683a14",
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
    ).toBe("codex-cli 0.162.1");

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
      "Codex 0.162.1 stable and experimental protocol artifacts are current.",
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
    expect(manifest.methods.serverNotifications).toHaveLength(86);
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
    expect(stable.officialArtifacts).toHaveLength(1060);
    expect(stable.officialTreeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(experimental).toMatchObject({
      profile: "experimental",
      experimentalApi: true,
      duplicateCleanGenerationVerified: true,
      officialGenerationEnvironment:
        "fresh empty temporary CODEX_HOME for each generation pass",
    });
    expect(experimental.officialArtifacts).toHaveLength(1335);
    expect(experimental.artifacts).toHaveLength(2);
    expect(experimental.officialTreeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(experimental.methods.clientRequests).toContain(
      "thread/settings/update",
    );
    expect(experimental.methods.clientRequests).toContain("process/spawn");
  });
});
