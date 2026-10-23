// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedThreadSnapshot, ProviderFeatureCapability } from "../../shared/index.js";
import { CODEX_SPEED_REF as ref, speedArgumentsWireSchema, type SpeedState, type SpeedResult } from "../../shared/provider-features/codex-speed.js";
import { boundValue } from "../../server/conversations/payload-policy.js";
import type { ThreadClientStore } from "../stores/ThreadClientStore.js";
import { codexFastModeClientFeature } from "./codex-fast-mode.js";
import { ApiError } from "../api/ApiClient.js";

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} unobserve() {} });
  Object.assign(window.HTMLElement.prototype, { scrollIntoView: vi.fn(), hasPointerCapture: vi.fn(), setPointerCapture: vi.fn(), releasePointerCapture: vi.fn() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const target = { turnId: "app-turn", activationId: "activation" };
const initial: SpeedState = { saved: { selection: "standard", desiredRevision: 7 }, offered: [{ selection: "standard" }, { selection: "fast" }], currentRun: null, lastChange: null };
function result(currentRun: SpeedResult["currentRun"], receiptRevision = 3): SpeedResult {
  return { operationId: "op", receiptRevision, saved: { status: "saved", selection: "fast", desiredRevision: 8 }, currentRun };
}
function receipt(value: SpeedResult) { return { status: "provider_feature_result", operationId: value.operationId, feature: ref, result: boundValue(value) }; }
function fixture(state = initial, availability: ProviderFeatureCapability["availability"] = "available", mobile = false) {
  const create = vi.fn((_operation: unknown) => "op");
  const read = vi.fn(async () => receipt(result({ status: "not_requested" })));
  const discard = vi.fn();
  const store = { createProviderFeatureAttempt: create, readProviderFeatureAttempt: read, discardProviderFeatureAttempt: discard } as unknown as ThreadClientStore;
  const capability: ProviderFeatureCapability = { ref, revision: 40, mutationRevision: 7, label: { text: "Speed" }, availability,
    operations: [{ actionId: "set_speed", label: { text: "Set Speed" }, effects: { application: "write", modelUsage: "none", external: "durable_side_effect" }, confirmation: "none", execution: "inline" }], presentationSlots: ["composer_action"] };
  const element = (next = state) => codexFastModeClientFeature.renderComposerAction!({ store, capability, featureState: { ref, revision: 40, state: boundValue(next) }, snapshot: {} as NormalizedThreadSnapshot, disabled: false, mobile });
  const view = render(element());
  return { create, read, discard, view, element, capability };
}
describe("Codex Speed composer", () => {
  it("saves from the one-speed toggle using mutation revision and an explicit null target", async () => {
    const f = fixture(); fireEvent.click(screen.getByRole("button", { name: "Speed, Standard saved" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Speed, Standard saved" })).toHaveAttribute("aria-disabled", "false"));
    const operation = f.create.mock.calls[0]![0] as unknown as { actionId: string; expectedMutationRevision: number; arguments: never };
    expect(operation).toMatchObject({ actionId: "set_speed", expectedMutationRevision: 7 });
    expect(speedArgumentsWireSchema.parse(operation.arguments)).toEqual({ selection: "fast", currentRunTarget: null });
    expect(f.read).toHaveBeenCalledWith("op");
  });
  it.each([false, true])("offers all speeds and retains the exact active target (mobile=%s)", async mobile => {
    const f = fixture({ ...initial, offered: [...initial.offered, { selection: "ultrafast" }], currentRun: { target, startingSelection: "standard", requestedSelection: "standard", publicationState: "initial" } }, "available", mobile);
    await userEvent.click(screen.getByRole("button", { name: "Speed, Standard saved" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /Ultrafast/ }));
    await waitFor(() => expect(f.create).toHaveBeenCalled());
    const operation = f.create.mock.calls[0]![0] as unknown as { arguments: never };
    expect(speedArgumentsWireSchema.parse(operation.arguments)).toEqual({ selection: "ultrafast", currentRunTarget: target });
  });
  it("offers same-value reapplication when the frozen start used a different choice", async () => {
    const f = fixture({ ...initial, saved: { selection: "fast", desiredRevision: 7 }, currentRun: { target, startingSelection: "standard", requestedSelection: "standard", publicationState: "initial" } });
    await userEvent.click(screen.getByRole("button", { name: "Speed, Fast saved" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /^Fast/ }));
    expect(f.create).toHaveBeenCalledOnce();
  });
  it.each([
    new Error("Connection lost"),
    new ApiError(503, "unavailable", "Reply unavailable", true),
  ])("quietly recovers a lost reply with the original operation: %s", async error => {
    const f = fixture(); f.read.mockRejectedValueOnce(error);
    fireEvent.click(screen.getByRole("button", { name: "Speed, Standard saved" }));
    await waitFor(() => expect(f.read).toHaveBeenCalledTimes(2), { timeout: 2500 });
    expect(f.create).toHaveBeenCalledOnce(); expect(f.read.mock.calls).toEqual([["op"], ["op"]]);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check Speed result" })).toBeNull();
  });
  it("discards a definitively rejected envelope without retrying or changing the selection", async () => {
    const f = fixture(); f.read.mockRejectedValueOnce(new ApiError(409, "conflict", "The turn changed before Speed could be saved.", false));
    fireEvent.click(screen.getByRole("button", { name: "Speed, Standard saved" }));
    await waitFor(() => expect(f.discard).toHaveBeenCalledWith("op"));
    expect(f.read).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Speed, Standard saved" })).toHaveAttribute("aria-pressed", "false");
  });
  it("bounds background recovery and leaves the control usable", async () => {
    const f = fixture(); f.read.mockRejectedValue(new Error("Connection lost"));
    fireEvent.click(screen.getByRole("button", { name: "Speed, Standard saved" }));
    await waitFor(() => expect(f.read).toHaveBeenCalledTimes(4), { timeout: 4500 });
    expect(f.create).toHaveBeenCalledOnce(); expect(f.discard).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Speed, Standard saved" })).toHaveAttribute("aria-disabled", "false");
  });
  it("polls a pending receipt but stops at a known uncertain result", async () => {
    const f = fixture();
    f.read.mockResolvedValueOnce(receipt(result({ status: "pending", target, selection: "fast" }, 1)))
      .mockResolvedValue(receipt(result({ status: "uncertain", target, selection: "fast", reason: "response_lost" }, 2)));
    fireEvent.click(screen.getByRole("button", { name: "Speed, Standard saved" }));
    await waitFor(() => expect(f.discard).toHaveBeenCalledWith("op"), { timeout: 2500 });
    // A known outcome stops the one-second polling timer, even when uncertain.
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(f.read.mock.calls).toEqual([["op"], ["op"]]);
    expect(f.create).toHaveBeenCalledOnce();
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("stops recovering when the control unmounts", async () => {
    const f = fixture(); f.read.mockRejectedValue(new Error("Connection lost"));
    fireEvent.click(screen.getByRole("button", { name: "Speed, Standard saved" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Speed, Standard saved" })).toHaveAttribute("aria-disabled", "false"));
    f.view.unmount();
    await new Promise(resolve => setTimeout(resolve, 1100));
    expect(f.read).toHaveBeenCalledOnce();
  });
  it("shows only the saved choice for a prior turn's durable receipt", () => {
    fixture({ ...initial, saved: { selection: "fast", desiredRevision: 8 }, lastChange: result({ status: "published", target, selection: "fast" }) });
    expect(screen.getByRole("button", { name: "Speed, Fast saved" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("status")).toBeNull();
  });
  it.each(["initial", "pending", "published", "unknown"] as const)("keeps the active touch menu quiet with %s publication knowledge", async publicationState => {
    fixture({ ...initial, saved: { selection: "fast", desiredRevision: 8 }, currentRun: { target: { ...target }, startingSelection: "standard", requestedSelection: "standard", publicationState },
      lastChange: result({ status: "rejected", target, selection: "fast", reason: "provider_rejected", message: { text: "Rejected" } }) }, "available", true);
    const trigger = screen.getByRole("button", { name: "Speed, Fast saved" });
    expect(trigger).not.toHaveAttribute("data-application-state");
    await userEvent.click(trigger);
    expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
    expect(screen.getByRole("menuitemradio", { name: /^Fast/ })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /^Standard/ })).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByText("How Speed works")).toBeNull();
    expect(screen.queryByText(/Rejected/)).toBeNull();
  });
  it.each([
    { status: "published", target, selection: "fast" },
    { status: "uncertain", target, selection: "fast", reason: "response_lost" },
    { status: "target_finished", target, selection: "fast" },
    { status: "not_attempted", target, selection: "fast", reason: "ownership_changed" },
  ] as const)("uses the saved projection, without extra UI, after a $status receipt", async outcome => {
    const f = fixture({ ...initial, currentRun: { target, startingSelection: "standard", requestedSelection: "standard", publicationState: "initial" } });
    f.read.mockResolvedValue(receipt(result(outcome)));
    await userEvent.click(screen.getByRole("button", { name: "Speed, Standard saved" }));
    await userEvent.click(await screen.findByRole("menuitemradio", { name: /^Fast/ }));
    await waitFor(() => expect(f.read).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Speed, Standard saved" })).toBeVisible();
    f.view.rerender(f.element({ ...initial, saved: { selection: "fast", desiredRevision: 8 } }));
    expect(screen.getByRole("button", { name: "Speed, Fast saved" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("explains next-step application and persistence in one short tooltip", async () => {
    fixture();
    await userEvent.hover(screen.getByRole("button", { name: "Speed, Standard saved" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Applies from the next model step. Saved for future turns.");
  });
  it("keeps unknown active ownership read-only", () => {
    const f = fixture({ ...initial, currentRun: { target: null, startingSelection: null, requestedSelection: null, publicationState: "unknown" } }, "read_only");
    const button = screen.getByRole("button", { name: "Speed, Standard saved" });
    expect(button).toHaveAttribute("aria-disabled", "true"); fireEvent.click(button); expect(f.create).not.toHaveBeenCalled();
  });
  it("does not replace a newer saved projection with an older operation result", async () => {
    const f = fixture(); let finish!: (value: ReturnType<typeof receipt>) => void;
    f.read.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Speed, Standard saved" }));
    f.view.rerender(f.element({ ...initial, saved: { selection: "ultrafast", desiredRevision: 9 } }));
    finish(receipt(result({ status: "published", target, selection: "fast" })));
    await screen.findByRole("button", { name: "Speed, Ultrafast saved" });
  });
  it("withdraws malformed offered authority instead of guessing", () => {
    fixture({ ...initial, offered: [{ selection: "fast" }, { selection: "fast" }] });
    expect(screen.queryByRole("button")).toBeNull();
  });
});
