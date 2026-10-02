import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionMessageInfo } from "@opencode/client";
import { BackendError } from "../../src/server/backends/contracts.js";
import { mapOpenCodeConversationError } from "../../src/server/backends/opencode/opencode-conversation-error.js";
import { OpenCodeHistoryError } from "../../src/server/backends/opencode/opencode-history-reader.js";
import { OpenCodeNativeProtocolError, OpenCodeNativeReadLimitError } from "../../src/server/backends/opencode/opencode-native-api.js";
import { OpenCodeRuntimeError } from "../../src/server/backends/opencode/opencode-release.js";
import { createOpenCodeConversationFixture, scope } from "../support/opencode-conversation-fixture.js";
import { readConversationHistory } from "../helpers/read-conversation-history.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture(messages: SessionMessageInfo[] = []) {
  const current = createOpenCodeConversationFixture({ messages }); cleanup.push(current.dispose); return current;
}
const user = (): SessionMessageInfo => ({ id: "msg_user", type: "user", text: "Question", time: { created: 1 } });
const idle = (): SessionMessageInfo => ({ id: "msg_idle", type: "idle", outcome: "succeeded", time: { created: 2 } });
const setting = (index: number): SessionMessageInfo => ({ id: `msg_setting_${index}`, type: "model-switched",
  model: { providerID: "fixture", id: "fixture" }, time: { created: index + 3 } });

describe("OpenCode read error classification", () => {
  it.each(["C:\\workspace", "\\\\server\\workspace", "relative/workspace", "/workspace/../other"])("rejects noncanonical execution-host path %s before starting a runtime", async canonicalPath => {
    const current = fixture();
    await expect(current.driver.discover({ scope, workspace: { ...current.target.workspace, canonicalPath }, limit: 10,
      signal: new AbortController().signal })).rejects.toMatchObject({ category: "permission_denied", crossedSubmissionBoundary: false });
    expect(current.runtime.start).not.toHaveBeenCalled();
    expect(current.wire.requests.map(request => request.pathname)).toEqual(["/api/event"]);
  });
  it.each(["attach", "discover", "read"] as const)("normalizes transient %s transport failure and releases its lease", async operation => {
    const current = fixture();
    current.wire.setResponse(operation === "discover" ? "/api/session" : `/api/session/${current.wire.sessionID}${operation === "read" ? "/message" : ""}`,
      503, { message: "sensitive provider diagnostic" });
    const read = operation === "discover"
      ? current.driver.discover({ scope, workspace: current.target.workspace, limit: 10, signal: new AbortController().signal })
      : operation === "read" ? readConversationHistory(current.driver, current.target) : current.driver.attach(current.target);
    await expect(read).rejects.toMatchObject({ name: "BackendError", category: "unavailable", retryable: true,
      crossedSubmissionBoundary: false, backendCode: "opencode_request_failed" });
    expect(current.runtime.snapshot().references).toBe(0);
    expect(current.interrupts()).toHaveLength(0);
  });

  it("classifies missing native sessions and runtime startup before lease acquisition", async () => {
    const current = fixture();
    current.wire.setResponse(`/api/session/${current.wire.sessionID}`, 404,
      { _tag: "SessionNotFoundError", sessionID: current.wire.sessionID, message: "sensitive native message" });
    await expect(current.driver.attach(current.target)).rejects.toMatchObject({ name: "BackendError", category: "not_found", retryable: false });
    vi.mocked(current.runtime.start).mockRejectedValueOnce(new OpenCodeRuntimeError("opencode_startup_timeout"));
    await expect(current.driver.attach(current.target)).rejects.toMatchObject({ name: "BackendError", category: "unavailable", retryable: true });
    expect(current.runtime.snapshot().references).toBe(0);
  });

  it("classifies fixed protocol/size limits, readiness timeouts, cancellation and identity loss without raw causes", () => {
    for (const code of ["opencode_request_aborted", "opencode_event_ready_timeout", "opencode_event_disconnected"]) {
      expect(mapOpenCodeConversationError(new OpenCodeRuntimeError(code))).toMatchObject({ category: "unavailable", retryable: true, backendCode: code });
    }
    expect(mapOpenCodeConversationError(new DOMException("private details", "AbortError"))).toMatchObject({ category: "unavailable", retryable: true });
    expect(mapOpenCodeConversationError(new OpenCodeRuntimeError("opencode_runtime_identity_changed")))
      .toMatchObject({ category: "invalid_state", retryable: false, backendCode: "opencode_runtime_identity_changed" });
    expect(mapOpenCodeConversationError(new OpenCodeNativeProtocolError()))
      .toMatchObject({ category: "incompatible_protocol", retryable: false, backendCode: "opencode_history_invalid", projectionRecovery: "futile" });
    expect(mapOpenCodeConversationError(new OpenCodeNativeReadLimitError("response_bytes")))
      .toMatchObject({ retryable: false, backendCode: "opencode_history_limit_response_bytes", projectionRecovery: "futile" });
    const typed = new OpenCodeHistoryError("invalidated");
    expect(mapOpenCodeConversationError(typed)).toBe(typed);
    const raw = mapOpenCodeConversationError(new Error("sensitive provider diagnostic"));
    expect(raw).toBeInstanceOf(BackendError); expect(raw.safeMessage).not.toContain("sensitive"); expect(raw.cause).toBeUndefined();
  });
});

describe("OpenCode bounded residency proof", () => {
  it("keeps an orphaned unfinished period busy despite all process-local inventories being empty", async () => {
    const current = fixture([user()]);
    await expect(current.driver.releaseConversationResidency(current.target)).resolves.toBe("busy");
    current.wire.messages.push(idle());
    await expect(current.driver.releaseConversationResidency(current.target)).resolves.toBe("released");
    expect(current.interrupts()).toHaveLength(0); expect(current.client.lifetime.aborted).toBe(false);
    expect(current.runtime.snapshot().references).toBe(0);
  });

  it("walks bounded pages of settings to the exact unfinished suffix and stops at an idle boundary", async () => {
    const current = fixture([user(), ...Array.from({ length: 100 }, (_, index) => setting(index))]);
    await expect(current.driver.releaseConversationResidency(current.target)).resolves.toBe("busy");
    const pages = current.wire.requests.filter(request => request.pathname.endsWith("/message"));
    expect(pages).toHaveLength(3);
    expect(pages.every(request => request.query.get("limit") === "50")).toBe(true);
    expect(pages[0]!.query.get("order")).toBe("desc");
    expect(pages.slice(1).every(request => request.query.has("cursor") && !request.query.has("order"))).toBe(true);
    current.wire.messages.splice(1, 0, idle());
    await expect(current.driver.releaseConversationResidency(current.target)).resolves.toBe("released");
  });

  it.each(["deleted", "moved"] as const)("reports a proven %s session as terminal absence instead of permanent busy", async kind => {
    const current = fixture([user()]);
    if (kind === "deleted") current.wire.setResponse(`/api/session/${current.wire.sessionID}`, 404,
      { _tag: "SessionNotFoundError", sessionID: current.wire.sessionID, message: "fixture missing" });
    else current.wire.session.location = { directory: "/fixture/moved" };
    await expect(current.driver.releaseConversationResidency(current.target)).rejects.toMatchObject({ name: "BackendError", retryable: false,
      category: kind === "deleted" ? "not_found" : "invalid_state", crossedSubmissionBoundary: false });
    expect(current.wire.requests.filter(request => request.pathname !== "/api/event")).toHaveLength(1);
    expect(current.runtime.assertCurrent).toHaveBeenCalledOnce();
    expect(current.runtime.snapshot().references).toBe(0); expect(current.client.lifetime.aborted).toBe(false);
  });

  it("does not treat missing history or replacement-runtime absence as proof that residency ended", async () => {
    const current = fixture([idle()]);
    current.wire.setResponse(`/api/session/${current.wire.sessionID}/message`, 404,
      { _tag: "SessionNotFoundError", sessionID: current.wire.sessionID, message: "fixture missing" });
    await expect(current.driver.releaseConversationResidency(current.target)).resolves.toBe("busy");
    current.wire.setResponse(`/api/session/${current.wire.sessionID}`, 404,
      { _tag: "SessionNotFoundError", sessionID: current.wire.sessionID, message: "fixture missing" });
    vi.mocked(current.runtime.assertCurrent).mockRejectedValue(new OpenCodeRuntimeError("opencode_runtime_identity_changed"));
    await expect(current.driver.releaseConversationResidency(current.target)).resolves.toBe("busy");
    expect(current.interrupts()).toHaveLength(0); expect(current.runtime.snapshot().references).toBe(0);
  });

  it("bounds malformed repeating history pagination and retains unknown residency", async () => {
    const current = fixture();
    current.wire.setResponse(`/api/session/${current.wire.sessionID}/message`, 200,
      { data: [setting(0)], cursor: { previous: null, next: "repeated" } });
    await expect(current.driver.releaseConversationResidency(current.target)).resolves.toBe("busy");
    expect(current.wire.requests.filter(request => request.pathname.endsWith("/message"))).toHaveLength(2);
    expect(current.interrupts()).toHaveLength(0); expect(current.runtime.snapshot().references).toBe(0);
  });
});
