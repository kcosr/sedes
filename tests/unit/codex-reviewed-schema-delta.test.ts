import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  verifyReviewedSchemaDelta,
  type ReviewedSchemaProfile,
} from "../../scripts/codex-probes/reviewed-schema-delta.js";

function tree(files: Record<string, string>): Map<string, Buffer> {
  return new Map(
    Object.entries(files).map(([name, value]) => [name, Buffer.from(value)]),
  );
}
function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
const baseline = tree({
  "same.ts": "same",
  "changed.ts": "old",
  "removed.ts": "removed",
});
const candidate = tree({
  "same.ts": "same",
  "changed.ts": "new",
  "added.ts": "added",
});
const review: ReviewedSchemaProfile = {
  baselineFiles: 3,
  candidateFiles: 3,
  changes: [
    {
      path: "changed.ts",
      baselineSha256: hash("old"),
      candidateSha256: hash("new"),
    },
    {
      path: "removed.ts",
      baselineSha256: hash("removed"),
      candidateSha256: null,
    },
    { path: "added.ts", baselineSha256: null, candidateSha256: hash("added") },
  ],
};

describe("reviewed Codex candidate schema drift", () => {
  it("accepts exact reviewed additions, changes and removals", () => {
    expect(() =>
      verifyReviewedSchemaDelta(baseline, candidate, review),
    ).not.toThrow();
    expect(() =>
      verifyReviewedSchemaDelta(baseline, baseline, {
        baselineFiles: 3,
        candidateFiles: 3,
        changes: [],
      }),
    ).not.toThrow();
  });

  it("rejects drift in both changed and unchanged candidate files", () => {
    for (const name of ["same.ts", "changed.ts", "added.ts"]) {
      const drifted = new Map(candidate).set(name, Buffer.from("unexpected"));
      expect(() =>
        verifyReviewedSchemaDelta(baseline, drifted, review),
      ).toThrow(`Unreviewed candidate content: ${name}`);
    }
  });

  it("rejects unreviewed inventory changes even when file counts match", () => {
    const drifted = new Map(candidate);
    drifted.delete("same.ts");
    drifted.set("unexpected.ts", Buffer.from("same"));
    expect(() => verifyReviewedSchemaDelta(baseline, drifted, review)).toThrow(
      "Unreviewed candidate paths",
    );
    expect(() =>
      verifyReviewedSchemaDelta(baseline, new Map(), review),
    ).toThrow("Candidate inventory changed");
  });

  it("rejects altered baselines and incomplete or contradictory reviews", () => {
    expect(() =>
      verifyReviewedSchemaDelta(
        new Map(baseline).set("changed.ts", Buffer.from("other")),
        candidate,
        review,
      ),
    ).toThrow("Reviewed baseline changed: changed.ts");
    expect(() =>
      verifyReviewedSchemaDelta(baseline, candidate, {
        ...review,
        changes: review.changes.slice(1),
      }),
    ).toThrow("Unreviewed candidate content: changed.ts");
    expect(() =>
      verifyReviewedSchemaDelta(baseline, candidate, {
        ...review,
        changes: [...review.changes, review.changes[0]!],
      }),
    ).toThrow("Duplicate reviewed path");
    expect(() =>
      verifyReviewedSchemaDelta(baseline, candidate, {
        ...review,
        changes: [
          {
            path: "same.ts",
            baselineSha256: hash("same"),
            candidateSha256: hash("same"),
          },
        ],
      }),
    ).toThrow("Unchanged reviewed entry");
  });
});
