import assert from "node:assert/strict";
import { createHash } from "node:crypto";

export interface ReviewedSchemaProfile {
  baselineFiles: number;
  candidateFiles: number;
  changes: {
    path: string;
    baselineSha256: string | null;
    candidateSha256: string | null;
  }[];
}

export interface ReviewedSchemaDelta {
  schemaVersion: 1;
  release: string;
  parserRelease: string;
  profiles: Record<string, ReviewedSchemaProfile>;
}

/** Exact qualification evidence, never a production parser or a drift allowlist. */
export function verifyReviewedSchemaDelta(
  baseline: ReadonlyMap<string, Buffer>,
  candidate: ReadonlyMap<string, Buffer>,
  review: ReviewedSchemaProfile,
): void {
  assert.equal(
    baseline.size,
    review.baselineFiles,
    "Baseline inventory changed",
  );
  assert.equal(
    candidate.size,
    review.candidateFiles,
    "Candidate inventory changed",
  );
  const expected = new Map(
    [...baseline].map(([name, bytes]) => [name, sha256(bytes)]),
  );
  const reviewedPaths = new Set<string>();
  for (const change of review.changes) {
    assert(
      !reviewedPaths.has(change.path),
      `Duplicate reviewed path: ${change.path}`,
    );
    reviewedPaths.add(change.path);
    for (const hash of [change.baselineSha256, change.candidateSha256]) {
      assert(
        hash === null || /^[a-f0-9]{64}$/.test(hash),
        "Invalid reviewed hash",
      );
    }
    assert.notEqual(
      change.baselineSha256,
      change.candidateSha256,
      "Unchanged reviewed entry",
    );
    assert.equal(
      expected.get(change.path) ?? null,
      change.baselineSha256,
      `Reviewed baseline changed: ${change.path}`,
    );
    if (change.candidateSha256 === null) expected.delete(change.path);
    else expected.set(change.path, change.candidateSha256);
  }
  assert.deepEqual(
    [...candidate.keys()].sort(),
    [...expected.keys()].sort(),
    "Unreviewed candidate paths",
  );
  for (const [name, bytes] of candidate) {
    assert.equal(
      sha256(bytes),
      expected.get(name),
      `Unreviewed candidate content: ${name}`,
    );
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
