// @vitest-environment jsdom

import { act, render, renderHook } from "@testing-library/react";
import { useEffect } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api/ApiClient.js";
import type { ProviderPulseStatus } from "../../shared/protocol/provider-pulse.js";
import { useProviderPulse } from "./use-provider-pulse.js";

const status = (): ProviderPulseStatus => ({
  version: 1,
  generatedAt: "2026-08-16T19:00:00.000Z",
  health: "healthy",
  accounts: [
    {
      id: "codex-work",
      label: "Codex · work",
      provider: "codex",
      brand: "codex",
      usage: { health: "healthy", inFlight: false },
    },
  ],
  usageBaseline: { health: "healthy", metrics: [] },
});

function apiWith(readProviderPulseStatus: () => Promise<ProviderPulseStatus>) {
  return {
    readProviderPulseStatus,
    checkProviderPulseAccount: vi.fn().mockResolvedValue({
      operationId: "operation-1",
      accepted: true,
      targetId: "codex-work",
      kind: "usage-check",
      coalesced: false,
    }),
    checkAllProviderPulseAccounts: vi.fn(),
    snapshotProviderPulseUsage: vi.fn(),
  } as unknown as ApiClient;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("useProviderPulse", () => {
  it("loads once when an open surface tracks the stable load callback", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockImplementation(async () => status());
    const api = apiWith(read);

    function OpenSurface(): React.JSX.Element {
      const pulse = useProviderPulse(api);
      useEffect(() => {
        void pulse.load();
        return pulse.stop;
      }, [pulse.load, pulse.stop]);
      return <span>{pulse.status?.health ?? "loading"}</span>;
    }

    const surface = render(<OpenSurface />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(read).toHaveBeenCalledOnce();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(59_999);
    });
    expect(read).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(read).toHaveBeenCalledTimes(2);
    surface.unmount();
  });

  it("uses one status request per action polling attempt", async () => {
    vi.useFakeTimers();
    const read = vi.fn().mockImplementation(async () => status());
    const api = apiWith(read);
    const hook = renderHook(() => useProviderPulse(api));

    await act(async () => {
      await hook.result.current.load();
    });
    expect(read).toHaveBeenCalledOnce();

    let action: Promise<void> | undefined;
    act(() => {
      action = hook.result.current.checkAccount("codex-work");
    });
    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(800);
      await action;
    });

    expect(read).toHaveBeenCalledTimes(2);
    expect(hook.result.current.checkingIds.size).toBe(0);
    hook.unmount();
  });
});
