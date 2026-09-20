// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { NormalizedThreadForkOrigin } from "../../../shared/index.js";
import { ForkProvenanceButton } from "./ForkProvenanceButton.js";

const origin: NormalizedThreadForkOrigin = {
  childThreadId: "child-1",
  sourceThreadId: "source-1",
  sourceTurnId: "turn/1",
  sourceTurnCompletedAt: "2026-07-30T15:00:00.000Z",
  boundaryKind: "completed_turn_inclusive",
  originKind: "user_fork",
  initiatingAgentThreadId: null,
  initiatingToolClientId: null,
  branchMethod: "provider_native",
  createdAt: "2026-07-30T15:00:00.000Z",
};

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("ForkProvenanceButton", () => {
  it("is icon-only and opens the normalized source turn", () => {
    render(<ForkProvenanceButton origin={origin} sourceTitle="Duplicate title" />);

    expect(screen.queryByText(/Forked from/)).not.toBeInTheDocument();
    const button = screen.getByRole("button", {
      name: /Forked from “Duplicate title” at .*2026.*Open the fork point/,
    });
    fireEvent.click(button);

    expect(window.location.pathname).toBe("/threads/source-1");
    expect(window.location.hash).toBe("#turn=turn%2F1");
  });

  it("retains focusable provenance when the authorized source is unavailable", () => {
    render(
      <ForkProvenanceButton
        origin={{
          ...origin,
          sourceThreadId: null,
          sourceTurnId: null,
          sourceTurnCompletedAt: null,
        }}
      />,
    );

    const button = screen.getByRole("button", { name: /Source unavailable/i });
    expect(button).toHaveAttribute("aria-disabled", "true");
    button.focus();
    expect(button).toHaveFocus();
    fireEvent.click(button);
    expect(window.location.pathname).toBe("/");
  });

  it("labels durable principal-client fork provenance", () => {
    render(
      <ForkProvenanceButton
        origin={{
          ...origin,
          originKind: "principal_client_fork",
          initiatingToolClientId: "10000000-0000-4000-8000-000000000099",
        }}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Initiated by a principal tool client/ }),
    ).toBeVisible();
  });
});
