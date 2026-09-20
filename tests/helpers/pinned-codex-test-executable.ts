import { createRequire } from "node:module";
import path from "node:path";
import release from "../../protocol/codex-app-server/0.153.0/release.json" with { type: "json" };

const require = createRequire(import.meta.url);

/**
 * Resolve the protocol fixture's pinned native Codex binary for offline
 * integration tests. Production runtime discovery must never use this helper.
 */
export function pinnedCodexTestExecutable(): string {
  const platform = release.generation.supportedPlatforms.find(
    (candidate) =>
      candidate.nodePlatform === process.platform &&
      candidate.nodeArch === process.arch,
  );
  if (!platform) {
    throw new Error(
      `codex_test_platform_unsupported:${process.platform}/${process.arch}`,
    );
  }
  const packageJsonPath = require.resolve(
    `${platform.nativePackage}/package.json`,
  );
  return path.join(
    path.dirname(packageJsonPath),
    ...platform.executableRelativePath.split("/"),
  );
}
