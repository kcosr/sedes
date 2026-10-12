// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PageFrameRecoveryAttempt,
  pageFrameNeedsActivation,
  pageFrameRecoveryKey,
} from "./page-frame-recovery.js";

const page = { threadId: "thread", pageId: "page", revision: 1 };

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("page preview recovery", () => {
  it("persists only the scoped revision identity, never admission credentials", () => {
    const key = pageFrameRecoveryKey("https://sedes.example/page-render/secret#channel=secret", page);
    expect(pageFrameNeedsActivation(key)).toBe(false);
    const attempt = new PageFrameRecoveryAttempt(key);
    expect(attempt.recorded).toBe(true);
    expect(pageFrameNeedsActivation(key)).toBe(true);
    expect(localStorage.getItem(localStorage.key(0)!)).not.toContain("secret");
    expect(pageFrameNeedsActivation(pageFrameRecoveryKey("https://other.example/page-render/secret", page))).toBe(false);
    expect(pageFrameNeedsActivation(pageFrameRecoveryKey("https://sedes.example/page-render/new", { ...page, revision: 2 }))).toBe(false);
    attempt.complete();
    expect(pageFrameNeedsActivation(key)).toBe(false);
  });

  it("bounds remembered revisions and updates a repeated entry's recency", () => {
    const key = pageFrameRecoveryKey("https://sedes.example/page-render/token", page);
    for (let revision = 1; revision <= 256; revision += 1)
      new PageFrameRecoveryAttempt(pageFrameRecoveryKey("https://sedes.example/page-render/token", { ...page, revision }));
    new PageFrameRecoveryAttempt(key);
    new PageFrameRecoveryAttempt(pageFrameRecoveryKey("https://sedes.example/page-render/token", { ...page, revision: 257 }));
    expect(pageFrameNeedsActivation(key)).toBe(true);
    expect(pageFrameNeedsActivation(pageFrameRecoveryKey("https://sedes.example/page-render/token", { ...page, revision: 2 }))).toBe(false);
    expect(JSON.parse(localStorage.getItem(localStorage.key(0)!)!)).toHaveLength(256);
  });

  it("requires manual activation when storage cannot preserve recovery state", () => {
    const key = pageFrameRecoveryKey("https://sedes.example/page-render/token", page);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("unavailable"); });
    expect(pageFrameNeedsActivation(key)).toBe(true);
    const attempt = new PageFrameRecoveryAttempt(key);
    expect(attempt.recorded).toBe(false);
    expect(() => attempt.cancel()).not.toThrow();
  });

  it("cancels only its own pending attempt, preserving previous failure and newer ownership", () => {
    const key = pageFrameRecoveryKey("https://sedes.example/page-render/token", page);
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
    const key = pageFrameRecoveryKey("https://sedes.example/page-render/token", page);
    new PageFrameRecoveryAttempt(key);
    expect(pageFrameNeedsActivation(key)).toBe(true);
    const retry = new PageFrameRecoveryAttempt(key);
    retry.cancel();
    expect(pageFrameNeedsActivation(key)).toBe(true);
  });
});
