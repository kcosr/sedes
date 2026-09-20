import { describe, expect, it } from "vitest";
import { parseResolvedBackendConfiguration } from "../support/resolved-backend-configuration.js";
import { openOverlayDatabase } from "../../src/server/db/database.js";
import { applyBackendNormalizationMigration, applyDatabaseMigrations, backendNormalizedMigrations } from "../../src/server/db/migrate.js";
import { WorkpadRepository } from "../../src/server/db/repositories/workpad-repository.js";
import { SingleUserIdentityProvider } from "../../src/server/identity/identity-provider.js";
import { OverlayRepository } from "../support/schema9/overlay-repository.js";
import { ThreadInventoryService } from "../support/schema9/thread-inventory-service.js";

const configuration = parseResolvedBackendConfiguration({
  schemaVersion: 10,
  executionEnvironments: [
    {
      id: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      kind: "local",
      label: "Local",
    },
  ],
  backends: [
    {
      id: "pi-primary",
      kind: "pi",
      label: "Primary Pi",
      enabled: true,
      modelPolicy: { type: "catalog" },
    },
  ],
  targets: [
    {
      id: "local-primary",
      kind: "pi_sdk",
      label: "Primary Local SDK",
      backendInstanceId: "pi-primary",
      executionEnvironmentId: "019196f7-a0a8-7bc4-a89b-8cf013978405",
      enabled: true,
    },
  ],
  defaultTargetId: "local-primary",
});

function fixture(latestVersion = backendNormalizedMigrations.at(-1)!.version) {
  const database = openOverlayDatabase(":memory:");
  const scope = new SingleUserIdentityProvider(database).getScope();
  const legacy = new ThreadInventoryService(new OverlayRepository(database));
  const environment = legacy.getLocalEnvironment(scope);
  const firstWorkspace = legacy.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/tasks-first",
      displayName: "Tasks first",
      availability: "available",
      trustState: "trusted",
    },
    100,
  );
  const secondWorkspace = legacy.rememberWorkspace(
    scope,
    {
      environmentId: environment.id,
      canonicalPath: "/tmp/tasks-second",
      displayName: "Tasks second",
      availability: "available",
      trustState: "trusted",
    },
    110,
  );
  const firstThread = legacy.createThread(
    scope,
    { workspaceId: firstWorkspace.id, title: "First thread" },
    200,
  );
  const secondThread = legacy.createThread(
    scope,
    { workspaceId: secondWorkspace.id, title: "Second thread" },
    210,
  );
  applyBackendNormalizationMigration(database, {
    configuration,
    quiescentCutoverConfirmed: true,
    appliedAt: 300,
  });
  applyDatabaseMigrations(
    database,
    backendNormalizedMigrations.filter(
      (migration) => migration.version <= latestVersion,
    ),
  );
  return {
    database,
    scope,
    environmentId: environment.id,
    firstWorkspaceId: firstWorkspace.id,
    secondWorkspaceId: secondWorkspace.id,
    firstThreadId: firstThread.thread.id,
    secondThreadId: secondThread.thread.id,
    workpads: new WorkpadRepository(database),
  };
}

const errorCode = (code: string) => expect.objectContaining({ code });

describe("WorkpadRepository", () => {
  it("fences retries and no-op replacements without creating duplicate revisions", () => {
    const f = fixture();
    try {
      const pad = f.workpads.create(f.scope, { title: "Integration", scope: { kind: "global" }, content: "Original" });
      expect(pad.revision).toBe(0);
      const request = { expectedRevision: 0, edit: { kind: "replace" as const, content: "Updated" } };
      const updated = f.workpads.update(f.scope, pad.id, request);
      expect(updated.revision).toBe(1);
      expect(() => f.workpads.update(f.scope, pad.id, request)).toThrow(errorCode("conflict"));
      const unchanged = f.workpads.update(f.scope, pad.id, { expectedRevision: 1, edit: { kind: "replace", content: "Updated" } });
      expect(unchanged.revision).toBe(1);
      expect(f.workpads.revisions(f.scope, pad.id).items).toHaveLength(2);
    } finally { f.database.close(); }
  });

  it("rejects missing and ambiguous exact matches without committing any part of a patch batch", () => {
    const f = fixture();
    try {
      const pad = f.workpads.create(f.scope, { title: "Patch", scope: { kind: "global" }, content: "First. repeat repeat" });
      for (const oldText of ["missing", "repeat"]) {
        expect(() => f.workpads.update(f.scope, pad.id, { expectedRevision: 0, title: "Must roll back", edit: { kind: "patch", edits: [{ oldText: "First", newText: "Changed" }, { oldText, newText: "replacement" }] } })).toThrow(errorCode("conflict"));
        expect(f.workpads.get(f.scope, pad.id)).toMatchObject({ title: "Patch", content: pad.content, revision: 0 });
        expect(f.workpads.revisions(f.scope, pad.id).items).toHaveLength(1);
      }
      expect(f.workpads.update(f.scope, pad.id, { expectedRevision: 0, edit: { kind: "patch", edits: [{ oldText: "First", newText: "Changed" }] } }).content).toBe("Changed. repeat repeat");
    } finally { f.database.close(); }
  });

  it("retains attribution on surviving text and records deletions in immutable history", () => {
    const f = fixture();
    try {
      const pad = f.workpads.create(f.scope, { title: "Attribution", scope: { kind: "thread", threadId: f.firstThreadId }, content: "Use a 30-minute timeout.\nRemove this." }, { kind: "agent", threadId: f.firstThreadId }, 1000);
      const updated = f.workpads.update(f.scope, pad.id, { expectedRevision: 0, edit: { kind: "replace", content: "Use a 15-minute timeout." } }, { kind: "user" }, 2000);
      expect(updated.attribution.map(span => updated.content.slice(span.start, span.end)).join("")).toBe(updated.content);
      const attributionAt = (offset: number) => updated.attribution.find(span => span.start <= offset && span.end > offset)?.author;
      expect(attributionAt(0)).toMatchObject({ kind: "agent", threadId: f.firstThreadId, name: "First thread" });
      expect(attributionAt(updated.content.indexOf("15"))).toMatchObject({ kind: "user" });
      expect(attributionAt(updated.content.indexOf("timeout"))).toMatchObject({ kind: "agent" });
      const original = f.workpads.revision(f.scope, pad.id, 0);
      expect(original.content).toBe(pad.content);
      expect(original.attribution.every(span => span.author.kind === "agent")).toBe(true);
      expect(f.workpads.revision(f.scope, pad.id, 1).changes.filter(change => change.kind === "removed").map(change => change.text).join("")).toContain("Remove this");
      expect(f.workpads.revision(f.scope, pad.id, 1).author.kind).toBe("user");
    } finally { f.database.close(); }
  });

  it("resolves live thread names without changing captured attribution identities", () => {
    const f = fixture();
    try {
      const pad = f.workpads.create(f.scope, { title: "Names", scope: { kind: "global" }, content: "Agent text" }, { kind: "agent", threadId: f.firstThreadId });
      f.database.prepare("UPDATE application_threads SET title = ? WHERE id = ?").run("Renamed thread", f.firstThreadId);
      expect(f.workpads.get(f.scope, pad.id).attribution[0]?.author).toMatchObject({ threadId: f.firstThreadId, name: "Renamed thread", nameSnapshot: "First thread" });
      expect(f.workpads.revision(f.scope, pad.id, 0).author).toMatchObject({ threadId: f.firstThreadId, name: "Renamed thread", nameSnapshot: "First thread" });
    } finally { f.database.close(); }
  });

  it("lists exact and subtree scopes with bounded search and pagination", () => {
    const f = fixture();
    try {
      const first = f.workpads.create(f.scope, { title: "Auth one", scope: { kind: "thread", threadId: f.firstThreadId }, content: "Token" }, undefined, 1000);
      const second = f.workpads.create(f.scope, { title: "Auth two", scope: { kind: "workspace", workspaceId: f.firstWorkspaceId }, content: "Expiry" }, undefined, 2000);
      f.workpads.create(f.scope, { title: "Unrelated", scope: { kind: "thread", threadId: f.secondThreadId }, content: "Other" }, undefined, 3000);
      expect(f.workpads.list(f.scope, { scope: { kind: "workspace", workspaceId: f.firstWorkspaceId } }).items.map(item => item.id)).toEqual([second.id]);
      const options = { scope: { kind: "workspace" as const, workspaceId: f.firstWorkspaceId }, scopeMode: "subtree" as const, limit: 1 };
      const page = f.workpads.list(f.scope, options);
      expect(page.nextCursor).toBeDefined();
      const next = f.workpads.list(f.scope, { ...options, cursor: page.nextCursor });
      expect([...page.items, ...next.items].map(item => item.id).sort()).toEqual([first.id, second.id].sort());
      expect(next.nextCursor).toBeUndefined();
      expect(f.workpads.list(f.scope, { scope: { kind: "global" }, scopeMode: "subtree", query: "Token" }).items.map(item => item.id)).toEqual([first.id]);
    } finally { f.database.close(); }
  });

  it("preserves the matched occurrence and unchanged text attribution in targeted patches", () => {
    const f = fixture();
    try {
      let pad = f.workpads.create(f.scope, { title: "Occurrences", scope: { kind: "global" }, content: "start aaa" }, { kind: "agent", threadId: f.firstThreadId });
      pad = f.workpads.update(f.scope, pad.id, { expectedRevision: 0, edit: { kind: "append", text: " aaa" } });
      pad = f.workpads.update(f.scope, pad.id, { expectedRevision: 1, edit: { kind: "patch", edits: [{ oldText: "start aaa", newText: "start aa!" }] } }, { kind: "agent", threadId: f.secondThreadId });
      expect(pad.content).toBe("start aa! aaa");
      const attributionAt = (offset: number) => pad.attribution.find(span => span.start <= offset && span.end > offset)?.author;
      expect(attributionAt(0)).toMatchObject({ kind: "agent", threadId: f.firstThreadId });
      expect(attributionAt(pad.content.indexOf("!"))).toMatchObject({ kind: "agent", threadId: f.secondThreadId });
      expect(attributionAt(pad.content.length - 1)).toMatchObject({ kind: "user" });
      expect(pad.attribution.map(span => pad.content.slice(span.start, span.end)).join("")).toBe(pad.content);
    } finally { f.database.close(); }
  });

  it("filters lists by authority and binds continuation cursors to owner and access boundary", () => {
    const f = fixture();
    try {
      const global = f.workpads.create(f.scope, { title: "Global", scope: { kind: "global" }, content: "Global content" }, undefined, 1000);
      const local = f.workpads.create(f.scope, { title: "Local", scope: { kind: "thread", threadId: f.firstThreadId }, content: "Local content" }, undefined, 2000);
      const other = f.workpads.create(f.scope, { title: "Other", scope: { kind: "thread", threadId: f.secondThreadId } }, undefined, 3000);
      const input = { scope: { kind: "global" as const }, scopeMode: "subtree" as const };
      expect(f.workpads.list(f.scope, input, { environmentIds: [], continuationKey: "no-environments" }).items.map(item => item.id)).toEqual([global.id]);
      expect(f.workpads.list(f.scope, input, { environmentIds: [f.environmentId], continuationKey: "local" }).items.map(item => item.id)).toEqual([other.id, local.id, global.id]);
      const page = f.workpads.list(f.scope, { ...input, limit: 1 }, { continuationKey: "first-policy" });
      expect(page.nextCursor).toBeDefined();
      expect(() => f.workpads.list(f.scope, { ...input, limit: 1, cursor: page.nextCursor }, { continuationKey: "changed-policy" })).toThrow(errorCode("cursor_invalid"));
      expect(() => f.workpads.list({ ...f.scope, principalId: "another-owner" }, { ...input, limit: 1, cursor: page.nextCursor }, { continuationKey: "first-policy" })).toThrow(errorCode("cursor_invalid"));
      for (const item of page.items) {
        expect(item).not.toHaveProperty("content");
        expect(item).not.toHaveProperty("attribution");
      }
      for (const item of f.workpads.revisions(f.scope, local.id).items) {
        expect(item).not.toHaveProperty("content");
        expect(item).not.toHaveProperty("attribution");
        expect(item).not.toHaveProperty("changes");
      }
    } finally { f.database.close(); }
  });

  it("attributes explicitly selected large rewrites without changing surrounding provenance", () => {
    const f = fixture();
    try {
      const oldText = "a".repeat(3000);
      const newText = "b".repeat(3000);
      const pad = f.workpads.create(f.scope, { title: "Large patch", scope: { kind: "global" }, content: `Before\n${oldText}\nAfter` });
      const updated = f.workpads.update(f.scope, pad.id, { expectedRevision: 0, edit: { kind: "patch", edits: [{ oldText, newText }] } }, { kind: "agent", threadId: f.firstThreadId });
      expect(updated.content).toBe(`Before\n${newText}\nAfter`);
      expect(updated.attribution.map(span => ({ text: updated.content.slice(span.start, span.end), kind: span.author.kind }))).toEqual([
        { text: "Before\n", kind: "user" },
        { text: newText, kind: "agent" },
        { text: "\nAfter", kind: "user" },
      ]);
    } finally { f.database.close(); }
  });

  it("commits a large initial user draft and preserves attribution through large insertions and deletions", () => {
    const f = fixture();
    try {
      const pad = f.workpads.create(f.scope, { title: "Large draft", scope: { kind: "global" } });
      const initial = `Before\n${"working notes\n".repeat(300)}After`;
      const draft = f.workpads.saveDraft(f.scope, pad.id, { expectedRevision: 0, baseRevision: 0, content: initial });
      const saved = f.workpads.commitDraft(f.scope, pad.id, { expectedDraftRevision: draft.revision, expectedRevision: 0 });
      expect(saved.content).toBe(initial);
      expect(saved.revision).toBe(1);
      expect(saved.attribution).toHaveLength(1);
      expect(saved.attribution[0]?.author.kind).toBe("user");

      const addition = "Agent contribution\n".repeat(300);
      const inserted = f.workpads.update(f.scope, pad.id, { expectedRevision: 1, edit: { kind: "replace", content: `Before\n${addition}${initial.slice(7)}` } }, { kind: "agent", threadId: f.firstThreadId });
      expect(inserted.attribution.map(span => ({ text: inserted.content.slice(span.start, span.end), kind: span.author.kind }))).toEqual([
        { text: "Before\n", kind: "user" },
        { text: addition, kind: "agent" },
        { text: initial.slice(7), kind: "user" },
      ]);
      const deleted = f.workpads.update(f.scope, pad.id, { expectedRevision: 2, edit: { kind: "replace", content: initial } }, { kind: "agent", threadId: f.secondThreadId });
      expect(deleted.content).toBe(initial);
      expect(deleted.attribution).toHaveLength(1);
      expect(deleted.attribution[0]).toMatchObject({ start: 0, end: initial.length, revision: 1, author: { kind: "user" } });
      expect(f.workpads.revision(f.scope, pad.id, 3).changes).toEqual([{ kind: "removed", text: addition, offset: 7 }]);
    } finally { f.database.close(); }
  });

  it("commits separated large draft insertions while preserving surviving provenance", () => {
    const f = fixture();
    try {
      const original = "# Notes\n\n## Section A\nKeep A.\n\n## Section B\nKeep B.\n\n## End\n";
      const pad = f.workpads.create(f.scope, { title: "Multi-section draft", scope: { kind: "global" }, content: original }, { kind: "agent", threadId: f.firstThreadId });
      // These long words exceed the character budget; the second case also
      // exceeds the word budget, exercising deterministic line alignment.
      for (const addition of ["paragraph ".repeat(130) + "\n", "many words ".repeat(700) + "\n"]) {
        const content = original.replace("## Section B", addition + "## Section B").replace("## End", addition + "## End");
        const current = f.workpads.get(f.scope, pad.id);
        const draft = f.workpads.getDraft(f.scope, pad.id);
        const saved = f.workpads.saveDraft(f.scope, pad.id, { expectedRevision: draft.revision, baseRevision: current.revision, content });
        const committed = f.workpads.commitDraft(f.scope, pad.id, { expectedDraftRevision: saved.revision, expectedRevision: current.revision });
        expect(committed.content).toBe(content);
        expect(committed.attribution.filter(span => span.author.kind === "agent").map(span => content.slice(span.start, span.end)).join("")).toBe(original);
        const authored = committed.attribution.filter(span => span.author.kind === "user").map(span => content.slice(span.start, span.end)).join("");
        expect(authored).toHaveLength(addition.length * 2);
        expect(authored.replace(/\s/g, "")).toBe((addition + addition).replace(/\s/g, ""));
        expect(committed.attribution.map(span => content.slice(span.start, span.end)).join("")).toBe(content);
        f.workpads.update(f.scope, pad.id, { expectedRevision: committed.revision, edit: { kind: "replace", content: original } });
      }
    } finally { f.database.close(); }
  });

  it("reports the attribution limit before schema validation and leaves the document unchanged", () => {
    const f = fixture();
    try {
      const pad = f.workpads.create(f.scope, { title: "Attribution limit", scope: { kind: "global" }, content: "x".repeat(4096) });
      // Seed a valid boundary-sized document with alternating revision spans.
      const attribution = Array.from({ length: 4096 }, (_, start) => ({ ...pad.attribution[0]!, start, end: start + 1, revision: start % 2 }));
      f.database.prepare("UPDATE workpads SET document_json=? WHERE id=?").run(JSON.stringify({ ...pad, revision: 1, attribution }), pad.id);
      expect(() => f.workpads.update(f.scope, pad.id, { expectedRevision: 1, edit: { kind: "append", text: "new" } }, { kind: "agent", threadId: f.firstThreadId })).toThrow("exceeds the workpad attribution limit");
      expect(f.workpads.get(f.scope, pad.id)).toMatchObject({ revision: 1, content: pad.content });
      expect(f.workpads.revisions(f.scope, pad.id).items).toHaveLength(1);
    } finally { f.database.close(); }
  });

  it("keeps complete Unicode code points at shared prefix and suffix alignment edges", () => {
    const f = fixture();
    try {
      for (const replacement of ["\u{10001}", "\u{10400}"]) {
        const pad = f.workpads.create(f.scope, { title: "Unicode edges", scope: { kind: "global" }, content: "Left \u{10000} right" });
        const updated = f.workpads.update(f.scope, pad.id, { expectedRevision: 0, edit: { kind: "replace", content: `Left ${replacement} right` } }, { kind: "agent", threadId: f.firstThreadId });
        expect(updated.attribution.map(span => ({ text: updated.content.slice(span.start, span.end), kind: span.author.kind }))).toEqual([
          { text: "Left ", kind: "user" },
          { text: replacement, kind: "agent" },
          { text: " right", kind: "user" },
        ]);
        const changes = f.workpads.revision(f.scope, pad.id, 1).changes;
        expect(changes).toEqual([{ kind: "removed", text: "\u{10000}", offset: 5 }, { kind: "added", text: replacement, offset: 5 }]);
      }
    } finally { f.database.close(); }
  });

  it("rejects replacements beyond the deterministic diff budget atomically while allowing explicit patches", () => {
    const f = fixture();
    try {
      const passages = ["first", "second", "third"].map(label => `${label}:\n${"a\n".repeat(400)}`);
      const replacements = passages.map(passage => passage.replaceAll("a\n", "b\n"));
      const original = passages.join("");
      const replacement = replacements.join("");
      const pad = f.workpads.create(f.scope, { title: "Bounded diff", scope: { kind: "global" }, content: original });
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() => f.workpads.update(f.scope, pad.id, { expectedRevision: 0, title: "Rejected", edit: { kind: "replace", content: replacement } })).toThrow(errorCode("bad_request"));
        expect(f.workpads.get(f.scope, pad.id)).toMatchObject({ title: "Bounded diff", content: original, revision: 0 });
        expect(f.workpads.revisions(f.scope, pad.id).items).toHaveLength(1);
      }
      const patched = f.workpads.update(f.scope, pad.id, { expectedRevision: 0, edit: { kind: "patch", edits: passages.map((oldText, index) => ({ oldText, newText: replacements[index]! })) } }, { kind: "agent", threadId: f.firstThreadId });
      expect(patched.content).toBe(replacement);
      expect(patched.attribution.filter(span => span.author.kind === "agent").map(span => patched.content.slice(span.start, span.end))).toEqual(Array(1200).fill("b"));
    } finally { f.database.close(); }
  });

  it("preserves Unicode text and keeps attribution ranges contiguous through replacements and append", () => {
    const f = fixture();
    try {
      let pad = f.workpads.create(f.scope, { title: "Unicode", scope: { kind: "global" }, content: "Hello 👋 café\n" }, { kind: "agent", threadId: f.firstThreadId });
      for (const content of ["Hello 🌍 café\n", "Hello 🌍 café\n日本語", "日本語"]) {
        pad = f.workpads.update(f.scope, pad.id, { expectedRevision: pad.revision, edit: { kind: "replace", content } });
        expect(pad.content).toBe(content);
        expect(pad.attribution.map(span => content.slice(span.start, span.end)).join("")).toBe(content);
        expect(pad.attribution[0]?.start).toBe(0);
        expect(pad.attribution.at(-1)?.end).toBe(content.length);
        for (let index = 1; index < pad.attribution.length; index++) expect(pad.attribution[index]!.start).toBe(pad.attribution[index - 1]!.end);
      }
      expect(f.workpads.update(f.scope, pad.id, { expectedRevision: pad.revision, edit: { kind: "append", text: " ✅" } }).content).toBe("日本語 ✅");
    } finally { f.database.close(); }
  });

  it("syncs drafts separately and preserves them when agent edits make their base stale", () => {
    const f = fixture();
    try {
      const pad = f.workpads.create(f.scope, { title: "Draft", scope: { kind: "global" }, content: "Original" });
      const draft = f.workpads.getDraft(f.scope, pad.id);
      const saved = f.workpads.saveDraft(f.scope, pad.id, { expectedRevision: draft.revision, baseRevision: 0, content: "My draft" });
      expect(f.workpads.get(f.scope, pad.id).revision).toBe(0);
      expect(f.workpads.revisions(f.scope, pad.id).items).toHaveLength(1);
      expect(() => f.workpads.saveDraft(f.scope, pad.id, { expectedRevision: draft.revision, baseRevision: 0, content: "Other device" })).toThrow(errorCode("draft_revision_conflict"));
      f.workpads.update(f.scope, pad.id, { expectedRevision: 0, edit: { kind: "append", text: " agent" } }, { kind: "agent", threadId: f.firstThreadId });
      expect(() => f.workpads.commitDraft(f.scope, pad.id, { expectedDraftRevision: saved.revision, expectedRevision: 0 })).toThrow(errorCode("conflict"));
      expect(() => f.workpads.commitDraft(f.scope, pad.id, { expectedDraftRevision: saved.revision, expectedRevision: 1 })).toThrow(errorCode("conflict"));
      expect(f.workpads.getDraft(f.scope, pad.id).content).toBe("My draft");
      const reconciled = f.workpads.saveDraft(f.scope, pad.id, { expectedRevision: saved.revision, baseRevision: 1, content: "My draft agent" });
      f.workpads.commitDraft(f.scope, pad.id, { expectedDraftRevision: reconciled.revision, expectedRevision: 1 });
      expect(f.workpads.get(f.scope, pad.id)).toMatchObject({ content: "My draft agent", revision: 2 });
      expect(f.workpads.getDraft(f.scope, pad.id)).toMatchObject({ baseRevision: 2, content: "My draft agent" });
      expect(() => f.workpads.commitDraft(f.scope, pad.id, { expectedDraftRevision: reconciled.revision, expectedRevision: 2 })).toThrow(errorCode("draft_revision_conflict"));
    } finally { f.database.close(); }
  });

  it("applies current scope to discovery after moves while retaining historical scope", () => {
    const f = fixture();
    try {
      const originalScope = { kind: "thread" as const, threadId: f.firstThreadId };
      const destination = { kind: "workspace" as const, workspaceId: f.secondWorkspaceId };
      const pad = f.workpads.create(f.scope, { title: "Move", scope: originalScope, content: "Retained" });
      f.workpads.update(f.scope, pad.id, { expectedRevision: 0, scope: destination });
      expect(f.workpads.list(f.scope, { scope: originalScope }).items).toHaveLength(0);
      expect(f.workpads.list(f.scope, { scope: destination }).items.map(item => item.id)).toEqual([pad.id]);
      expect(f.workpads.revision(f.scope, pad.id, 0).scope).toEqual(originalScope);
      expect(f.workpads.get(f.scope, pad.id).scope).toEqual(destination);
      expect(f.workpads.getAuthority(f.scope, pad.id)).toMatchObject({ scope: destination, environmentId: f.environmentId, revision: 1 });
      f.workpads.update(f.scope, pad.id, { expectedRevision: 1, archived: true });
      expect(f.workpads.list(f.scope, { scope: destination }).items).toHaveLength(0);
      expect(f.workpads.list(f.scope, { scope: destination, archived: true }).items.map(item => item.id)).toEqual([pad.id]);
    } finally { f.database.close(); }
  });

  it("denies other owners access to documents, history, drafts and mutations", () => {
    const f = fixture();
    try {
      const pad = f.workpads.create(f.scope, { title: "Private", scope: { kind: "global" }, content: "Secret" });
      for (const scope of [{ ...f.scope, principalId: "foreign-principal" }, { ...f.scope, tenantId: "foreign-tenant" }]) {
        expect(f.workpads.list(scope, { scope: { kind: "global" }, scopeMode: "subtree" }).items).toHaveLength(0);
        for (const access of [
          () => f.workpads.get(scope, pad.id),
          () => f.workpads.getAuthority(scope, pad.id),
          () => f.workpads.revision(scope, pad.id, 0),
          () => f.workpads.revisions(scope, pad.id),
          () => f.workpads.getDraft(scope, pad.id),
          () => f.workpads.saveDraft(scope, pad.id, { expectedRevision: 0, baseRevision: 0, content: "Stolen" }),
          () => f.workpads.discardDraft(scope, pad.id, 0),
          () => f.workpads.commitDraft(scope, pad.id, { expectedDraftRevision: 0, expectedRevision: 0 }),
          () => f.workpads.update(scope, pad.id, { expectedRevision: 0, title: "Stolen" }),
        ]) expect(access).toThrow(errorCode("not_found"));
      }
      expect(f.workpads.get(f.scope, pad.id).content).toBe("Secret");
    } finally { f.database.close(); }
  });
});
