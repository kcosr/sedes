import { afterEach, describe, expect, it, vi } from "vitest";
import { automationCliInputSchema } from "../../src/cli/automation-input.js";
import {
  SedesCliApiClient,
  normalizeSedesUrl,
} from "../../src/cli/sedes-api-client.js";
import { SEDES_CLIENT_PROTOCOL_VERSION } from "../../src/shared/protocol/application.js";
import { SEDES_VERSION } from "../../src/shared/version.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("automation CLI authentication", () => {
  it("sends paired credentials only to its configured origin and refuses redirects", async () => {
    const token = "a".repeat(43);
    const fetchMock = vi.fn(async () => new Response("{}", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SedesCliApiClient("https://sedes.example.test/", token);
    await expect(client.session()).rejects.toThrow("set SEDES_AUTH_TOKEN");
    const [url, options] = fetchMock.mock.calls[0]! as unknown as [URL, RequestInit];
    expect(url.origin).toBe("https://sedes.example.test");
    expect(options.redirect).toBe("error");
    expect(new Headers(options.headers).get("Authorization")).toBe(`Bearer ${token}`);
  });
  it("rejects malformed credentials without disclosing them", () => {
    expect(() => new SedesCliApiClient("http://localhost:4784", "sensitive-invalid-value")).toThrow("SEDES_AUTH_TOKEN must be a paired device credential.");
  });
});

const validInput = {
  thread: {
    workspaceId: "10000000-0000-4000-8000-000000000001",
    title: "Nightly review",
    configuration: {
      kind: "custom",
      targetId: "pi-default",
    },
    executionWorkspace: { kind: "direct" },
  },
  automation: {
    prompt: "Review the repository.",
    runMode: "clone",
    schedule: {
      kind: "cron",
      expression: "0 2 * * *",
      timeZone: "UTC",
    },
    misfirePolicy: "skip",
  },
};

describe("automation CLI input", () => {
  it("leaves state unset for the create command's paused default", () => {
    const parsed = automationCliInputSchema.parse(validInput);

    expect(parsed.automation.state).toBeUndefined();
    expect(parsed.automation.precheck).toBeNull();
    expect(parsed.checks).toEqual({ previewCount: 0, testPrecheck: false });
  });

  it("accepts a paused automation with bounded pre-check testing", () => {
    const parsed = automationCliInputSchema.parse({
      ...validInput,
      automation: {
        ...validInput.automation,
        state: "paused",
        precheck: {
          command: "test -f package.json",
          timeoutSeconds: 10,
          includeStdout: false,
        },
      },
      checks: { previewCount: 5, testPrecheck: true },
    });

    expect(parsed.automation.state).toBe("paused");
    expect(parsed.checks.previewCount).toBe(5);
  });

  it("allows existing-thread commands to omit create-only thread selection", () => {
    const { thread: _thread, ...existingThreadInput } = validInput;

    const parsed = automationCliInputSchema.parse(existingThreadInput);

    expect(parsed.thread).toBeUndefined();
    expect(parsed.automation.prompt).toBe("Review the repository.");
  });

  it("rejects unknown fields rather than creating an accidental dual contract", () => {
    expect(() =>
      automationCliInputSchema.parse({
        ...validInput,
        tenantId: "browser-chosen",
      }),
    ).toThrow();
  });
});

describe("automation CLI server URL", () => {
  it("permits loopback origins by default", () => {
    expect(normalizeSedesUrl("http://127.0.0.1:4783", false)).toBe(
      "http://127.0.0.1:4783",
    );
    expect(normalizeSedesUrl("http://localhost:4783/", false)).toBe(
      "http://localhost:4783",
    );
  });

  it("requires explicit consent for a non-loopback origin", () => {
    expect(() =>
      normalizeSedesUrl("https://sedes.example.test", false),
    ).toThrow("--allow-remote");
    expect(normalizeSedesUrl("https://sedes.example.test", true)).toBe(
      "https://sedes.example.test",
    );
  });

  it("rejects credentials and URL paths", () => {
    expect(() =>
      normalizeSedesUrl("http://user@localhost:4783", false),
    ).toThrow();
    expect(() =>
      normalizeSedesUrl("http://localhost:4783/api", false),
    ).toThrow();
  });
});

describe("automation CLI thread requests", () => {
  it("keeps session metadata separate from point-in-time inventory", async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(input.toString()).pathname;
      if (path === "/api/application/session") {
        return Response.json({
          clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION,
          version: SEDES_VERSION,
          csrfToken: "a".repeat(32),
          providerPulseEnabled: false, experimentalUsageEnabled: false,
        });
      }
      if (path === "/api/application/snapshot") {
        return Response.json({
          advisories: [],
          environments: [],
          projects: [{ id: "project-1", name: "Project", revision: 0 }],
          workspaces: [],
          threads: [],
          forkOrigins: [],
          lineagePlacements: [],
          groups: [],
          lineageFamilies: [],
          executionTargets: [],
          defaultNewThreadTargetId: null,
          counts: { active: 0, snoozed: 0, settled: 0, archived: 0 },
          tasks: [],
        });
      }
      return Response.json({}, { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);
    const client = new SedesCliApiClient("http://127.0.0.1:4783");

    await expect(client.session()).resolves.toMatchObject({
      csrfToken: "a".repeat(32),
    });
    await expect(client.snapshot()).resolves.toMatchObject({ threads: [] });

    expect(
      fetch.mock.calls.map(([input]) => new URL(input.toString()).pathname),
    ).toEqual(["/api/application/session", "/api/application/snapshot"]);
  });

  it("reads clone eligibility from the automation capability route", async () => {
    const capability = {
      available: true,
      canAttach: true,
      canRunNow: false,
      canCloneOnRun: false,
    };
    const fetch = vi.fn().mockResolvedValue(Response.json(capability));
    vi.stubGlobal("fetch", fetch);
    const client = new SedesCliApiClient("http://127.0.0.1:4783");

    await expect(
      client.automationCapability("thread/with spaces"),
    ).resolves.toEqual(capability);

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      "http://127.0.0.1:4783/api/threads/thread%2Fwith%20spaces/automation/capability",
    );
  });

  it("sends the run-history filter and the resolve-and-resume choice", async () => {
    const threadId = "10000000-0000-4000-8000-000000000001";
    const runId = "10000000-0000-4000-8000-000000000002";
    const run = {
      id: runId,
      occurrence: "scheduled",
      scheduledFor: "2026-10-06T08:15:00.000Z",
      state: "failed",
      runMode: "same_thread",
      definitionRevision: 3,
      coalescedCount: 0,
      errorCode: "automation_uncertain_resolved",
    };
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input.toString());
      if (url.pathname === "/api/application/session") {
        return Response.json({
          clientProtocolVersion: SEDES_CLIENT_PROTOCOL_VERSION,
          version: SEDES_VERSION,
          csrfToken: "a".repeat(32),
          providerPulseEnabled: false,
          experimentalUsageEnabled: false,
        });
      }
      if (url.pathname.endsWith("/automation/runs")) {
        return Response.json({
          items: [run],
          nextCursor: null,
          counts: { all: 4, problems: 1, skipped: 2 },
        });
      }
      return Response.json({ run, automation: null });
    });
    vi.stubGlobal("fetch", fetch);
    const client = new SedesCliApiClient("http://127.0.0.1:4783");

    await expect(client.listRuns(threadId, "problems")).resolves.toMatchObject({
      counts: { all: 4, problems: 1, skipped: 2 },
    });
    await expect(client.resolveRun(threadId, runId, true)).resolves.toEqual({
      run,
      automation: null,
    });

    const calls = fetch.mock.calls as unknown as [URL, RequestInit][];
    expect(calls[0]![0].toString()).toBe(
      `http://127.0.0.1:4783/api/threads/${threadId}/automation/runs?pageSize=50&filter=problems`,
    );
    const resolve = calls.find(([url]) =>
      url.toString().endsWith(`/runs/${runId}/resolve`),
    )!;
    expect(resolve[1].method).toBe("POST");
    expect(JSON.parse(resolve[1].body as string)).toEqual({
      action: "mark_failed",
      resume: true,
    });
  });
});
