import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import type { ValidatedWorkspace } from "../../src/server/execution/contracts.js";
import { DefaultPiSdkSessionFactory, PiInteractionBridge, type PiSdkSession } from "../../src/server/backends/pi/pi-sdk-session.js";

it.each(["ready", "binding"])("shuts down extension timers before invalidating a %s native Pi session", async phase => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-extension-shutdown-"));
  const agentDir = path.join(root, "agent");
  const cwd = path.join(root, "workspace");
  const eventsFile = path.join(root, "events.txt");
  await mkdir(path.join(agentDir, "extensions"), { recursive: true });
  await mkdir(cwd);
  await writeFile(path.join(agentDir, "extensions", "timer.ts"), `
    import { appendFileSync } from "node:fs";
    const record = (event: string) => appendFileSync(${JSON.stringify(eventsFile)}, event + "\\n");
    export default function(pi: any) {
      let timer: ReturnType<typeof setInterval>;
      pi.on("session_start", async (_event: any, ctx: any) => {
        record("start");
        await new Promise(resolve => setTimeout(resolve, 12));
        timer = setInterval(() => {
          try { ctx.sessionManager.getSessionId(); record("tick"); }
          catch { record("stale"); clearInterval(timer); }
        }, 5);
        timer.unref();
      });
      pi.on("session_shutdown", async (event: any, ctx: any) => {
        clearInterval(timer);
        record(event.reason);
        await new Promise(resolve => setTimeout(resolve, 12));
        ctx.sessionManager.getSessionId();
        record("shutdown_end");
      });
    }
  `);
  let session: PiSdkSession | undefined;
  try {
    session = await new DefaultPiSdkSessionFactory({ agentDir }).create({
      manager: SessionManager.inMemory(cwd),
      workspace: { canonicalPath: cwd, summary: { trustState: "trusted" } } as ValidatedWorkspace,
      interactions: new PiInteractionBridge(),
    });
    if (phase === "ready") {
      await session.ready();
      await vi.waitFor(async () => expect(await readFile(eventsFile, "utf8")).toContain("tick"));
    }
    const disposal = session.dispose();
    expect(session.controlLifetime?.aborted).toBe(true);
    await disposal;
    expect(session.dispose()).toBe(disposal);
    const closedEvents = await readFile(eventsFile, "utf8");
    expect(closedEvents.split("\n").filter(event => event === "quit")).toHaveLength(1);
    expect(closedEvents).toContain("shutdown_end");
    expect(closedEvents).not.toContain("stale");
    // Several former timer periods must pass without touching the disposed ctx.
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(await readFile(eventsFile, "utf8")).toBe(closedEvents);
  } finally {
    await session?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
