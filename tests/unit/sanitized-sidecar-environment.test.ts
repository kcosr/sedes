import { describe, expect, it } from "vitest";
import { buildSanitizedSidecarEnvironment } from "../../src/server/sidecar/sanitized-sidecar-environment.js";

describe("sidecar account environment", () => {
  it.each(["linux", "darwin"] as const)("preserves the POSIX allowlist on %s", (platform) => {
    const environment = buildSanitizedSidecarEnvironment({
      HOME: "/home/account", PATH: "/usr/bin", LANG: "en_US.UTF-8", LC_ALL: "C", TMPDIR: "/tmp",
      USER: "account", LOGNAME: "account", Path: "ignored", USERPROFILE: "ignored", SystemRoot: "ignored",
      NODE_OPTIONS: "--require injected.js", LD_PRELOAD: "injected.so", TOKEN: "secret", LC_BAD: "$(command)",
    }, platform);
    expect(environment).toEqual({ HOME: "/home/account", PATH: "/usr/bin", LANG: "en_US.UTF-8", LC_ALL: "C", TMPDIR: "/tmp", USER: "account", LOGNAME: "account" });
    expect(Object.isFrozen(environment)).toBe(true);
    expect(Object.getPrototypeOf(environment)).toBe(null);
  });

  it("keeps Windows account and executable discovery with canonical case", () => {
    expect(buildSanitizedSidecarEnvironment({
      Path: "C:\\Windows\\System32;C:\\Users\\account\\bin", systemroot: "C:\\Windows", WINDIR: "C:\\Windows",
      comspec: "C:\\Windows\\System32\\cmd.exe", userprofile: "C:\\Users\\account", HOMEDRIVE: "C:", HOMEPATH: "\\Users\\account",
      AppData: "C:\\Users\\account\\AppData\\Roaming", LocalAppData: "C:\\Users\\account\\AppData\\Local",
      TEMP: "C:\\Temp", TMP: "C:\\Temp", pathext: ".COM;.EXE;.BAT;.CMD", USERNAME: "account",
      NODE_OPTIONS: "--require injected.js", NODE_PATH: "C:\\injected", API_TOKEN: "secret", PSModulePath: "C:\\injected",
    }, "win32")).toEqual({
      PATH: "C:\\Windows\\System32;C:\\Users\\account\\bin", SystemRoot: "C:\\Windows", windir: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe", USERPROFILE: "C:\\Users\\account", HOMEDRIVE: "C:", HOMEPATH: "\\Users\\account",
      APPDATA: "C:\\Users\\account\\AppData\\Roaming", LOCALAPPDATA: "C:\\Users\\account\\AppData\\Local",
      TEMP: "C:\\Temp", TMP: "C:\\Temp", PATHEXT: ".COM;.EXE;.BAT;.CMD", USERNAME: "account",
    });
  });

  it("rejects ambiguous Windows keys and invalid values", () => {
    expect(buildSanitizedSidecarEnvironment({ PATH: "one", Path: "two", path: "three", USERPROFILE: "C:\\Users\\account\nmalformed", TMP: "\0", TEMP: "a".repeat(4097), SystemRoot: "C:\\Windows" }, "win32"))
      .toEqual({ SystemRoot: "C:\\Windows" });
  });
});
