import { afterEach, describe, expect, it } from "vitest";
import { OpenCodeObservationCursorRepository } from "../../src/server/backends/opencode/opencode-observation-cursor-repository.js";
import { createOpenCodeConversationFixture } from "../support/opencode-conversation-fixture.js";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
function setup() {
  const fixture = createOpenCodeConversationFixture(); cleanups.push(fixture.dispose);
  const authority = fixture.port.authority;
  const repository = new OpenCodeObservationCursorRepository(fixture.database, authority, fixture.context.nativeNamespaceKey);
  const checkpoint = { journalId: "journal", sequence: 0, nativeContinuity: "native-continuity",
    runtimeId: authority.runtimeId, nativeGeneration: authority.nativeGeneration };
  return { ...fixture, authority, repository, checkpoint };
}
describe("OpenCode private observation cursor", () => {
  it("fences scope, exact cursor replacement, gaps and stale owners", () => {
    const f = setup(); f.repository.commit(undefined, f.checkpoint, () => {}, { reset: true });
    expect(f.repository.read()).toEqual(f.checkpoint);
    for (const authority of [{ ...f.authority, principalId: "foreign" },
      { ...f.authority, session: { ...f.authority.session!, bindingFingerprint: "other" } }]) {
      const foreign = new OpenCodeObservationCursorRepository(f.database, authority, f.context.nativeNamespaceKey);
      expect(foreign.read()).toBeUndefined();
    }
    expect(() => f.repository.commit(undefined, f.checkpoint, () => {}, { reset: true })).toThrow("opencode_observation_cursor_conflict");
    expect(() => f.repository.commit(f.checkpoint, { ...f.checkpoint, sequence: 2 }, () => {}, { reset: false })).toThrow("opencode_observation_cursor_conflict");
    expect(() => f.repository.commit(f.checkpoint, { ...f.checkpoint, runtimeId: "other" }, () => {}, { reset: true })).toThrow("opencode_observation_cursor_conflict");
    f.repository.commit(f.checkpoint, { ...f.checkpoint, sequence: 1 }, () => {}, { reset: false });
    expect(f.repository.read()?.sequence).toBe(1);
  });
  it("rolls back both the native cursor and evidence side effects on failed storage", () => {
    const f = setup(); f.database.exec("CREATE TABLE observation_test (value TEXT NOT NULL)");
    f.repository.commit(undefined, f.checkpoint, () => {}, { reset: true });
    f.database.exec("CREATE TRIGGER cursor_abort BEFORE UPDATE ON opencode_observation_cursors BEGIN SELECT RAISE(ABORT,'fixture'); END");
    expect(() => f.repository.commit(f.checkpoint, { ...f.checkpoint, sequence: 1 }, () => {
      f.database.prepare("INSERT INTO observation_test VALUES (?)").run("must rollback");
    }, { reset: false })).toThrow("fixture");
    expect(f.repository.read()).toEqual(f.checkpoint);
    expect(f.database.prepare("SELECT * FROM observation_test").all()).toEqual([]);
  });
});
