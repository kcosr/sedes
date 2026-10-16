import { useEffect, useRef } from "react";
import {
  automationPath,
  automationsPath,
  historyEntryBefore,
  historyStepsBackTo,
  navigateBack,
  navigateOut,
  navigateUp,
  routePath,
  threadPath,
  type Route,
} from "../../app/router.js";
import { openThreadRoute } from "../../workspace-panels/thread-panel-navigation.js";
import { useEscapeUp } from "../settings/settings-escape.js";

/**
 * Where an automation page's one "‹" link leads; Escape and Android Back
 * without history go there too. The label names the destination.
 */
export interface AutomationUp {
  readonly label: string;
  /** The destination's address, for the link itself (a new tab, a copy). */
  readonly href: string;
  /** Present when the link returns directly to a thread, including a focused turn. */
  readonly targetThreadId?: string;
  readonly go: () => void;
}

/** A thread's title, when the application knows the thread. */
export type ThreadTitleSource = (threadId: string) => string | undefined;

const isAutomationList = (route: Route): boolean => route.name === "automations";

/**
 * Where an automation's page was opened from: an Automations list (every
 * automation, or a thread's) or a thread (its own, or a fork result's
 * notice). Leaving goes back there.
 */
const isAutomationOrigin = (route: Route): boolean =>
  isAutomationList(route) || route.name === "thread";

/**
 * The automation page's way up: back to the Automations list or the thread
 * history reached it from, past its own editor; otherwise (a deep link, a
 * reload, another page's link) up to its thread's Automations, or to every
 * automation while the thread is not known yet.
 */
export function automationPageUp(
  automationId: string,
  thread: { readonly id: string; readonly title: string } | undefined,
  threadTitle: ThreadTitleSource,
): AutomationUp {
  const page = automationPath(automationId);
  const fallback = automationsPath(thread?.id);
  const go = () => navigateOut(page, isAutomationOrigin, fallback);
  const before = historyEntryBefore(page)?.route;
  if (before?.name === "thread") {
    const title = before.threadId === thread?.id ? thread.title : threadTitle(before.threadId);
    return { label: title ?? "Thread", href: routePath(before), targetThreadId: before.threadId, go };
  }
  if (before && isAutomationList(before)) return { label: "Automations", href: routePath(before), go };
  return { label: "Automations", href: fallback, go };
}

/**
 * The editor's way up: a new automation's to its thread's Automations, where
 * it is added from (back when history came from there); an automation's to
 * its page.
 */
export function automationEditorUp(
  threadId: string,
  automation?: { readonly id: string; readonly name: string },
): AutomationUp {
  if (!automation) {
    const list = automationsPath(threadId);
    return { label: "Automations", href: list, go: () => navigateBack(list) };
  }
  const page = automationPath(automation.id);
  return { label: automation.name, href: page, go: () => navigateUp(page) };
}

/**
 * Leaves a deleted automation's page or editor: back to the list or thread
 * history reached it from, so no Back lands on the gone page; otherwise to
 * its thread's Automations, in place of this entry.
 */
export function leaveDeletedAutomation(automationId: string, threadId: string): void {
  navigateOut(automationPath(automationId), isAutomationOrigin, automationsPath(threadId));
}

/**
 * Opens a thread from an automation's page (its source, or a run's result
 * thread): back to it when history came from it, at whatever turn, or down
 * from it through its Automations, so Back never loops between the thread
 * and its automations; otherwise a new entry, with the thread's Chat in
 * front.
 */
export function openAutomationThread(threadId: string, automationId: string): void {
  const before = historyEntryBefore(automationPath(automationId));
  const steps = before?.route.name === "thread" && before.route.threadId === threadId
    ? before.steps
    : historyStepsBackTo(threadPath(threadId));
  if (steps === undefined) openThreadRoute(threadId);
  else window.history.go(steps);
}

/** The shown automation page's way up, for Android Back without history. */
let shownUp: { readonly go: () => void } | undefined;

/**
 * An automation page's way up, where its "‹" link leads: Escape goes there
 * (open layers and focused fields take it first, as in Settings), and so
 * does Android Back when the WebView has no history to go back through.
 * `up` navigates through the router, so dirty guards run as they do for the
 * link. Undefined where a page has no way up (the Automations list).
 */
export function useAutomationUp(up: (() => void) | undefined): void {
  useEscapeUp(up);
  const handler = useRef(up);
  handler.current = up;
  const enabled = up !== undefined;
  useEffect(() => {
    if (!enabled) return undefined;
    const entry = { go: () => handler.current?.() };
    shownUp = entry;
    return () => {
      if (shownUp === entry) shownUp = undefined;
    };
  }, [enabled]);
}

/** The shown automation page's way up; undefined when none is shown. */
export function shownAutomationUp(): (() => void) | undefined {
  return shownUp?.go;
}
