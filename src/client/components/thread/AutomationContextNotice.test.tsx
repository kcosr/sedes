// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationContextNotice } from "./AutomationContextNotice.js";
import { automationStore } from "../automation/automation-test-fixture.js";

afterEach(cleanup);
const context = { automationId: "30000000-0000-4000-8000-000000000001", name: "Daily update", runId: "20000000-0000-4000-8000-000000000001", sourceThreadId: "10000000-0000-4000-8000-000000000001", triggeredAt: "2026-10-06T06:30:00.000Z", outcome: "failed" as const, diagnostic: { text: "Check the source" } };

describe("automation context notice", () => {
  it("links directly to the responsible automation without source singleton inference", () => {
    const fixture = automationStore([]);
    render(<AutomationContextNotice context={context} onDismiss={vi.fn()} />);
    expect(screen.getByText("Daily update: this run failed.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open automation" })).toHaveAttribute("href", `/automations/${context.automationId}`);
    expect(screen.getByText("Check the source")).toBeInTheDocument();
  });
  it("dismisses only the selected notice while a sibling remains visible", async () => {
    const fixture = automationStore([]);
    const dismiss = vi.fn();
    render(<><AutomationContextNotice context={context} onDismiss={dismiss} /><AutomationContextNotice context={{ ...context, automationId: "other", runId: "other-run", name: "Reminder", outcome: "triggered" }} onDismiss={vi.fn()} /></>);
    await userEvent.setup().click(screen.getAllByRole("button", { name: "Dismiss" })[0]!);
    expect(dismiss).toHaveBeenCalledOnce();
    expect(screen.getByText("Reminder triggered this thread.")).toBeInTheDocument();
  });
  it("keeps an uncertain delivery visible until resolved", () => {
    render(<AutomationContextNotice context={{ ...context, outcome: "uncertain" }} onDismiss={vi.fn()} />);
    expect(screen.getByText("Daily update: delivery outcome is unknown.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Dismiss" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open automation" })).toBeInTheDocument();
  });

});
