import { readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Sedes passes the operator's Claude Code executable to the SDK explicitly.
// Keep the SDK itself and other optional dependencies; only discard its unused
// platform executable packages after npm has installed them.
export async function pruneClaudeExecutables(modulesRoot) {
  const anthropicRoot = path.join(modulesRoot, "@anthropic-ai");
  const entries = await readdir(anthropicRoot).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  await Promise.all(
    entries
      .filter((name) => /^claude-agent-sdk-(linux|darwin|win32)-/.test(name))
      .map((name) =>
        rm(path.join(anthropicRoot, name), { recursive: true, force: true }),
      ),
  );
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await pruneClaudeExecutables(
    fileURLToPath(new URL("../node_modules", import.meta.url)),
  );
}
