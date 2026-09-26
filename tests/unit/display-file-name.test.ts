import { describe, expect, it } from "vitest";
import { displayFileName } from "../../src/server/output-artifacts/display-file-name.js";

describe("displayFileName", () => {
  it.each([
    ["/home/user/project/screen.png", "screen.png"],
    ["C:\\Users\\user\\Pictures\\screen.png", "screen.png"],
    ["images/relative.png", "relative.png"],
    ["/tmp/\u202egnp.exe\u0007", "gnp.exe"],
  ])("shows only the final component of %j", (path, expected) => {
    expect(displayFileName(path)).toEqual({ text: expected });
  });

  it("omits a name that is empty after sanitizing", () => {
    expect(displayFileName("/")).toBeUndefined();
    expect(displayFileName("/tmp/\u200e\u0001 ")).toBeUndefined();
  });

  it("bounds an overlong name and records the truncation", () => {
    const name = displayFileName(`/tmp/${"é".repeat(200)}.png`);
    expect(Buffer.byteLength(name!.text)).toBeLessThanOrEqual(255);
    expect(name!.truncation?.truncated).toBe(true);
  });
});
