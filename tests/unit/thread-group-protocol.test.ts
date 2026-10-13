import { describe, expect, it } from "vitest";
import { updateThreadGroupAssignmentRequestSchema } from "../../src/shared/protocol/thread-groups.js";

const threadId = "ae282c19-d927-45b0-b10e-5db4e779d1a7";
const secondId = "40a7b081-8df4-41fb-bef6-d314caa2c116";
const mutationId = "65fa1d7b-157f-4851-8b4e-0769b7b0105c";

describe("group creation contract", () => {
  it("requires one bounded set of distinct revisioned members", () => {
    const request = {
      action: "create", name: "Together", mutationId,
      members: [{ threadId, expectedRevision: 1 }, { threadId: secondId, expectedRevision: 0 }],
    };
    expect(updateThreadGroupAssignmentRequestSchema.parse(request)).toEqual(request);
    const boundedMembers = Array.from({ length: 101 }, (_, index) => ({
      threadId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      expectedRevision: 0,
    }));
    expect(updateThreadGroupAssignmentRequestSchema.safeParse({ ...request, members: boundedMembers.slice(0, 100) }).success).toBe(true);
    for (const members of [[], [request.members[0], request.members[0]], boundedMembers]) {
      expect(updateThreadGroupAssignmentRequestSchema.safeParse({ ...request, members }).success).toBe(false);
    }
    expect(updateThreadGroupAssignmentRequestSchema.safeParse({ action: "create", name: "Old shape", mutationId, expectedRevision: 0 }).success).toBe(false);
  });
});
