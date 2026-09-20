import { chmod, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

export async function prepareNodePtySpawnHelper({
  platform,
  architecture,
  nodePtyRoot,
}) {
  if (platform !== "darwin") return;

  const helperPath = path.join(
    nodePtyRoot,
    "prebuilds",
    `${platform}-${architecture}`,
    "spawn-helper",
  );
  const metadata = await stat(helperPath).catch((error) => {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  });
  if (metadata === undefined) return;
  if (!metadata.isFile()) {
    throw new Error("node_pty_spawn_helper_invalid");
  }
  const permissions = metadata.mode & 0o777;
  if ((permissions & 0o111) !== 0o111) {
    await chmod(helperPath, permissions | 0o111);
  }
}

async function main() {
  const require = createRequire(import.meta.url);
  const nodePtyRoot = path.dirname(path.dirname(require.resolve("node-pty")));
  await prepareNodePtySpawnHelper({
    platform: process.platform,
    architecture: process.arch,
    nodePtyRoot,
  });
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await main();
}
