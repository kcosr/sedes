import { describe, expect, it } from "vitest";
import {
  normalizeDeterministicFind,
  normalizeDeterministicGrep,
  sortDeterministicGrepMatches,
} from "../../src/server/workspace-tools/deterministic-search.js";

const limits = {
  maximumScannedEntries: 10,
  maximumScannedBytes: 1_000,
  maximumDurationMilliseconds: 1_000,
  maximumResults: 2,
  maximumResultBytes: 1_000,
};

describe("deterministic search normalization", () => {
  it("sorts a complete find scan before applying result limits", () => {
    const one = normalizeDeterministicFind(
      {
        paths: ["z.ts", "b.ts", "a.ts"],
        completed: true,
        scannedEntries: 3,
        scannedBytes: 15,
        durationMilliseconds: 2,
      },
      limits,
    );
    const two = normalizeDeterministicFind(
      {
        paths: ["a.ts", "z.ts", "b.ts"],
        completed: true,
        scannedEntries: 3,
        scannedBytes: 15,
        durationMilliseconds: 2,
      },
      limits,
    );
    expect(one).toEqual(two);
    expect(one).toMatchObject({ paths: ["a.ts", "b.ts"], truncated: true });
  });

  it.each([
    {
      completed: false,
      scannedEntries: 3,
      scannedBytes: 15,
      durationMilliseconds: 2,
    },
    {
      completed: true,
      scannedEntries: 11,
      scannedBytes: 15,
      durationMilliseconds: 2,
    },
    {
      completed: true,
      scannedEntries: 3,
      scannedBytes: 1_001,
      durationMilliseconds: 2,
    },
    {
      completed: true,
      scannedEntries: 3,
      scannedBytes: 15,
      durationMilliseconds: 1_001,
    },
  ])(
    "returns search_budget_exceeded instead of partial find output",
    (evidence) => {
      expect(() =>
        normalizeDeterministicFind(
          { paths: ["a", "b", "c"], ...evidence },
          limits,
        ),
      ).toThrowError("search_budget_exceeded");
    },
  );

  it("sorts grep by UTF-8 path bytes, then line and column", () => {
    expect(
      sortDeterministicGrepMatches([
        { path: "b.ts", line: 1, column: 1, text: "b" },
        { path: "a.ts", line: 2, column: 1, text: "later" },
        { path: "a.ts", line: 1, column: 8, text: "right" },
        { path: "a.ts", line: 1, column: 2, text: "left" },
      ]),
    ).toEqual([
      { path: "a.ts", line: 1, column: 2, text: "left" },
      { path: "a.ts", line: 1, column: 8, text: "right" },
      { path: "a.ts", line: 2, column: 1, text: "later" },
      { path: "b.ts", line: 1, column: 1, text: "b" },
    ]);
  });

  it("applies grep result limits after deterministic sorting", () => {
    expect(
      normalizeDeterministicGrep(
        [
          { path: "z.ts", line: 1, column: 1, text: "z" },
          { path: "a.ts", line: 1, column: 1, text: "a" },
        ],
        { maximumResults: 1, maximumResultBytes: 100 },
      ),
    ).toEqual({
      matches: [{ path: "a.ts", line: 1, column: 1, text: "a" }],
      truncated: true,
    });
  });
});
