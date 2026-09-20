// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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
  vi.restoreAllMocks();
});

describe("Sidebar Usage", () => {
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
        onOpenAgents={vi.fn()}
        onOpenArchivedThreads={vi.fn()}
        api={apiWith({ ...balanceOnlyStatus, accounts: [] })}
        providerPulseEnabled
      />,
    );

    await user.click(screen.getByRole("button", { name: "More" }));
    const usage = screen.getByRole("menuitem", { name: "Usage" });
    usage.focus();
    await user.keyboard("{ArrowRight}");

    expect(
      await screen.findByRole("menuitem", { name: "Check" }),
    ).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Snapshot" })).toBeVisible();
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
