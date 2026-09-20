import type {
  NormalizedApplicationSnapshot,
  NormalizedApplicationThreadSummary,
} from "../../shared/index.js";

/**
 * Build one indexed matcher for a search pass. Workspace and environment
 * metadata are resolved once instead of scanning both collections for every
 * thread rendered or projected.
 */
export function createThreadSearchMatcher(
  search: string,
  snapshot?: Pick<
    NormalizedApplicationSnapshot,
    "workspaces" | "environments" | "executionTargets"
  >,
): (thread: NormalizedApplicationThreadSummary) => boolean {
  const query = search.trim().toLocaleLowerCase();
  if (!query) return () => true;

  const workspaceById = new Map(
    snapshot?.workspaces.map((workspace) => [workspace.id, workspace]) ?? [],
  );
  const environmentById = new Map(
    snapshot?.environments.map((environment) => [
      environment.id,
      environment,
    ]) ?? [],
  );
  const targetById = new Map(
    snapshot?.executionTargets.map((target) => [target.id, target]) ?? [],
  );

  return (thread) => {
    const workspace = workspaceById.get(thread.workspaceId);
    const environment = workspace
      ? environmentById.get(workspace.environmentId)
      : undefined;
    const target = targetById.get(thread.targetId);
    return [
      thread.title.text,
      workspace?.label.text,
      workspace?.displayPath.text,
      environment?.label.text,
      target?.label.text,
      target?.backend.label.text,
      thread.backend.label.text,
    ].some((value) => value?.toLocaleLowerCase().includes(query));
  };
}
