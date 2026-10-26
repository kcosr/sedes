import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CodexCliWebSearchProvider, buildCodexArguments, parseCodexJsonl, runCodexProcess,
  type CodexProcessResult,
} from "../../src/server/web-search/codex-cli-web-search-provider.js";
import { WebSearchService } from "../../src/server/web-search/web-search-service.js";

const sessionId = "019196f7-a0a8-7bc4-a89b-8cf013978405";
const answer = "Current answer. [Source](https://example.com/research)";
const events = [
  { type: "thread.started", thread_id: sessionId },
  { type: "turn.started" },
  { type: "item.completed", item: { type: "agent_message", text: "Researching…" } },
  { type: "item.completed", item: { type: "web_search", query: "current research" } },
  { type: "item.completed", item: { type: "agent_message", text: answer } },
  { type: "turn.completed", usage: {} },
];
const jsonl = (items: unknown[]) => items.map((item) => JSON.stringify(item)).join("\n") + "\n";
const success = (output = jsonl(events)): CodexProcessResult => ({
  exitCode: 0, stdout: output, stderr: "", timedOut: false, aborted: false, outputLimitExceeded: false,
});

describe("Codex research boundary", () => {
  it.each(["", "relative"])("keeps malformed ambient CODEX_HOME=%j out of server construction", async (codexHome) => {
    const runProcess = vi.fn<typeof runCodexProcess>();
    const provider = new CodexCliWebSearchProvider({
      workDirectory: path.resolve("unused-research"), environment: { CODEX_HOME: codexHome }, runProcess,
    });
    await expect(provider.checkAvailability()).resolves.toEqual({ available: false, reason: "The Codex research home must be an absolute path." });
    expect(runProcess).not.toHaveBeenCalled();
  });

  it.each(["0.162.1", "0.163.0", "0.164.0"])("uses the normal Codex runtime policy for %s with a curated environment and configured home", async (release) => {
    const root = await mkdtemp(path.join(tmpdir(), "sedes-search-provider-"));
    const runProcess = vi.fn<typeof runCodexProcess>()
      .mockResolvedValueOnce(success(`codex-cli ${release}\n`));
    try {
      const provider = new CodexCliWebSearchProvider({
        workDirectory: path.join(root, "work"), codexHome: path.join(root, "auth"), runProcess,
        environment: {
          HOME: "/operator-home", PATH: "/bin", CODEX_HOME: "/ambient-home",
          SEDES_AUTHORITY_SECRET: "secret", OPENAI_API_KEY: "secret", XAI_API_KEY: "secret", NODE_OPTIONS: "secret",
        },
      });
      await expect(provider.checkAvailability()).resolves.toEqual({ available: true });
      expect(runProcess.mock.calls.map(([input]) => input.arguments)).toEqual([["--version"]]);
      for (const [input] of runProcess.mock.calls) {
        expect(input.environment).toEqual({ HOME: "/operator-home", PATH: "/bin", CODEX_HOME: path.join(root, "auth"), NO_COLOR: "1", TERM: "dumb" });
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each(["0.162.0", "0.163.0-beta.1", "not-a-version"])("rejects unqualified release %s", async (release) => {
    const runProcess = vi.fn<typeof runCodexProcess>().mockResolvedValue(success(`codex-cli ${release}`));
    const root = await mkdtemp(path.join(tmpdir(), "sedes-search-version-"));
    try {
      const provider = new CodexCliWebSearchProvider({ workDirectory: root, environment: {}, runProcess });
      await expect(provider.checkAvailability()).resolves.toMatchObject({ available: false });
      expect(runProcess).toHaveBeenCalledTimes(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("allows native login to repair authentication without reconfiguring the service", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedes-search-auth-"));
    const runProcess = vi.fn<typeof runCodexProcess>()
      .mockResolvedValueOnce(success("codex-cli 0.163.0"))
      .mockResolvedValueOnce({ ...success(), exitCode: 1, stderr: "Unauthorized private-token" })
      .mockResolvedValueOnce(success());
    try {
      const provider = new CodexCliWebSearchProvider({ workDirectory: root, environment: {}, runProcess });
      const availability = await provider.checkAvailability();
      expect(availability).toEqual({ available: true });
      const service = new WebSearchService(provider, availability);
      const request = { subject: { tenantId: "tenant", principalId: "principal", kind: "thread" as const, id: "thread" }, query: "Research", continue: false, signal: new AbortController().signal };
      await expect(service.search(request)).rejects.toMatchObject({ code: "failed", message: "Codex web search failed. Check its authentication and research sandbox configuration." });
      // Native authentication succeeds on the next exec after the user signs in.
      await expect(service.search(request)).resolves.toEqual({ text: answer, continued: false, continuationFallback: false });
      expect(runProcess.mock.calls).toHaveLength(3);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("uses named read restrictions, live search and explicit resume while keeping sessions persistent", () => {
    const args = buildCodexArguments({ resumeSessionId: sessionId });
    expect(args.slice(-3)).toEqual(["resume", sessionId, "-"]);
    expect(args).toContain('default_permissions="research"');
    expect(args).toContain('permissions.research.filesystem={":root"="deny",":minimal"="read",":tmpdir"="deny",":slash_tmp"="deny"}');
    expect(args).toContain('web_search="live"');
    expect(args).toContain("features.shell_tool=false");
    expect(args).toContain("features.code_mode_host=true");
    expect(args).toContain("agents.enabled=false");
    expect(args).toContain("--ignore-user-config");
    expect(args).toContain("--ignore-rules");
    expect(args).not.toContain("--sandbox");
    expect(args).not.toContain("--ephemeral");
    expect(args).not.toContain("--last");
    expect(() => buildCodexArguments({ resumeSessionId: "--last" })).toThrow(/session_id_invalid/u);
  });

  it("sends the complete query on stdin and returns only the completed final answer", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedes-search-input-"));
    const runProcess = vi.fn<typeof runCodexProcess>().mockResolvedValue(success());
    try {
      const query = "Research $HOME and `literal` text\nwith newlines";
      const provider = new CodexCliWebSearchProvider({ workDirectory: root, environment: {}, runProcess });
      await expect(provider.search({ query, signal: new AbortController().signal })).resolves.toEqual({ text: answer, sessionId });
      const [input] = runProcess.mock.calls[0]!;
      expect(input.input).toBe(query);
      expect(input.arguments).not.toContain(query);
      expect(input.timeoutMilliseconds).toBe(100_000);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it.each([
    ["missing exact session", `Error: no rollout found for thread id ${sessionId}`, "session_unavailable"],
    ["authentication failure", "Unauthorized private-token", "failed"],
    ["unrelated missing session", "no rollout found for thread id another-id", "failed"],
  ])("classifies %s without unsafe continuation fallback", async (_label, stderr, code) => {
    const root = await mkdtemp(path.join(tmpdir(), "sedes-search-error-"));
    const runProcess = vi.fn<typeof runCodexProcess>().mockResolvedValue({ ...success(), exitCode: 1, stderr });
    try {
      const provider = new CodexCliWebSearchProvider({ workDirectory: root, environment: {}, runProcess });
      await expect(provider.search({ query: "Follow up", resumeSessionId: sessionId, signal: new AbortController().signal })).rejects.toMatchObject({ code });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("rejects a completed answer from a different session during continuation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedes-search-resume-"));
    const runProcess = vi.fn<typeof runCodexProcess>().mockResolvedValue(success());
    try {
      const provider = new CodexCliWebSearchProvider({ workDirectory: root, environment: {}, runProcess });
      await expect(provider.search({ query: "Follow up", resumeSessionId: "00000000-0000-4000-8000-000000000123", signal: new AbortController().signal })).rejects.toMatchObject({ code: "failed" });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("requires completed web research for a fresh query while allowing follow-ups from saved results", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedes-search-no-tools-"));
    const runProcess = vi.fn<typeof runCodexProcess>().mockResolvedValue(success(jsonl(
      events.filter((event) => event.item?.type !== "web_search"),
    )));
    try {
      const provider = new CodexCliWebSearchProvider({ workDirectory: root, environment: {}, runProcess });
      await expect(provider.search({ query: "Research", signal: new AbortController().signal })).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("did not complete a web search") });
      await expect(provider.search({ query: "Follow up", resumeSessionId: sessionId, signal: new AbortController().signal })).resolves.toEqual({ text: answer, sessionId });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("buffered Codex JSONL", () => {
  it("accepts nonfatal native error items and keeps ordinary source links", () => {
    const warning = { type: "item.completed", item: { type: "error", message: "Native feature warning" } };
    expect(parseCodexJsonl(jsonl([warning, ...events]))).toEqual({ text: answer, sessionId });
  });

  it("accepts a recovered stream reconnect before a completed research answer", () => {
    const reconnect = { type: "error", message: "Reconnecting… 1/5" };
    expect(parseCodexJsonl(jsonl([...events.slice(0, 2), reconnect, ...events.slice(2)]), { requireWebSearch: true }))
      .toEqual({ text: answer, sessionId });
  });

  it.each([
    ["empty", ""],
    ["invalid JSON", "startup notice\n" + jsonl(events)],
    ["truncated", jsonl(events.slice(0, -1))],
    ["failed turn", jsonl([...events.slice(0, -1), { type: "turn.failed", error: { message: "failed" } }])],
    ["error without completion", jsonl([...events.slice(0, -1), { type: "error", message: "failed" }])],
    ["no session", jsonl(events.slice(1))],
    ["invalid session", jsonl([{ type: "thread.started", thread_id: "not-a-session" }, ...events.slice(1)])],
    ["output after completion", jsonl([...events, { type: "item.completed", item: { type: "agent_message", text: "late" } }])],
    ["unresolved citations", jsonl([...events.slice(0, -2), { type: "item.completed", item: { type: "agent_message", text: "Answer citeturn0search0" } }, events.at(-1)])],
  ])("rejects %s output", (_label, output) => {
    expect(() => parseCodexJsonl(output)).toThrow();
  });
});

describe("owned Codex subprocess", () => {
  it("captures stdin/stdout without a shell", async () => {
    const input = "$HOME `literal`\nresearch";
    const result = await runCodexProcess({
      executable: process.execPath, arguments: ["-e", 'process.stdin.pipe(process.stdout)'],
      input, cwd: process.cwd(), environment: process.env, timeoutMilliseconds: 5_000,
    });
    expect(result).toEqual({ ...success(input) });
  });

  it("terminates on timeout and cancellation", async () => {
    const input = { executable: process.execPath, arguments: ["-e", "setInterval(() => {}, 1000)"], cwd: process.cwd(), environment: process.env };
    await expect(runCodexProcess({ ...input, timeoutMilliseconds: 75 })).resolves.toMatchObject({ timedOut: true, aborted: false });
    const controller = new AbortController();
    const promise = runCodexProcess({ ...input, signal: controller.signal, timeoutMilliseconds: 5_000 });
    controller.abort();
    await expect(promise).resolves.toMatchObject({ aborted: true, timedOut: false });
  });

  it.each(["stdout", "stderr"])("bounds %s before retaining excessive output", async (stream) => {
    const result = await runCodexProcess({
      executable: process.execPath, arguments: ["-e", `process.${stream}.write("x".repeat(3 * 1024 * 1024)); setInterval(() => {}, 1000)`],
      cwd: process.cwd(), environment: process.env, timeoutMilliseconds: 5_000,
    });
    expect(result).toMatchObject({ outputLimitExceeded: true, timedOut: false });
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(256 * 1024);
  });
});
