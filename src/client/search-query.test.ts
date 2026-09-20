import { describe, expect, it } from "vitest";
import { isSearchQueryReady } from "./search-query.js";

describe("isSearchQueryReady", () => {
  it.each([
    ["ab", false],
    ["a b", false],
    [" a b c ", true],
    ["\tα \nβ γ", true],
    ["😀 😀", false],
    ["😀 🧭 🔎", true],
  ])("classifies %j", (query, expected) => {
    expect(isSearchQueryReady(query)).toBe(expected);
  });
});
