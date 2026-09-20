// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { createPaneSize } from "./pane-size";

describe("createPaneSize", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty("--test-pane");
  });

  function pane() {
    return createPaneSize({
      storageKey: "test-pane-size",
      cssVariable: "--test-pane",
      min: 100,
      max: 500,
      default: 240,
    });
  }

  it("reads, rounds, and clamps persisted values", () => {
    const size = pane();
    expect(size.get()).toBe(240);
    localStorage.setItem("test-pane-size", "312.8px");
    expect(size.get()).toBe(312);
    localStorage.setItem("test-pane-size", "900");
    expect(size.get()).toBe(500);
    localStorage.setItem("test-pane-size", "not-a-size");
    expect(size.get()).toBe(240);
    expect(size.clamp(150.7)).toBe(151);
    expect(size.clamp(Number.POSITIVE_INFINITY)).toBe(240);
  });

  it("keeps drag-frame application separate from committed persistence", () => {
    const size = pane();
    size.apply(333.5);
    expect(document.documentElement.style.getPropertyValue("--test-pane")).toBe(
      "333.5px",
    );
    expect(localStorage.getItem("test-pane-size")).toBeNull();

    expect(size.set(999)).toBe(500);
    expect(localStorage.getItem("test-pane-size")).toBe("500");
    expect(document.documentElement.style.getPropertyValue("--test-pane")).toBe(
      "500px",
    );
  });

  it("installs the persisted value", () => {
    localStorage.setItem("test-pane-size", "180");
    pane().install();
    expect(document.documentElement.style.getPropertyValue("--test-pane")).toBe(
      "180px",
    );
  });

  it("rejects an incoherent range", () => {
    expect(() =>
      createPaneSize({
        storageKey: "bad",
        cssVariable: "--bad",
        min: 500,
        max: 100,
        default: 240,
      }),
    ).toThrowError("invalid_pane_size_options");
  });
});
