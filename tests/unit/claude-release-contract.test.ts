import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_MINIMUM_VERSION,
  CLAUDE_CODE_TESTED_THROUGH_VERSION,
} from "../../src/server/backends/claude/claude-release-guard.js";
import { CLAUDE_AGENT_SDK_RELEASE } from "../../src/server/backends/claude/claude-sdk-facade.js";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

function readJson(filename: string): unknown {
  return JSON.parse(readFileSync(filename, "utf8"));
}

describe("Claude Agent SDK release contract", () => {
  it("pins the SDK artifact without deriving runtime policy from its bundled CLI", () => {
    const packageJson = readJson(path.join(repositoryRoot, "package.json")) as {
      dependencies: Record<string, string>;
    };
    const packageLock = readJson(
      path.join(repositoryRoot, "package-lock.json"),
    ) as {
      packages: Record<
        string,
        {
          dependencies?: Record<string, string>;
          version?: string;
          resolved?: string;
          integrity?: string;
        }
      >;
    };
    const installedPackage = readJson(
      path.join(
        repositoryRoot,
        "node_modules/@anthropic-ai/claude-agent-sdk/package.json",
      ),
    ) as {
      version: string;
      claudeCodeVersion: string;
    };

    expect(CLAUDE_AGENT_SDK_RELEASE).toBe("0.3.274");
    expect(CLAUDE_CODE_MINIMUM_VERSION).toBe("2.1.274");
    expect(CLAUDE_CODE_TESTED_THROUGH_VERSION).toBe("2.1.274");
    expect(packageJson.dependencies["@anthropic-ai/claude-agent-sdk"]).toBe(
      CLAUDE_AGENT_SDK_RELEASE,
    );
    expect(
      packageLock.packages[""]?.dependencies?.[
        "@anthropic-ai/claude-agent-sdk"
      ],
    ).toBe(CLAUDE_AGENT_SDK_RELEASE);
    expect(
      packageLock.packages["node_modules/@anthropic-ai/claude-agent-sdk"],
    ).toMatchObject({
      version: CLAUDE_AGENT_SDK_RELEASE,
      resolved:
        "https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/-/claude-agent-sdk-0.3.274.tgz",
      integrity:
        "sha512-kFmWMsh/BEd4jKkOxUeihr0xMkaMdOxONhNNkZ2pGmP0ElHkArvFvuZxqJTPvREnhCsPZByv5f0EzyAb/hkRZw==",
    });
    expect(installedPackage).toMatchObject({
      version: CLAUDE_AGENT_SDK_RELEASE,
      claudeCodeVersion: "2.1.274",
    });
  });
});
