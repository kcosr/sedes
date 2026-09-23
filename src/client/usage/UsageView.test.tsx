// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  USAGE_ANALYTICS_DIMENSIONS, usageAnalyticsResponseSchema,
  type UsageAnalyticsAggregate, type UsageAnalyticsRequest, type UsageAnalyticsResponse,
} from "../../shared/protocol/usage-analytics.js";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import { UsageView } from "./UsageView.js";

const aggregate = (tokens: number, overrides: Partial<UsageAnalyticsAggregate> = {}): UsageAnalyticsAggregate => ({
  tokens: String(tokens), input: String(Math.round(tokens * 0.9)), uncachedInput: "0", cacheRead: String(Math.round(tokens * 0.6)), cacheWrite: "0",
  output: String(tokens - Math.round(tokens * 0.9)), reasoning: "0", requests: "0",
  costs: [{ currency: "USD", amount: (tokens / 1_000_000).toFixed(2), kind: "estimated" }], increments: "4", threads: "2", uncostedTokens: "0",
  missing: { input: "0", output: "0", cacheRead: "0", cacheWrite: "0", reasoning: "0", requests: "4", cost: "0" }, ...overrides,
});
const points = (values: number[]) => ({
  tokens: values.map(String), input: values.map(String), output: values.map(() => "0"), cacheRead: values.map(() => "0"),
  cacheWrite: values.map(() => "0"), reasoning: values.map(() => "0"), requests: values.map(() => "0"), cost: values.map(() => "0"),
});
function response(request: UsageAnalyticsRequest, overrides: Partial<UsageAnalyticsResponse> = {}): UsageAnalyticsResponse {
  const empty: UsageAnalyticsResponse["breakdowns"]["model"] = { rows: [], other: null, distinct: "0" };
  const breakdowns = Object.fromEntries(USAGE_ANALYTICS_DIMENSIONS.map((dimension) => [dimension, empty])) as UsageAnalyticsResponse["breakdowns"];
  breakdowns.model = { rows: [{ key: "opus", totals: aggregate(2_000_000) }, { key: null, totals: aggregate(500_000, { costs: [] }) }], other: null, distinct: "2" };
  breakdowns.thread = { rows: [{ key: "thread-1", totals: aggregate(2_500_000) },
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
    breakdowns, matrix: null, facets: null, heatmap: [{ weekday: 0, hour: 9, tokens: "2500000", cost: "2.5" }],
    placement: { reported: "2500000", observed: "0", interval: "0", spanning: "0", straddling: "0", unplaced: "0" },
    coverage: { threads: "2", partialThreads: "0", conflictThreads: "0", unsupportedThreads: "0", modelUnknownTokens: "500000", effortUnknownTokens: "2500000" },
    labels, ...overrides,
  });
}
function mount(implementation?: (request: UsageAnalyticsRequest) => Promise<UsageAnalyticsResponse>) {
  // A synchronous throw models client-side request validation failing before any fetch.
  const getUsageAnalytics = vi.fn(implementation ?? (async (request: UsageAnalyticsRequest) => response(request)));
  render(<UsageView store={{ api: { getUsageAnalytics } } as unknown as ApplicationClientStore} />);
  return getUsageAnalytics;
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
});
afterEach(() => { cleanup(); localStorage.clear(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("UsageView", () => {
  it("summarizes the range and compares it with the previous period", async () => {
    const api = mount();
    expect(await screen.findByText("2.5M")).toBeVisible();
    expect(api).toHaveBeenCalledWith(expect.objectContaining({ groupBy: "model", crossBy: null, breakdownLimit: 8, facets: false, bucket: "auto", filters: {} }), expect.any(AbortSignal));
    const request = api.mock.calls[0]![0];
    expect(Date.parse(request.to) - Date.parse(request.from!)).toBeGreaterThan(29 * 86_400_000);
    const tokens = screen.getByText("Total tokens").closest(".usage-stat")!;
    expect(within(tokens as HTMLElement).getByText("25%")).toBeVisible();
    expect(screen.getByText("$2.50")).toBeVisible();
    expect(screen.getByRole("group", { name: /Total tokens by model/ })).toBeVisible();
    expect(screen.getAllByText("Unknown model").length).toBeGreaterThan(0);
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
    const api = mount();
    await screen.findByText("2.5M");
    fireEvent.click(screen.getByRole("tab", { name: "Explore" }));
    expect(api).toHaveBeenLastCalledWith(expect.objectContaining({ groupBy: "model", breakdownLimit: 100 }), expect.any(AbortSignal));
    const table = await screen.findByRole("table");
    const opus = within(table).getByRole("button", { name: /opus/ }).closest("tr")!;
    expect(within(opus).getByText("2M")).toBeVisible();
    expect(within(table).queryByRole("columnheader", { name: /Requests/ })).toBeNull();
    expect(JSON.parse(localStorage.getItem("sedes-usage-view-v1")!).tab).toBe("explore");
  });

  it("lists threads with a link that opens them", async () => {
    mount();
    await screen.findByText("2.5M");
    fireEvent.click(screen.getByRole("tab", { name: "Threads" }));
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
    fireEvent.click(screen.getByRole("tab", { name: "Patterns" }));
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
    await waitFor(() => expect(api).toHaveBeenCalledWith(expect.objectContaining({ facets: true, facetSearch: { dimension: "thread", text: "ship" } }), expect.any(AbortSignal)));
  });

  it("keeps the last successful read when a refresh fails", async () => {
    let fail = false;
    const api = mount(async (request) => { if (fail) throw new Error("database_unavailable"); return response(request); });
    await screen.findByText("2.5M");
    fail = true;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Refresh usage" })); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Usage could not be refreshed");
    expect(screen.getByText("2.5M")).toBeVisible();
    fail = false;
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Retry" })); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(api).toHaveBeenCalledTimes(3);
  });

  it("reports a request that fails before it is sent instead of unmounting", async () => {
    mount(() => { throw new Error("request_invalid"); });
    expect(await screen.findByRole("alert")).toHaveTextContent("Usage is unavailable right now.");
    expect(screen.getByRole("heading", { name: "Usage" })).toBeVisible();
  });

  it("explains an installation with no recorded usage", async () => {
    mount(async (request) => response(request, { firstRecordedAt: null, totals: aggregate(0, { increments: "0", threads: "0", costs: [] }) }));
    expect(await screen.findByRole("heading", { name: "No recorded usage yet" })).toBeVisible();
  });
});
