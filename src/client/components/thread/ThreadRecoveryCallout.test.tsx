// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThreadRecoveryCallout } from "./ThreadRecoveryCallout.js";

afterEach(cleanup);

const operation = {
  id: "recover_uncertain" as const,
  label: { text: "Resume submission" },
  destructive: false,
  available: true,
  parameters: { kind: "none" as const },
};

describe("ThreadRecoveryCallout", () => {
  it("offers to resume a pre-submission creation failure", () => {
    const onRecover = vi.fn();
    render(
      <ThreadRecoveryCallout
        recovery={{
          kind: "conversation_creation",
          creationType: "first_input",
          phase: "recovery_required",
          diagnostic: { text: "Settings could not be applied." },
          submissionMayHaveBeenAccepted: false,
          forkUncertainty: null,
          possibleProviderOrphan: null,
          recoverable: true,
        }}
        operation={operation}
        pending={false}
        onRecover={onRecover}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Resume submission" }));
    expect(onRecover).toHaveBeenCalledOnce();
    expect(
      screen.queryByText("The backend may already have accepted this prompt."),
    ).not.toBeInTheDocument();
  });

  it("labels possible acceptance as reconciliation", () => {
    render(
      <ThreadRecoveryCallout
        recovery={{
          kind: "conversation_creation",
          creationType: "first_input",
          phase: "recovery_required",
          diagnostic: { text: "Submission outcome is unknown." },
          submissionMayHaveBeenAccepted: true,
          forkUncertainty: null,
          possibleProviderOrphan: null,
          recoverable: true,
        }}
        operation={{
          ...operation,
          label: { text: "Reconcile submission" },
        }}
        pending={true}
        onRecover={() => undefined}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Reconcile submission" }),
    ).toBeDisabled();
    expect(
      screen.getByText("The backend may already have accepted this prompt."),
    ).toBeInTheDocument();
  });

  it("describes uncertain manual forks without implying prompt submission", () => {
    render(
      <ThreadRecoveryCallout
        recovery={{
          kind: "conversation_creation",
          creationType: "fork",
          phase: "recovery_required",
          diagnostic: { text: "The provider response was lost." },
          submissionMayHaveBeenAccepted: false,
          forkUncertainty: "fork_unknown",
          possibleProviderOrphan: "full_native_copy",
          recoverable: true,
        }}
        operation={{ ...operation, label: { text: "Reconcile fork" } }}
        pending={false}
        onRecover={() => undefined}
      />,
    );

    expect(screen.getByText("Fork creation needs attention.")).toBeInTheDocument();
    expect(screen.getByText(/may already have created a child/)).toBeInTheDocument();
    expect(screen.getByText(/provider child may exist/)).toBeInTheDocument();
    expect(screen.queryByText(/accepted this prompt/)).not.toBeInTheDocument();
  });
});
