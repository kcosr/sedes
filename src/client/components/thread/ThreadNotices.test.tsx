// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RuntimeNotice } from "../../../shared/index.js";
import { ThreadNotices } from "./ThreadNotices.js";

afterEach(cleanup);

const warning: RuntimeNotice = {
  id: "first",
  tone: "warning",
  message: { text: "Claude usage is approaching its current limit." },
  createdAt: "2026-09-27T12:00:00.000Z",
};

describe("runtime notice presentation", () => {
  it("dismisses the selected notice and waits for the authoritative collection", () => {
    const dismiss = vi.fn();
    const notices = [warning, { ...warning, id: "other", message: { text: "Another notice" } }];
    const { rerender } = render(<ThreadNotices notices={notices} pending={false} onDismiss={dismiss} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Dismiss" })[0]!);
    expect(dismiss).toHaveBeenCalledExactlyOnceWith(warning.id);
    expect(screen.getByText(warning.message.text)).toBeVisible();
    rerender(<ThreadNotices notices={notices} pending onDismiss={dismiss} />);
    expect(screen.getAllByRole("button", { name: "Dismiss" }).every(button => button.hasAttribute("disabled"))).toBe(true);
    rerender(<ThreadNotices notices={notices.slice(1)} pending={false} onDismiss={dismiss} />);
    expect(screen.queryByText(warning.message.text)).toBeNull();
    expect(screen.getByText("Another notice")).toBeVisible();
  });

  it("preserves different text or severity and clears when the supplied notices clear", () => {
    const notices: RuntimeNotice[] = [
      warning,
      { ...warning, id: "other", message: { text: "A different warning." } },
      { ...warning, id: "error", tone: "error" },
      { ...warning, id: "different-case", message: { text: warning.message.text.toLowerCase() } },
    ];
    const { rerender } = render(<ThreadNotices notices={notices} pending={false} onDismiss={vi.fn()} />);
    expect(screen.getAllByRole("status")).toHaveLength(3);
    expect(screen.getByRole("alert")).toHaveTextContent(warning.message.text);
    expect(screen.getAllByText(warning.message.text)).toHaveLength(2);
    rerender(<ThreadNotices notices={[]} pending={false} onDismiss={vi.fn()} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<ThreadNotices notices={[warning]} pending={false} onDismiss={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent(warning.message.text);
  });
});
