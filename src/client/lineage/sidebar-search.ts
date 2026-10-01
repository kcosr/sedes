import type {
  NormalizedApplicationSnapshot,
  NormalizedApplicationThreadSummary,
} from "../../shared/index.js";

type SearchCatalog = Pick<
  NormalizedApplicationSnapshot,
  "workspaces" | "environments" | "executionTargets"
>;

/** The resolved catalog entries a thread's search text is drawn from. */
export interface ThreadSearchContext {
  readonly workspace?: SearchCatalog["workspaces"][number];
  readonly environment?: SearchCatalog["environments"][number];
  readonly target?: SearchCatalog["executionTargets"][number];
}

/** The normalized query a search pass compares; empty means match all. */
export function normalizeThreadSearchQuery(search: string): string {
  return search.trim().toLocaleLowerCase();
}

/**
 * Every text a thread search matches against, in one place so callers that
 * pre-index rows (the archive page) share the sidebar's matching rules.
 */
export function threadSearchValues(
  thread: NormalizedApplicationThreadSummary,
  { workspace, environment, target }: ThreadSearchContext,
): readonly (string | undefined)[] {
  return [
    thread.title.text,
    workspace?.label.text,
    workspace?.displayPath.text,
    environment?.label.text,
    target?.label.text,
    target?.backend.label.text,
    thread.backend.label.text,
  ];
}

/**
 * Pre-lowercased search values for a thread; pair with
 * `threadSearchValuesMatch` and a `normalizeThreadSearchQuery` query.
 */
export function indexThreadSearchValues(
  thread: NormalizedApplicationThreadSummary,
  context: ThreadSearchContext,
): readonly string[] {
  const values: string[] = [];
  for (const value of threadSearchValues(thread, context)) {
    if (value !== undefined) values.push(value.toLocaleLowerCase());
  }
  return values;
}

export function threadSearchValuesMatch(
  values: readonly string[],
  query: string,
): boolean {
  if (!query) return true;
  return values.some((value) => value.includes(query));
}

/**
 * Build one indexed matcher for a search pass. Workspace and environment
 * metadata are resolved once instead of scanning both collections for every
 * thread rendered or projected.
 */
export function createThreadSearchMatcher(
  search: string,
  snapshot?: SearchCatalog,
): (thread: NormalizedApplicationThreadSummary) => boolean {
  const query = normalizeThreadSearchQuery(search);
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
    return threadSearchValues(thread, { workspace, environment, target }).some(
      (value) => value?.toLocaleLowerCase().includes(query),
    );
  };
}
