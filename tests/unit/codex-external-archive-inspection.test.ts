import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { inspectExternalCodexThread } from "../../src/server/backends/codex/runtime/codex-external-archive-inspection.js";
import { LocalEnvironmentChannelProvider } from "../../src/server/execution/local-environment-channel.js";

const scope = { tenantId: "tenant", principalId: "principal", backendInstanceId: "codex", executionEnvironmentId: "local" };
const target = { threadId: "native-target", workspace: "/workspace" };

it("accepts only an absent Unix listener in the canonical private directory and preserves identity failures", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "sedes-probe-"));
  const channels = new LocalEnvironmentChannelProvider({ scope, executionEnvironmentId: scope.executionEnvironmentId });
  const opened = vi.spyOn(channels, "openOwnedProcess"), observed = vi.fn();
  const inspect = (socketPath: string) => inspectExternalCodexThread(scope, channels,
    { ownership: "external", channel: { type: "unix_websocket", socketPath } }, target, AbortSignal.timeout(3_000), observed);
  try {
    await chmod(root, 0o700);
    await expect(inspect(path.join(root, "absent.sock"))).resolves.toBe("offline");
    await symlink(path.join(root, "absent.sock"), path.join(root, "dangling.sock"));
    await expect(inspect(path.join(root, "dangling.sock"))).rejects.toThrow();
    await writeFile(path.join(root, "file.sock"), "", { mode: 0o600 });
    await expect(inspect(path.join(root, "file.sock"))).rejects.toThrow();
    await chmod(root, 0o755);
    await expect(inspect(path.join(root, "absent.sock"))).rejects.toThrow();
    expect(opened).not.toHaveBeenCalled();
    expect(observed).not.toHaveBeenCalled();
  } finally { await channels.close(); await rm(root, { recursive: true, force: true }); }
});

it("accepts only a TCP listener refusal after resolving its configured authentication", async () => {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const url = `ws://127.0.0.1:${(listener.address() as AddressInfo).port}`;
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  const channels = new LocalEnvironmentChannelProvider({ scope, executionEnvironmentId: scope.executionEnvironmentId,
    environment: { SEDES_CODEX_TEST_TOKEN: "disposable-test-token-12345" } });
  const observed = vi.fn();
  const inspect = (variable: string) => inspectExternalCodexThread(scope, channels, { ownership: "external", channel: {
    type: "tcp_websocket", url, authentication: { type: "capability_token", secret: { source: "environment", variable } },
  } }, target, AbortSignal.timeout(3_000), observed);
  try {
    await expect(inspect("SEDES_CODEX_TEST_TOKEN")).resolves.toBe("offline");
    await expect(inspect("SEDES_CODEX_ABSENT_TOKEN")).rejects.toThrow();
    expect(observed).not.toHaveBeenCalled();
  } finally { await channels.close(); }
});
