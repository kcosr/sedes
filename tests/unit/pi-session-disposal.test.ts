import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { disposePiSession } from "../../src/server/backends/pi/pi-session-disposal.js";

it("disposes the native session once even when extension shutdown fails", async () => {
  const failure = new Error("extension shutdown failed");
  const emit = vi.fn(async () => { throw failure; });
  const dispose = vi.fn();
  const session = { extensionRunner: { hasHandlers: () => true, emit }, dispose } as unknown as AgentSession;
  const first = disposePiSession(session);
  expect(disposePiSession(session)).toBe(first);
  await expect(first).rejects.toBe(failure);
  expect(emit).toHaveBeenCalledExactlyOnceWith({ type: "session_shutdown", reason: "quit" });
  expect(dispose).toHaveBeenCalledOnce();
  expect(disposePiSession(session)).toBe(first);
});
