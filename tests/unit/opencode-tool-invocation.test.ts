import { describe, expect, it } from "vitest";
import { assertOpenCodeInvocationAuthority, assertOpenCodeInvocationSource, captureOpenCodeInvocation,
  parseOpenCodeToolInvocationStamp, runWithOpenCodeInvocation } from "../../src/server/backends/opencode/opencode-tool-invocation.js";

const stamp = () => ({ authority: { tenantId: "tenant", principalId: "principal", executionEnvironmentId: "environment",
  backendInstanceId: "backend", runtimeId: "runtime", nativeGeneration: "generation", directory: "/workspace",
  session: { applicationThreadId: "thread", nativeSessionID: "ses_fixture", bindingFingerprint: "a".repeat(64) } },
  journalId: "journal", throughSequence: 2, nativeContinuity: "continuity", inputId: "msg_user", authorityEpoch: 1, nativeConnected: true });

describe("OpenCode private invocation context", () => {
  it("strictly validates and detaches immutable stamp identity", () => {
    const input = stamp(), parsed = parseOpenCodeToolInvocationStamp(input);
    input.authority.session.nativeSessionID = "ses_foreign";
    expect(parsed.authority.session.nativeSessionID).toBe("ses_fixture");
    expect(Object.isFrozen(parsed) && Object.isFrozen(parsed.authority) && Object.isFrozen(parsed.authority.session)).toBe(true);
    expect(() => parseOpenCodeToolInvocationStamp({ ...stamp(), extra: true })).toThrow();
    expect(() => parseOpenCodeToolInvocationStamp({ ...stamp(), authority: { ...stamp().authority, session: undefined } })).toThrow();
    expect(() => parseOpenCodeToolInvocationStamp({ ...stamp(), throughSequence: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });
  it("isolates concurrent async invocations and restores the parent context", async () => {
    const captures = await Promise.all([1, 2].map(authorityEpoch => runWithOpenCodeInvocation({ ...stamp(), authorityEpoch }, async () => {
      await Promise.resolve(); const captured = captureOpenCodeInvocation()!;
      runWithOpenCodeInvocation({ ...stamp(), authorityEpoch: 3 }, () => expect(captureOpenCodeInvocation()?.authorityEpoch).toBe(3));
      expect(captureOpenCodeInvocation()).toBe(captured); return captured.authorityEpoch;
    })));
    expect(captures).toEqual([1, 2]); expect(captureOpenCodeInvocation()).toBeUndefined();
  });
  it("rejects wrong source scope and any changed native authority field", () => {
    const value = parseOpenCodeToolInvocationStamp(stamp());
    const source = { scope: { tenantId: "tenant", principalId: "principal" }, sourceEnvironmentId: "environment",
      sourceWorkspaceId: "workspace", sourceThreadId: "thread", backendKind: "opencode" as const };
    expect(() => assertOpenCodeInvocationSource(value, source)).not.toThrow();
    for (const sourceThreadId of ["foreign", ""]) expect(() => assertOpenCodeInvocationSource(value, { ...source, sourceThreadId })).toThrow();
    for (const field of ["tenantId", "principalId", "executionEnvironmentId", "backendInstanceId", "runtimeId", "nativeGeneration", "directory"] as const) {
      expect(() => assertOpenCodeInvocationAuthority(value, { ...value.authority, [field]: "foreign" })).toThrow();
    }
    expect(() => assertOpenCodeInvocationAuthority(value, { ...value.authority,
      session: { ...value.authority.session, bindingFingerprint: "b".repeat(64) } })).toThrow();
  });
});
