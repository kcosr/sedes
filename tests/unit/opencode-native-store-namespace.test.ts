import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openCodeNativeStoreNamespaceKey } from "../../src/server/backends/opencode/opencode-native-store.js";
import { openCodeRuntimeNamespaceKey } from "../../src/server/backends/opencode/opencode-runtime.js";

// Namespace preparation runs on main, whose default path implementation may
// differ from the Linux host's. No remote filesystem operation belongs here.
vi.mock("node:path", async importOriginal => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, default: actual.win32 };
});

describe("OpenCode Linux store identity on a Windows main", () => {
  it("preserves existing Linux store and runtime namespace keys", () => {
    expect(path.normalize("/native/opencode.db")).toBe("\\native\\opencode.db");
    expect(openCodeNativeStoreNamespaceKey("/native/opencode.db"))
      .toBe("9c9bc7fd0dffda7052b299070ef07707852fa11add41eb94542696de2d690139");
    expect(openCodeRuntimeNamespaceKey("remote-linux", "/native/opencode.db"))
      .toBe("fa8e671cff4fd166e6be8ae12328e4e0a1ebe037a4a32637c3774302cae0e02b");
    expect(openCodeRuntimeNamespaceKey("another-host", "/native/opencode.db"))
      .not.toBe(openCodeRuntimeNamespaceKey("remote-linux", "/native/opencode.db"));
  });

  it.each(["native.db", "C:\\native\\opencode.db", "C:/native/opencode.db", "\\\\host\\share\\opencode.db",
    "/native/../opencode.db", "/native/./opencode.db", "/native//opencode.db"])
  ("rejects paths outside canonical POSIX grammar: %s", filename => {
    expect(() => openCodeNativeStoreNamespaceKey(filename)).toThrow("opencode_native_store_path_invalid");
  });

  it("retains literal Linux backslashes without retargeting them as separators", () => {
    expect(openCodeNativeStoreNamespaceKey("/native/channel\\one/opencode.db"))
      .not.toBe(openCodeNativeStoreNamespaceKey("/native/channel/one/opencode.db"));
  });
});
