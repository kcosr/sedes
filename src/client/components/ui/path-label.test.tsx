// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PathLabel } from "./path-label.js";

afterEach(cleanup);

function parts(container: HTMLElement) {
  const root = container.querySelector("[data-slot=path-label]")!;
  return {
    root,
    directory: root.querySelector("[data-slot=path-label-directory]"),
    name: root.querySelector("[data-slot=path-label-name]")!,
  };
}

describe("PathLabel", () => {
  it("keeps the file name whole while the directory gives way from its start", () => {
    const { container } = render(
      <PathLabel path="src/client/workspace-files/WorkspaceFilesPanel.tsx" />,
    );
    const { root, directory, name } = parts(container);
    expect(root).toHaveAttribute(
      "title",
      "src/client/workspace-files/WorkspaceFilesPanel.tsx",
    );
    expect(root).toHaveTextContent(
      "src/client/workspace-files/WorkspaceFilesPanel.tsx",
    );
    expect(directory).toHaveTextContent("src/client/workspace-files/");
    expect(directory).toHaveClass("shrink", "truncate", "[direction:rtl]");
    expect(directory?.querySelector("bdi")).toHaveAttribute("dir", "ltr");
    expect(name).toHaveTextContent(/^WorkspaceFilesPanel\.tsx$/);
    expect(name).toHaveClass("shrink-0", "max-w-full", "truncate");
  });

  it("renders a bare name without a directory part", () => {
    const { container } = render(<PathLabel path="README.md" />);
    const { directory, name } = parts(container);
    expect(directory).toBeNull();
    expect(name).toHaveTextContent("README.md");
  });

  it("keeps a directory's trailing slash with its last segment", () => {
    const { container } = render(<PathLabel path="src/client/" />);
    const { directory, name } = parts(container);
    expect(directory).toHaveTextContent(/^src\/$/);
    expect(name).toHaveTextContent(/^client\/$/);
  });

  it("lets a caller replace the tooltip", () => {
    const { container } = render(
      <PathLabel path="b/new.ts" title="a/old.ts → b/new.ts" />,
    );
    expect(parts(container).root).toHaveAttribute(
      "title",
      "a/old.ts → b/new.ts",
    );
  });
});
