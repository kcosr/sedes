import { useSyncExternalStore } from "react";
import { beginThreadLoadAttempt } from "./thread-load-diagnostics.js";
import { settingsPageSlugs, type SettingsPage } from "./settings-route.js";

export type Route =
  | { name: "home" }
  | { name: "agents"; agentId?: string; create: boolean }
  | {
      name: "thread";
      threadId: string;
      automationOpen: boolean;
      focusTurnId?: string;
    }
  | { name: "archived" }
  | { name: "usage" }
  | { name: "settings"; page?: SettingsPage };

let currentRoute = parseRoute(window.location.pathname, window.location.hash);
if (currentRoute.name === "thread") {
  beginThreadLoadAttempt(currentRoute.threadId, "initial_route");
}
let currentLocation = `${window.location.pathname}${window.location.search}${window.location.hash}`;
const listeners = new Set<() => void>();
export type NavigationBlocker = (current: Route, next: Route, proceed: () => void) => boolean;
const blockers = new Set<NavigationBlocker>();
const historyIndexKey = "__sedesHistoryIndex";
let currentIndex = historyIndex(window.history.state) ?? 0;
window.history.replaceState(indexedState(window.history.state, currentIndex), "", window.location.href);

interface NavigationIntent {
  readonly current: Route;
  readonly originLocation: string;
  readonly originIndex: number;
  readonly next: Route;
  readonly path: string;
  readonly mode: "push" | "replace" | "traverse";
  readonly targetIndex?: number;
  readonly approved: Set<NavigationBlocker>;
  ready: boolean;
}
let pendingIntent: NavigationIntent | undefined;
let restoringIndex: number | undefined;
let resumedTraversal: NavigationIntent | undefined;

export function parseRoute(pathname: string, hash = ""): Route {
  if (pathname === "/settings") return { name: "settings" };
  const settingsPage = (Object.keys(settingsPageSlugs) as SettingsPage[])
    .find(page => pathname === `/settings/${settingsPageSlugs[page]}`);
  if (settingsPage) return { name: "settings", page: settingsPage };
  if (pathname === "/archived") return { name: "archived" };
  if (pathname === "/usage") return { name: "usage" };
  if (pathname === "/agents") return { name: "agents", create: false };
  if (pathname === "/agents/new") return { name: "agents", create: true };
  const agentMatch = /^\/agents\/([^/]+)$/.exec(pathname);
  if (agentMatch?.[1]) {
    try {
      return {
        name: "agents",
        agentId: decodeURIComponent(agentMatch[1]),
        create: false,
      };
    } catch {
      return { name: "home" };
    }
  }
  const automationMatch = /^\/threads\/([^/]+)\/automation$/.exec(pathname);
  if (automationMatch?.[1]) {
    try {
      return {
        name: "thread",
        threadId: decodeURIComponent(automationMatch[1]),
        automationOpen: true,
      };
    } catch {
      return { name: "home" };
    }
  }
  const match = /^\/threads\/([^/]+)$/.exec(pathname);
  if (match?.[1]) {
    try {
      const focusTurnId = parseTurnHash(hash);
      return {
        name: "thread",
        threadId: decodeURIComponent(match[1]),
        automationOpen: false,
        ...(focusTurnId ? { focusTurnId } : {}),
      };
    } catch {
      return { name: "home" };
    }
  }
  return { name: "home" };
}

function historyIndex(state: unknown): number | undefined {
  if (!state || typeof state !== "object") return undefined;
  const index = (state as Record<string, unknown>)[historyIndexKey];
  return typeof index === "number" && Number.isSafeInteger(index) && index >= 0 ? index : undefined;
}

function indexedState(state: unknown, index: number): Record<string, unknown> {
  return { ...(state && typeof state === "object" ? state : {}), [historyIndexKey]: index };
}

function locationPath(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

/** App-owned same-document entries, including same-URL mobile panel entries,
 * share the router's position tracking. Preserve all caller-owned state fields. */
export function pushHistoryEntry(state: unknown, path: string): void {
  const index = (historyIndex(window.history.state) ?? currentIndex) + 1;
  window.history.pushState(indexedState(state, index), "", path);
  if (locationPath() === currentLocation) {
    currentIndex = index;
    pendingIntent = undefined;
  }
}

export function replaceHistoryEntry(state: unknown, path: string): void {
  window.history.replaceState(indexedState(state, historyIndex(window.history.state) ?? currentIndex), "", path);
}

function publish(next: Route): void {
  currentRoute = next;
  currentLocation = locationPath();
  currentIndex = historyIndex(window.history.state) ?? currentIndex;
  for (const listener of listeners) listener();
}

function currentIntent(intent: NavigationIntent): boolean {
  return pendingIntent === intent && intent.originIndex === currentIndex && intent.originLocation === currentLocation;
}

function commit(intent: NavigationIntent): void {
  if (!currentIntent(intent) || !intent.ready || restoringIndex !== undefined || resumedTraversal !== undefined) return;
  if (intent.mode === "traverse" && historyIndex(window.history.state) !== intent.targetIndex) {
    resumedTraversal = intent;
    window.history.go(intent.targetIndex! - intent.originIndex);
    return;
  }
  pendingIntent = undefined;
  if (intent.next.name === "thread" && (currentRoute.name !== "thread" || currentRoute.threadId !== intent.next.threadId)) {
    beginThreadLoadAttempt(intent.next.threadId, intent.mode === "traverse" ? "history" : "navigation");
  }
  if (intent.mode === "replace") replaceHistoryEntry(null, intent.path);
  else if (intent.mode === "push") pushHistoryEntry(null, intent.path);
  publish(intent.next);
}

function admit(intent: NavigationIntent): void {
  if (!currentIntent(intent)) return;
  intent.ready = false;
  for (const blocker of [...blockers]) {
    if (intent.approved.has(blocker)) continue;
    let checking = true;
    let resumed = false;
    const proceed = () => {
      if (resumed || !currentIntent(intent)) return;
      resumed = true;
      intent.approved.add(blocker);
      // A guard may approve synchronously (for example a clean editor).
      // Finish this admission pass before mutating history in that case.
      if (!checking) admit(intent);
    };
    const allowed = blocker(intent.current, intent.next, proceed);
    checking = false;
    if (!currentIntent(intent)) return;
    if (!allowed && !resumed) return;
  }
  intent.ready = true;
  commit(intent);
}

function intentFor(path: string, mode: NavigationIntent["mode"], targetIndex?: number): NavigationIntent {
  const parsed = new URL(path, window.location.href);
  return {
    current: currentRoute, originLocation: currentLocation, originIndex: currentIndex,
    next: parseRoute(parsed.pathname, parsed.hash), path, mode, targetIndex,
    approved: new Set(), ready: false,
  };
}

window.addEventListener("popstate", (event: PopStateEvent) => {
  const targetIndex = historyIndex(window.history.state);
  if (restoringIndex !== undefined && targetIndex === restoringIndex) {
    event.stopImmediatePropagation();
    restoringIndex = undefined;
    if (pendingIntent?.ready) commit(pendingIntent);
    return;
  }
  if (resumedTraversal && targetIndex !== undefined && targetIndex === resumedTraversal.targetIndex) {
    const intent = resumedTraversal;
    resumedTraversal = undefined;
    if (currentIntent(intent)) { commit(intent); return; }
    // A newer navigation superseded the approved traversal while it was in
    // flight. Return to the still-published entry before committing that intent.
    event.stopImmediatePropagation();
    restoringIndex = currentIndex;
    window.history.go(currentIndex - targetIndex);
    return;
  }
  const path = locationPath();
  if (targetIndex === undefined) {
    // A caller that changes the URL outside the router and dispatches a
    // synthetic popstate has no traversal position. Treat that as a replace
    // request; real app history entries always use the indexed helpers above.
    replaceHistoryEntry(null, currentLocation);
    pendingIntent = intentFor(path, "replace");
    admit(pendingIntent);
    return;
  }
  const intent = intentFor(path, "traverse", targetIndex);
  pendingIntent = intent;
  admit(intent);
  if (pendingIntent === intent && !intent.ready) {
    event.stopImmediatePropagation();
    const delta = intent.originIndex - targetIndex;
    if (delta !== 0) {
      restoringIndex = intent.originIndex;
      window.history.go(delta);
    }
  }
});

export function navigate(path: string, options?: { replace?: boolean }): void {
  pendingIntent = intentFor(path, options?.replace ? "replace" : "push");
  admit(pendingIntent);
}

export function installNavigationBlocker(blocker: NavigationBlocker): () => void {
  blockers.add(blocker);
  return () => blockers.delete(blocker);
}

export function threadPath(threadId: string): string {
  return `/threads/${encodeURIComponent(threadId)}`;
}

export function settingsPath(page?: SettingsPage): string {
  return page ? `/settings/${settingsPageSlugs[page]}` : "/settings";
}

export function agentsPath(): string {
  return "/agents";
}

export function newAgentPath(): string {
  return "/agents/new";
}

export function agentPath(agentId: string): string {
  return `/agents/${encodeURIComponent(agentId)}`;
}

export function usagePath(): string {
  return "/usage";
}

export function threadTurnPath(threadId: string, turnId: string): string {
  return `${threadPath(threadId)}#turn=${encodeURIComponent(turnId)}`;
}

export function threadAutomationPath(threadId: string): string {
  return `/threads/${encodeURIComponent(threadId)}/automation`;
}

/** Serialize a route back to the path navigate()/history expect. */
export function routePath(route: Route): string {
  if (route.name === "home") return "/";
  if (route.name === "archived") return "/archived";
  if (route.name === "usage") return usagePath();
  if (route.name === "settings") return settingsPath(route.page);
  if (route.name === "agents") {
    if (route.create) return newAgentPath();
    return route.agentId ? agentPath(route.agentId) : agentsPath();
  }
  if (route.automationOpen) return threadAutomationPath(route.threadId);
  if (route.focusTurnId) return threadTurnPath(route.threadId, route.focusTurnId);
  return threadPath(route.threadId);
}

export function sameRoute(a: Route, b: Route): boolean {
  return routePath(a) === routePath(b);
}

export function useRoute(): Route {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => currentRoute,
    () => currentRoute,
  );
}

export function openExternal(url: string): void {
  const parsed = new URL(url, window.location.href);
  if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) return;
  window.open(parsed.href, "_blank", "noopener,noreferrer");
}

function parseTurnHash(hash: string): string | undefined {
  const match = /^#turn=([^&]+)$/.exec(hash);
  if (!match?.[1]) return undefined;
  try {
    const turnId = decodeURIComponent(match[1]);
    return turnId.length >= 1 && turnId.length <= 160 ? turnId : undefined;
  } catch {
    return undefined;
  }
}
