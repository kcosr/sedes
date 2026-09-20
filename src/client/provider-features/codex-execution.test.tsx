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

// jsdom lacks the pointer-capture and scroll APIs the Radix Select
// primitive relies on.
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

const ref = { featureId: "codex.execution", schemaVersion: 1 } as const;
const actionIds = [
  "set_sandbox_read_only",
  "set_sandbox_workspace",
  "set_sandbox_unrestricted",
  "set_network_disabled",
  "set_network_enabled",
  "set_approval_untrusted",
  "set_approval_on_request",
  "set_approval_never",
  "set_reviewer_user",
  "set_reviewer_auto_review",
] as const;

const capability = {
  ref,
  revision: 7,
  label: { text: "Codex execution" },
  availability: "available",
  operations: actionIds.map((actionId) => ({
    actionId,
    label: { text: actionId },
    effects: { application: "write", modelUsage: "none", external: "none" },
    confirmation: "none",
    execution: "inline",
  })),
  presentationSlots: ["thread_details"],
} as const;

type Tuple = {
  readonly sandboxMode:
    "read-only" | "workspace-write" | "danger-full-access" | null;
  readonly networkAccess: "disabled" | "enabled" | null;
  readonly approvalPolicy: "untrusted" | "on-request" | "never" | null;
  readonly approvalReviewer: "user" | "auto_review" | null;
};

type DesiredTuple = {
  readonly sandboxMode: Exclude<Tuple["sandboxMode"], null>;
  readonly networkAccess: Exclude<Tuple["networkAccess"], null>;
  readonly approvalPolicy: Exclude<Tuple["approvalPolicy"], null>;
  readonly approvalReviewer: Exclude<Tuple["approvalReviewer"], null>;
};

const defaultDesired: DesiredTuple = {
  sandboxMode: "workspace-write",
  networkAccess: "disabled",
  approvalPolicy: "on-request",
  approvalReviewer: "user",
};

function snapshot({
  desired = defaultDesired,
  effective = defaultDesired,
  featureCapability = capability,
  runState = "idle",
}: {
  readonly desired?: DesiredTuple | null;
  readonly effective?: Tuple | null;
  readonly featureCapability?: unknown;
  readonly runState?: "idle" | "active";
} = {}): NormalizedThreadSnapshot {
  return {
    runState,
    capabilities: { providerFeatures: [featureCapability] },
    providerFeatures: [
      {
        ref,
        revision: 7,
        state: objectValue({
          desired: tupleValue(desired),
          effective: tupleValue(effective),
        }),
      },
    ],
  } as unknown as NormalizedThreadSnapshot;
}

describe("codex.execution@1 client feature", () => {
  it("renders the four desired next-turn values as plain dropdowns", () => {
    renderFeature(snapshot());

    expect(screen.getByText("Codex execution")).toBeInTheDocument();
    expect(screen.getAllByRole("combobox")).toHaveLength(4);
    expect(screen.getByRole("combobox", { name: "Sandbox" })).toHaveTextContent(
      "Workspace",
    );
    expect(screen.getByRole("combobox", { name: "Network" })).toHaveTextContent(
      "Disabled",
    );
    expect(
      screen.getByRole("combobox", { name: "Approval policy" }),
    ).toHaveTextContent("On request");
    expect(
      screen.getByRole("combobox", { name: "Approval reviewer" }),
    ).toHaveTextContent("User");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/current:|next turn|warning/i),
    ).not.toBeInTheDocument();
  });

  it("forces Network to Enabled for Unrestricted and disables only that dependency", () => {
    renderFeature(
      snapshot({
        desired: {
          ...defaultDesired,
          sandboxMode: "danger-full-access",
          networkAccess: "disabled",
        },
      }),
    );

    expect(screen.getByRole("combobox", { name: "Network" })).toHaveTextContent(
      "Enabled",
    );
    expect(screen.getByRole("combobox", { name: "Network" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: "Sandbox" })).toBeEnabled();
    expect(
      screen.getByRole("combobox", { name: "Approval policy" }),
    ).toBeEnabled();
    expect(screen.queryByText(/Forced on/i)).not.toBeInTheDocument();
  });

  it("disables the reviewer without adding helper copy when approvals are never", () => {
    renderFeature(
      snapshot({ desired: { ...defaultDesired, approvalPolicy: "never" } }),
    );

    expect(screen.getByRole("combobox", { name: "Approval reviewer" })).toBeDisabled();
    expect(screen.queryByText(/Not used while/i)).not.toBeInTheDocument();
  });

  it("keeps desired values in the selects without effective-state helper copy", () => {
    renderFeature(
      snapshot({
        desired: { ...defaultDesired, sandboxMode: "workspace-write" },
        effective: { ...defaultDesired, sandboxMode: "read-only" },
      }),
    );

    expect(screen.getByRole("combobox", { name: "Sandbox" })).toHaveTextContent(
      "Workspace",
    );
    expect(screen.queryByText(/Current:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/next turn/i)).not.toBeInTheDocument();
  });

  it("disables the reviewer only when the approval policy is Never", () => {
    const { rerender } = renderFeature(
      snapshot({ desired: { ...defaultDesired, approvalPolicy: "never" } }),
    );

    expect(
      screen.getByRole("combobox", { name: "Approval reviewer" }),
    ).toBeDisabled();

    rerender(featureElement(snapshot()));
    expect(
      screen.getByRole("combobox", { name: "Approval reviewer" }),
    ).toBeEnabled();
  });

  it("performs the selected operation against the exact feature revision", async () => {
    const user = userEvent.setup();
    const perform = vi.fn().mockResolvedValue(undefined);
    renderFeature(snapshot(), perform);

    await user.click(screen.getByRole("combobox", { name: "Network" }));
    await user.click(screen.getByRole("option", { name: "Enabled" }));

    expect(perform).toHaveBeenCalledWith({
      action: "perform_provider_feature",
      feature: ref,
      actionId: "set_network_enabled",
      arguments: null,
      expectedFeatureRevision: 7,
    });
  });

  it("remains mutable while a turn is active when the feature is available", () => {
    renderFeature(snapshot({ runState: "active" }));

    for (const select of screen.getAllByRole("combobox")) {
      expect(select).toBeEnabled();
    }
  });

  it("preserves true capability and pending-operation disabling", () => {
    const { rerender } = renderFeature(snapshot(), vi.fn(), true);
    for (const select of screen.getAllByRole("combobox")) {
      expect(select).toBeDisabled();
    }

    rerender(
      featureElement(
        snapshot({
          featureCapability: {
            ...capability,
            availability: "unavailable",
            unavailableReason: { text: "Connection unavailable" },
          },
        }),
      ),
    );
    for (const select of screen.getAllByRole("combobox")) {
      expect(select).toBeDisabled();
    }
    expect(
      screen.queryByText("Connection unavailable"),
    ).not.toBeInTheDocument();
  });

  it("renders no explanatory text when native execution state is absent", () => {
    const absent = snapshot() as unknown as {
      providerFeatures: Array<Record<string, unknown>>;
    };
    absent.providerFeatures = [];

    renderFeature(absent as unknown as NormalizedThreadSnapshot);

    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.queryByText(/Codex execution/i)).not.toBeInTheDocument();
  });

  it("degrades an unknown feature version without exposing raw state", () => {
    const unknown = snapshot() as unknown as {
      capabilities: { providerFeatures: Array<Record<string, unknown>> };
      providerFeatures: Array<Record<string, unknown>>;
    };
    unknown.capabilities.providerFeatures[0] = {
      ...capability,
      ref: { featureId: "codex.execution", schemaVersion: 2 },
    };
    unknown.providerFeatures[0] = {
      ref: { featureId: "codex.execution", schemaVersion: 2 },
      revision: 1,
      state: { secretProviderField: "must-not-render" },
    };

    renderFeature(unknown as unknown as NormalizedThreadSnapshot);

    expect(
      screen.getByText(/unavailable in this client version/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/must-not-render/)).not.toBeInTheDocument();
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

function tupleValue(value: Tuple | null): BoundedValue {
  return value === null
    ? null
    : objectValue({
        sandboxMode: textValue(value.sandboxMode),
        networkAccess: textValue(value.networkAccess),
        approvalPolicy: textValue(value.approvalPolicy),
        approvalReviewer: textValue(value.approvalReviewer),
      });
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
