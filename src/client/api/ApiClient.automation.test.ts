// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiClient } from "./ApiClient.js";
import { SEDES_CLIENT_PROTOCOL_VERSION } from "../../shared/protocol/application.js";

afterEach(() => vi.unstubAllGlobals());

const threadId = "thread/1";
const runId = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const run = {
  id: runId,
  occurrence: "scheduled",
  scheduledFor: "2026-10-06T08:15:00.000Z",
  state: "failed",
  runMode: "same_thread",
  definitionRevision: 2,
  coalescedCount: 0,
  errorCode: "automation_uncertain_resolved",
} as const;

describe("ApiClient automation routes", () => {
  it("reads the automation capability for a thread", async () => {
    const capability = {
      available: true,
      canAttach: false,
      canRunNow: true,
      canCloneOnRun: false,
      unavailableReason: { text: "Automation is unavailable for this thread." },
    };
    const fetch = vi.fn().mockResolvedValue(Response.json(capability));
    vi.stubGlobal("fetch", fetch);

    await expect(
      new ApiClient().getThreadAutomationCapability(threadId),
    ).resolves.toEqual(capability);
    expect(String(fetch.mock.calls[0]![0])).toBe(
      "/api/threads/thread%2F1/automation/capability",
    );
  });

  it("pages filtered runs and parses first-page counts", async () => {
    const page = {
      items: [run],
      nextCursor: "next",
      counts: { all: 9, problems: 3, skipped: 4 },
    };
    const fetch = vi.fn().mockResolvedValue(Response.json(page));
    vi.stubGlobal("fetch", fetch);
    const api = new ApiClient();

    await expect(
      api.listThreadAutomationRuns(threadId, { filter: "problems", limit: 5 }),
    ).resolves.toEqual(page);
    expect(String(fetch.mock.calls[0]![0])).toBe(
      "/api/threads/thread%2F1/automation/runs?pageSize=5&filter=problems",
    );

    fetch.mockResolvedValue(Response.json({ items: [], nextCursor: null }));
    await expect(
      api.listThreadAutomationRuns(threadId, { cursor: "next" }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(String(fetch.mock.calls[1]![0])).toBe(
      "/api/threads/thread%2F1/automation/runs?cursor=next&pageSize=50",
    );
  });

  it("previews a schedule from now, or after a later instant", async () => {
    const fetch = vi.fn((url: string, _init?: RequestInit) =>
      Promise.resolve(
        url.endsWith("/api/application/session")
          ? Response.json({
              clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION,
              version: "0.1.1",
              csrfToken: "a".repeat(32),
              providerPulseEnabled: false,
              experimentalUsageEnabled: false,
            })
          : Response.json({ occurrences: ["2026-10-08T09:00:00.000Z"] }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const api = new ApiClient();
    await api.session();
    const schedule = { kind: "cron", expression: "0 9 * * *", timeZone: "UTC" } as const;

    await expect(api.previewThreadAutomationSchedule(threadId, schedule)).resolves.toEqual({
      occurrences: ["2026-10-08T09:00:00.000Z"],
    });
    await api.previewThreadAutomationSchedule(threadId, schedule, {
      count: 3,
      after: "2026-10-08T00:00:00.000Z",
    });

    const bodies = fetch.mock.calls
      .filter(([url]) => url.endsWith("/automation/preview"))
      .map(([, init]) => JSON.parse(init!.body as string));
    expect(bodies).toEqual([
      { schedule, count: 5 },
      { schedule, count: 3, after: "2026-10-08T00:00:00.000Z" },
    ]);
  });

  it("resolves a run with an explicit resume choice", async () => {
    const fetch = vi.fn((url: string, _init?: RequestInit) =>
      Promise.resolve(
        url.endsWith("/api/application/session")
          ? Response.json({
              clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION,
              version: "0.1.1",
              csrfToken: "a".repeat(32),
              providerPulseEnabled: false,
              experimentalUsageEnabled: false,
            })
          : Response.json({ run, automation: null }),
      ),
    );
    vi.stubGlobal("fetch", fetch);
    const api = new ApiClient();
    await api.session();

    await expect(
      api.resolveThreadAutomationRun(threadId, runId, { resume: true }),
    ).resolves.toEqual({ run, automation: null });
    await api.resolveThreadAutomationRun(threadId, runId);

    const bodies = fetch.mock.calls
      .filter(([url]) => url.endsWith("/resolve"))
      .map(([, init]) => JSON.parse(init!.body as string));
    expect(bodies).toEqual([
      { action: "mark_failed", resume: true },
      { action: "mark_failed", resume: false },
    ]);
    expect(
      fetch.mock.calls.find(([url]) => url.endsWith("/resolve"))![0],
    ).toBe(`/api/threads/thread%2F1/automation/runs/${runId}/resolve`);
  });
});
