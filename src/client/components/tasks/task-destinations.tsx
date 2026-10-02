import { useMemo } from "react";
import { Folder, Globe, MessageSquare } from "lucide-react";
import type {
  NormalizedApplicationSnapshot,
  TaskScope,
} from "../../../shared/index.js";
import { describeProjectLocations } from "../../app/project-locations.js";
import type { Route } from "../../app/router.js";
import { workspaceDisplayLabel } from "../../app/sidebar-scope-presentation.js";
import type { SearchableSelectOption } from "../ui/searchable-select.js";
import {
  scopeKey,
  type TaskGroupKind,
  type TasksContext,
} from "./task-view-model.js";

/** The icon of a scope kind: threads, projects and Global read the same everywhere in Tasks. */
export function ScopeIcon({
  kind,
  className,
}: {
  readonly kind: TaskGroupKind | TaskScope["kind"];
  readonly className?: string;
}): React.JSX.Element {
  const Icon =
    kind === "global" ? Globe : kind === "thread" ? MessageSquare : Folder;
  return <Icon className={className} aria-hidden="true" />;
}

export interface TaskDestinations {
  /** The chat the panel follows. */
  readonly context: TasksContext;
  /** Project labels by project ID. */
  readonly projectLabels: ReadonlyMap<string, string>;
  readonly threadTitles: ReadonlyMap<string, string>;
  /** A scope's short name: "Global", the project's label or the thread's title. */
  label(scope: TaskScope): string;
  /**
   * Every place a task can belong to, for "Belongs to" and Move to ›
   * Choose…: this thread, this project and Global first, then the other
   * projects and threads, each listed once. A current scope that is no
   * longer offered (an archived thread) stays listed, marked unavailable.
   */
  options(current?: TaskScope): SearchableSelectOption[];
}

type Snapshot = Pick<
  NormalizedApplicationSnapshot,
  "threads" | "projects" | "workspaces" | "environments"
>;

export function useTaskDestinations(
  snapshot: Snapshot | undefined,
  route: Route,
): TaskDestinations {
  const threads = snapshot?.threads;
  const projects = snapshot?.projects;
  const workspaces = snapshot?.workspaces;
  const environments = snapshot?.environments;
  const routeThreadId = route.name === "thread" ? route.threadId : undefined;
  return useMemo(() => {
    const threadList = threads ?? [];
    const projectList = projects ?? [];
    const workspaceList = workspaces ?? [];
    const environmentList = environments ?? [];
    const projectLocations = describeProjectLocations({
      projects: projectList,
      workspaces: workspaceList,
      environments: environmentList,
    });
    const projectLabels = new Map(
      projectList.map((project) => [
        project.id,
        projectLocations.projectLabel(project.id) ?? project.name,
      ]),
    );
    const threadTitles = new Map(
      threadList.map((thread) => [thread.id, thread.title.text]),
    );
    const routeThread = routeThreadId
      ? threadList.find(({ id }) => id === routeThreadId)
      : undefined;
    const currentThread =
      routeThread && routeThread.inventoryState !== "archived"
        ? routeThread
        : undefined;
    const currentWorkspace = routeThread
      ? workspaceList.find(({ id }) => id === routeThread.workspaceId)
      : undefined;
    const context: TasksContext = {
      ...(currentThread
        ? {
            thread: {
              id: currentThread.id,
              title: currentThread.title.text,
              workspaceId: currentThread.workspaceId,
            },
          }
        : routeThread
          ? { threadArchived: true as const }
          : {}),
      ...(currentWorkspace
        ? {
            project: {
              id: currentWorkspace.projectId,
              label:
                projectLabels.get(currentWorkspace.projectId) ??
                currentWorkspace.label.text,
            },
          }
        : {}),
    };

    const locationLabel = (workspace: (typeof workspaceList)[number]) =>
      workspaceDisplayLabel({
        workspace,
        workspaces: workspaceList,
        environments: environmentList,
        includeEnvironment:
          environmentList.find(({ id }) => id === workspace.environmentId)
            ?.kind !== "local",
      });
    const label = (scope: TaskScope): string => {
      if (scope.kind === "global") return "Global";
      if (scope.kind === "project") {
        return projectLabels.get(scope.projectId) ?? "Unavailable project";
      }
      return threadTitles.get(scope.threadId) ?? "Unavailable thread";
    };
    const compare = (left: SearchableSelectOption, right: SearchableSelectOption) =>
      left.label.localeCompare(right.label, undefined, { numeric: true }) ||
      left.value.localeCompare(right.value);

    // A project is listed once, however many locations it has.
    const projectOptions = projectList
      .filter(({ id }) => id !== context.project?.id)
      .map((project): SearchableSelectOption => {
        const locations = projectLocations.locationsOf(project.id);
        const only = locations.length === 1 ? locations[0] : undefined;
        return {
          value: scopeKey({ kind: "project", projectId: project.id }),
          label: projectLabels.get(project.id) ?? project.name,
          ...(only
            ? { description: only.displayPath.text, descriptionIsPath: true }
            : {}),
          icon: <ScopeIcon kind="project" />,
          group: "Projects",
          searchTerms: [
            project.id,
            project.name,
            ...locations.map(({ label }) => label.text),
          ],
        };
      })
      .sort(compare);
    const titleCounts = new Map<string, number>();
    const activeThreads = threadList.filter(
      ({ inventoryState }) => inventoryState !== "archived",
    );
    for (const thread of activeThreads) {
      const key = JSON.stringify([thread.workspaceId, thread.title.text]);
      titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
    }
    const threadOptions = activeThreads
      .filter(({ id }) => id !== context.thread?.id)
      .map((thread): SearchableSelectOption => {
        const duplicate =
          (titleCounts.get(
            JSON.stringify([thread.workspaceId, thread.title.text]),
          ) ?? 0) > 1;
        const workspace = workspaceList.find(
          ({ id }) => id === thread.workspaceId,
        );
        return {
          value: scopeKey({ kind: "thread", threadId: thread.id }),
          label: duplicate
            ? `${thread.title.text} · ${thread.id}`
            : thread.title.text,
          description: workspace ? locationLabel(workspace) : thread.workspaceId,
          icon: <ScopeIcon kind="thread" />,
          group: "Threads",
          searchTerms: [thread.id, workspace?.label.text ?? ""],
        };
      })
      .sort(compare);
    const options = (current?: TaskScope): SearchableSelectOption[] => {
      const leading: SearchableSelectOption[] = [
        ...(context.thread
          ? [
              {
                value: scopeKey({ kind: "thread", threadId: context.thread.id }),
                label: `This thread · ${context.thread.title}`,
                icon: <ScopeIcon kind="thread" />,
                pinned: true,
              },
            ]
          : []),
        ...(context.project
          ? [
              {
                value: scopeKey({
                  kind: "project",
                  projectId: context.project.id,
                }),
                label: `This project · ${context.project.label}`,
                icon: <ScopeIcon kind="project" />,
                pinned: true,
              },
            ]
          : []),
        {
          value: "global",
          label: "Global",
          icon: <ScopeIcon kind="global" />,
          pinned: true,
        },
      ];
      const all = [...leading, ...projectOptions, ...threadOptions];
      if (current && !all.some(({ value }) => value === scopeKey(current))) {
        all.unshift({
          value: scopeKey(current),
          label: label(current),
          icon: <ScopeIcon kind={current.kind} />,
          unavailable: current.kind === "thread" ? "Archived" : true,
          pinned: true,
        });
      }
      return all;
    };
    return { context, projectLabels, threadTitles, label, options };
  }, [threads, projects, workspaces, environments, routeThreadId]);
}
