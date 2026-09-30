// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PathText } from "./detail-parts.js";

afterEach(cleanup);

describe("PathText", () => {
  it("offers a line break after each separator and nowhere else", () => {
    const { container } = render(<PathText value="/home/kevin/worktrees/ui-polish" />);
    const path = container.querySelector(".execution-path")!;
    expect(path).toHaveTextContent("/home/kevin/worktrees/ui-polish");
    expect(path.innerHTML).toBe("/<wbr>home/<wbr>kevin/<wbr>worktrees/<wbr>ui-polish");
  });

  it("treats Windows separators and URLs the same way", () => {
    const windows = render(<PathText value={"C:\\Projects\\sedes"} />).container.querySelector(".execution-path")!;
    expect(windows.querySelectorAll("wbr")).toHaveLength(2);
    cleanup();
    const url = render(<PathText value="ws://127.0.0.1:4500/socket" />).container.querySelector(".execution-path")!;
    expect(url).toHaveTextContent("ws://127.0.0.1:4500/socket");
    expect(url.querySelectorAll("wbr")).toHaveLength(3);
  });
});
