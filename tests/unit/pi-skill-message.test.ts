import { describe, expect, it } from "vitest";
import {
  parsePiSkillInvocation,
  projectPiUserMessageContent,
} from "../../src/server/backends/pi/pi-skill-message.js";

describe("Pi skill message normalization", () => {
  const expanded = `<skill name="keel-local" location="/private/skills/keel-local/SKILL.md">
References are relative to /private/skills/keel-local.

# Secret skill body

Do the private workflow.
</skill>

Here's the test`;

  it("uses Pi's native skill boundary without exposing its body or path", () => {
    expect(parsePiSkillInvocation(expanded)).toEqual({
      name: "keel-local",
      userText: "Here's the test",
    });

    const content = projectPiUserMessageContent(expanded);
    expect(content).toEqual([
      { kind: "skill", name: { text: "keel-local" } },
      { kind: "text", text: { text: "Here's the test" } },
    ]);
    expect(JSON.stringify(content)).not.toContain("/private");
    expect(JSON.stringify(content)).not.toContain("Secret skill body");
  });

  it("preserves ordinary user text and supports a skill-only historical message", () => {
    expect(projectPiUserMessageContent("ordinary text")).toEqual([
      { kind: "text", text: { text: "ordinary text" } },
    ]);
    expect(
      projectPiUserMessageContent(expanded.replace("\n\nHere's the test", "")),
    ).toEqual([{ kind: "skill", name: { text: "keel-local" } }]);
  });

  it("fails closed when Pi's expanded skill framing drifts", () => {
    const singleNewline = expanded.replace("</skill>\n\n", "</skill>\n");
    expect(parsePiSkillInvocation(singleNewline)).toBeUndefined();
    expect(projectPiUserMessageContent(singleNewline)).toEqual([
      { kind: "skill", name: { text: "keel-local" } },
      { kind: "text", text: { text: "Here's the test" } },
    ]);

    const unterminated = expanded.replace("</skill>\n\nHere's the test", "");
    const projected = projectPiUserMessageContent(unterminated);
    expect(projected).toEqual([
      { kind: "skill", name: { text: "keel-local" } },
    ]);
    expect(JSON.stringify(projected)).not.toContain("/private");
    expect(JSON.stringify(projected)).not.toContain("Secret skill body");
  });
});
