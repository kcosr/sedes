// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BoundedValue,
  NormalizedThreadSnapshot,
} from "../../shared/index.js";
import type { ThreadClientStore } from "../stores/ThreadClientStore.js";
import { ProviderFeatureComposerActions } from "./registry.js";

const ref = { featureId: "codex.fast_mode", schemaVersion: 1 } as const;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

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

function snapshot(input: {
  readonly desired: "standard" | "fast" | null;
  readonly effective: "standard" | "fast" | null;
  readonly applicationState: "applied" | "pending" | "unknown";
  readonly availability?: "available" | "read_only" | "unavailable";
  readonly revision?: number;
}): NormalizedThreadSnapshot {
  const availability = input.availability ?? "available";
  const actionId = input.desired === "fast" ? "disable" : "enable";
  const revision = input.revision ?? 7;
  return {
    capabilities: {
      providerFeatures: [
        {
          ref,
          revision,
          label: { text: "Fast mode" },
          description: {
            text: "Fast mode: about 1.5x speed, higher usage",
          },
          availability,
          ...(availability === "available"
            ? {}
            : {
                unavailableReason: { text: "Wait for the thread to settle." },
              }),
          operations: [
            {
              actionId,
              label: { text: actionId === "enable" ? "Enable" : "Disable" },
              effects: {
                application: "write",
                modelUsage: "none",
                external: "none",
              },
              confirmation: "none",
              execution: "inline",
            },
          ],
          presentationSlots: ["composer_action"],
        },
      ],
    },
    providerFeatures: [
      {
        ref,
        revision,
        state: objectValue({
          desired: input.desired === null ? null : { text: input.desired },
          effective:
            input.effective === null ? null : { text: input.effective },
          applicationState: { text: input.applicationState },
        }),
      },
    ],
  } as unknown as NormalizedThreadSnapshot;
}

function renderFastMode(
  value: NormalizedThreadSnapshot,
  perform = vi.fn().mockResolvedValue({
    status: "accepted",
    operationId: "operation-fast",
  }),
) {
  render(
    <ProviderFeatureComposerActions
      store={{ perform } as unknown as ThreadClientStore}
      snapshot={value}
      disabled={false}
      mobile={false}
    />,
  );
  return perform;
}

describe("codex.fast_mode@1 client feature", () => {
  it("renders Standard as an accessible outline toggle and enables Fast", async () => {
    const perform = renderFastMode(
      snapshot({
        desired: "standard",
        effective: "standard",
        applicationState: "applied",
      }),
    );

    const toggle = screen.getByRole("button", { name: "Fast mode, off" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveAttribute("aria-disabled", "false");
    expect(toggle.querySelector("svg")).toHaveAttribute("fill", "none");

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(perform).toHaveBeenCalledWith({
        action: "perform_provider_feature",
        feature: ref,
        actionId: "enable",
        arguments: null,
        expectedFeatureRevision: 7,
      }),
    );
  });

  it("renders Fast as a filled pressed toggle and disables it", async () => {
    const perform = renderFastMode(
      snapshot({
        desired: "fast",
        effective: "fast",
        applicationState: "applied",
      }),
    );
    const toggle = screen.getByRole("button", { name: "Fast mode, on" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle.querySelector("svg")).toHaveAttribute("fill", "currentColor");

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(perform).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: "disable" }),
      ),
    );
  });

  it("exposes pending and unknown application state without changing the desired selection", () => {
    renderFastMode(
      snapshot({
        desired: "fast",
        effective: "standard",
        applicationState: "pending",
      }),
    );
    const pending = screen.getByRole("button", {
      name: "Fast mode, on, pending",
    });
    expect(pending).toHaveAttribute("aria-pressed", "true");
    expect(pending).toHaveAttribute("data-application-state", "pending");

    cleanup();
    renderFastMode(
      snapshot({
        desired: "standard",
        effective: null,
        applicationState: "unknown",
      }),
    );
    const unknown = screen.getByRole("button", {
      name: "Fast mode, off, application unknown",
    });
    expect(unknown).toHaveAttribute("aria-pressed", "false");
    expect(unknown).toHaveAttribute("data-application-state", "unknown");
  });

  it("keeps unavailable and unresolved controls inert with an exact accessible state", () => {
    const perform = renderFastMode(
      snapshot({
        desired: "standard",
        effective: "standard",
        applicationState: "applied",
        availability: "read_only",
      }),
    );
    const readOnly = screen.getByRole("button", { name: "Fast mode, off" });
    expect(readOnly).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(readOnly);
    expect(perform).not.toHaveBeenCalled();

    cleanup();
    renderFastMode(
      snapshot({
        desired: null,
        effective: null,
        applicationState: "unknown",
      }),
    );
    expect(
      screen.getByRole("button", { name: "Fast mode, unavailable" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("uses only a passive hover/focus tooltip for usage information", async () => {
    renderFastMode(
      snapshot({
        desired: "standard",
        effective: "standard",
        applicationState: "applied",
      }),
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.focus(screen.getByRole("button", { name: "Fast mode, off" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Fast mode: about 1.5x speed, higher usage",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("fails closed for malformed or wrong-version state", () => {
    const malformed = snapshot({
      desired: "standard",
      effective: "standard",
      applicationState: "applied",
    }) as unknown as {
      providerFeatures: Array<Record<string, unknown>>;
    };
    malformed.providerFeatures[0]!.state = objectValue({
      desired: { text: "priority" },
      effective: { text: "standard" },
      applicationState: { text: "applied" },
    });
    renderFastMode(malformed as unknown as NormalizedThreadSnapshot);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
