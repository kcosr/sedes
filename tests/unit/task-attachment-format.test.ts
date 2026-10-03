import { describe, expect, it } from "vitest";
import { taskSchema, type Task } from "../../src/shared/index.js";
import {
  parseStoredTaskContexts,
  serializeTaskContexts,
} from "../../src/server/db/composer-tasks-json.js";
import {
  materializeTaskContext,
  materializedTaskContextSchema,
} from "../../src/server/domain/materialized-task-contexts.js";

// Exact bytes of v1 copies as Sedes stores and signs them. The literals are
// the format: never regenerate them from code.
const threadCopy =
  '{"id":"10000000-0000-4000-8000-000000000001","scope":{"kind":"thread","threadId":"20000000-0000-4000-8000-000000000001"},"title":"Attach a thread task","details":"Keep the exact bytes.","pinned":true,"files":["/work/sedes/src/tasks.ts"],"completedAt":null,"revision":3,"createdAt":"2026-09-01T10:00:00.000Z","updatedAt":"2026-09-02T10:00:00.000Z"}';
const projectCopy =
  '{"id":"10000000-0000-4000-8000-000000000002","scope":{"kind":"project","projectId":"30000000-0000-4000-8000-000000000001"},"title":"Attach a project task","details":"","pinned":false,"files":[],"completedAt":"2026-09-03T10:00:00.000Z","revision":5,"createdAt":"2026-09-01T10:00:00.000Z","updatedAt":"2026-09-03T10:00:00.000Z"}';
const globalCopy =
  '{"id":"10000000-0000-4000-8000-000000000003","scope":{"kind":"global"},"title":"Attach a global task","details":"","pinned":false,"files":[],"completedAt":null,"revision":0,"createdAt":"2026-09-01T10:00:00.000Z","updatedAt":"2026-09-01T10:00:00.000Z"}';
// Delivered while Tasks still belonged to a workspace.
const workspaceCopy =
  '{"id":"10000000-0000-4000-8000-000000000004","scope":{"kind":"workspace","workspaceId":"40000000-0000-4000-8000-000000000001"},"title":"Legacy workspace task","details":"Delivered before projects existed.","pinned":false,"files":["/workspace/src/legacy.ts"],"completedAt":null,"revision":6,"createdAt":"2026-08-10T12:00:00.000Z","updatedAt":"2026-08-10T13:00:00.000Z"}';

const V1_KEYS = [
  "id",
  "scope",
  "title",
  "details",
  "pinned",
  "files",
  "completedAt",
  "revision",
  "createdAt",
  "updatedAt",
];

describe("Task attachment format v1", () => {
  it("parses stored copies and re-serializes them to the same bytes", () => {
    for (const copy of [threadCopy, projectCopy, globalCopy, workspaceCopy]) {
      expect(
        JSON.stringify(materializedTaskContextSchema.parse(JSON.parse(copy))),
      ).toBe(copy);
    }
    const stored = `[${threadCopy},${projectCopy},${globalCopy},${workspaceCopy}]`;
    expect(serializeTaskContexts(parseStoredTaskContexts(stored))).toBe(stored);
  });

  it("captures only v1 fields of a live Task, in v1 order", () => {
    const live: Task = taskSchema.parse(JSON.parse(threadCopy));
    // A field the live Task gains later stays out of the attachment.
    const grown = { ...live, laterField: true } as Task;
    const copy = materializeTaskContext(grown);
    expect(Object.keys(copy)).toEqual(V1_KEYS);
    expect(JSON.stringify(copy)).toBe(threadCopy);
  });

  it("is closed to fields outside v1", () => {
    expect(
      materializedTaskContextSchema.safeParse({
        ...JSON.parse(threadCopy),
        laterField: true,
      }).success,
    ).toBe(false);
    const { pinned: _pinned, ...withoutPinned } = JSON.parse(threadCopy);
    expect(materializedTaskContextSchema.safeParse(withoutPinned).success).toBe(
      false,
    );
  });

  it("keeps its own limits", () => {
    const base = JSON.parse(globalCopy);
    const parses = (patch: object) =>
      materializedTaskContextSchema.safeParse({ ...base, ...patch }).success;
    expect(parses({ title: "t".repeat(240) })).toBe(true);
    expect(parses({ title: "t".repeat(241) })).toBe(false);
    expect(parses({ title: "" })).toBe(false);
    expect(parses({ details: "d".repeat(65_536) })).toBe(true);
    expect(parses({ details: "d".repeat(65_537) })).toBe(false);
    const files = Array.from({ length: 16 }, (_, index) => `/f/${index}`);
    expect(parses({ files })).toBe(true);
    expect(parses({ files: [...files, "/f/16"] })).toBe(false);
    expect(parses({ files: ["/f", "/f"] })).toBe(false);
    expect(parses({ files: [`/${"p".repeat(4_095)}`] })).toBe(true);
    expect(parses({ files: [`/${"p".repeat(4_096)}`] })).toBe(false);
    expect(parses({ files: ["relative/path"] })).toBe(false);
    expect(parses({ title: "\ud800" })).toBe(false);
  });
});
