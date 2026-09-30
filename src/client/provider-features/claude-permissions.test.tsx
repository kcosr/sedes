// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BoundedValue,
  NormalizedThreadSnapshot,
} from "../../shared/index.js";
import type { ThreadClientStore } from "../stores/ThreadClientStore.js";
import { ProviderFeatureThreadDetails } from "./registry.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@client/components/ui/dropdown-menu";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
  Object.assign(window.HTMLElement.prototype, {
    scrollIntoView: vi.fn(),
    hasPointerCapture: vi.fn(),
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const ref = { featureId: "claude.permissions", schemaVersion: 1 } as const;
const allActions = [
  "set_permission_default",
  "set_permission_accept_edits",
  "set_permission_dont_ask",
  "set_permission_auto",
  "set_permission_bypass",
] as const;

function snapshot(
  input: {
    readonly desired?: string | null;
    readonly effective?: string | null;
    readonly effectiveState?: string;
    readonly actionIds?: readonly string[];
    readonly availability?: "available" | "read_only" | "unavailable";
    readonly revision?: number;
  } = {},
): NormalizedThreadSnapshot {
  const availability = input.availability ?? "available";
  const revision = input.revision ?? 7;
  return {
    capabilities: {
      providerFeatures: [
        {
          ref,
          revision,
          label: { text: "Claude permissions" },
          availability,
          ...(availability === "available"
            ? {}
            : { unavailableReason: { text: "Unavailable" } }),
          operations: (input.actionIds ?? allActions).map((actionId) => ({
            actionId,
            label: { text: actionId },
            effects: {
              application: "write",
              modelUsage: "none",
              external: "none",
            },
            confirmation: "none",
            execution: "inline",
          })),
          presentationSlots: ["thread_details"],
        },
      ],
    },
    providerFeatures: [
      {
        ref,
        revision,
        state: objectValue({
          desired: textValue(
            input.desired === undefined ? "default" : input.desired,
          ),
          effective: textValue(
            input.effective === undefined ? "default" : input.effective,
          ),
          effectiveState: textValue(input.effectiveState ?? "confirmed"),
        }),
      },
    ],
  } as unknown as NormalizedThreadSnapshot;
}

async function openModes(): Promise<HTMLElement> {
  await userEvent.click(
    screen.getByRole("menuitem", { name: "Permission mode" }),
  );
  return await screen.findByRole("menu", { name: /Permission mode/ });
}

describe("claude.permissions@1 client feature", () => {
  it("renders one permission-mode radio submenu with no confirmation UI", async () => {
    renderFeature(snapshot());

    const trigger = screen.getByRole("menuitem", { name: "Permission mode" });
    expect(trigger).toHaveTextContent("Default");
    const menu = await openModes();
    expect(
      within(menu).getByRole("menuitemradio", { name: "Default" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(within(menu).getAllByRole("menuitemradio")).toHaveLength(5);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/warning|confirm|danger/i),
    ).not.toBeInTheDocument();
  });

  it("performs the fixed null-argument action at the exact feature revision", async () => {
    const perform = vi.fn().mockResolvedValue(undefined);
    renderFeature(snapshot(), perform);

    const menu = await openModes();
    await userEvent.click(
      within(menu).getByRole("menuitemradio", { name: "Accept edits" }),
    );

    expect(perform).toHaveBeenCalledWith({
      action: "perform_provider_feature",
      feature: ref,
      actionId: "set_permission_accept_edits",
      arguments: null,
      expectedFeatureRevision: 7,
    });
  });

  it("retains a selected mode removed from the deployment allowlist", async () => {
    renderFeature(
      snapshot({
        desired: "bypassPermissions",
        actionIds: allActions.filter(
          (actionId) => actionId !== "set_permission_bypass",
        ),
      }),
    );

    expect(
      screen.getByRole("menuitem", { name: "Permission mode" }),
    ).toHaveTextContent("Bypass permissions");
    const menu = await openModes();
    const retained = within(menu).getByRole("menuitemradio", {
      name: /Bypass permissions/,
    });
    expect(retained).toHaveAttribute("data-disabled");
    expect(retained).toHaveAttribute("aria-checked", "true");
    expect(retained).toHaveTextContent("Unavailable");
    expect(
      within(menu).getByRole("menuitemradio", { name: "Default" }),
    ).not.toHaveAttribute("data-disabled");
  });

  it("disables selection when the capability or host is unavailable", () => {
    const { rerender } = renderFeature(snapshot(), vi.fn(), true);
    const trigger = screen.getByRole("menuitem", { name: "Permission mode" });
    expect(trigger).toHaveAttribute("data-disabled");
    expect(trigger).toHaveTextContent("Unavailable");

    rerender(featureElement(snapshot({ availability: "unavailable" })));
    expect(
      screen.getByRole("menuitem", { name: "Permission mode" }),
    ).toHaveAttribute("data-disabled");
  });

  it("fails closed on unknown state values or extra provider fields", () => {
    const invalid = snapshot({ desired: "plan" });
    renderFeature(invalid);
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();

    cleanup();
    const extra = snapshot() as unknown as {
      providerFeatures: Array<{ state: { entries: unknown[] } }>;
    };
    extra.providerFeatures[0]!.state.entries.push({
      key: { text: "nativeRules" },
      value: null,
    });
    renderFeature(extra as unknown as NormalizedThreadSnapshot);
    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
  });
});

function featureElement(
  value: NormalizedThreadSnapshot,
  perform = vi.fn().mockResolvedValue(undefined),
  disabled = false,
): React.JSX.Element {
  return (
    <DropdownMenu defaultOpen>
      <DropdownMenuTrigger>Thread actions</DropdownMenuTrigger>
      <DropdownMenuContent aria-label="Thread actions">
        <ProviderFeatureThreadDetails
          store={{ perform } as unknown as ThreadClientStore}
          snapshot={value}
          disabled={disabled}
          mobile={false}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function renderFeature(
  value: NormalizedThreadSnapshot,
  perform = vi.fn().mockResolvedValue(undefined),
  disabled = false,
) {
  return render(featureElement(value, perform, disabled));
}

function textValue(value: string | null): BoundedValue {
  return value === null ? null : { text: value };
}

function objectValue(
  value: Readonly<Record<string, BoundedValue>>,
): BoundedValue {
  return {
    kind: "object",
    entries: Object.entries(value).map(([key, entry]) => ({
      key: { text: key },
      value: entry,
    })),
  };
}
