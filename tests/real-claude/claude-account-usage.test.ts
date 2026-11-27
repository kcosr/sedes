import { expect, it, vi } from "vitest";
import { claudeQuotaAccountKey } from "../../src/server/backends/claude/claude-quota-account.js";
import { probeClaudeSdkDirect } from "../../src/server/backends/claude/claude-sdk-probe.js";
import { readClaudeAccountUsage } from "../../src/server/backends/claude/claude-account-usage-probe.js";
import { OfficialClaudeSdkFacade } from "../../src/server/backends/claude/claude-sdk-facade.js";

// This file can qualify the experimental control alone, without running any model turns.
it.runIf(process.env.SEDES_REAL_CLAUDE_ACCOUNT_USAGE === "1")("reads included subscription windows without generating a turn", async () => {
  const executablePath = process.env.SEDES_REAL_CLAUDE_EXECUTABLE ?? "claude";
  const sdk = new OfficialClaudeSdkFacade();
  const create = sdk.createQuery.bind(sdk);
  let checkingPrimary = true;
  let controls = 0;
  let inputs = 0;
  vi.spyOn(sdk, "createQuery").mockImplementation(input => {
    const prompt = input.prompt;
    if (typeof prompt === "string") throw new Error("Quota reads must not send a string prompt");
    const primary = checkingPrimary;
    const options = primary ? { ...input.options, settings: { disableAllHooks: true } } : input.options;
    const guardedPrompt = (async function* () {
      for await (const message of prompt) {
        // The ordinary catalog probe requests its startup frame with an empty, non-model control.
        if (primary && message.isSynthetic && message.shouldQuery === false && message.message.content === "") {
          yield message;
          continue;
        }
        inputs++;
        // Stop here even if a future implementation accidentally supplies input.
        throw new Error(`Quota reads must not submit ${message.type} messages`);
      }
    })();
    const native = create({ ...input, options, prompt: guardedPrompt });
    const usage = native.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET.bind(native);
    native.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET = async options => {
      expect(options).toEqual({ skipBehaviors: true });
      const report = await usage(options);
      expect(report.behaviors === null).toBe(true);
      expect(report.session.total_cost_usd).toBe(0);
      expect(report.session.total_api_duration_ms).toBe(0);
      expect(Object.keys(report.session.model_usage)).toHaveLength(0);
      controls++;
      return report;
    };
    return native;
  });
  const environment = { ...process.env, CLAUDE_CONFIG_DIR: process.env.SEDES_REAL_CLAUDE_CONFIG_DIRECTORY ?? process.env.CLAUDE_CONFIG_DIR };
  const cwd = process.cwd();
  const auth = vi.spyOn(sdk, "readCliAuthStatus");
  const primary = await probeClaudeSdkDirect({ sdk, executablePath, environment, cwd, timeoutMs: 10_000 });
  const status = await auth.mock.results[0]!.value;
  const primaryKey = claudeQuotaAccountKey(status, primary.account);
  checkingPrimary = false;
  const result = await readClaudeAccountUsage({ sdk, executablePath, signal: AbortSignal.timeout(15_000), environment });
  // Compare inside this process so a mismatch cannot print either private key.
  expect(!!primaryKey && result?.accountKey === primaryKey).toBe(true);
  expect(controls).toBe(1);
  expect(inputs).toBe(0);
  expect(result?.usage.windows.some(row => row.scope.kind === "account")).toBe(true);
  expect(result?.usage.windows.every(row => Number.isFinite(row.remainingPercent) &&
    (row.resetsAt === null || Number.isFinite(row.resetsAt)))).toBe(true);
});
