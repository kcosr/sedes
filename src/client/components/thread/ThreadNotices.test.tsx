// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
  it("shows one copy when fresh events repeat the same warning and after remount", () => {
    const notices = Array.from({ length: 5 }, (_, index) => ({
      ...warning, id: `notice-${index}`, createdAt: `2026-09-27T12:00:0${index}.000Z`,
    }));
    const { rerender, unmount } = render(<ThreadNotices notices={notices.slice(0, 1)} />);
    const first = screen.getByRole("status");
    rerender(<ThreadNotices notices={notices} />);
    expect(screen.getAllByText(warning.message.text)).toHaveLength(1);
    expect(screen.getByRole("status")).toBe(first);
    expect(notices).toHaveLength(5);
    unmount();
    render(<ThreadNotices notices={notices} />);
    expect(screen.getAllByText(warning.message.text)).toHaveLength(1);
  });

  it("preserves different text or severity and clears when the supplied notices clear", () => {
    const notices: RuntimeNotice[] = [
      warning,
      { ...warning, id: "other", message: { text: "A different warning." } },
      { ...warning, id: "duplicate" },
      { ...warning, id: "error", tone: "error" },
      { ...warning, id: "different-case", message: { text: warning.message.text.toLowerCase() } },
    ];
    const { rerender } = render(<ThreadNotices notices={notices} />);
    expect(screen.getAllByRole("status")).toHaveLength(3);
    expect(screen.getByRole("alert")).toHaveTextContent(warning.message.text);
    expect(screen.getAllByText(warning.message.text)).toHaveLength(2);
    rerender(<ThreadNotices notices={[]} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<ThreadNotices notices={[warning]} />);
    expect(screen.getByRole("status")).toHaveTextContent(warning.message.text);
  });
});
