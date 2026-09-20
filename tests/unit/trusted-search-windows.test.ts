import { expect, it, vi } from "vitest";
import { assertTrustedWindowsSearchPath } from "../../src/server/workspace-tools/trusted-search-windows.js";

it("runs a bounded native ACL inspection using literal path authority and fails closed", async () => {
  const candidate = "C:\\Program Files\\ripgrep\\rg.exe";
  const run = vi.fn(async () => ({
    stdout: JSON.stringify({ path: candidate, trusted: true }),
  }));
  await assertTrustedWindowsSearchPath(candidate, run, "C:\\Windows");
  const call = run.mock.calls[0] as unknown as [
    string,
    string[],
    { env: NodeJS.ProcessEnv },
  ];
  expect(call[0]).toBe(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  expect(call[2].env.SEDES_SEARCH_EXECUTABLE).toBe(candidate);
  const script = Buffer.from(call[1].at(-1)!, "base64").toString("utf16le");
  expect(script).toContain("GetAccessRules");
  expect(script).toContain("ReparsePoint");
  run.mockResolvedValueOnce({
    stdout: JSON.stringify({ path: "C:\\other.exe", trusted: true }),
  });
  await expect(
    assertTrustedWindowsSearchPath(candidate, run, "C:\\Windows"),
  ).rejects.toThrow("trusted_search_path_untrusted");
  run.mockRejectedValueOnce(new Error("untrusted ACL"));
  await expect(
    assertTrustedWindowsSearchPath(candidate, run, "C:\\Windows"),
  ).rejects.toThrow("untrusted ACL");
  await expect(
    assertTrustedWindowsSearchPath("\\\\?\\C:\\rg.exe", run, "C:\\Windows"),
  ).rejects.toThrow("trusted_search_path_invalid");
});

it.skipIf(process.platform !== "win32")(
  "validates native Windows system executable ACLs",
  async () => {
    await expect(
      assertTrustedWindowsSearchPath(
        `${process.env.SystemRoot}\\System32\\where.exe`,
      ),
    ).resolves.toBeUndefined();
  },
);
