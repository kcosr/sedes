// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BoundedValue,
  NormalizedThreadSnapshot,
} from "../../shared/index.js";
import type { ThreadClientStore } from "../stores/ThreadClientStore.js";
import { ProviderFeatureComposerActions } from "./registry.js";

const ref = { featureId: "codex.fast_mode", schemaVersion: 2 } as const;

type Speed = "standard" | "fast" | "ultrafast";
type OfferedInput = {
  readonly selection: Exclude<Speed, "standard">;
  readonly description?: string;
};

const ACTIONS: Readonly<Record<Speed, string>> = {
  standard: "set_standard",
  fast: "set_fast",
  ultrafast: "set_ultrafast",
};

const FAST_DESCRIPTION = "Faster responses with higher plan usage.";
const ULTRAFAST_DESCRIPTION =
  "The fastest available responses for latency-sensitive work.";
const FEATURE_DESCRIPTION =
  "Faster speeds respond sooner and use more of your plan's usage";

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

function offeredValue(offered: readonly OfferedInput[]): BoundedValue {
  return {
    kind: "array",
    values: offered.map(({ selection, description }) =>
      objectValue({
        selection: { text: selection },
        ...(description === undefined
          ? {}
          : { description: { text: description } }),
      }),
    ),
  };
}

function speedState(input: {
  readonly desired: Speed | null;
  readonly effective: Speed | null;
  readonly applicationState: "applied" | "pending" | "unknown";
  readonly offered: BoundedValue;
}): BoundedValue {
  return objectValue({
    desired: input.desired === null ? null : { text: input.desired },
    effective: input.effective === null ? null : { text: input.effective },
    applicationState: { text: input.applicationState },
    offered: input.offered,
  });
}

/**
 * Mirrors the server projection: when available, every offered speed other
 * than the desired one (Standard is always offered); none when read-only.
 */
function snapshot(input: {
  readonly desired: Speed | null;
  readonly effective: Speed | null;
  readonly applicationState: "applied" | "pending" | "unknown";
  readonly offered?: readonly OfferedInput[];
  readonly availability?: "available" | "read_only" | "unavailable";
  readonly operations?: readonly Speed[];
  readonly description?: string | null;
  readonly revision?: number;
}): NormalizedThreadSnapshot {
  const availability = input.availability ?? "available";
  const offered = input.offered ?? [{ selection: "fast" }];
  const revision = input.revision ?? 7;
  const operations =
    input.operations ??
    (availability === "available"
      ? (["standard", ...offered.map(({ selection }) => selection)] as const)
          .filter((selection) => selection !== input.desired)
      : []);
  const description =
    input.description === undefined ? FEATURE_DESCRIPTION : input.description;
  return {
    capabilities: {
      providerFeatures: [
        {
          ref,
          revision,
          label: { text: "Speed" },
          ...(description === null ? {} : { description: { text: description } }),
          availability,
          ...(availability === "available"
            ? {}
            : {
                unavailableReason: { text: "Wait for the thread to settle." },
              }),
          operations: operations.map((selection) => ({
            actionId: ACTIONS[selection],
            label: { text: `Use ${selection} speed` },
            effects: {
              application: "write",
              modelUsage: "none",
              external: "none",
            },
            confirmation: "none",
            execution: "inline",
          })),
          presentationSlots: ["composer_action"],
        },
      ],
    },
    providerFeatures: [
      {
        ref,
        revision,
        state: speedState({
          desired: input.desired,
          effective: input.effective,
          applicationState: input.applicationState,
          offered: offeredValue(offered),
        }),
      },
    ],
  } as unknown as NormalizedThreadSnapshot;
}

function withState(
  value: NormalizedThreadSnapshot,
  envelope: Record<string, unknown>,
): NormalizedThreadSnapshot {
  const mutable = value as unknown as {
    providerFeatures: Array<Record<string, unknown>>;
  };
  Object.assign(mutable.providerFeatures[0]!, envelope);
  return value;
}

function renderSpeed(
  value: NormalizedThreadSnapshot,
  perform = vi.fn().mockResolvedValue({
    status: "accepted",
    operationId: "operation-speed",
  }),
  mobile = false,
) {
  render(
    <ProviderFeatureComposerActions
      store={{ perform } as unknown as ThreadClientStore}
      snapshot={value}
      disabled={false}
      mobile={mobile}
    />,
  );
  return perform;
}

const BOTH_TIERS: readonly OfferedInput[] = [
  { selection: "fast", description: FAST_DESCRIPTION },
  { selection: "ultrafast", description: ULTRAFAST_DESCRIPTION },
];

function speedIcon(element: HTMLElement): Element | null {
  return element.querySelector("svg[data-speed-icon]");
}

/** Radix names the floating menu by its trigger, e.g. "Speed, Fast". */
async function openSpeedMenu(trigger: HTMLElement): Promise<HTMLElement> {
  await userEvent.click(trigger);
  return await screen.findByRole("menu", {
    name: trigger.getAttribute("aria-label")!,
  });
}

function speedRows(menu: HTMLElement): HTMLElement[] {
  return within(
    within(menu).getByRole("group", { name: "Speed" }),
  ).getAllByRole("menuitemradio");
}

function rowNamed(menu: HTMLElement, label: string): HTMLElement {
  return within(menu).getByRole("menuitemradio", {
    name: new RegExp(`^${label}\\b`),
  });
}

describe("codex.fast_mode@2 client feature: one offered speed", () => {
  it("renders Standard as an accessible outline toggle and selects Fast", async () => {
    const perform = renderSpeed(
      snapshot({
        desired: "standard",
        effective: "standard",
        applicationState: "applied",
      }),
    );

    const toggle = screen.getByRole("button", { name: "Fast speed, off" });
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveAttribute("aria-disabled", "false");
    expect(toggle).toHaveAttribute("data-accelerated", "false");
    expect(toggle).not.toHaveAttribute("aria-haspopup");
    expect(speedIcon(toggle)).toHaveAttribute("data-speed-icon", "fast");
    expect(speedIcon(toggle)).toHaveAttribute("fill", "none");

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(perform).toHaveBeenCalledWith({
        action: "perform_provider_feature",
        feature: ref,
        actionId: "set_fast",
        arguments: null,
        expectedFeatureRevision: 7,
      }),
    );
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("renders Fast as a filled pressed toggle and returns to Standard", async () => {
    const perform = renderSpeed(
      snapshot({
        desired: "fast",
        effective: "fast",
        applicationState: "applied",
        revision: 11,
      }),
    );
    const toggle = screen.getByRole("button", { name: "Fast speed, on" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveAttribute("data-accelerated", "true");
    expect(speedIcon(toggle)).toHaveAttribute("data-speed-icon", "fast");
    expect(speedIcon(toggle)).toHaveAttribute("fill", "currentColor");

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(perform).toHaveBeenCalledWith({
        action: "perform_provider_feature",
        feature: ref,
        actionId: "set_standard",
        arguments: null,
        expectedFeatureRevision: 11,
      }),
    );
  });

  it("toggles an Ultrafast-only model with the rocket and set_ultrafast", async () => {
    const offered = [
      { selection: "ultrafast", description: ULTRAFAST_DESCRIPTION },
    ] as const;
    const perform = renderSpeed(
      snapshot({
        desired: "standard",
        effective: "standard",
        applicationState: "applied",
        offered,
      }),
    );
    const off = screen.getByRole("button", { name: "Ultrafast speed, off" });
    expect(off).toHaveAttribute("aria-pressed", "false");
    expect(off).toHaveAttribute("data-accelerated", "false");
    expect(speedIcon(off)).toHaveAttribute("data-speed-icon", "ultrafast");

    fireEvent.click(off);
    await waitFor(() =>
      expect(perform).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: "set_ultrafast",
          expectedFeatureRevision: 7,
        }),
      ),
    );

    cleanup();
    const disable = renderSpeed(
      snapshot({
        desired: "ultrafast",
        effective: "ultrafast",
        applicationState: "applied",
        offered,
      }),
    );
    const on = screen.getByRole("button", { name: "Ultrafast speed, on" });
    expect(on).toHaveAttribute("aria-pressed", "true");
    expect(on).toHaveAttribute("data-accelerated", "true");
    expect(speedIcon(on)).toHaveAttribute("data-speed-icon", "ultrafast");
    fireEvent.click(on);
    await waitFor(() =>
      expect(disable).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: "set_standard" }),
      ),
    );
  });

  it("names the selected speed when the catalog no longer offers it", async () => {
    const perform = renderSpeed(
      snapshot({
        desired: "ultrafast",
        effective: "ultrafast",
        applicationState: "applied",
        offered: [{ selection: "fast" }],
      }),
    );
    const toggle = screen.getByRole("button", { name: "Ultrafast speed, on" });
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(speedIcon(toggle)).toHaveAttribute("data-speed-icon", "ultrafast");

    fireEvent.click(toggle);
    await waitFor(() =>
      expect(perform).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: "set_standard" }),
      ),
    );
  });

  it("exposes pending and unknown application state without changing the desired selection", () => {
    renderSpeed(
      snapshot({
        desired: "fast",
        effective: "standard",
        applicationState: "pending",
      }),
    );
    const pending = screen.getByRole("button", {
      name: "Fast speed, on, pending",
    });
    expect(pending).toHaveAttribute("aria-pressed", "true");
    expect(pending).toHaveAttribute("data-application-state", "pending");

    cleanup();
    renderSpeed(
      snapshot({
        desired: "standard",
        effective: null,
        applicationState: "unknown",
      }),
    );
    const unknown = screen.getByRole("button", {
      name: "Fast speed, off, application unknown",
    });
    expect(unknown).toHaveAttribute("aria-pressed", "false");
    expect(unknown).toHaveAttribute("data-application-state", "unknown");
  });

  it("labels the toggle pending while its own request is in flight", async () => {
    let resolve!: (value: unknown) => void;
    const perform = vi.fn(
      () => new Promise((settle) => (resolve = settle)),
    );
    renderSpeed(
      snapshot({
        desired: "standard",
        effective: "standard",
        applicationState: "applied",
      }),
      perform,
    );
    fireEvent.click(screen.getByRole("button", { name: "Fast speed, off" }));
    const busy = await screen.findByRole("button", {
      name: "Fast speed, off, pending",
    });
    expect(busy).toHaveAttribute("aria-busy", "true");
    expect(busy).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(busy);
    expect(perform).toHaveBeenCalledTimes(1);

    resolve({ status: "accepted", operationId: "operation-speed" });
    expect(
      await screen.findByRole("button", { name: "Fast speed, off" }),
    ).not.toHaveAttribute("aria-busy");
  });

  it("keeps unavailable and unresolved controls inert with an exact accessible state", async () => {
    const perform = renderSpeed(
      snapshot({
        desired: "standard",
        effective: "standard",
        applicationState: "applied",
        availability: "read_only",
      }),
    );
    const readOnly = screen.getByRole("button", { name: "Fast speed, off" });
    expect(readOnly).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(readOnly);
    expect(perform).not.toHaveBeenCalled();
    fireEvent.focus(readOnly);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Wait for the thread to settle.",
    );

    cleanup();
    const missingOperation = renderSpeed(
      snapshot({
        desired: "standard",
        effective: "standard",
        applicationState: "applied",
        operations: [],
      }),
    );
    const noOperation = screen.getByRole("button", { name: "Fast speed, off" });
    expect(noOperation).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(noOperation);
    expect(missingOperation).not.toHaveBeenCalled();

    cleanup();
    renderSpeed(
      snapshot({
        desired: null,
        effective: null,
        applicationState: "unknown",
      }),
    );
    expect(
      screen.getByRole("button", { name: "Speed, unavailable" }),
    ).toHaveAttribute("aria-disabled", "true");
  });

  it("uses only a passive hover/focus tooltip for usage information", async () => {
    renderSpeed(
      snapshot({
        desired: "standard",
        effective: "standard",
        applicationState: "applied",
      }),
    );
    expect(screen.queryByRole("tooltip")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    fireEvent.focus(screen.getByRole("button", { name: "Fast speed, off" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      FEATURE_DESCRIPTION,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("prefers the catalog's tier description in the tooltip", async () => {
    renderSpeed(
      snapshot({
        desired: "standard",
        effective: "standard",
        applicationState: "applied",
        offered: [{ selection: "fast", description: FAST_DESCRIPTION }],
      }),
    );
    fireEvent.focus(screen.getByRole("button", { name: "Fast speed, off" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      `Fast: ${FAST_DESCRIPTION}`,
    );

    cleanup();
    renderSpeed(
      snapshot({
        desired: "standard",
        effective: "standard",
        applicationState: "applied",
        description: null,
      }),
    );
    fireEvent.focus(screen.getByRole("button", { name: "Fast speed, off" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent(/^Fast$/);
  });
});

describe("codex.fast_mode@2 client feature: several offered speeds", () => {
  it("renders a Speed menu trigger instead of a toggle", async () => {
    renderSpeed(
      snapshot({
        desired: "standard",
        effective: "standard",
        applicationState: "applied",
        offered: BOTH_TIERS,
      }),
    );
    const trigger = screen.getByRole("button", { name: "Speed, Standard" });
    expect(trigger).not.toHaveAttribute("aria-pressed");
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveAttribute("aria-disabled", "false");
    expect(trigger).toHaveAttribute("data-accelerated", "false");
    expect(speedIcon(trigger)).toHaveAttribute("data-speed-icon", "standard");
    expect(speedIcon(trigger)).toHaveAttribute("fill", "none");

    fireEvent.focus(trigger);
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      FEATURE_DESCRIPTION,
    );
  });

  it("lists Standard, Fast and Ultrafast with the checked desired speed", async () => {
    renderSpeed(
      snapshot({
        desired: "fast",
        effective: "fast",
        applicationState: "applied",
        offered: BOTH_TIERS,
      }),
    );
    const trigger = screen.getByRole("button", { name: "Speed, Fast" });
    expect(trigger).toHaveAttribute("data-accelerated", "true");
    expect(speedIcon(trigger)).toHaveAttribute("data-speed-icon", "fast");
    expect(speedIcon(trigger)).toHaveAttribute("fill", "currentColor");

    const menu = await openSpeedMenu(trigger);
    const rows = speedRows(menu);
    expect(
      rows.map((row) => row.querySelector("svg")?.getAttribute("data-speed-icon")),
    ).toEqual(["standard", "fast", "ultrafast"]);
    expect(rows.map((row) => row.getAttribute("aria-checked"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    expect(rows[0]).toHaveTextContent(/^Standard$/);
    expect(rows[1]).toHaveTextContent(`Fast ${FAST_DESCRIPTION}`);
    expect(rows[2]).toHaveTextContent(`Ultrafast ${ULTRAFAST_DESCRIPTION}`);
    expect(
      rows[2]!.querySelector('[data-slot="dropdown-menu-item-description"]'),
    ).toHaveTextContent(ULTRAFAST_DESCRIPTION);
    for (const row of rows) expect(row).not.toHaveAttribute("data-disabled");
  });

  it("selecting Ultrafast performs set_ultrafast at the observed revision", async () => {
    const perform = renderSpeed(
      snapshot({
        desired: "standard",
        effective: "standard",
        applicationState: "applied",
        offered: BOTH_TIERS,
        revision: 12,
      }),
    );
    const menu = await openSpeedMenu(
      screen.getByRole("button", { name: "Speed, Standard" }),
    );
    await userEvent.click(rowNamed(menu, "Ultrafast"));
    await waitFor(() =>
      expect(perform).toHaveBeenCalledWith({
        action: "perform_provider_feature",
        feature: ref,
        actionId: "set_ultrafast",
        arguments: null,
        expectedFeatureRevision: 12,
      }),
    );
    expect(perform).toHaveBeenCalledTimes(1);
    // The menu stays closed once the request settles.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Speed, Standard" }),
      ).not.toHaveAttribute("aria-busy"),
    );
    expect(screen.queryByRole("menu")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Speed, Standard" }),
    ).toHaveAttribute("aria-expanded", "false");
  });

  it("re-selecting the current speed performs nothing", async () => {
    const perform = renderSpeed(
      snapshot({
        desired: "fast",
        effective: "fast",
        applicationState: "applied",
        offered: BOTH_TIERS,
      }),
    );
    const menu = await openSpeedMenu(
      screen.getByRole("button", { name: "Speed, Fast" }),
    );
    await userEvent.click(rowNamed(menu, "Fast"));
    expect(perform).not.toHaveBeenCalled();

    const reopened = await openSpeedMenu(
      screen.getByRole("button", { name: "Speed, Fast" }),
    );
    await userEvent.click(rowNamed(reopened, "Standard"));
    await waitFor(() =>
      expect(perform).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: "set_standard" }),
      ),
    );
  });

  it("disables rows whose operation the capability does not offer", async () => {
    const perform = renderSpeed(
      snapshot({
        desired: "standard",
        effective: "standard",
        applicationState: "applied",
        offered: BOTH_TIERS,
        operations: ["fast"],
      }),
    );
    const menu = await openSpeedMenu(
      screen.getByRole("button", { name: "Speed, Standard" }),
    );
    // The current row stays enabled; Ultrafast lacks its operation.
    expect(rowNamed(menu, "Standard")).not.toHaveAttribute("data-disabled");
    expect(rowNamed(menu, "Fast")).not.toHaveAttribute("data-disabled");
    const ultrafast = rowNamed(menu, "Ultrafast");
    expect(ultrafast).toHaveAttribute("data-disabled");
    expect(ultrafast).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(ultrafast);
    expect(perform).not.toHaveBeenCalled();
  });

  it("shows the rocket and Ultrafast state on the trigger", () => {
    renderSpeed(
      snapshot({
        desired: "ultrafast",
        effective: "fast",
        applicationState: "pending",
        offered: BOTH_TIERS,
      }),
    );
    const trigger = screen.getByRole("button", {
      name: "Speed, Ultrafast, pending",
    });
    expect(trigger).toHaveAttribute("data-accelerated", "true");
    expect(trigger).toHaveAttribute("data-application-state", "pending");
    expect(speedIcon(trigger)).toHaveAttribute("data-speed-icon", "ultrafast");

    cleanup();
    renderSpeed(
      snapshot({
        desired: "ultrafast",
        effective: null,
        applicationState: "unknown",
        offered: BOTH_TIERS,
      }),
    );
    expect(
      screen.getByRole("button", {
        name: "Speed, Ultrafast, application unknown",
      }),
    ).toHaveAttribute("data-application-state", "unknown");
  });

  it("keeps a read-only or unresolved trigger closed", async () => {
    const perform = renderSpeed(
      snapshot({
        desired: "fast",
        effective: "fast",
        applicationState: "applied",
        offered: BOTH_TIERS,
        availability: "read_only",
      }),
    );
    const readOnly = screen.getByRole("button", { name: "Speed, Fast" });
    expect(readOnly).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(readOnly);
    fireEvent.keyDown(readOnly, { key: "Enter" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(perform).not.toHaveBeenCalled();
    expect(await screen.findByRole("tooltip")).toHaveTextContent(
      "Wait for the thread to settle.",
    );

    cleanup();
    renderSpeed(
      snapshot({
        desired: null,
        effective: null,
        applicationState: "unknown",
        offered: BOTH_TIERS,
      }),
    );
    const unresolved = screen.getByRole("button", {
      name: "Speed, unavailable",
    });
    expect(unresolved).toHaveAttribute("aria-disabled", "true");
    await userEvent.click(unresolved);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("opens the same choices as a sheet on mobile", async () => {
    const perform = renderSpeed(
      snapshot({
        desired: "standard",
        effective: "standard",
        applicationState: "applied",
        offered: BOTH_TIERS,
      }),
      undefined,
      true,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Speed, Standard" }),
    );
    const sheet = await screen.findByRole("dialog", { name: "Speed" });
    expect(sheet).toHaveAttribute("data-menu-sheet");
    const menu = within(sheet).getByRole("menu", { name: "Speed" });
    expect(
      speedRows(menu).map((row) => row.getAttribute("aria-checked")),
    ).toEqual(["true", "false", "false"]);
    await userEvent.click(rowNamed(menu, "Ultrafast"));
    await waitFor(() =>
      expect(perform).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: "set_ultrafast" }),
      ),
    );
  });
});

describe("codex.fast_mode@2 client feature: decoding", () => {
  const valid = () =>
    snapshot({
      desired: "standard",
      effective: "standard",
      applicationState: "applied",
      offered: BOTH_TIERS,
    });

  it("fails closed for malformed selections and unknown keys", () => {
    // The unmodified fixture renders, so each rejection below is the decoder's.
    renderSpeed(valid());
    expect(
      screen.getByRole("button", { name: "Speed, Standard" }),
    ).toBeInTheDocument();

    cleanup();
    renderSpeed(
      withState(valid(), {
        state: speedState({
          desired: "priority" as Speed,
          effective: "standard",
          applicationState: "applied",
          offered: offeredValue(BOTH_TIERS),
        }),
      }),
    );
    expect(screen.queryByRole("button")).toBeNull();

    cleanup();
    renderSpeed(
      withState(valid(), {
        state: objectValue({
          desired: { text: "standard" },
          effective: { text: "standard" },
          applicationState: { text: "applied" },
          offered: offeredValue(BOTH_TIERS),
          extra: { text: "x" },
        }),
      }),
    );
    expect(screen.queryByRole("button")).toBeNull();

    cleanup();
    renderSpeed(
      withState(valid(), {
        state: speedState({
          desired: "standard",
          effective: "standard",
          applicationState: "settled" as "applied",
          offered: offeredValue(BOTH_TIERS),
        }),
      }),
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("ignores schemaVersion 1 envelopes, including the legacy state shape", () => {
    const legacyRef = { featureId: "codex.fast_mode", schemaVersion: 1 };
    renderSpeed(
      withState(valid(), {
        ref: legacyRef,
        state: objectValue({
          desired: { text: "fast" },
          effective: { text: "fast" },
          applicationState: { text: "applied" },
        }),
      }),
    );
    expect(screen.queryByRole("button")).toBeNull();

    cleanup();
    renderSpeed(withState(valid(), { ref: legacyRef }));
    expect(screen.queryByRole("button")).toBeNull();

    cleanup();
    // The v1 state under the v2 reference is missing `offered`.
    renderSpeed(
      withState(valid(), {
        state: objectValue({
          desired: { text: "fast" },
          effective: { text: "fast" },
          applicationState: { text: "applied" },
        }),
      }),
    );
    expect(screen.queryByRole("button")).toBeNull();
  });

  it.each([
    ["empty", { kind: "array", values: [] }],
    ["not an array", { text: "fast" }],
    [
      "truncated",
      {
        kind: "array",
        values: [objectValue({ selection: { text: "fast" } })],
        truncation: {
          truncated: true,
          retainedBytes: 32,
          reason: "entry_limit",
        },
      },
    ],
    [
      "out of order",
      offeredValue([{ selection: "ultrafast" }, { selection: "fast" }]),
    ],
    ["duplicated", offeredValue([{ selection: "fast" }, { selection: "fast" }])],
    ["standard offered", offeredValue([{ selection: "standard" as "fast" }])],
    ["unknown speed", offeredValue([{ selection: "priority" as "fast" }])],
    [
      "unknown entry key",
      {
        kind: "array",
        values: [
          objectValue({ selection: { text: "fast" }, tier: { text: "x" } }),
        ],
      },
    ],
    [
      "missing selection",
      {
        kind: "array",
        values: [objectValue({ description: { text: "Fast" } })],
      },
    ],
    [
      "non-text description",
      {
        kind: "array",
        values: [objectValue({ selection: { text: "fast" }, description: 3 })],
      },
    ],
  ] as const)("fails closed when offered is %s", (_case, offered) => {
    renderSpeed(
      withState(valid(), {
        state: speedState({
          desired: "standard",
          effective: "standard",
          applicationState: "applied",
          offered: offered as BoundedValue,
        }),
      }),
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
