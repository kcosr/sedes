import type { AgentSession } from "@earendil-works/pi-coding-agent";

const disposals = new WeakMap<AgentSession, Promise<void>>();

/** Extensions must release timers while their native context is still valid. */
export function disposePiSession(session: AgentSession): Promise<void> {
  const existing = disposals.get(session);
  if (existing) return existing;
  const disposal = Promise.resolve().then(async () => {
    try {
      if (session.extensionRunner.hasHandlers("session_shutdown")) {
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      }
    } finally {
      session.dispose();
    }
  });
  disposals.set(session, disposal);
  return disposal;
}
