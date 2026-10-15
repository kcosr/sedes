import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkoutGitEnvironment, gitEnvironment } from "../../src/server/workspace-files/git-environment.js";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { promisify } = await import("node:util");
  return {
    ...actual,
    execFile: Object.assign(vi.fn(), { [promisify.custom]: execute }),
  };
});

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
beforeEach(() => {
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  execute.mockReset().mockResolvedValue({ stdout: "" });
});
afterEach(() => {
  Object.defineProperty(process, "platform", platform);
  vi.unstubAllEnvs();
});

function injectedSettings(environment: NodeJS.ProcessEnv) {
  return Object.fromEntries(Array.from({ length: Number(environment.GIT_CONFIG_COUNT ?? 0) }, (_, index) => [
    environment[`GIT_CONFIG_KEY_${index}`], environment[`GIT_CONFIG_VALUE_${index}`],
  ]));
}

describe("Windows checkout Git configuration", () => {
  it("scrubs inherited Git authority and reimports only inert effective checkout settings", async () => {
    vi.stubEnv("GIT_DIR", "unrelated-repository");
    vi.stubEnv("GIT_CONFIG_SYSTEM", "untrusted-system-config");
    vi.stubEnv("GIT_CONFIG_COUNT", "1");
    vi.stubEnv("GIT_CONFIG_KEY_0", "core.fsmonitor");
    vi.stubEnv("GIT_CONFIG_VALUE_0", "untrusted-command");
    vi.stubEnv("gIt_InDeX_fIlE", "untrusted-index");
    execute.mockResolvedValue({ stdout: [
      "core.autocrlf\ntrue", "core.eol\ncrlf", "core.symlinks\nfalse",
      // Git lists lower-priority settings first, then their overrides.
      "core.autocrlf\ninput",
    ].join("\0") + "\0" });

    const environment = await checkoutGitEnvironment("C:\\checkout");
    expect(injectedSettings(environment)).toEqual({
      "core.autocrlf": "input", "core.eol": "crlf", "core.symlinks": "false",
    });
    expect(environment).toMatchObject({ GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_COUNT: "3" });
    expect(environment.GIT_DIR).toBeUndefined();
    expect(environment.GIT_CONFIG_SYSTEM).toBeUndefined();
    expect(Object.keys(environment).filter((key) => key.toUpperCase() === "GIT_INDEX_FILE")).toEqual([]);
    const [executable, arguments_, options] = execute.mock.calls[0]!;
    expect(executable).toBe("git");
    expect(arguments_).toEqual([
      "-C", "C:\\checkout", "config", "--type=bool-or-str", "--null",
      "--get-regexp", "^core\\.(autocrlf|eol|symlinks)$",
    ]);
    expect(options.env.GIT_CONFIG_NOSYSTEM).toBeUndefined();
    expect(options.env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(options.env.GIT_CONFIG_SYSTEM).toBeUndefined();
    expect(Object.keys(options.env).filter((key) => key.toUpperCase() === "GIT_INDEX_FILE")).toEqual([]);
    expect(options).toMatchObject({ timeout: 10_000, maxBuffer: 16 * 1_024, windowsHide: true, killSignal: "SIGKILL" });
  });

  it.each([
    ["core.autocrlf", "true"], ["core.autocrlf", "false"], ["core.autocrlf", "input"],
    ["core.eol", "native"], ["core.eol", "lf"], ["core.eol", "crlf"],
    ["core.symlinks", "true"], ["core.symlinks", "false"],
  ])("preserves Git's canonical bool-or-str value %s=%s", async (key, value) => {
    execute.mockResolvedValue({ stdout: `${key}\n${value}\0` });
    expect(injectedSettings(await checkoutGitEnvironment("C:\\checkout"))).toEqual({ [key]: value });
  });

  it.each([
    "core.fsmonitor\nuntrusted-command\0",
    "filter.untrusted.process\nuntrusted-command\0",
    "core.autocrlf\nuntrusted-command\0",
    "core.eol\ntrue\0",
    "core.symlinks\ninput\0",
    "core.autocrlf\0",
    "\ntrue\0",
  ])("rejects unexpected or malformed config output %j", async (stdout) => {
    execute.mockResolvedValue({ stdout });
    await expect(checkoutGitEnvironment("C:\\checkout")).rejects.toThrow("workspace_file_git_checkout_configuration_invalid");
  });

  it("accepts absent optional settings but preserves configuration read failures", async () => {
    execute.mockRejectedValueOnce(Object.assign(new Error("no matching keys"), { code: 1 }));
    expect(await checkoutGitEnvironment("C:\\checkout")).toEqual(gitEnvironment());
    const failure = Object.assign(new Error("configuration unreadable"), { code: 128 });
    execute.mockRejectedValueOnce(failure);
    await expect(checkoutGitEnvironment("C:\\checkout")).rejects.toBe(failure);
  });

  it("passes cancellation to Git and preserves the caller's abort reason", async () => {
    const controller = new AbortController();
    const reason = new Error("checkout lookup cancelled");
    execute.mockImplementationOnce(async (_command, _arguments, options) => {
      expect(options.signal).toBe(controller.signal);
      controller.abort(reason);
      throw Object.assign(new Error("aborted child"), { code: 1 });
    });
    await expect(checkoutGitEnvironment("C:\\checkout", controller.signal)).rejects.toBe(reason);
  });

  it("keeps non-Windows Git commands system-config-free without an inspection process", async () => {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
    expect(await checkoutGitEnvironment("/checkout")).toEqual(gitEnvironment());
    expect(execute).not.toHaveBeenCalled();
  });
});
