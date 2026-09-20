// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BoundedValue,
  NormalizedThreadSnapshot,
} from "../../shared/index.js";
import type { ThreadClientStore } from "../stores/ThreadClientStore.js";
import { ProviderFeatureThreadDetails } from "./registry.js";

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

describe("claude.permissions@1 client feature", () => {
  it("renders one ordinary permission-mode dropdown with no confirmation UI", () => {
    renderFeature(snapshot());

    expect(screen.getByText("Claude permissions")).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", { name: "Permission mode" }),
    ).toHaveTextContent("Default");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/warning|confirm|danger/i),
    ).not.toBeInTheDocument();
  });

  it("performs the fixed null-argument action at the exact feature revision", async () => {
    const perform = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    renderFeature(snapshot(), perform);

    await user.click(screen.getByRole("combobox", { name: "Permission mode" }));
    await user.click(screen.getByRole("option", { name: "Accept edits" }));

    expect(perform).toHaveBeenCalledWith({
      action: "perform_provider_feature",
      feature: ref,
      actionId: "set_permission_accept_edits",
      arguments: null,
      expectedFeatureRevision: 7,
    });
  });

  it("retains a selected mode removed from the deployment allowlist", async () => {
    const user = userEvent.setup();
    renderFeature(
      snapshot({
        desired: "bypassPermissions",
        actionIds: allActions.filter(
          (actionId) => actionId !== "set_permission_bypass",
        ),
      }),
    );

    const select = screen.getByRole("combobox", { name: "Permission mode" });
    expect(select).toHaveTextContent("Bypass permissions");
    await user.click(select);
    expect(
      screen.getByRole("option", {
        name: "Bypass permissions (unavailable)",
      }),
    ).toHaveAttribute("data-disabled");
    expect(screen.getByRole("option", { name: "Default" })).not.toHaveAttribute(
      "data-disabled",
    );
  });

  it("disables selection when the capability or host is unavailable", () => {
    const { rerender } = renderFeature(snapshot(), vi.fn(), true);
    expect(
      screen.getByRole("combobox", { name: "Permission mode" }),
    ).toBeDisabled();

    rerender(featureElement(snapshot({ availability: "unavailable" })));
    expect(
      screen.getByRole("combobox", { name: "Permission mode" }),
    ).toBeDisabled();
  });

  it("fails closed on unknown state values or extra provider fields", () => {
    const invalid = snapshot({ desired: "plan" });
    renderFeature(invalid);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();

    cleanup();
    const extra = snapshot() as unknown as {
      providerFeatures: Array<{ state: { entries: unknown[] } }>;
    };
    extra.providerFeatures[0]!.state.entries.push({
      key: { text: "nativeRules" },
      value: null,
    });
    renderFeature(extra as unknown as NormalizedThreadSnapshot);
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });
});

function featureElement(
  value: NormalizedThreadSnapshot,
  perform = vi.fn().mockResolvedValue(undefined),
  disabled = false,
): React.JSX.Element {
  return (
    <ProviderFeatureThreadDetails
      store={{ perform } as unknown as ThreadClientStore}
      snapshot={value}
      disabled={disabled}
      mobile
    />
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
