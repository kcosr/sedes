import { describe, expect, it } from "vitest";
import { boundedPierreLanguage } from "./pierre-language.js";

describe("boundedPierreLanguage", () => {
  it("allows a bounded syntax grammar catalog", () => {
    expect(boundedPierreLanguage("src/App.tsx")).toBe("tsx");
    expect(boundedPierreLanguage("Dockerfile")).toBe("docker");
    expect(boundedPierreLanguage("config/settings.yaml")).toBe("yaml");
  });

  it("renders unknown file types as text instead of loading arbitrary grammars", () => {
    expect(boundedPierreLanguage("data/example.swift")).toBe("text");
    expect(boundedPierreLanguage("LICENSE")).toBe("text");
  });
});
