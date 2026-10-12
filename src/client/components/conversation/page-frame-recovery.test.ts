// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectionScope } from "../../app/connection-scope.js";
import { ELECTRON_LOCAL_CONNECTION_PROFILE_ID } from "../../app/electron-connections.js";
import {
  PageFrameRecoveryAttempt,
  pageFrameNeedsActivation,
  pageFrameRecoveryKey,
} from "./page-frame-recovery.js";

const page = { threadId: "thread", pageId: "page", revision: 1 };
const scope = connectionScope("browser", "https://sedes.example", "alice");

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("page preview recovery", () => {
  it("persists only the scoped revision identity, never admission credentials", () => {
    const key = pageFrameRecoveryKey(scope, page);
    expect(pageFrameNeedsActivation(key)).toBe(false);
    const attempt = new PageFrameRecoveryAttempt(key);
    expect(attempt.recorded).toBe(true);
    expect(pageFrameNeedsActivation(key)).toBe(true);
    const entries = JSON.parse(localStorage.getItem(localStorage.key(0)!)!);
    expect(entries).toEqual([{ key, owner: expect.any(String) }]);
    expect(JSON.parse(key)).toEqual([JSON.stringify(["browser", "https://sedes.example", "alice"]), "thread", "page", 1]);
    expect(pageFrameNeedsActivation(pageFrameRecoveryKey(scope, { ...page, revision: 2 }))).toBe(false);
    attempt.complete();
    expect(pageFrameNeedsActivation(key)).toBe(false);
  });

  it("retains unfinished Managed Local renders across transport port changes", () => {
    const beforeRestart = connectionScope(ELECTRON_LOCAL_CONNECTION_PROFILE_ID, "http://127.0.0.1:31001", "alice");
    const afterRestart = connectionScope(ELECTRON_LOCAL_CONNECTION_PROFILE_ID, "http://127.0.0.1:31002", "alice");
    const originalKey = pageFrameRecoveryKey(beforeRestart, page);
    new PageFrameRecoveryAttempt(originalKey);
    expect(pageFrameRecoveryKey(afterRestart, page)).toBe(originalKey);
    expect(pageFrameNeedsActivation(pageFrameRecoveryKey(afterRestart, page))).toBe(true);
    const anotherIdentity = connectionScope(ELECTRON_LOCAL_CONNECTION_PROFILE_ID, "http://127.0.0.1:31002", "bob");
    expect(pageFrameNeedsActivation(pageFrameRecoveryKey(anotherIdentity, page))).toBe(false);
  });

  it("keeps direct origins, connection profiles, identities, threads and pages separate", () => {
    const direct = connectionScope("direct", "http://127.0.0.1:31001", "alice");
    new PageFrameRecoveryAttempt(pageFrameRecoveryKey(direct, page));
    for (const other of [
      connectionScope("direct", "http://127.0.0.1:31002", "alice"),
      connectionScope("another-profile", "http://127.0.0.1:31001", "alice"),
      connectionScope("direct", "http://127.0.0.1:31001", "bob"),
      connectionScope(ELECTRON_LOCAL_CONNECTION_PROFILE_ID, "http://127.0.0.1:31001", "alice"),
    ]) expect(pageFrameNeedsActivation(pageFrameRecoveryKey(other, page))).toBe(false);
    expect(pageFrameNeedsActivation(pageFrameRecoveryKey(direct, { ...page, threadId: "another-thread" }))).toBe(false);
    expect(pageFrameNeedsActivation(pageFrameRecoveryKey(direct, { ...page, pageId: "another-page" }))).toBe(false);
  });

  it("bounds remembered revisions and updates a repeated entry's recency", () => {
    const key = pageFrameRecoveryKey(scope, page);
    for (let revision = 1; revision <= 256; revision += 1)
      new PageFrameRecoveryAttempt(pageFrameRecoveryKey(scope, { ...page, revision }));
    new PageFrameRecoveryAttempt(key);
    new PageFrameRecoveryAttempt(pageFrameRecoveryKey(scope, { ...page, revision: 257 }));
    expect(pageFrameNeedsActivation(key)).toBe(true);
    expect(pageFrameNeedsActivation(pageFrameRecoveryKey(scope, { ...page, revision: 2 }))).toBe(false);
    expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!)).toHaveLength(256);
  });

  it("requires manual activation when storage cannot preserve recovery state", () => {
    const key = pageFrameRecoveryKey(scope, page);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
    expect(pageFrameNeedsActivation(key)).toBe(true);
    const attempt = new PageFrameRecoveryAttempt(key);
    expect(attempt.recorded).toBe(false);
    expect(() => attempt.cancel()).not.toThrow();
  });

  it("cancels only its own pending attempt, preserving previous failure and newer ownership", () => {
    const key = pageFrameRecoveryKey(scope, page);
    const prior = new PageFrameRecoveryAttempt(key);
    prior.fail();
    const retry = new PageFrameRecoveryAttempt(key);
    retry.cancel();
    expect(pageFrameNeedsActivation(key)).toBe(true);
    const inline = new PageFrameRecoveryAttempt(key);
    const dialog = new PageFrameRecoveryAttempt(key);
    inline.cancel();
    expect(pageFrameNeedsActivation(key)).toBe(true);
    dialog.complete();
    expect(pageFrameNeedsActivation(key)).toBe(false);
    // A stale cleanup cannot delete a later run's marker.
    const newer = new PageFrameRecoveryAttempt(key);
    dialog.cancel();
    expect(pageFrameNeedsActivation(key)).toBe(true);
    newer.cancel();
    expect(pageFrameNeedsActivation(key)).toBe(false);
  });

  it("keeps unanswered attempts if their process never performs cleanup", () => {
    const key = pageFrameRecoveryKey(scope, page);
    new PageFrameRecoveryAttempt(key);
    expect(pageFrameNeedsActivation(key)).toBe(true);
    const retry = new PageFrameRecoveryAttempt(key);
    retry.cancel();
    expect(pageFrameNeedsActivation(key)).toBe(true);
  });
});
