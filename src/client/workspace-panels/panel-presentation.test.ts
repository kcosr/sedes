import { describe, expect, it } from "vitest";
import { resolvePanelPresentation } from "./panel-presentation.js";

describe("resolvePanelPresentation", () => {
  it("keeps normal clicks and inverts Shift-clicks", () => {
    expect(resolvePanelPresentation("split", false)).toBe("split");
    expect(resolvePanelPresentation("single", false)).toBe("single");
    expect(resolvePanelPresentation("split", true)).toBe("single");
    expect(resolvePanelPresentation("single", true)).toBe("split");
  });
});
