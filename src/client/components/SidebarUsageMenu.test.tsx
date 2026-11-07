// @vitest-environment jsdom

import { act, cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/ApiClient.js";
import type { ProviderPulseStatus } from "../../shared/protocol/provider-pulse.js";
import { SidebarFooterActions } from "./SidebarFooterActions.js";
import { SidebarUsageSheet } from "./SidebarUsageMenu.js";

const balanceResetAt = new Date(2026, 8, 1, 12).toISOString();

const balanceOnlyStatus: ProviderPulseStatus = {
  version: 1,
  generatedAt: "2026-08-16T19:00:00.000Z",
  health: "healthy",
  accounts: [
    {
      id: "fireworks-work",
      label: "Fireworks · work",
      provider: "fireworks",
      usage: {
        health: "healthy",
        inFlight: false,
        lastSuccessAt: "2026-08-16T19:00:00.000Z",
        snapshot: {
          observedAt: "2026-08-16T19:00:00.000Z",
          windows: [],
          balances: [
            {
              id: "credits",
              label: "Credits",
              remainingPercent: 72,
              used: "$28",
              limit: "$100",
              resetsAt: balanceResetAt,
            },
          ],
        },
      },
    },
  ],
  usageBaseline: {
    health: "healthy",
    metrics: [
      {
        accountId: "fireworks-work",
        metricKind: "balance",
        metricId: "credits",
        remainingPercent: 80,
        capturedAt: "2026-08-16T12:00:00.000Z",
      },
    ],
  },
};

const resetCreditStatus: ProviderPulseStatus = {
  version: 1,
  generatedAt: "2026-08-16T19:00:00.000Z",
  health: "healthy",
  accounts: [
    {
      id: "codex-main",
      label: "Codex · Main",
      provider: "codex",
      brand: "codex",
      usage: {
        health: "healthy",
        inFlight: false,
        lastSuccessAt: "2026-08-16T19:00:00.000Z",
        snapshot: {
          observedAt: "2026-08-16T19:00:00.000Z",
          windows: [],
          balances: [],
          resetCredits: {
            availableCount: 2,
            nextExpiresAt: "2026-08-30T18:00:00.000Z",
          },
        },
      },
    },
  ],
  usageBaseline: { health: "unknown", metrics: [] },
};

function apiWith(status: ProviderPulseStatus): ApiClient {
  return {
    readProviderPulseStatus: vi.fn().mockResolvedValue(status),
    checkProviderPulseAccount: vi.fn(),
    checkAllProviderPulseAccounts: vi.fn(),
    snapshotProviderPulseUsage: vi.fn(),
  } as unknown as ApiClient;
}

beforeEach(() => {
  Object.assign(window.HTMLElement.prototype, {
    scrollIntoView: vi.fn(),
    hasPointerCapture: vi.fn(),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  });
  window.matchMedia = vi.fn().mockReturnValue({
    matches: false,
    media: "",
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
    onchange: null,
  }) as unknown as typeof window.matchMedia;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("Sidebar Usage", () => {
  it.each([
    [2, "2026-11-09T12:00:00Z", "danger", "2"],
    [1, "2026-11-12T12:00:00Z", "neutral", "1"],
    [3, undefined, "neutral", "3"],
    [125, "2026-11-12T12:00:00Z", "neutral", "99+"],
  ] as const)("shows %i banked resets with the correct expiry tone", async (count, expiry, tone, text) => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-11-07T12:00:00Z"));
    const status = structuredClone(resetCreditStatus);
    // Presentation follows normalized reset-credit data, not a provider name.
    status.accounts[0]!.provider = "another-provider";
    status.accounts[0]!.usage.snapshot!.resetCredits = {
      availableCount: count,
      ...(expiry ? { nextExpiresAt: expiry } : {}),
    };
    render(<SidebarUsageSheet api={apiWith(status)} open onOpenChange={vi.fn()} />);
    const row = await screen.findByRole("button", { name: /Main/i });
    const badge = within(row).getByText(text).closest("[data-slot='badge']")!;
    expect(badge).toHaveAttribute("data-tone", tone);
    expect(badge).toHaveAttribute("title", expect.stringContaining(`${count} banked`));
    expect(row).toHaveAccessibleName(expect.stringContaining(`${count} banked`));
    if (tone === "danger") expect(badge).toHaveAttribute("title", expect.stringContaining("within 3 days"));
    expect(row.querySelector(".sidebar-usage-reset-credits")).toContainElement(badge as HTMLElement);
  });

  it.each([0, undefined])("leaves an empty badge column for a %s count", async (count) => {
    const status = structuredClone(resetCreditStatus);
    const snapshot = status.accounts[0]!.usage.snapshot!;
    if (count === undefined) delete snapshot.resetCredits;
    else snapshot.resetCredits = { availableCount: count, nextExpiresAt: "2026-11-08T12:00:00Z" };
    render(<SidebarUsageSheet api={apiWith(status)} open onOpenChange={vi.fn()} />);
    const row = await screen.findByRole("button", { name: /Main/i });
    expect(row.querySelector(".sidebar-usage-reset-credits")).toBeEmptyDOMElement();
    expect(row.querySelector("[data-slot='badge']")).toBeNull();
  });

  it("updates expiry warnings with time and replaces counts after a status refresh", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T12:00:00Z"));
    const status = structuredClone(resetCreditStatus);
    status.accounts[0]!.usage.snapshot!.resetCredits = {
      availableCount: 2,
      nextExpiresAt: "2026-11-10T12:00:30Z",
    };
    const api = apiWith(status);
    const read = vi.mocked(api.readProviderPulseStatus);
    read.mockResolvedValueOnce(status).mockRejectedValue(new Error("Temporarily unavailable"));
    render(<SidebarUsageSheet api={api} open onOpenChange={vi.fn()} />);
    await act(async () => {});
    const badge = () => screen.getByText("2").closest("[data-slot='badge']")!;
    expect(badge()).toHaveAttribute("data-tone", "neutral");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_100); });
    expect(badge()).toHaveAttribute("data-tone", "danger");

    const refreshed = structuredClone(status);
    refreshed.accounts[0]!.usage.snapshot!.resetCredits = { availableCount: 0 };
    read.mockResolvedValue(refreshed);
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByRole("button", { name: /Main/i }).querySelector("[data-slot='badge']")).toBeNull();
  });

  it("exposes banked resets in the desktop submenu and its keyboard-opened details", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-28T19:00:00Z"));
    const user = userEvent.setup();
    render(<SidebarFooterActions
      onOpenSettings={vi.fn()} onOpenUsage={vi.fn()} onOpenAgents={vi.fn()}
      onOpenAutomations={vi.fn()} onOpenArchivedThreads={vi.fn()}
      api={apiWith(resetCreditStatus)} providerPulseEnabled
    />);
    await user.click(screen.getByRole("button", { name: "More" }));
    screen.getByRole("menuitem", { name: "Accounts" }).focus();
    await user.keyboard("{ArrowRight}");
    const row = await screen.findByRole("menuitem", { name: /Main.*2 banked resets/ });
    expect(within(row).getByText("2").closest("[data-slot='badge']")).toHaveAttribute("data-tone", "danger");
    row.focus();
    await user.keyboard("{ArrowRight}");
    expect(await screen.findByText("2 resets")).toBeVisible();
    expect(screen.getByText(/^Next expires /)).toBeVisible();
  });

  it("separates reset dates accessibly and explains expired credits in mobile details", async () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-08-31T12:00:00Z"));
    const status = structuredClone(resetCreditStatus);
    status.accounts[0]!.usage.snapshot!.windows = [{
      id: "weekly", label: "Weekly", remainingPercent: 50,
      resetsAt: "2026-09-01T12:00:00Z",
    }];
    const user = userEvent.setup();
    render(<SidebarUsageSheet api={apiWith(status)} open onOpenChange={vi.fn()} />);
    const row = await screen.findByRole("button", { name: /Main/i });
    // JSDOM omits stylesheet-driven separators between the grid cells.
    expect(row).toHaveAccessibleName(/Next expires .*\.\s*tomorrow;/);
    await user.click(row);
    expect(screen.getByText("Reported expiry has passed; check the account to refresh.", { selector: ".sidebar-usage-reset-warning" })).toBeVisible();
  });

  it("renders balance-only accounts and exposes the mobile disclosure state", async () => {
    vi.spyOn(Date, "now").mockReturnValue(
      new Date(2026, 7, 18, 12).getTime(),
    );
    const user = userEvent.setup();
    render(
      <SidebarUsageSheet
        api={apiWith(balanceOnlyStatus)}
        open
        onOpenChange={vi.fn()}
      />,
    );

    const disclosure = await screen.findByRole("button", { name: /work/i });
    expect(screen.getByText("Tue")).toHaveClass("sidebar-usage-reset-day");
    expect(screen.getByText("Tue")).toHaveAttribute(
      "aria-label",
      expect.stringMatching(/^Tue; Resets /),
    );
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(disclosure).toHaveAttribute(
      "aria-controls",
      "usage-account-fireworks-work",
    );
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Credits")).toBeVisible();
    expect(screen.getByText("72% left")).toBeVisible();
    expect(screen.getByText("$28 used · $100 limit")).toBeVisible();
    expect(screen.getByText(/8% used since/)).toBeVisible();
  });

  it("renders lowercase relative reset labels in the summary column", async () => {
    const now = new Date(2026, 7, 22, 12);
    vi.spyOn(Date, "now").mockReturnValue(now.getTime());
    const resetsToday = structuredClone(balanceOnlyStatus);
    resetsToday.accounts[0]!.usage.snapshot!.balances[0]!.resetsAt = new Date(
      2026,
      7,
      22,
      23,
    ).toISOString();

    render(
      <SidebarUsageSheet
        api={apiWith(resetsToday)}
        open
        onOpenChange={vi.fn()}
      />,
    );

    const today = await screen.findByText("today");
    expect(today).toHaveClass("sidebar-usage-reset-day");
    expect(today).toHaveAttribute(
      "aria-label",
      expect.stringMatching(/^today; Resets /),
    );
  });

  it("uses Radix menu items for keyboard-reachable desktop actions", async () => {
    const user = userEvent.setup();
    render(
      <SidebarFooterActions
        onOpenSettings={vi.fn()}
        onOpenUsage={vi.fn()}
        onOpenAgents={vi.fn()}
        onOpenAutomations={vi.fn()}
        onOpenArchivedThreads={vi.fn()}
        api={apiWith({ ...balanceOnlyStatus, accounts: [] })}
        providerPulseEnabled
      />,
    );

    await user.click(screen.getByRole("button", { name: "More" }));
    const accounts = screen.getByRole("menuitem", { name: "Accounts" });
    accounts.focus();
    await user.keyboard("{ArrowRight}");

    const checkAll = await screen.findByRole("menuitem", { name: "Check all" });
    expect(checkAll).toBeVisible();
    expect(checkAll.querySelector("svg")).not.toBeNull();
    expect(
      screen.getByRole("menuitem", { name: "Save snapshot" }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("No provider accounts.");
    expect(screen.getByRole("status")).not.toHaveAttribute("tabindex");
  });

  it("renders banked reset count and nearest expiry without other usage metrics", async () => {
    const user = userEvent.setup();
    render(
      <SidebarUsageSheet
        api={apiWith(resetCreditStatus)}
        open
        onOpenChange={vi.fn()}
      />,
    );

    const disclosure = await screen.findByRole("button", { name: /Main/i });
    await user.click(disclosure);
    expect(screen.getByText("Banked resets")).toBeVisible();
    expect(screen.getByText("2 resets")).toBeVisible();
    expect(screen.getByText(/^Next expires /)).toBeVisible();
    expect(screen.queryByText("Usage unavailable.")).not.toBeInTheDocument();
  });
});
