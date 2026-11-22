// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedThreadSnapshot } from "../../shared/index.js";
import type { ThreadClientStore } from "../stores/ThreadClientStore.js";
import { ProviderFeatureThreadDetails } from "./registry.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@client/components/ui/dropdown-menu";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  Object.assign(window.HTMLElement.prototype, { scrollIntoView: vi.fn(), hasPointerCapture: vi.fn(), setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const ref = { featureId: "antigravity.mode", schemaVersion: 1 };
function fixture(desiredMode: string | null = null, unavailable = false) {
  const perform = vi.fn().mockResolvedValue(undefined);
  const snapshot = {
    capabilities: { providerFeatures: [{ ref, revision: 9, mutationRevision: 4, label: { text: "Antigravity mode" },
      availability: unavailable ? "unavailable" : "available", ...(unavailable ? { unavailableReason: { text: "Disconnected" } } : {}),
      presentationSlots: ["thread_details"], operations: ["keep_native_mode", "set_mode_default", "set_mode_plan"].map(actionId => ({
        actionId, label: { text: actionId }, effects: { application: "write", modelUsage: "none", external: "none" }, confirmation: "none", execution: "inline",
      })) }] },
    providerFeatures: [{ ref, revision: 4, state: { kind: "object", entries: [
      { key: { text: "desiredMode" }, value: desiredMode === null ? null : { text: desiredMode } },
      { key: { text: "application" }, value: { text: "next_turn" } },
    ] } }],
  } as unknown as NormalizedThreadSnapshot;
  const show = () => render(<DropdownMenu defaultOpen><DropdownMenuTrigger>Thread actions</DropdownMenuTrigger>
    <DropdownMenuContent aria-label="Thread actions"><ProviderFeatureThreadDetails store={{ perform } as unknown as ThreadClientStore}
      snapshot={snapshot} disabled={false} mobile={false} /></DropdownMenuContent></DropdownMenu>);
  return { perform, snapshot, show };
}
async function openModes() {
  await userEvent.click(screen.getByRole("menuitem", { name: "Antigravity mode" }));
  return screen.findByRole("menu", { name: /Antigravity mode/ });
}
describe("antigravity.mode@1 client", () => {
  it("selects an advertised exact mode with the mutation revision and explains next-turn application", async () => {
    const f = fixture(); f.show(); const menu = await openModes();
    expect(within(menu).getByText(/Applies before the next turn/)).toBeVisible();
    expect(within(menu).getByRole("menuitemradio", { name: "Auto" })).toHaveAttribute("data-disabled");
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: "Plan" }));
    expect(f.perform).toHaveBeenCalledWith({ action: "perform_provider_feature", feature: ref, actionId: "set_mode_plan",
      arguments: null, expectedMutationRevision: 4 });
  });
  it("preserves an unqualified stored choice while permitting Keep native mode", async () => {
    const f = fixture("future-mode"); f.show(); const menu = await openModes();
    expect(within(menu).getByRole("menuitemradio", { name: /future-mode/ })).toHaveAttribute("data-disabled");
    await userEvent.click(within(menu).getByRole("menuitemradio", { name: "Keep native mode" }));
    expect(f.perform).toHaveBeenCalledWith(expect.objectContaining({ actionId: "keep_native_mode", arguments: null }));
  });
  it("keeps stored mode visible but disables controls when the capability is unavailable", async () => {
    const f = fixture("plan", true); f.show(); const menu = await openModes();
    expect(within(menu).getByRole("status")).toHaveTextContent("Disconnected");
    for (const item of within(menu).getAllByRole("menuitemradio")) expect(item).toHaveAttribute("data-disabled");
    expect(f.perform).not.toHaveBeenCalled();
  });
  it("rejects unknown state contracts without exposing actions", () => {
    const f = fixture();
    const state = f.snapshot.providerFeatures[0]!.state;
    if (!state || typeof state !== "object" || !("kind" in state) || state.kind !== "object") throw new Error();
    state.entries.push({ key: { text: "nativeWire" }, value: null });
    f.show(); expect(screen.queryByRole("menuitem", { name: "Antigravity mode" })).not.toBeInTheDocument();
  });
});
