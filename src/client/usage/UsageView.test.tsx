// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  USAGE_ANALYTICS_DIMENSIONS, usageAnalyticsResponseSchema,
  type UsageAnalyticsAggregate, type UsageAnalyticsRequest, type UsageAnalyticsResponse, type UsageFacetRequest, type UsageFacetResponse,
} from "../../shared/protocol/usage-analytics.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { UsageDisabledView, UsageView } from "./UsageView.js";

const aggregate = (tokens: number, overrides: Partial<UsageAnalyticsAggregate> = {}): UsageAnalyticsAggregate => ({
  tokens: String(tokens), input: String(Math.round(tokens * 0.9)), uncachedInput: "0", cacheRead: String(Math.round(tokens * 0.6)), cacheWrite: "0",
  output: String(tokens - Math.round(tokens * 0.9)), reasoning: "0", requests: "0",
  costs: [{ currency: "USD", amount: (tokens / 1_000_000).toFixed(2), kind: "estimated" }], increments: "4", threads: "2", uncostedTokens: "0",
  missing: { input: "0", uncachedInput: "0", output: "0", cacheRead: "0", cacheWrite: "0", reasoning: "0", requests: "4", cost: "0" }, ...overrides,
});
const points = (values: number[]) => ({
  tokens: values.map(String), input: values.map(String), output: values.map(() => "0"), cacheRead: values.map(() => "0"),
  cacheWrite: values.map(() => "0"), reasoning: values.map(() => "0"), requests: values.map(() => "0"), cost: values.map(() => "0"),
});
function response(request: UsageAnalyticsRequest, overrides: Partial<UsageAnalyticsResponse> = {}): UsageAnalyticsResponse {
  const empty: UsageAnalyticsResponse["breakdowns"]["model"] = { rows: [], other: null, distinct: "0" };
  const breakdowns = Object.fromEntries(request.breakdownDimensions.map((dimension) => [dimension, empty])) as UsageAnalyticsResponse["breakdowns"];
  if (request.breakdownDimensions.includes("model")) breakdowns.model = { rows: [{ key: "opus", totals: aggregate(2_000_000) }, { key: null, totals: aggregate(500_000, { costs: [] }) }], other: null, distinct: "2" };
  if (request.breakdownDimensions.includes("thread")) breakdowns.thread = { rows: [{ key: "thread-1", totals: aggregate(2_500_000) },
    { key: "thread-2", totals: aggregate(400_000, { costs: [], uncostedTokens: "400000", missing: { ...aggregate(0).missing, cost: "4" } }) }], other: null, distinct: "2" };
  const labels = Object.fromEntries(USAGE_ANALYTICS_DIMENSIONS.map((dimension) => [dimension, {}])) as UsageAnalyticsResponse["labels"];
  labels.thread = { "thread-1": { label: "Ship usage page", detail: null, kind: "pi", retired: false, workspaceId: null },
    "thread-2": { label: "Unpriced codex work", detail: null, kind: "codex_app_server", retired: false, workspaceId: null } };
  return usageAnalyticsResponseSchema.parse({
    generatedAt: "2026-09-23T12:00:00.000Z", timeZone: request.timeZone, from: "2026-09-21T00:00:00.000Z", to: "2026-09-23T12:00:00.000Z",
    firstRecordedAt: "2026-09-01T00:00:00.000Z", bucket: "day",
    buckets: [0, 1, 2].map((day) => ({ start: `2026-09-2${day + 1}T00:00:00.000Z`, end: `2026-09-2${day + 2}T00:00:00.000Z` })),
    costCurrency: "USD", totals: aggregate(2_500_000), previous: { from: "2026-09-18T12:00:00.000Z", to: "2026-09-21T00:00:00.000Z", totals: aggregate(2_000_000) },
    timeline: { overall: points([1_000_000, 0, 1_500_000]), groupBy: request.groupBy,
      series: request.groupBy === "model" ? [{ key: "opus", other: false, totals: aggregate(2_000_000), points: points([800_000, 0, 1_200_000]) },
        { key: null, other: false, totals: aggregate(500_000), points: points([200_000, 0, 300_000]) }] : [], colorOrder: ["opus"] },
    breakdowns, matrix: request.matrix ? { ...request.matrix, cells: [] } : null,
    heatmap: request.includeHeatmap ? [{ weekday: 0, hour: 9, tokens: "2500000", cost: "2.5" }] : null,
    placement: { reported: "2500000", observed: "0", interval: "0", spanning: "0", straddling: "0", unplaced: "0" },
    coverage: request.includeCoverage ? { threads: "2", partialThreads: "0", conflictThreads: "0", unsupportedThreads: "0", modelUnknownTokens: "500000", effortUnknownTokens: "2500000" } : null,
    labels, ...overrides,
  });
}
function facetResponse(request: UsageFacetRequest): UsageFacetResponse {
  return { generatedAt: "2026-09-23T12:00:00.000Z", from: "2026-09-21T00:00:00.000Z", to: request.to, dimension: request.dimension,
    choices: request.dimension === "thread" ? [{ key: "thread-1", tokens: "2500000" }] : [{ key: "opus", tokens: "2500000" }],
    labels: request.dimension === "thread" ? { "thread-1": { label: "Ship usage page", detail: null, kind: "pi", retired: false, workspaceId: null } } : {} };
}
function mount(implementation?: (request: UsageAnalyticsRequest) => Promise<UsageAnalyticsResponse>,
  facetImplementation?: (request: UsageFacetRequest, signal?: AbortSignal) => Promise<UsageFacetResponse>) {
  // A synchronous throw models client-side request validation failing before any fetch.
  const getUsageAnalytics = vi.fn(implementation ?? (async (request: UsageAnalyticsRequest) => response(request)));
  const getUsageFacets = vi.fn(facetImplementation ?? (async (request: UsageFacetRequest) => facetResponse(request)));
  render(<UsageView store={{ api: { getUsageAnalytics, getUsageFacets } } as unknown as ApplicationClientStore} />);
  return Object.assign(getUsageAnalytics, { getUsageFacets });
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("UsageView", () => {
  it("summarizes the range and compares it with the previous period", async () => {
    const api = mount();
    expect(await screen.findByText("2.5M")).toBeVisible();
    expect(api).toHaveBeenCalledWith(expect.objectContaining({ groupBy: "model", matrix: null, breakdownLimit: 8,
      breakdownDimensions: ["model", "provider", "effort", "backend", "environment", "workspace", "agentRole", "activity"],
      includeHeatmap: false, includeCoverage: false, bucket: "auto", filters: {} }), expect.any(AbortSignal));
    const request = api.mock.calls[0]![0];
    expect(Date.parse(request.to) - Date.parse(request.from!)).toBeGreaterThan(29 * 86_400_000);
    const tokens = screen.getByText("Total tokens").closest(".usage-stat")!;
    expect(within(tokens as HTMLElement).getByText("25%")).toBeVisible();
    expect(screen.getByText("$2.50")).toBeVisible();
    expect(screen.getByRole("group", { name: /Total tokens by model/ })).toBeVisible();
    expect(screen.getAllByText("Unknown model").length).toBeGreaterThan(0);
  });

  it("picks a date range preset from radio rows that mark the choice with a trailing check", async () => {
    const user = userEvent.setup();
    const api = mount();
    await screen.findByText("2.5M");
    const trigger = screen.getByRole("button", { name: "Date range: Last 30 days" });
    await user.click(trigger);
    const menu = await screen.findByRole("menu", { name: "Date range: Last 30 days" });
    expect(within(menu).getByText("Date range")).toBeVisible();
    const rows = within(menu).getAllByRole("menuitemradio");
    expect(rows.map((row) => row.textContent)).toEqual([
      "Today", "Last 24 hours", "Last 7 days", "Last 30 days", "Last 90 days", "This month", "Last month", "This year", "All time", "Custom range…",
    ]);
    const current = within(menu).getByRole("menuitemradio", { name: "Last 30 days" });
    expect(current).toHaveAttribute("aria-checked", "true");
    expect(current).toHaveClass("data-[state=checked]:font-medium");
    expect(current.lastElementChild?.querySelector("svg")).not.toBeNull();
    expect(rows.filter((row) => row.getAttribute("aria-checked") === "true")).toHaveLength(1);
    await user.click(within(menu).getByRole("menuitemradio", { name: "Last 7 days" }));
    expect(await screen.findByRole("button", { name: "Date range: Last 7 days" })).toBeVisible();
    const request = api.mock.lastCall![0];
    expect(Date.parse(request.to) - Date.parse(request.from!)).toBeLessThan(8 * 86_400_000);
    expect(JSON.parse(localStorage.getItem("sedes-usage-view-v1")!).preset).toBe("7d");
  });

  it("sets a custom range in a dialog that validates the dates and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    const api = mount();
    await screen.findByText("2.5M");
    await user.click(screen.getByRole("button", { name: "Date range: Last 30 days" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Custom range…" }));
    const dialog = await screen.findByRole("dialog", { name: "Custom range" });
    const from = within(dialog).getByLabelText("From");
    const to = within(dialog).getByLabelText("To");
    await waitFor(() => expect(from).toHaveFocus());
    const apply = within(dialog).getByRole("button", { name: "Apply range" });
    fireEvent.change(from, { target: { value: "2026-09-10" } });
    fireEvent.change(to, { target: { value: "2026-09-05" } });
    expect(to).toHaveAttribute("aria-invalid", "true");
    expect(within(dialog).getByText("The end date is before the start date.")).toBeVisible();
    expect(apply).toBeDisabled();
    fireEvent.change(to, { target: { value: "2026-09-12" } });
    expect(to).not.toHaveAttribute("aria-invalid");
    await user.click(apply);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Custom range" })).toBeNull());
    const trigger = await screen.findByRole("button", { name: /^Date range: Sep 10 – Sep 12/ });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(JSON.parse(localStorage.getItem("sedes-usage-view-v1")!)).toMatchObject({ preset: "custom", customFrom: "2026-09-10", customTo: "2026-09-12" });
    expect(Date.parse(api.mock.lastCall![0].to) - Date.parse(api.mock.lastCall![0].from!)).toBe(3 * 86_400_000);
    // Reopening marks Custom range as the choice; Cancel keeps the range.
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitemradio", { name: "Custom range…" }));
    const reopened = await screen.findByRole("dialog", { name: "Custom range" });
    expect(within(reopened).getByLabelText("From")).toHaveValue("2026-09-10");
    await user.click(within(reopened).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^Date range: Sep 10 – Sep 12/ })).toHaveFocus());
  });

  it("presents the long range and group-by lists as sheets under the touch density", async () => {
    vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
    const user = userEvent.setup();
    mount();
    await screen.findByText("2.5M");
    await user.click(screen.getByRole("button", { name: "Date range: Last 30 days" }));
    const sheet = await screen.findByRole("dialog", { name: "Date range" });
    expect(within(sheet).getByRole("menuitemradio", { name: "Last 30 days" })).toHaveAttribute("aria-checked", "true");
    await user.click(within(sheet).getByRole("menuitemradio", { name: "This month" }));
    expect(await screen.findByRole("button", { name: "Date range: This month" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Group by: Model" }));
    expect(await screen.findByRole("dialog", { name: "Group by" })).toBeVisible();
  });

  it("filters every view from a breakdown row and removes the filter from its chip", async () => {
    const api = mount();
    const row = await screen.findByTitle("Filter to opus");
    fireEvent.click(row);
    expect(await screen.findByRole("list", { name: "Active filters" })).toHaveTextContent("Modelopus");
    expect(api).toHaveBeenLastCalledWith(expect.objectContaining({ filters: { model: ["opus"] } }), expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("button", { name: "Remove Model filter" }));
    expect(api).toHaveBeenLastCalledWith(expect.objectContaining({ filters: {} }), expect.any(AbortSignal));
    expect(screen.queryByRole("list", { name: "Active filters" })).toBeNull();
  });

  it("requests the wider explore read and shows unreported metrics as unknown", async () => {
    const user = userEvent.setup();
    const api = mount();
    await screen.findByText("2.5M");
    await user.click(screen.getByRole("tab", { name: "Explore" }));
    expect(api).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: null, breakdownDimensions: ["model"], breakdownLimit: 100,
      matrix: null, includeHeatmap: false, includeCoverage: false }), expect.any(AbortSignal));
    const table = await screen.findByRole("table");
    const opus = within(table).getByRole("button", { name: /opus/ }).closest("tr")!;
    expect(within(opus).getByText("2M")).toBeVisible();
    expect(within(table).queryByRole("columnheader", { name: /Requests/ })).toBeNull();
    expect(JSON.parse(localStorage.getItem("sedes-usage-view-v1")!).tab).toBe("explore");
  });

  it("requests only each tab's rendered sections and keeps the Explore matrix independent of chart grouping", async () => {
    const user = userEvent.setup();
    const api = mount();
    await screen.findByText("2.5M");
    await user.click(screen.getByRole("tab", { name: "Threads" }));
    expect(api.mock.lastCall![0]).toMatchObject({ groupBy: null, breakdownDimensions: ["thread"], matrix: null,
      includeHeatmap: false, includeCoverage: false });
    await user.click(screen.getByRole("tab", { name: "Patterns" }));
    expect(api.mock.lastCall![0]).toMatchObject({ groupBy: null, breakdownDimensions: [], matrix: null,
      includeHeatmap: true, includeCoverage: false });
    await user.click(screen.getByRole("tab", { name: "Coverage" }));
    expect(api.mock.lastCall![0]).toMatchObject({ groupBy: null, breakdownDimensions: [], matrix: null,
      includeHeatmap: false, includeCoverage: true });
    await user.click(screen.getByRole("tab", { name: "Explore" }));
    await user.click(await screen.findByRole("button", { name: "Split by: Nothing" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Reasoning effort" }));
    expect(api.mock.lastCall![0]).toMatchObject({ groupBy: null, breakdownDimensions: ["model"],
      matrix: { rows: "model", columns: "effort" }, includeHeatmap: false, includeCoverage: false });
  });

  it.each(["Threads", "Patterns", "Coverage"])("keeps missing %s sections visibly unavailable through a failed tab read", async (tab) => {
    let fail = false;
    let reject!: (error: Error) => void;
    mount((request) => fail ? new Promise((_resolve, no) => { reject = no; }) : Promise.resolve(response(request)));
    await screen.findByText("2.5M");
    fail = true;
    await userEvent.setup().click(screen.getByRole("tab", { name: tab }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading this view");
    expect(screen.getByText("2.5M")).toBeVisible();
    expect(screen.queryByText("No thread usage in this range")).toBeNull();
    expect(screen.queryByText("No timed usage")).toBeNull();
    expect(screen.queryByText("Every token in range has a source estimate.")).toBeNull();
    await act(async () => { reject(new Error("database_unavailable")); });
    expect(screen.getByRole("status")).toHaveTextContent("This view is unavailable. Retry to load it.");
    expect(screen.getByText("2.5M")).toBeVisible();
    fail = false;
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps Overview controls and local chart state when a new grouping is pending or fails", async () => {
    let fail = false;
    let reject!: (error: Error) => void;
    mount((request) => fail ? new Promise((_resolve, no) => { reject = no; }) : Promise.resolve(response(request)));
    const user = userEvent.setup();
    await screen.findByText("2.5M");
    await user.click(screen.getByRole("button", { name: "Show as table" }));
    fail = true;
    await user.click(screen.getByRole("button", { name: "Group by: Model" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Provider" }));
    expect(screen.getByRole("button", { name: "Group by: Provider" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Show as table" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText(/by model · daily/)).toBeVisible();
    await act(async () => { reject(new Error("database_unavailable")); });
    expect(screen.getByRole("button", { name: "Group by: Provider" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Show as table" })).toHaveAttribute("aria-pressed", "true");
    fail = false;
    await user.click(screen.getByRole("button", { name: "Group by: Provider" }));
    await user.click(screen.getByRole("menuitemradio", { name: "Model" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Show as table" })).toHaveAttribute("aria-pressed", "true");
  });

  it.each(["rows", "split"])("keeps Explore controls and sort state while a changed %s request is pending or fails", async (change) => {
    localStorage.setItem("sedes-usage-view-v1", JSON.stringify({ tab: "explore" }));
    let fail = false;
    let reject!: (error: Error) => void;
    mount((request) => fail ? new Promise((_resolve, no) => { reject = no; }) : Promise.resolve(response(request)));
    const user = userEvent.setup();
    const table = await screen.findByRole("table");
    await user.click(within(table).getByRole("button", { name: "Tokens" }));
    expect(within(table).getByRole("columnheader", { name: "Tokens" })).toHaveAttribute("aria-sort", "ascending");
    fail = true;
    await user.click(screen.getByRole("button", { name: change === "rows" ? "Rows: Model" : "Split by: Nothing" }));
    await user.click(screen.getByRole("menuitemradio", { name: change === "rows" ? "Environment" : "Reasoning effort" }));
    const changedControl = change === "rows" ? "Rows: Environment" : "Split by: Reasoning effort";
    expect(screen.getByRole("button", { name: changedControl })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Loading this view");
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByRole("button", { name: "Export CSV" })).toBeDisabled();
    expect(screen.queryByText("No recorded usage in this range")).toBeNull();
    await act(async () => { reject(new Error("database_unavailable")); });
    expect(screen.getByRole("button", { name: changedControl })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("This view is unavailable");
    fail = false;
    await user.click(screen.getByRole("button", { name: changedControl }));
    await user.click(screen.getByRole("menuitemradio", { name: change === "rows" ? "Model" : "Nothing" }));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(within(await screen.findByRole("table")).getByRole("columnheader", { name: "Tokens" })).toHaveAttribute("aria-sort", "ascending");
  });

  it("lists threads with a link that opens them", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("2.5M");
    await user.click(screen.getByRole("tab", { name: "Threads" }));
    const open = await screen.findByRole("button", { name: /^Ship usage page/ });
    fireEvent.click(open);
    expect(window.location.pathname).toBe("/threads/thread-1");
  });

  it("shows an unpriced thread's cost as unknown when sorted by cost", async () => {
    const user = userEvent.setup();
    mount();
    await screen.findByText("2.5M");
    await user.click(screen.getByRole("tab", { name: "Threads" }));
    await user.click(await screen.findByRole("button", { name: /Sort threads by/ }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Cost" }));
    const row = (await screen.findByText("Unpriced codex work")).closest("li")!;
    expect(within(row as HTMLElement).getByText("—")).toBeVisible();
    expect(within(row as HTMLElement).queryByText("$0.00")).toBeNull();
  });

  it("keeps unreported cache reuse unknown and averages only drawn usage", async () => {
    mount(async (request) => response(request, {
      totals: aggregate(9_000_000, { missing: { ...aggregate(0).missing, cacheRead: "4" } }),
    }));
    await screen.findByText("9M");
    await userEvent.setup().click(screen.getByRole("tab", { name: "Patterns" }));
    const tile = (label: string) => screen.getByText(label).closest(".usage-stat") as HTMLElement;
    expect(within(await waitFor(() => tile("Cache reuse"))).getByText("—")).toBeVisible();
    expect(within(tile("Cache reuse")).getByText("Cache reads not reported")).toBeVisible();
    expect(within(tile("Average per active day")).getByText("1.25M")).toBeVisible();
  });

  it("searches filter choices on the server for values outside the top ranked", async () => {
    const user = userEvent.setup();
    const api = mount();
    await screen.findByText("2.5M");
    await user.click(screen.getByRole("button", { name: /^Filter/ }));
    await user.click(await screen.findByRole("button", { name: "Thread" }));
    await user.type(screen.getByRole("textbox", { name: "Search Threads" }), "ship");
    await waitFor(() => expect(api.getUsageFacets).toHaveBeenCalledWith(expect.objectContaining({ dimension: "thread", search: "ship" }), expect.any(AbortSignal)));
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.getUsageFacets.mock.calls.every(([request]) => Object.keys(request).sort().join(",") === "bucket,dimension,filters,from,search,timeZone,to")).toBe(true);
    const reads = api.getUsageFacets.mock.calls.length;
    await user.click(screen.getByRole("button", { name: "Environment" }));
    expect(api.getUsageFacets).toHaveBeenCalledTimes(reads + 1);
    expect(api.getUsageFacets).toHaveBeenLastCalledWith(expect.objectContaining({ dimension: "environment", search: "" }), expect.any(AbortSignal));
  });

  it("offers every server match even when its visible label does not contain the search", async () => {
    const user = userEvent.setup();
    // The server matched "c0ffee" in a thread ID that the choice label does not show.
    mount(undefined, async (request) => ({ ...facetResponse(request), choices: request.search === "c0ffee" ? [{ key: "thread-1", tokens: "2500000" }] : [] }));
    await screen.findByText("2.5M");
    await user.click(screen.getByRole("button", { name: /^Filter/ }));
    await user.click(await screen.findByRole("button", { name: "Thread" }));
    await user.type(screen.getByRole("textbox", { name: "Search Threads" }), "c0ffee");
    expect(await screen.findByRole("checkbox", { name: /Ship usage page/ })).toBeEnabled();
  });

  it("discards a pending filter dimension's response after switching dimensions", async () => {
    const pending = new Map<string, { request: UsageFacetRequest; signal: AbortSignal | undefined; resolve: (value: UsageFacetResponse) => void }>();
    const api = mount(undefined, (request, signal) => new Promise((resolve) => { pending.set(request.dimension, { request, signal, resolve }); }));
    const user = userEvent.setup();
    await screen.findByText("2.5M");
    await user.click(screen.getByRole("button", { name: /^Filter/ }));
    await user.click(await screen.findByRole("button", { name: "Thread" }));
    expect(pending.get("model")!.signal!.aborted).toBe(true);
    await act(async () => { const old = pending.get("model")!; old.resolve(facetResponse(old.request)); });
    const choices = screen.getByRole("group", { name: "Threads" });
    expect(within(choices).queryAllByRole("checkbox")).toHaveLength(0);
    await act(async () => { const current = pending.get("thread")!; current.resolve(facetResponse(current.request)); });
    expect(within(choices).getByRole("checkbox", { name: /Ship usage page/ })).toBeVisible();
    expect(api).toHaveBeenCalledTimes(1);
    expect(api.getUsageFacets).toHaveBeenCalledTimes(2);
  });

  it("keeps the last successful read when a refresh fails", async () => {
    let fail = false;
    const api = mount(async (request) => { if (fail) throw new Error("database_unavailable"); return response(request); });
    await screen.findByText("2.5M");
    fail = true;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh usage" })); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Usage could not be refreshed");
    // The last numbers stay, so a failed refresh is a warning, not an error.
    expect(screen.getByRole("alert")).toHaveAttribute("data-slot", "callout");
    expect(screen.getByRole("alert")).toHaveAttribute("data-tone", "warning");
    expect(screen.getByText("2.5M")).toBeVisible();
    fail = false;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry" })); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api).toHaveBeenCalledTimes(3);
  });

  it("reports a request that fails before it is sent instead of unmounting", async () => {
    mount(() => { throw new Error("request_invalid"); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Usage is unavailable right now.");
    expect(screen.getByRole("alert")).toHaveAttribute("data-tone", "danger");
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Usage" })).toBeVisible();
  });

  it("explains an installation with no recorded usage", async () => {
    mount(async (request) => response(request, { firstRecordedAt: null, totals: aggregate(0, { increments: "0", threads: "0", costs: [] }) }));
    const empty = (await screen.findByText("No recorded usage yet")).closest("[data-slot=empty-state]");
    expect(empty).toHaveAttribute("data-variant", "panel");
    expect(empty).toHaveTextContent("Pi, Codex, Claude, and OpenCode threads");
  });

  it("explains that usage is turned off and how the operator enables it", () => {
    render(<UsageDisabledView />);
    expect(screen.getByRole("heading", { name: "Usage" })).toBeVisible();
    const empty = screen.getByText("Usage is turned off").closest("[data-slot=empty-state]");
    expect(empty).toHaveAttribute("data-variant", "panel");
    expect(within(empty as HTMLElement).getByText("SEDES_EXPERIMENTAL_USAGE=1").tagName).toBe("CODE");
  });
});
