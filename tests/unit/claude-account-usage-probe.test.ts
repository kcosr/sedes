import type { AccountInfo, Query, SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { readClaudeAccountUsage } from "../../src/server/backends/claude/claude-account-usage-probe.js";
import { OfficialClaudeSdkFacade } from "../../src/server/backends/claude/claude-sdk-facade.js";

const subscription = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max" };
const environment = { HOME: "/account", CLAUDE_CONFIG_DIR: "/provider" };
const response = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 1,
    total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: "max", rate_limits_available: true, behaviors: null,
  rate_limits: { seven_day: { utilization: 53, resets_at: "2030-05-08T18:00:00Z" } },
} satisfies SDKControlGetUsageResponse;

function fixture() {
  const sdk = new OfficialClaudeSdkFacade();
  const auth = vi.spyOn(sdk, "readCliAuthStatus").mockResolvedValue(subscription);
  const initialize = vi.fn<() => Promise<{ account: AccountInfo }>>()
    .mockResolvedValue({ account: { apiProvider: "firstParty", subscriptionType: "max" } });
  const usage = vi.fn(async (_options: { skipBehaviors?: boolean }) => response);
  const close = vi.fn();
  const create = vi.spyOn(sdk, "createQuery").mockReturnValue({
    initializationResult: initialize,
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
    close,
  } as unknown as Query);
  const abort = new AbortController();
  const read = () => readClaudeAccountUsage({ sdk, executablePath: "/bin/claude", environment, signal: abort.signal });
  return { auth, create, initialize, usage, close, abort, read };
}

describe("Claude's backend subscription probe", () => {
  it("sends no input, skips transcript behavior scans, and closes its isolated query", async () => {
    const { read, auth, create, usage, close } = fixture();
    await expect(read()).resolves.toMatchObject({ windows: [{ remainingPercent: 47 }] });
    expect(auth).toHaveBeenCalledWith("/bin/claude", 10_000, environment, "/", expect.any(AbortSignal));
    expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ options: expect.objectContaining({
      pathToClaudeCodeExecutable: "/bin/claude", cwd: "/", env: environment, settingSources: ["user"],
      persistSession: false, tools: [], strictMcpConfig: true, mcpServers: {}, settings: { disableAllHooks: true },
    }) }));
    const { prompt, options } = create.mock.calls[0]![0];
    if (typeof prompt === "string") throw new Error("quota probe submitted a string prompt");
    await expect(prompt[Symbol.asyncIterator]().next()).resolves.toMatchObject({ done: true });
    expect(usage).toHaveBeenCalledExactlyOnceWith({ skipBehaviors: true });
    expect(options.abortController?.signal.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects an API-key override before creating a query", async () => {
    const { read, auth, create } = fixture();
    auth.mockResolvedValue({ ...subscription, apiKeySource: "env" });
    await expect(read()).rejects.toThrow("claude_subscription_auth_unavailable");
    expect(create).not.toHaveBeenCalled();
  });

  it("requires first-party subscription evidence from the initialized query", async () => {
    const { read, initialize, usage, close } = fixture();
    initialize.mockResolvedValue({ account: { apiProvider: "bedrock", subscriptionType: "max" } });
    await expect(read()).resolves.toBeNull();
    expect(usage).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects an API-key override discovered during SDK initialization", async () => {
    const { read, initialize, usage, close } = fixture();
    initialize.mockResolvedValue({ account: { apiProvider: "firstParty", subscriptionType: "max", apiKeySource: "user" } });
    await expect(read()).resolves.toBeNull();
    expect(usage).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("interrupts an unresponsive control and closes its own CLI", async () => {
    const { read, usage, close, abort } = fixture();
    let started!: () => void;
    const reading = new Promise<void>(resolve => { started = resolve; });
    usage.mockImplementation(async () => { started(); return new Promise(() => {}); });
    const result = read();
    await reading;
    abort.abort(new Error("worker released"));
    await expect(result).rejects.toThrow("worker released");
    expect(close).toHaveBeenCalledOnce();
  });
});
