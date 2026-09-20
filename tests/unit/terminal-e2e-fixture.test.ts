import { describe, expect, it } from "vitest";
import { TerminalE2eFixture } from "../e2e/terminal-fixture.js";

describe("TerminalE2eFixture output flow control", () => {
  it("retains paused output and flushes it in order across repeated pauses", async () => {
    const fixture = new TerminalE2eFixture("environment-1");
    const process = await fixture.openTerminal({
      scope: { tenantId: "tenant", principalId: "principal" },
      environmentId: "environment-1",
      terminalId: "terminal-1",
      incarnationId: "incarnation-1",
      initialCwd: "/workspace",
      rows: 24,
      columns: 80,
    });
    const output: string[] = [];
    process.onOutput((bytes) => {
      const text = new TextDecoder().decode(bytes);
      output.push(text);
      if (text === "first") process.pauseOutput();
    });

    process.pauseOutput();
    fixture.emit("terminal-1", "first");
    fixture.emit("terminal-1", "second");
    expect(output).toEqual([]);

    process.resumeOutput();
    expect(output).toEqual(["first"]);

    process.resumeOutput();
    expect(output).toEqual(["first", "second"]);
  });
});
