import type { AccountInfo, Query, SDKControlGetUsageResponse } from "@anthropic-ai/claude-agent-sdk";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readClaudeAccountUsage } from "../../src/server/backends/claude/claude-account-usage-probe.js";
import { verifyClaudeQuotaSettings } from "../../src/server/backends/claude/claude-quota-account.js";
import { OfficialClaudeSdkFacade } from "../../src/server/backends/claude/claude-sdk-facade.js";

const identity = { email: "quota@example.test", organizationId: "db334f78-8fe4-44e3-9c25-9b661c2df56a", organizationName: "Workspace" };
const subscription = { loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty", subscriptionType: "max", quotaAccount: identity };
const account = { email: identity.email, organization: identity.organizationName, apiProvider: "firstParty", subscriptionType: "max" } satisfies AccountInfo;
let environment: { CLAUDE_CONFIG_DIR: string };
beforeAll(async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sedes-quota-provider-"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", directory);
  environment = { CLAUDE_CONFIG_DIR: directory };
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await rm(environment.CLAUDE_CONFIG_DIR, { recursive: true, force: true });
});
const response = {
  session: { total_cost_usd: 0, total_api_duration_ms: 0, total_duration_ms: 1,
    total_lines_added: 0, total_lines_removed: 0, model_usage: {} },
  subscription_type: "max", rate_limits_available: true, behaviors: null,
  rate_limits: { seven_day: { utilization: 53, resets_at: "2030-05-08T18:00:00Z" } },
} satisfies SDKControlGetUsageResponse;

function fixture(childEnvironment: Record<string, string> = environment) {
  const sdk = new OfficialClaudeSdkFacade();
  const auth = vi.spyOn(sdk, "readCliAuthStatus").mockResolvedValue(subscription);
  const initialize = vi.fn<() => Promise<{ account: AccountInfo }>>()
    .mockResolvedValue({ account });
  const usage = vi.fn(async (_options: { skipBehaviors?: boolean }) => response);
  const close = vi.fn();
  const create = vi.spyOn(sdk, "createQuery").mockReturnValue({
    initializationResult: initialize,
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: usage,
    close,
  } as unknown as Query);
  const abort = new AbortController();
  const read = () => readClaudeAccountUsage({ sdk, executablePath: "/bin/claude", environment: childEnvironment, signal: abort.signal });
  return { auth, create, initialize, usage, close, abort, read };
}

describe("Claude's backend subscription probe", () => {
  it("sends no input, skips transcript behavior scans, and closes its isolated query", async () => {
    const { read, auth, create, usage, close } = fixture();
    const quota = await read();
    expect(quota?.usage).toMatchObject({ windows: [{ remainingPercent: 47 }] });
    expect(quota?.accountKey).toEqual(expect.any(String));
    for (const privateValue of [identity.email, identity.organizationId, identity.organizationName, quota!.accountKey]) {
      expect(JSON.stringify(quota?.usage)).not.toContain(privateValue);
    }
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

  it.each([
    "CLAUDE_CODE_API_BASE_URL", "CLAUDE_CODE_SESSION_ACCESS_TOKEN", "CLAUDE_CODE_SESSIONS_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_HOST_CREDS_FILE", "CLAUDE_SESSION_INGRESS_TOKEN_FILE",
    "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR", "HOME",
  ])("avoids launching either CLI with %s overriding the worker login", async name => {
    const { read, auth, create } = fixture({ ...environment, [name]: "/unverified" });
    await expect(read()).resolves.toBeNull();
    expect(auth).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([
    { env: { CLAUDE_CODE_SESSIONS_OAUTH_TOKEN: "fixture-override" } },
    { env: { HOME: "/alternate-home" } },
    { env: { CLAUDE_CONFIG_DIR: "/alternate-config" } },
    { policyHelpers: { linux: { path: "/unexecuted-helper" } } },
  ])("checks resolved user settings before probing auth or opening the quota query", async settings => {
    const directory = await mkdtemp(path.join(environment.CLAUDE_CONFIG_DIR, "settings-"));
    await writeFile(path.join(directory, "settings.json"), JSON.stringify(settings));
    vi.stubEnv("CLAUDE_CONFIG_DIR", directory);
    try {
      const { read, auth, create } = fixture({ CLAUDE_CONFIG_DIR: directory });
      await expect(read()).resolves.toBeNull();
      expect(auth).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    } finally {
      vi.stubEnv("CLAUDE_CONFIG_DIR", environment.CLAUDE_CONFIG_DIR);
    }
  });

  it("retains the primary proof for the same configured login and rejects a project-local alternate home", async () => {
    const project = await mkdtemp(path.join(environment.CLAUDE_CONFIG_DIR, "project-"));
    await mkdir(path.join(project, ".claude"));
    await writeFile(path.join(project, ".claude/settings.json"), JSON.stringify({ env: {
      HOME: homedir(), CLAUDE_CONFIG_DIR: environment.CLAUDE_CONFIG_DIR,
    } }));
    const verify = () => verifyClaudeQuotaSettings("private-proof", project, environment, ["user", "project", "local"]);
    expect(await verify()).toBe("private-proof");
    await writeFile(path.join(project, ".claude/settings.local.json"), JSON.stringify({ env: { HOME: "/alternate-home" } }));
    expect(await verify()).toBeNull();
  });

  it("rejects an API-key override before creating a query", async () => {
    const { read, auth, create } = fixture();
    auth.mockResolvedValue({ ...subscription, apiKeySource: "env" });
    await expect(read()).rejects.toThrow("claude_subscription_auth_unavailable");
    expect(create).not.toHaveBeenCalled();
  });

  it("requires first-party subscription evidence from the initialized query", async () => {
    const { read, initialize, usage, close } = fixture();
    initialize.mockResolvedValue({ account: { ...account, apiProvider: "bedrock" } });
    await expect(read()).resolves.toBeNull();
    expect(usage).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects an API-key override discovered during SDK initialization", async () => {
    const { read, initialize, usage, close } = fixture();
    initialize.mockResolvedValue({ account: { ...account, apiKeySource: "user" } });
    await expect(read()).resolves.toBeNull();
    expect(usage).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([
    { ...account, email: "other@example.test" },
    { ...account, organization: "Other workspace" },
    { ...account, email: "" },
    { ...account, organization: "" },
  ])("skips usage when the CLI and SDK cannot prove the same identity", async other => {
    const { read, initialize, usage, close } = fixture();
    initialize.mockResolvedValue({ account: other });
    await expect(read()).resolves.toBeNull();
    expect(usage).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("distinguishes subscriptions sharing the same email and organization display name", async () => {
    const { read, auth } = fixture();
    const first = await read();
    auth.mockResolvedValue({ ...subscription, quotaAccount: {
      ...identity, organizationId: "f79a3ab2-e757-4672-9f28-8c3d18151f9f",
    } });
    const second = await read();
    expect(first?.accountKey).toEqual(expect.any(String));
    expect(second?.accountKey).toEqual(expect.any(String));
    expect(first?.accountKey).not.toBe(second?.accountKey);
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
