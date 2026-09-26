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
          conversationIdentified: false,
          forkChildIdentity: null,
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
          conversationIdentified: false,
          forkChildIdentity: null,
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
          conversationIdentified: false,
          forkChildIdentity: "provider_assigned",
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

  it("discards a stuck fork only after an explicit confirmation", () => {
    const onDiscard = vi.fn();
    const onRecover = vi.fn();
    const recovery = {
      kind: "conversation_creation" as const,
      creationType: "fork" as const,
      phase: "recovery_required" as const,
      diagnostic: { text: "Claude history could not be read, so this fork's outcome is not yet known." },
      submissionMayHaveBeenAccepted: false,
      forkUncertainty: null,
      possibleProviderOrphan: null,
      conversationIdentified: false,
      forkChildIdentity: "application_reserved" as const,
      recoverable: true,
    };
    const discard = { ...operation, id: "discard_fork" as const, label: { text: "Discard this fork" }, destructive: true };
    render(
      <ThreadRecoveryCallout
        recovery={recovery}
        operation={{ ...operation, label: { text: "Recover fork" } }}
        discardOperation={discard}
        pending={false}
        onRecover={onRecover}
        onDiscard={onDiscard}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Discard this fork" }));
    expect(onDiscard).not.toHaveBeenCalled();
    expect(screen.getByText(/Discard removes this fork thread/u)).toHaveTextContent(
      "Discard removes this fork thread. Anything the provider already copied is left untouched and never imported as a thread.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Keep it" }));
    expect(screen.getByRole("button", { name: "Recover fork" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Discard this fork" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard fork" }));
    expect(onDiscard).toHaveBeenCalledOnce();
    expect(onRecover).not.toHaveBeenCalled();
  });

  it("does not promise that a provider-assigned or unrecorded fork child stays hidden", () => {
    const discard = { ...operation, id: "discard_fork" as const, label: { text: "Discard this fork" }, destructive: true };
    for (const forkChildIdentity of ["provider_assigned", null] as const) {
      render(
        <ThreadRecoveryCallout
          recovery={{ kind: "conversation_creation", creationType: "fork", phase: "recovery_required",
            diagnostic: { text: "The provider response was lost." }, submissionMayHaveBeenAccepted: true,
            forkUncertainty: "fork_unknown", possibleProviderOrphan: "full_native_copy",
            conversationIdentified: false, forkChildIdentity, recoverable: false }}
          discardOperation={discard}
          pending={false}
          onRecover={vi.fn()}
          onDiscard={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Discard this fork" }));
      expect(screen.getByText(/Discard removes this fork thread/u)).toHaveTextContent(
        "Discard removes this fork thread. Anything the provider already copied is left untouched and may later appear as a separate thread.",
      );
      expect(screen.queryByText(/never imported/u)).toBeNull();
      cleanup();
    }
  });

  it("never offers discard once the provider returned the fork child", () => {
    const discard = { ...operation, id: "discard_fork" as const, label: { text: "Discard this fork" }, destructive: true };
    render(
      <ThreadRecoveryCallout
        recovery={{ kind: "conversation_creation", creationType: "fork", phase: "recovery_required",
          diagnostic: { text: "Binding failed." }, submissionMayHaveBeenAccepted: false, forkUncertainty: null,
          possibleProviderOrphan: null, conversationIdentified: true, forkChildIdentity: "provider_assigned",
          recoverable: true }}
        operation={{ ...operation, label: { text: "Recover fork" } }}
        discardOperation={discard}
        pending={false}
        onRecover={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "Recover fork" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Discard this fork" })).toBeNull();
  });

  it("does not offer discard for an unavailable operation or a non-fork recovery", () => {
    const discard = { ...operation, id: "discard_fork" as const, label: { text: "Discard this fork" }, destructive: true,
      available: false, unavailableReason: { text: "Recover instead." } };
    render(
      <ThreadRecoveryCallout
        recovery={{ kind: "conversation_creation", creationType: "fork", phase: "conversation_identified",
          diagnostic: { text: "Binding failed." }, submissionMayHaveBeenAccepted: false, forkUncertainty: null,
          possibleProviderOrphan: null, conversationIdentified: true, forkChildIdentity: "application_reserved",
          recoverable: true }}
        operation={operation}
        discardOperation={discard}
        pending={false}
        onRecover={vi.fn()}
        onDiscard={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Discard this fork" })).toBeNull();
  });
});
