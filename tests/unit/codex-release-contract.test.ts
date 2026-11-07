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
  "0.167.0",
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

describe("Codex 0.167.0 release contract", () => {
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

    expect(packageJson.devDependencies["@openai/codex"]).toBe("0.167.0");
    expect(release).toMatchObject({
      release: "0.167.0",
      git: {
        tag: "rust-v0.167.0",
        tagObject: "cb41599ccbe371272892f156286a236aa097bada",
        commit: "086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a",
      },
      npm: {
        version: "0.167.0",
        tarballSha256:
          "e858522a37b85b5bbe695919190cfb0974aee5ae739d84d8d629c39735fb03a9",
      },
      generation: {
        supportedPlatforms: [
          {
            nodePlatform: "linux",
            nodeArch: "x64",
            nativePackage: "@openai/codex-linux-x64",
            nativePackageVersion: "0.167.0-linux-x64",
            nativePackageTarballSha256:
              "2dc9aa871abb513c3539d20d025f701faf1974c46ee906bda3a1e1f5026d4434",
            executableRelativePath:
              "vendor/x86_64-unknown-linux-musl/bin/codex",
            executableSha256:
              "cdcb45aaa01d0f14e298985e09465aebccd47f64ecd298aea44814af7b62bbda",
          },
          {
            nodePlatform: "darwin",
            nodeArch: "arm64",
            nativePackage: "@openai/codex-darwin-arm64",
            nativePackageVersion: "0.167.0-darwin-arm64",
            nativePackageTarballSha256:
              "6989512a93d5fc74cb221dd348c972bf3cd83592e471bfd9557bccb45eb6fffc",
            executableRelativePath: "vendor/aarch64-apple-darwin/bin/codex",
            executableSha256:
              "030316ecfbb41f4e7946e584b0063ef333b7a36cd312ba349f2f6869e39b62cc",
          },
          {
            nodePlatform: "darwin",
            nodeArch: "x64",
            nativePackage: "@openai/codex-darwin-x64",
            nativePackageVersion: "0.167.0-darwin-x64",
            nativePackageTarballSha256:
              "5b950f992ec8a2340c4c4c853d665639b27f618b64eede87ddf94b9ab7979360",
            executableRelativePath: "vendor/x86_64-apple-darwin/bin/codex",
            executableSha256:
              "a3b4df639ed5808100fe9d3dacdb324c9fb50b2804d72d5ab59def67bb2d6ab6",
          },
        ],
        profiles: ["stable", "experimental"],
        rawJsonSchemaInventories: {
          stable: {
            count: 322,
            pathSetSha256:
              "348b686ba4b480c272c54a6ffce2340198186c3b4f906a3df42c426e09dd3a25",
          },
          experimental: {
            count: 470,
            pathSetSha256:
              "017f2a34f3be957bdb32494d1721595044bb599ae653f9c5b5b391fd91cb25ec",
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
    ).toBe("codex-cli 0.167.0");

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
      "Codex 0.167.0 stable and experimental protocol artifacts are current.",
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
    expect(manifest.methods.serverNotifications).toHaveLength(88);
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
    expect(stable.officialArtifacts).toHaveLength(1083);
    expect(stable.officialTreeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(experimental).toMatchObject({
      profile: "experimental",
      experimentalApi: true,
      duplicateCleanGenerationVerified: true,
      officialGenerationEnvironment:
        "fresh empty temporary CODEX_HOME for each generation pass",
    });
    expect(experimental.officialArtifacts).toHaveLength(1396);
    expect(experimental.artifacts).toHaveLength(2);
    expect(experimental.officialTreeSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(experimental.methods.clientRequests).toContain(
      "thread/settings/update",
    );
    expect(experimental.methods.clientRequests).toContain("process/spawn");
  });
});
