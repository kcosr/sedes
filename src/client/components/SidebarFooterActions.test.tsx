// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarFooterActions } from "./SidebarFooterActions.js";
import {
  CONNECTION_INDICATOR_DELAY_MILLISECONDS,
} from "../app/use-delayed-connection-status.js";

const codexAdvisory = {
  id: "backend_instance/codex-local/runtime_newer_than_tested",
  tone: "warning" as const,
  title: { text: "Local Codex is newer than tested" },
  message: { text: "Running 0.154.0; Sedes is tested through 0.153.0." },
  source: {
    kind: "backend_instance" as const,
    backendInstanceId: "codex-local",
    label: { text: "Local Codex" },
    backend: "codex" as const,
  },
};

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
});

function renderActions() {
  const callbacks = {
    onOpenSettings: vi.fn(),
    onOpenAgents: vi.fn(),
    onOpenArchivedThreads: vi.fn(),
  };
  render(<SidebarFooterActions {...callbacks} />);
  return callbacks;
}

describe("SidebarFooterActions", () => {
  it("uses its visible More text as the menu trigger name", () => {
    renderActions();

    expect(screen.getByRole("button", { name: "More" })).toBeVisible();
  });

  it("can show the desktop fallback connection status", () => {
    vi.useFakeTimers();
    const callbacks = {
      onOpenSettings: vi.fn(),
      onOpenAgents: vi.fn(),
      onOpenArchivedThreads: vi.fn(),
    };
    render(<SidebarFooterActions {...callbacks} connection="disconnected" />);
    expect(screen.queryByRole("img")).toBeNull();
    act(() => {
      vi.advanceTimersByTime(
        CONNECTION_INDICATOR_DELAY_MILLISECONDS,
      );
    });

    expect(
      screen.getByRole("img", { name: "Application disconnected" }),
    ).toHaveAttribute("data-connection", "disconnected");
  });

  it("keeps Settings as a labeled icon button and reports its trigger", async () => {
    const user = userEvent.setup();
    const callbacks = renderActions();

    const settings = screen.getByRole("button", { name: "Settings" });
    expect(settings.textContent).toBe("");

    await user.click(settings);

    expect(callbacks.onOpenSettings).toHaveBeenCalledExactlyOnceWith(settings);
  });

  it("hides the warning affordance when there are no active advisories", () => {
    renderActions();

    expect(screen.queryByRole("button", { name: /Warnings/u })).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Warnings" })).toBeNull();
  });

  it("places the active-warning affordance immediately before Settings", () => {
    render(
      <SidebarFooterActions
        onOpenSettings={vi.fn()}
        onOpenAgents={vi.fn()}
        onOpenArchivedThreads={vi.fn()}
        advisories={[codexAdvisory]}
      />,
    );

    const warnings = screen.getByRole("button", {
      name: "Warnings, 1 active",
    });
    const settings = screen.getByRole("button", { name: "Settings" });
    expect(
      warnings.compareDocumentPosition(settings) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
    expect(warnings).toHaveTextContent("1");
  });

  it("opens an accessible sheet listing the instance, backend, title, and message", async () => {
    const user = userEvent.setup();
    render(
      <SidebarFooterActions
        onOpenSettings={vi.fn()}
        onOpenAgents={vi.fn()}
        onOpenArchivedThreads={vi.fn()}
        advisories={[
          codexAdvisory,
          {
            ...codexAdvisory,
            id: "backend_instance/claude-lab/runtime_newer_than_tested",
            tone: "info",
            title: { text: "Lab Claude has an advisory" },
            message: { text: "Review this backend instance." },
            source: {
              kind: "backend_instance",
              backendInstanceId: "claude-lab",
              label: { text: "Lab Claude" },
              environment: { id: "lab", label: { text: "Lab host" } },
              backend: "claude",
            },
          },
          {
            id: "application/storage_pressure",
            tone: "error",
            title: { text: "Storage needs attention" },
            message: { text: "Sedes cannot retain more artifacts." },
            source: { kind: "application" },
          },
        ]}
      />,
    );

    const trigger = screen.getByRole("button", {
      name: "Warnings, 3 active",
    });
    await user.click(trigger);

    const sheet = screen.getByRole("dialog", { name: "Warnings" });
    expect(sheet).toHaveClass("advisory-center-sheet");
    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(sheet).toHaveAccessibleDescription(
      "Active application and backend warnings.",
    );
    expect(sheet).toHaveTextContent("Local Codex");
    expect(sheet.querySelector(".advisory-center-source")?.textContent).toBe(
      "Local Codex",
    );
    expect(sheet).toHaveTextContent("Local Codex is newer than tested");
    expect(sheet).toHaveTextContent(
      "Running 0.154.0; Sedes is tested through 0.153.0.",
    );
    expect(sheet).toHaveTextContent("Lab Claude·Lab host");
    expect(sheet).toHaveTextContent("Sedes");
    expect(sheet).toHaveTextContent("Storage needs attention");
    expect(sheet.querySelectorAll(".advisory-center-item")).toHaveLength(3);
    expect(
      sheet.querySelector('.advisory-center-item[data-tone="warning"]'),
    ).not.toBeNull();
    expect(
      sheet.querySelector('.advisory-center-item[data-tone="info"]'),
    ).not.toBeNull();
    expect(
      sheet.querySelector('.advisory-center-item[data-tone="error"]'),
    ).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Warnings" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("keeps warning and Settings controls reachable in the narrow sidebar layout", () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: String(query).includes("819"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })) as unknown as typeof window.matchMedia;
    render(
      <SidebarFooterActions
        onOpenSettings={vi.fn()}
        onOpenAgents={vi.fn()}
        onOpenArchivedThreads={vi.fn()}
        advisories={[codexAdvisory]}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Warnings, 1 active" }),
    ).toHaveClass("sidebar-footer-advisories");
    expect(screen.getByRole("button", { name: "Settings" })).toBeVisible();
  });

  it("closes and restores focus to Settings when the last active warning resolves", async () => {
    const user = userEvent.setup();
    const callbacks = {
      onOpenSettings: vi.fn(),
      onOpenAgents: vi.fn(),
      onOpenArchivedThreads: vi.fn(),
    };
    const { rerender } = render(
      <SidebarFooterActions {...callbacks} advisories={[codexAdvisory]} />,
    );

    await user.click(
      screen.getByRole("button", { name: "Warnings, 1 active" }),
    );
    expect(screen.getByRole("dialog", { name: "Warnings" })).toBeVisible();

    rerender(<SidebarFooterActions {...callbacks} advisories={[]} />);

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Warnings" })).toBeNull();
    });
    expect(screen.queryByRole("button", { name: /Warnings/u })).toBeNull();
    expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();
  });

  it("restores focus to Settings when the focused warning trigger resolves", () => {
    const callbacks = {
      onOpenSettings: vi.fn(),
      onOpenAgents: vi.fn(),
      onOpenArchivedThreads: vi.fn(),
    };
    const { rerender } = render(
      <SidebarFooterActions {...callbacks} advisories={[codexAdvisory]} />,
    );
    const warnings = screen.getByRole("button", {
      name: "Warnings, 1 active",
    });
    warnings.focus();
    expect(warnings).toHaveFocus();

    rerender(<SidebarFooterActions {...callbacks} advisories={[]} />);

    expect(screen.queryByRole("button", { name: /Warnings/u })).toBeNull();
    expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();
  });

  it("opens its destination menu upward from the footer", async () => {
    const user = userEvent.setup();
    renderActions();

    const trigger = screen.getByRole("button", {
      name: "More",
    });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const menu = await screen.findByRole("menu");
    expect(menu).toHaveAttribute("data-side", "top");
    expect(screen.getByRole("menuitem", { name: "Agents" })).toBeVisible();
    expect(
      screen.getByRole("menuitem", { name: "Archived threads" }),
    ).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Usage" })).toBeNull();
  });

  it("opens a full-width usage sheet on a coarse pointer instead of a submenu", async () => {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches:
        String(query).includes("coarse") || String(query).includes("819"),
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
      onchange: null,
    })) as unknown as typeof window.matchMedia;
    const user = userEvent.setup();
    render(
      <SidebarFooterActions
        onOpenSettings={vi.fn()}
        onOpenAgents={vi.fn()}
        onOpenArchivedThreads={vi.fn()}
        providerPulseEnabled
        api={
          {
            readProviderPulseStatus: vi.fn().mockResolvedValue({
              version: 1,
              generatedAt: "2026-08-16T19:00:00.000Z",
              health: "healthy",
              accounts: [],
              usageBaseline: { health: "healthy", metrics: [] },
            }),
            checkProviderPulseAccount: vi.fn(),
            checkAllProviderPulseAccounts: vi.fn(),
            snapshotProviderPulseUsage: vi.fn(),
          } as never
        }
      />,
    );

    await user.click(screen.getByRole("button", { name: "More" }));
    const usage = screen.getByRole("menuitem", { name: "Usage" });
    expect(usage).not.toHaveAttribute("aria-haspopup");
    await user.click(usage);
    expect(await screen.findByRole("dialog", { name: "Usage" })).toBeVisible();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("adds Usage only when bootstrap reports Provider Pulse enabled", async () => {
    const user = userEvent.setup();
    render(
      <SidebarFooterActions
        onOpenSettings={vi.fn()}
        onOpenAgents={vi.fn()}
        onOpenArchivedThreads={vi.fn()}
        providerPulseEnabled
        api={
          {
            readProviderPulseStatus: vi.fn(),
            checkProviderPulseAccount: vi.fn(),
            checkAllProviderPulseAccounts: vi.fn(),
            snapshotProviderPulseUsage: vi.fn(),
          } as never
        }
      />,
    );

    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.getByRole("menuitem", { name: "Usage" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Agents" })).toBeVisible();
  });

  it("hides Usage when an API client exists but Provider Pulse is disabled", async () => {
    const user = userEvent.setup();
    render(
      <SidebarFooterActions
        onOpenSettings={vi.fn()}
        onOpenAgents={vi.fn()}
        onOpenArchivedThreads={vi.fn()}
        api={{} as never}
      />,
    );

    await user.click(screen.getByRole("button", { name: "More" }));
    expect(screen.queryByRole("menuitem", { name: "Usage" })).toBeNull();
  });

  it("reports destination selections so the parent can navigate and close", async () => {
    const user = userEvent.setup();
    const callbacks = renderActions();

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(screen.getByRole("menuitem", { name: "Agents" }));
    expect(callbacks.onOpenAgents).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();

    await user.click(screen.getByRole("button", { name: "More" }));
    await user.click(
      screen.getByRole("menuitem", { name: "Archived threads" }),
    );
    expect(callbacks.onOpenArchivedThreads).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
