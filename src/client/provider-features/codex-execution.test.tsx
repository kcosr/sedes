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
import type { MenuPresentation } from "@client/components/ui/menu-sheet";

// jsdom lacks the pointer-capture and scroll APIs the Radix menu
// primitives rely on.
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

async function openExecution(): Promise<HTMLElement> {
  await userEvent.click(
    screen.getByRole("menuitem", { name: "Codex execution" }),
  );
  return await screen.findByRole("menu", { name: "Codex execution" });
}

function checkedIn(menu: HTMLElement, group: string): string | undefined {
  return within(within(menu).getByRole("group", { name: group }))
    .getAllByRole("menuitemradio")
    .find((row) => row.getAttribute("aria-checked") === "true")
    ?.textContent ?? undefined;
}

function radiosIn(menu: HTMLElement, group: string): HTMLElement[] {
  return within(within(menu).getByRole("group", { name: group })).getAllByRole(
    "menuitemradio",
  );
}

describe("codex.execution@1 client feature", () => {
  it("renders the four desired next-turn values as radio groups in a submenu", async () => {
    renderFeature(snapshot());

    const trigger = screen.getByRole("menuitem", { name: "Codex execution" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    const menu = await openExecution();
    expect(within(menu).getAllByRole("group")).toHaveLength(4);
    expect(checkedIn(menu, "Sandbox")).toBe("Workspace");
    expect(checkedIn(menu, "Network")).toBe("Disabled");
    expect(checkedIn(menu, "Approval policy")).toBe("On request");
    expect(checkedIn(menu, "Approval reviewer")).toBe("User");
    expect(within(menu).queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(
      screen.queryByText(/current:|next turn|warning/i),
    ).not.toBeInTheDocument();
  });

  it("forces Network to Enabled for Unrestricted and disables only that dependency", async () => {
    renderFeature(
      snapshot({
        desired: {
          ...defaultDesired,
          sandboxMode: "danger-full-access",
          networkAccess: "disabled",
        },
      }),
    );

    const menu = await openExecution();
    expect(checkedIn(menu, "Network")).toBe("Enabled");
    for (const row of radiosIn(menu, "Network")) {
      expect(row).toHaveAttribute("data-disabled");
    }
    expect(
      within(menu).getByText("Always enabled with an unrestricted sandbox"),
    ).toBeVisible();
    for (const row of radiosIn(menu, "Sandbox")) {
      expect(row).not.toHaveAttribute("data-disabled");
    }
    for (const row of radiosIn(menu, "Approval policy")) {
      expect(row).not.toHaveAttribute("data-disabled");
    }
  });

  it("disables the reviewer with its reason when approvals are never", async () => {
    renderFeature(
      snapshot({ desired: { ...defaultDesired, approvalPolicy: "never" } }),
    );

    const menu = await openExecution();
    for (const row of radiosIn(menu, "Approval reviewer")) {
      expect(row).toHaveAttribute("data-disabled");
    }
    expect(
      within(menu).getByText("Not used when approval is never requested"),
    ).toBeVisible();
  });

  it("checks the desired values without effective-state helper copy", async () => {
    renderFeature(
      snapshot({
        desired: { ...defaultDesired, sandboxMode: "workspace-write" },
        effective: { ...defaultDesired, sandboxMode: "read-only" },
      }),
    );

    const menu = await openExecution();
    expect(checkedIn(menu, "Sandbox")).toBe("Workspace");
    expect(screen.queryByText(/Current:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/next turn/i)).not.toBeInTheDocument();
  });

  it("enables the reviewer again once the approval policy is not Never", async () => {
    const { rerender } = renderFeature(
      snapshot({ desired: { ...defaultDesired, approvalPolicy: "never" } }),
    );

    let menu = await openExecution();
    expect(radiosIn(menu, "Approval reviewer")[0]).toHaveAttribute(
      "data-disabled",
    );

    rerender(featureElement(snapshot()));
    menu = screen.getByRole("menu", { name: "Codex execution" });
    for (const row of radiosIn(menu, "Approval reviewer")) {
      expect(row).not.toHaveAttribute("data-disabled");
    }
  });

  it("performs the selected operation against the exact feature revision", async () => {
    const perform = vi.fn().mockResolvedValue(undefined);
    renderFeature(snapshot(), perform);

    const menu = await openExecution();
    await userEvent.click(
      within(within(menu).getByRole("group", { name: "Network" })).getByRole(
        "menuitemradio",
        { name: "Enabled" },
      ),
    );

    expect(perform).toHaveBeenCalledWith({
      action: "perform_provider_feature",
      feature: ref,
      actionId: "set_network_enabled",
      arguments: null,
      expectedFeatureRevision: 7,
    });
  });

  it("remains mutable while a turn is active when the feature is available", async () => {
    renderFeature(snapshot({ runState: "active" }));

    const menu = await openExecution();
    for (const row of within(menu).getAllByRole("menuitemradio")) {
      if (row.closest('[role="group"]')?.getAttribute("aria-label") === "Network") continue;
      expect(row).not.toHaveAttribute("data-disabled");
    }
  });

  it("preserves true capability and pending-operation disabling", () => {
    const { rerender } = renderFeature(snapshot(), vi.fn(), true);
    const trigger = screen.getByRole("menuitem", { name: "Codex execution" });
    expect(trigger).toHaveAttribute("data-disabled");
    expect(trigger).toHaveTextContent("Unavailable");

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
    expect(
      screen.getByRole("menuitem", { name: "Codex execution" }),
    ).toHaveAttribute("data-disabled");
    expect(
      screen.queryByText("Connection unavailable"),
    ).not.toBeInTheDocument();
  });

  it("drills into the same choices on the touch sheet", async () => {
    const perform = vi.fn().mockResolvedValue(undefined);
    render(featureElement(snapshot(), perform, false, "sheet"));

    await userEvent.click(
      screen.getByRole("menuitem", { name: "Codex execution" }),
    );
    const pane = await screen.findByRole("group", { name: "Codex execution" });
    expect(
      within(pane).getByRole("menuitemradio", { name: "Workspace" }),
    ).toHaveAttribute("aria-checked", "true");
    await userEvent.click(
      within(pane).getByRole("menuitemradio", { name: "Read only" }),
    );
    expect(perform).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: "set_sandbox_read_only" }),
    );
  });

  it("renders no explanatory text when native execution state is absent", () => {
    const absent = snapshot() as unknown as {
      providerFeatures: Array<Record<string, unknown>>;
    };
    absent.providerFeatures = [];

    renderFeature(absent as unknown as NormalizedThreadSnapshot);

    expect(screen.queryByRole("menuitem")).not.toBeInTheDocument();
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

    const row = screen.getByRole("menuitem", { name: /Codex execution/ });
    expect(row).toHaveAttribute("data-disabled");
    expect(row).toHaveTextContent("Needs a client update");
    expect(screen.queryByText(/must-not-render/)).not.toBeInTheDocument();
  });
});

function featureElement(
  value: NormalizedThreadSnapshot,
  perform = vi.fn().mockResolvedValue(undefined),
  disabled = false,
  presentation: MenuPresentation = "menu",
): React.JSX.Element {
  return (
    <DropdownMenu presentation={presentation} defaultOpen>
      <DropdownMenuTrigger>Thread actions</DropdownMenuTrigger>
      <DropdownMenuContent aria-label="Thread actions">
        <ProviderFeatureThreadDetails
          store={{ perform } as unknown as ThreadClientStore}
          snapshot={value}
          disabled={disabled}
          mobile={presentation === "sheet"}
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
