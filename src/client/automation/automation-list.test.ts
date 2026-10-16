import { describe, expect, it } from "vitest";
import type { NormalizedApplicationSnapshot, NormalizedApplicationThreadSummary } from "../../shared/index.js";
import { definition } from "../components/automation/automation-test-fixture.js";
import { automationHealth, type SummaryAutomation, type SummaryAutomationRun } from "./automation-health.js";
import {
  EMPTY_AUTOMATIONS_BASE,
  automationGroupCollapsedByDefault,
  automationRowPresentation,
  listThreadAutomations,
  projectAutomations,
  selectAutomationsBase,
  type AutomationListEntry,
  type AutomationsProjectionOptions,
} from "./automation-list.js";

const NOW = Date.parse("2026-10-06T03:40:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const ahead = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const ALL: AutomationsProjectionOptions["scope"] = {
  environmentId: null, targetId: null, projectId: null, groupId: null, ungrouped: false,
};

function run(state: SummaryAutomationRun["state"], overrides: Partial<SummaryAutomationRun> = {}): SummaryAutomationRun {
  return { id: `run-${state}`, state, occurrence: "scheduled", scheduledFor: ago(30), finishedAt: ago(23), ...overrides };
}

function automation(id: string, name: string, overrides: Partial<SummaryAutomation> = {}): SummaryAutomation {
  return definition({
    id, name, threadId: "shared-source", prompt: "Check dependencies for advisories",
    nextRunAt: ahead(22), lastRun: run("completed"),
    source: {
      title: "Assistant", workspaceId: "ws-acme", environmentId: "env-local",
      targetId: "t-pi", groupId: null, backendLabel: "Pi SDK", available: true,
      backingState: "bound", runState: "idle", inventoryState: "active", inventoryRevision: 1,
    },
    ...overrides,
  });
}

function snapshot(threads: NormalizedApplicationThreadSummary[] = [], overrides: Partial<NormalizedApplicationSnapshot> = {}): NormalizedApplicationSnapshot {
  return {
    advisories: [], environments: [{ id: "env-local", kind: "local", label: { text: "Local" }, available: true, directoryBrowsing: "available" }],
    projects: [{ id: "project-acme", name: "acme-web", revision: 1 }, { id: "project-billing", name: "billing-service", revision: 1 }],
    workspaces: [
      { id: "ws-acme", environmentId: "env-local", projectId: "project-acme", label: { text: "acme-web" }, displayPath: { text: "/src/acme-web" }, available: true },
      { id: "ws-billing", environmentId: "env-local", projectId: "project-billing", label: { text: "billing-service" }, displayPath: { text: "/src/billing-service" }, available: true },
    ],
    executionTargets: [], threads, forkOrigins: [], lineagePlacements: [], groups: [], lineageFamilies: [],
    defaultNewThreadTargetId: null, counts: { active: threads.length, snoozed: 0, settled: 0, archived: 0 }, tasks: [], ...overrides,
  };
}

function project(definitions: readonly SummaryAutomation[], options: Partial<AutomationsProjectionOptions> = {}) {
  return projectAutomations(selectAutomationsBase(snapshot(), definitions), { scope: ALL, search: "", groupBy: "status", now: NOW, ...options });
}
const groupTitles = (projection: ReturnType<typeof project>) => projection.groups.map((group) => [group.label, group.entries.map(({ row }) => row.displayTitle)]);
function entryFor(automation: SummaryAutomation, threads: NormalizedApplicationThreadSummary[] = []): AutomationListEntry {
  const row = selectAutomationsBase(snapshot(threads), [automation]).rows[0]!;
  return { row, health: automationHealth(row, NOW) };
}

const daily = automation("daily", "Daily update");
const reminder = automation("reminder", "One-shot reminder", { schedule: { kind: "date_time", runAt: ahead(1) }, misfirePolicy: null, nextRunAt: ahead(1) });
const failed = automation("failure", "Failed delivery", { attention: { runId: "run-failed", kind: "failed" }, lastRun: run("failed", { errorCode: "automation_dispatch_failed" }) });
const paused = automation("paused", "Paused audit", { status: "paused", nextRunAt: undefined, lastRun: undefined });
const archived = automation("archived", "Archived source", { source: { ...daily.source, inventoryState: "archived" } });
const finished = automation("finished", "Completed reminder", { status: "exhausted", nextRunAt: undefined });

describe("selectAutomationsBase", () => {
  it("lists independent automation IDs even when their common source is outside the bootstrap", () => {
    const base = selectAutomationsBase(snapshot(), [daily, reminder, archived]);
    expect(base.rows.map(({ id }) => id)).toEqual(["daily", "reminder", "archived"]);
    expect(base.rows.map(({ threadId }) => threadId)).toEqual(["shared-source", "shared-source", "shared-source"]);
    expect(base.rows[0]).toMatchObject({ displayTitle: "Daily update", sourceTitle: "Assistant", projectLabel: "acme-web", backendLabel: "Pi SDK" });
  });

  it("keeps unchanged rows by automation identity and updates one sibling independently", () => {
    const app = snapshot();
    const base = selectAutomationsBase(app, [daily, reminder]);
    expect(selectAutomationsBase(structuredClone(app), structuredClone([daily, reminder]), base)).toBe(base);
    const next = selectAutomationsBase(app, [daily, { ...reminder, name: "Changed reminder", revision: reminder.revision + 1 }], base);
    expect(next.rows[0]).toBe(base.rows[0]);
    expect(next.rows[1]).not.toBe(base.rows[1]);
    expect(next.rows[1]!.displayTitle).toBe("Changed reminder");
    expect(selectAutomationsBase(app, [reminder], next).rows.map(({ id }) => id)).toEqual(["reminder"]);
  });

  it("uses source metadata to follow a same-thread run even when the source is unloaded", () => {
    const busy = automation("daily", "Daily update", { source: { ...daily.source, runState: "running" }, lastRun: run("completed", { resultThreadId: daily.threadId }) });
    expect(entryFor(busy).row.latestRunTurnRunning).toBe(true);
    expect(entryFor({ ...busy, lastRun: { ...busy.lastRun!, turn: { outcome: "completed" } } }).row.latestRunTurnRunning).toBe(false);
  });

  it("follows a fork result instead of the source's activity", () => {
    const forked = automation("fork", "Fork audit", { runMode: "clone", source: { ...daily.source, runState: "running" }, lastRun: run("completed", { resultThreadId: "fork-result" }) });
    const result = { id: "fork-result", runState: "idle" } as NormalizedApplicationThreadSummary;
    expect(entryFor(forked, [result]).row.latestRunTurnRunning).toBe(false);
    expect(entryFor(forked, [{ ...result, runState: "running" }]).row.latestRunTurnRunning).toBe(true);
  });

  it("relabels catalog changes and provides a location fallback", () => {
    const base = selectAutomationsBase(snapshot(), [daily]);
    const renamed = selectAutomationsBase(snapshot([], { projects: [{ id: "project-acme", name: "Storefront", revision: 2 }] }), [daily], base);
    expect(renamed.rows[0]!.projectLabel).toBe("Storefront");
    const missing = automation("missing", "Missing location", { source: { ...daily.source, title: "", workspaceId: "missing" } });
    expect(entryFor(missing).row).toMatchObject({ projectId: null, projectLabel: "Project", sourceTitle: "Untitled thread" });
  });

  it("preserves the prior base while application metadata is unavailable", () => {
    const base = selectAutomationsBase(snapshot(), [daily]);
    expect(selectAutomationsBase(undefined, [daily], base)).toBe(base);
    expect(selectAutomationsBase(undefined, [])).toBe(EMPTY_AUTOMATIONS_BASE);
  });
});

describe("projectAutomations", () => {
  it("places siblings into their own health groups including retained finished one-shots", () => {
    expect(groupTitles(project([daily, failed, reminder, paused, archived, finished]))).toEqual([
      ["Needs attention", ["Failed delivery"]], ["Upcoming", ["One-shot reminder", "Daily update"]],
      ["Paused", ["Paused audit"]], ["Suspended", ["Archived source"]], ["Finished", ["Completed reminder"]],
    ]);
  });

  it("searches automation names, source titles and prompts", () => {
    expect(project([daily, reminder], { search: "one-shot" }).matchCount).toBe(1);
    expect(project([daily, reminder], { search: "assistant" }).matchCount).toBe(2);
    expect(project([daily, reminder], { search: "advisories" }).matchCount).toBe(2);
    expect(project([daily, reminder], { search: "billing-service" }).matchCount).toBe(0);
  });

  it("honors source project scope and groups independent automations by project", () => {
    const billing = automation("billing", "Billing report", { source: { ...daily.source, workspaceId: "ws-billing" } });
    const scoped = project([daily, reminder, billing], { scope: { ...ALL, projectId: "project-billing" } });
    expect(scoped).toMatchObject({ total: 3, scopedCount: 1, matchCount: 1 });
    expect(groupTitles(scoped)).toEqual([["Upcoming", ["Billing report"]]]);
    expect(groupTitles(project([daily, reminder, billing], { groupBy: "project" }))).toEqual([
      ["acme-web", ["One-shot reminder", "Daily update"]], ["billing-service", ["Billing report"]],
    ]);
  });

  it("collapses suspended and finished groups by default", () => {
    expect(automationGroupCollapsedByDefault("status:suspended")).toBe(true);
    expect(automationGroupCollapsedByDefault("status:finished")).toBe(true);
    for (const key of ["status:needs_attention", "status:upcoming", "status:paused", "project:project-acme"]) expect(automationGroupCollapsedByDefault(key)).toBe(false);
  });
});

describe("listThreadAutomations", () => {
  it("lists every automation flat in status order, across projects and with suspended and finished ones", () => {
    const billing = automation("billing", "Billing report", { source: { ...daily.source, workspaceId: "ws-billing" } });
    const entries = listThreadAutomations(selectAutomationsBase(snapshot(), [finished, archived, paused, billing, daily, failed]), NOW);
    expect(entries.map(({ row }) => row.displayTitle)).toEqual([
      "Failed delivery", "Billing report", "Daily update", "Paused audit", "Archived source", "Completed reminder",
    ]);
    expect(entries.map(({ health }) => health.group)).toEqual([
      "needs_attention", "upcoming", "upcoming", "paused", "suspended", "finished",
    ]);
  });
});

describe("automationRowPresentation", () => {
  it("shows delivered and finished turn outcomes without turning assistant failures into delivery attention", () => {
    expect(automationRowPresentation(entryFor(daily), NOW)).toMatchObject({ secondary: { text: "Delivered 23m ago", check: true } });
    const turnFailed = automation("turn-failed", "Turn failed", { lastRun: run("completed", { turn: { outcome: "failed", endedAt: ago(120) } }) });
    expect(entryFor(turnFailed).health.kind).toBe("active");
    expect(automationRowPresentation(entryFor(turnFailed), NOW)).toMatchObject({ secondary: { text: "Failed 2h ago", tone: "danger" } });
  });

  it("reports a delivery failure and preserves its older attention after a skipped run", () => {
    expect(automationRowPresentation(entryFor(failed), NOW)).toMatchObject({ primary: { text: "Failed 23m ago", tone: "danger" }, detail: "The prompt could not be delivered to the agent." });
    const skipped = { ...failed, attention: { ...failed.attention!, diagnostic: "Delivery rejected" }, lastRun: run("skipped") };
    expect(automationRowPresentation(entryFor(skipped), NOW)).toMatchObject({ primary: { text: "Failed", tone: "danger" }, detail: "Delivery rejected" });
  });

  it("shows a delivered run as running while its own target is busy", () => {
    const running = { ...daily, source: { ...daily.source, runState: "running" as const }, lastRun: run("completed", { resultThreadId: daily.threadId, finishedAt: ago(4) }) };
    expect(automationRowPresentation(entryFor(running), NOW)).toMatchObject({ secondary: { text: "Running · 4m", running: true }, outcome: { text: "Running · 4m", running: true } });
  });

  it("keeps queued delivery separate from retained finished schedules", () => {
    const queued = { ...daily, lastRun: run("queued", { finishedAt: undefined }) };
    expect(automationRowPresentation(entryFor(queued), NOW)).toMatchObject({ primary: { text: "Waiting for turn", tone: "info" } });
    expect(automationRowPresentation(entryFor(finished), NOW)).toMatchObject({ primary: { text: "Finished" }, nextRun: null });
  });
});
