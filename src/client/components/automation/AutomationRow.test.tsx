// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { automationHealth } from "../../automation/automation-health.js";
import { selectAutomationsBase } from "../../automation/automation-list.js";
import { AutomationRow } from "./AutomationRow.js";
import { automationStore, definition, installAutomationDom, run } from "./automation-test-fixture.js";

const NOW = Date.parse("2026-10-06T03:40:00.000Z");
const ENDED = "2026-10-06T03:17:00.000Z";

beforeEach(installAutomationDom);
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function renderFinishedRow(lastRun: ReturnType<typeof run>) {
  const value = definition({ status: "exhausted", nextRunAt: undefined, lastRun });
  const fixture = automationStore([{ automation: value }]);
  const row = selectAutomationsBase(fixture.store.getSnapshot().snapshot, [value]).rows[0]!;
  render(<ul><AutomationRow entry={{ row, health: automationHealth(row, NOW) }}
    now={NOW} context="thread" onAction={vi.fn()} /></ul>);
  return screen.getByRole("link", { name: value.name });
}

describe("finished automation row accessibility", () => {
  it.each([
    ["Delivered", run({ finishedAt: ENDED })],
    ["Skipped", run({ state: "skipped", finishedAt: ENDED })],
    ["Interrupted", run({ turn: { id: "turn-interrupted", outcome: "interrupted", endedAt: ENDED, settledAt: ENDED } })],
    ["Failed", run({ turn: { id: "turn-failed", outcome: "failed", endedAt: ENDED, settledAt: ENDED } })],
  ])("announces Finished before the %s result while keeping one visible outcome", (outcome, lastRun) => {
    const link = renderFinishedRow(lastRun);
    expect(link).toHaveAccessibleDescription(new RegExp(`^Finished\\. ${outcome} 23m ago\\.`));
    expect(link.querySelector(".automation-row-primary")).toHaveTextContent(`${outcome} 23m ago`);
    expect(link.querySelector(".automation-row-primary")).not.toHaveTextContent("Finished");
    expect(link.querySelector(".automation-row-secondary")).toBeEmptyDOMElement();
  });

  it("does not announce Finished twice when the result already names it", () => {
    const link = renderFinishedRow(run({ turn: { id: "turn-completed", outcome: "completed", endedAt: ENDED, settledAt: ENDED } }));
    expect(link).toHaveAccessibleDescription(/^Finished 23m ago\./);
    const description = document.getElementById(link.getAttribute("aria-describedby")!)!;
    expect(description.textContent?.match(/Finished/g)).toHaveLength(1);
  });
});
