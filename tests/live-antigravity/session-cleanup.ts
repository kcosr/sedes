import { lstat, realpath, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { antigravityConversationsDirectory, readAntigravityNativeHistory } from "../../src/server/backends/antigravity/native-history.js";
import type { AntigravityIdentity, AntigravityRuntimeConfiguration } from "../../src/server/backends/antigravity/port.js";
export { readAntigravityNativeHistory };

/** Deletes only this invocation's freshly-created, independently verified
 * sessions. Never enumerates or adopts an operator's existing conversations. */
export async function removeAntigravityQualificationSession(configuration: AntigravityRuntimeConfiguration, identity: AntigravityIdentity, fixtureRoot: string) {
  return remove(configuration, identity, fixtureRoot, new Set());
}
async function remove(configuration: AntigravityRuntimeConfiguration, identity: AntigravityIdentity, fixtureRoot: string, seen: Set<string>, parentSessionId?: string): Promise<void> {
  if (seen.has(identity.sessionId) || seen.size >= 32) throw new Error("live_antigravity_cleanup_graph_denied");
  seen.add(identity.sessionId);
  const root = await realpath(fixtureRoot), cwd = await realpath(identity.cwd);
  if (!cwd.startsWith(`${root}${path.sep}`)) throw new Error("live_antigravity_cleanup_workspace_denied");
  const history = await readAntigravityNativeHistory(configuration, identity);
  if (parentSessionId && history.native.parentSessionId !== parentSessionId) throw new Error("live_antigravity_cleanup_parent_denied");
  const children = [...new Map(history.native.steps.flatMap(step => step.subagents?.map(child => [child.sessionId, child] as const) ?? [])).values()];
  for (const child of children) {
    // Independently check the child's exact parent and cwd, even if its runtime
    // state was unknown (for example shutdown interrupted response creation).
    // A reference alone never authorizes deletion of another session.
    await remove(configuration, { ...identity, sessionId: child.sessionId }, fixtureRoot, seen, identity.sessionId);
  }
  const conversations = await realpath(antigravityConversationsDirectory(configuration));
  const file = path.join(conversations, `${identity.sessionId}.db`);
  const metadata = await lstat(file); if (!metadata.isFile() || metadata.isSymbolicLink() || await realpath(file) !== file) throw new Error("live_antigravity_cleanup_file_denied");
  await unlink(file);
  for (const suffix of ["-wal", "-shm", "-journal"]) await rm(`${file}${suffix}`, { force: true });
  const app = path.dirname(conversations);
  await rm(path.join(app, "brain", identity.sessionId), { recursive: true, force: true });
  await rm(path.join(app, "annotations", `${identity.sessionId}.pbtxt`), { force: true });
}
