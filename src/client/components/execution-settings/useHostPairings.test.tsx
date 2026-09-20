// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useHostPairings, type HostPairingControls } from "./useHostPairings.js";
import type { HostPairingList } from "../../../shared/protocol/host-pairing.js";

afterEach(() => { cleanup(); vi.useRealTimers(); });

it("bounds pending presence reads, aborts a timed-out request, and allows an explicit fresh read", async () => {
  vi.useFakeTimers();
  let signal: AbortSignal | undefined;
  const controls = {
    outboundConnectorSetup: () => ({ serverUrl: "http://sedes.test:4784", downloadUrl: "http://sedes.test:4784/api/outbound/connector/sedes-sidecar.mjs" }),
    listHostRegistrations: vi.fn((nextSignal?: AbortSignal): Promise<HostPairingList> => {
      signal = nextSignal;
      return new Promise((_resolve, reject) => nextSignal?.addEventListener("abort", () => reject(new Error("Aborted")), { once: true }));
    }), acceptHostRegistration: vi.fn(), denyHostRegistration: vi.fn(), revokeHostPairing: vi.fn(), reapproveHostPairing: vi.fn(),
  } satisfies HostPairingControls;
  const { result, unmount } = renderHook(() => useHostPairings(controls, async () => true));
  await act(() => vi.advanceTimersByTimeAsync(10_000));
  expect(controls.listHostRegistrations).toHaveBeenCalledOnce();
  await act(() => vi.advanceTimersByTimeAsync(5_000));
  expect(result.current.stale).toBe(true);
  expect(result.current.error).toContain("timed out");
  controls.listHostRegistrations.mockResolvedValue({ registrations: [], pairings: [] });
  await act(() => result.current.refresh());
  expect(result.current.stale).toBe(false);
  expect(result.current.hosts).toEqual({ registrations: [], pairings: [] });
  expect(signal?.aborted).toBe(true);
  unmount();
  expect(vi.getTimerCount()).toBe(0);
});
