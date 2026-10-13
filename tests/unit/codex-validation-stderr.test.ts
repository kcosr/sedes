import { describe, expect, it } from "vitest";
import { codexValidationStderr } from "../support/codex-validation-stderr.js";

const warning = "WARNING: failed to clean up stale arg0 temp dirs: Permission denied (os error 13)";

describe("Codex validation stderr", () => {
  it("keeps strict validation by default", () => {
    expect(codexValidationStderr(`${warning}\n`)).toBe(`${warning}\n`);
    expect(codexValidationStderr(`${warning}\n`, false)).toBe(`${warning}\n`);
  });

  it.each(["", warning, `${warning}\n`, `${warning}\r\n`, `${warning}\n${warning}\n`])(
    "allows only complete known warning lines when opted in: %j",
    (stderr) => {
      expect(codexValidationStderr(stderr, true)).toBe("");
    },
  );

  it.each([
    "ERROR: provider failed\n",
    warning.replace("13", "1"),
    `prefix ${warning}\n`,
    `${warning} extra diagnostic\n`,
    `${warning} \n`,
    "WARNING: proceeding, even though we could not create PATH aliases\n",
    "\n",
  ])("preserves other diagnostics exactly: %j", (stderr) => {
    expect(codexValidationStderr(stderr, true)).toBe(stderr);
  });

  it("preserves errors mixed with the allowed warning", () => {
    expect(codexValidationStderr(`${warning}\nERROR: provider failed\r\n${warning}`, true))
      .toBe("ERROR: provider failed\r\n");
  });
});
