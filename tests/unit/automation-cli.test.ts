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
          providerPulseEnabled: false,
        });
      }
      if (path === "/api/application/snapshot") {
        return Response.json({
          advisories: [],
          environments: [],
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

  it("requests the explicit full activity projection", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({}), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const client = new SedesCliApiClient("http://127.0.0.1:4783");

    await expect(client.getThread("thread/with spaces")).rejects.toThrow();

    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0]?.[0].toString()).toBe(
      "http://127.0.0.1:4783/api/threads/thread%2Fwith%20spaces?activityDetail=full",
    );
  });
});
