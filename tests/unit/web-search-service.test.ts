import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GrokCliWebSearchProvider,
  GROK_WEB_SEARCH_DISALLOWED_TOOLS,
  buildGrokArguments,
  parseGrokJson,
  runGrokProcess,
  type GrokCliWebSearchProviderOptions,
} from "../../src/server/web-search/grok-cli-web-search-provider.js";
import {
  WebSearchProviderError,
  type WebSearchProvider,
} from "../../src/server/web-search/web-search-provider.js";
import { WebSearchService } from "../../src/server/web-search/web-search-service.js";

const subject = {
  tenantId: "tenant-1",
  principalId: "principal-1",
  kind: "thread" as const,
  id: "thread-1",
};

describe("Grok CLI web-search provider boundary", () => {
  it("uses a configured Grok home only in the child environment", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "sedes-web-search-"));
    const workDirectory = path.join(root, "work");
    const grokHome = path.join(root, "grok-home");
    const runProcess = vi.fn<
      NonNullable<GrokCliWebSearchProviderOptions["runProcess"]>
    >();
    runProcess.mockResolvedValue({
      exitCode: 0,
      stdout: "grok 1.0.5",
      stderr: "",
      timedOut: false,
      aborted: false,
      outputLimitExceeded: false,
    });
    try {
      const provider = new GrokCliWebSearchProvider({
        workDirectory,
        grokHome,
        environment: {
          HOME: "/operator-home",
          PATH: "/bin",
          SEDES_AUTHORITY_SECRET: "must-not-leak",
          XAI_API_KEY: "must-not-override-oauth",
        },
        runProcess,
      });

      await expect(provider.checkAvailability()).resolves.toEqual({
        available: true,
      });
      expect(runProcess.mock.calls[0]?.[0]).toMatchObject({
        arguments: ["--no-auto-update", "--version"],
        environment: {
          HOME: "/operator-home",
          PATH: "/bin",
          GROK_HOME: grokHome,
          GROK_OAUTH2_REFERRER: "sedes",
          NO_COLOR: "1",
          TERM: "dumb",
        },
      });
      expect(runProcess.mock.calls[0]?.[0].environment).not.toHaveProperty(
        "SEDES_AUTHORITY_SECRET",
      );
      expect(runProcess.mock.calls[0]?.[0].environment).not.toHaveProperty(
        "XAI_API_KEY",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps web search, fetch, and X available while denying dangerous tools", () => {
    const arguments_ = buildGrokArguments({
      query: "What changed today?",
      resumeSessionId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
    });

    expect(arguments_).not.toContain("--tools");
    expect(arguments_).toContain("--no-auto-update");
    expect(arguments_).toContain("--no-subagents");
    expect(arguments_).toContain("MCPTool(*)");
    expect(arguments_).toContain(GROK_WEB_SEARCH_DISALLOWED_TOOLS.join(","));
    expect(arguments_.slice(-2)).toEqual([
      "--resume",
      "019196f7-a0a8-7bc4-a89b-8cf013978405",
    ]);
  });

  it("accepts one bounded JSON result and ignores non-JSON preamble lines", () => {
    expect(
      parseGrokJson(
        'startup notice\n{"text":"Current answer","sessionId":"019196F7-A0A8-7BC4-A89B-8CF013978405"}\n',
      ),
    ).toEqual({
      text: "Current answer",
      sessionId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
    });
    expect(() => parseGrokJson('{"sessionId":"not-an-id"}')).toThrow(
      /no answer text/i,
    );
  });

  it("terminates the real child process on timeout and cancellation", async () => {
    const stalledChild = ["-e", "setInterval(() => {}, 1000)"];

    const timedOut = await runGrokProcess({
      executable: process.execPath,
      arguments: stalledChild,
      cwd: process.cwd(),
      environment: process.env,
      timeoutMilliseconds: 75,
    });
    expect(timedOut).toMatchObject({
      timedOut: true,
      aborted: false,
      outputLimitExceeded: false,
    });

    const controller = new AbortController();
    const cancelledPromise = runGrokProcess({
      executable: process.execPath,
      arguments: stalledChild,
      cwd: process.cwd(),
      environment: process.env,
      timeoutMilliseconds: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 75);
    await expect(cancelledPromise).resolves.toMatchObject({
      timedOut: false,
      aborted: true,
      outputLimitExceeded: false,
    });
  });

  it("terminates the real child process when its output exceeds the cap", async () => {
    const result = await runGrokProcess({
      executable: process.execPath,
      arguments: [
        "-e",
        [
          'process.stdout.write("x".repeat(3 * 1024 * 1024));',
          "setInterval(() => {}, 1000);",
        ].join(" "),
      ],
      cwd: process.cwd(),
      environment: process.env,
      timeoutMilliseconds: 10_000,
    });

    expect(result).toMatchObject({
      timedOut: false,
      aborted: false,
      outputLimitExceeded: true,
    });
  });
});

describe("WebSearchService", () => {
  it("keeps admitted calls and their queue on the old provider without blocking or contaminating the new provider", async () => {
    const active = deferred<{ text: string; sessionId: string }>();
    const oldSearch = vi.fn<WebSearchProvider["search"]>()
      .mockResolvedValueOnce({ text: "seed", sessionId: "old-seed" })
      .mockImplementationOnce(() => active.promise)
      .mockResolvedValueOnce({ text: "queued", sessionId: "old-queued" });
    const newSearch = vi.fn<WebSearchProvider["search"]>()
      .mockResolvedValueOnce({ text: "new", sessionId: "new-session" })
      .mockResolvedValueOnce({ text: "new follow-up", sessionId: "new-session" });
    const service = serviceWith(oldSearch);
    const request = {
      subject, continue: true, signal: new AbortController().signal,
    };
    await service.search({ ...request, query: "seed" });
    const oldActive = service.search({ ...request, query: "old active" });
    const oldQueued = service.search({ ...request, query: "old queued" });
    expect(oldSearch).toHaveBeenCalledTimes(2);

    // The provider kind is unchanged, as when Settings changes only grokHome.
    service.reconfigure(providerWith(newSearch), { available: true });
    await expect(service.search({ ...request, query: "new generation" }))
      .resolves.toEqual({ text: "new", continued: false, continuationFallback: true });
    expect(newSearch.mock.calls[0]?.[0]).not.toHaveProperty("resumeSessionId");

    active.resolve({ text: "old complete", sessionId: "old-active" });
    await expect(oldActive).resolves.toMatchObject({ text: "old complete", continued: true });
    await expect(oldQueued).resolves.toMatchObject({ text: "queued", continued: true });
    expect(oldSearch.mock.calls[1]?.[0].resumeSessionId).toBe("old-seed");
    expect(oldSearch.mock.calls[2]?.[0].resumeSessionId).toBe("old-active");

    await service.search({ ...request, query: "new follow-up" });
    expect(newSearch.mock.calls[1]?.[0].resumeSessionId).toBe("new-session");
    expect(oldSearch).toHaveBeenCalledTimes(3);
  });

  it("uses the captured provider for a stale-session fallback after reconfiguration", async () => {
    const resumed = deferred<never>();
    const oldSearch = vi.fn<WebSearchProvider["search"]>()
      .mockResolvedValueOnce({ text: "seed", sessionId: "old-stale" })
      .mockImplementationOnce(() => resumed.promise)
      .mockResolvedValueOnce({ text: "old fresh", sessionId: "old-fresh" });
    const newSearch = vi.fn<WebSearchProvider["search"]>()
      .mockResolvedValue({ text: "new answer", sessionId: "new-session" });
    const service = serviceWith(oldSearch);
    const request = {
      subject, continue: true, signal: new AbortController().signal,
    };
    await service.search({ ...request, query: "seed" });
    const oldFollowUp = service.search({ ...request, query: "old follow-up" });
    service.reconfigure(providerWith(newSearch), { available: true });
    await service.search({ ...request, query: "new question" });

    resumed.reject(new WebSearchProviderError("session_unavailable", "Old session gone."));
    await expect(oldFollowUp).resolves.toEqual({
      text: "old fresh", continued: false, continuationFallback: true,
    });
    expect(oldSearch.mock.calls[2]?.[0]).toMatchObject({ query: "old follow-up" });
    expect(oldSearch.mock.calls[2]?.[0]).not.toHaveProperty("resumeSessionId");
    expect(newSearch).toHaveBeenCalledTimes(1);

    await service.search({ ...request, query: "new follow-up" });
    expect(newSearch.mock.calls[1]?.[0].resumeSessionId).toBe("new-session");
  });

  it("disables new calls without cancelling admitted work and starts fresh when reenabled", async () => {
    const active = deferred<{ text: string; sessionId: string }>();
    const search = vi.fn<WebSearchProvider["search"]>()
      .mockImplementationOnce(() => active.promise)
      .mockResolvedValue({ text: "reenabled", sessionId: "new-session" });
    const provider = providerWith(search);
    const service = new WebSearchService(provider, { available: true });
    const request = {
      subject, continue: true, signal: new AbortController().signal,
    };
    const admitted = service.search({ ...request, query: "admitted" });
    service.reconfigure(provider, { available: false, reason: "Disabled in Settings." });
    await expect(service.search({ ...request, query: "disabled" }))
      .rejects.toMatchObject({ code: "unavailable", message: "Disabled in Settings." });
    expect(search).toHaveBeenCalledTimes(1);
    active.resolve({ text: "completed after disable", sessionId: "old-session" });
    await expect(admitted).resolves.toMatchObject({ text: "completed after disable" });

    service.reconfigure(provider, { available: true });
    await expect(service.search({ ...request, query: "reenabled" }))
      .resolves.toEqual({ text: "reenabled", continued: false, continuationFallback: true });
    expect(search.mock.calls[1]?.[0]).not.toHaveProperty("resumeSessionId");
  });

  it("resumes only the exact latest session for the same trusted subject", async () => {
    const search = vi
      .fn<WebSearchProvider["search"]>()
      .mockResolvedValueOnce({ text: "first", sessionId: "session-1" })
      .mockResolvedValueOnce({ text: "follow-up", sessionId: "session-1" });
    const service = serviceWith(search);

    await service.search({
      subject,
      query: "first question",
      continue: false,
      signal: new AbortController().signal,
    });
    const result = await service.search({
      subject,
      query: "direct follow-up",
      continue: true,
      signal: new AbortController().signal,
    });

    expect(search.mock.calls[1]?.[0].resumeSessionId).toBe("session-1");
    expect(result).toEqual({
      text: "follow-up",
      continued: true,
      continuationFallback: false,
    });
  });

  it("starts fresh after restart-like missing state and after a stale exact session", async () => {
    const missingSearch = vi
      .fn<WebSearchProvider["search"]>()
      .mockResolvedValue({ text: "fresh", sessionId: "session-2" });
    const missing = serviceWith(missingSearch);
    await expect(
      missing.search({
        subject,
        query: "follow-up after restart",
        continue: true,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      text: "fresh",
      continued: false,
      continuationFallback: true,
    });
    expect(missingSearch.mock.calls[0]?.[0]).not.toHaveProperty(
      "resumeSessionId",
    );

    const staleSearch = vi
      .fn<WebSearchProvider["search"]>()
      .mockResolvedValueOnce({ text: "seed", sessionId: "stale-session" })
      .mockRejectedValueOnce(
        new WebSearchProviderError(
          "session_unavailable",
          "The session is gone.",
        ),
      )
      .mockResolvedValueOnce({ text: "fallback", sessionId: "session-3" });
    const stale = serviceWith(staleSearch);
    await stale.search({
      subject,
      query: "seed",
      continue: false,
      signal: new AbortController().signal,
    });
    await expect(
      stale.search({
        subject,
        query: "follow-up",
        continue: true,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      text: "fallback",
      continued: false,
      continuationFallback: true,
    });
    expect(staleSearch.mock.calls[1]?.[0].resumeSessionId).toBe(
      "stale-session",
    );
    expect(staleSearch.mock.calls[2]?.[0]).not.toHaveProperty(
      "resumeSessionId",
    );
  });

  it("does not resume an older search when a newer successful search has no session ID", async () => {
    const search = vi
      .fn<WebSearchProvider["search"]>()
      .mockResolvedValueOnce({ text: "first", sessionId: "session-1" })
      .mockResolvedValueOnce({ text: "second" })
      .mockResolvedValueOnce({ text: "follow-up", sessionId: "session-3" });
    const service = serviceWith(search);

    await service.search({
      subject,
      query: "first",
      continue: false,
      signal: new AbortController().signal,
    });
    await service.search({
      subject,
      query: "unrelated second search",
      continue: false,
      signal: new AbortController().signal,
    });
    const result = await service.search({
      subject,
      query: "follow-up to second",
      continue: true,
      signal: new AbortController().signal,
    });

    expect(search.mock.calls[2]?.[0]).not.toHaveProperty("resumeSessionId");
    expect(result.continuationFallback).toBe(true);
  });
});

function serviceWith(search: WebSearchProvider["search"]): WebSearchService {
  return new WebSearchService(
    providerWith(search),
    { available: true },
  );
}

function providerWith(search: WebSearchProvider["search"]): WebSearchProvider {
  return {
    id: "test",
    checkAvailability: async () => ({ available: true }),
    search,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}
