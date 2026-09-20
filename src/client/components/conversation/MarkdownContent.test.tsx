// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode, useLayoutEffect, useMemo, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  workspaceFileRootIdSchema,
  type WorkspaceFileLinkReference,
} from "../../../shared/index.js";
import {
  createWorkspaceFileLinkHandler,
  WorkspaceFileLinkProvider,
} from "../../workspace-files/workspace-file-link-routing.js";
import { setPanelPresentation } from "../../app/settings.js";
import { MarkdownContent } from "./MarkdownContent.js";

vi.mock("./MermaidDiagram.js", () => ({
  MermaidDiagram: ({
    source,
    sourcePositionAttributes,
  }: {
    source: string;
    sourcePositionAttributes: React.HTMLAttributes<HTMLDivElement>;
  }) => (
    <div data-testid="mermaid-diagram" {...sourcePositionAttributes}>
      {source}
    </div>
  ),
}));

afterEach(() => {
  cleanup();
  setPanelPresentation("split");
});

const fileRequest = (reference: WorkspaceFileLinkReference) => ({
  reference,
  target: { kind: "file" as const },
  presentation: "split" as const,
});

describe("MarkdownContent source-position metadata", () => {
  it("keeps metadata off for ordinary transcript rendering", () => {
    const { container } = render(
      <MarkdownContent># Heading\n\nBody</MarkdownContent>,
    );
    expect(
      container.querySelector("[data-markdown-block]"),
    ).not.toBeInTheDocument();
  });

  it("annotates positioned Markdown blocks without treating inline syntax as offsets", () => {
    const { container } = render(
      <MarkdownContent sourcePositionMetadata>
        {[
          "# Heading",
          "",
          "A **bold** [link](https://example.test).",
          "",
          "```ts",
          "const answer = 42;",
          "```",
          "",
          "| A | B |",
          "| - | - |",
          "| 1 | 2 |",
        ].join("\n")}
      </MarkdownContent>,
    );

    const heading = screen.getByRole("heading", { name: "Heading" });
    expect(heading).toHaveAttribute("data-markdown-block");
    expect(heading).toHaveAttribute("data-markdown-source-start-line", "1");
    expect(heading).toHaveAttribute("data-markdown-source-end-line", "1");
    expect(heading).toHaveAttribute("data-markdown-heading-level", "1");

    const paragraph = screen.getByText(
      (_, element) =>
        element?.tagName === "P" && element.textContent === "A bold link.",
    );
    expect(paragraph).toHaveAttribute("data-markdown-source-start-line", "3");
    expect(paragraph).toHaveAttribute("data-markdown-source-end-line", "3");
    expect(screen.getByText("bold")).not.toHaveAttribute("data-markdown-block");
    expect(screen.getByRole("link", { name: "link" })).not.toHaveAttribute(
      "data-markdown-block",
    );

    expect(container.querySelector("pre")).toHaveAttribute(
      "data-markdown-source-start-line",
      "5",
    );
    expect(container.querySelector("table")).toHaveAttribute(
      "data-markdown-source-start-line",
      "9",
    );
    expect(container.querySelector("td")).toHaveAttribute(
      "data-markdown-source-start-line",
      "11",
    );
  });
});

describe("MarkdownContent code block copy", () => {
  it("copies the raw fenced contents without the Markdown fence", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <MarkdownContent copyCodeBlocks>
        {"```ts\nconst answer = 42;\n\nconsole.log(answer);\n```"}
      </MarkdownContent>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "const answer = 42;\n\nconsole.log(answer);",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Code copied" }),
    ).toBeInTheDocument();
  });

  it("does not add copy controls unless the rendering surface opts in", () => {
    render(
      <MarkdownContent>{"```ts\nconst answer = 42;\n```"}</MarkdownContent>,
    );

    expect(
      screen.queryByRole("button", { name: "Copy code" }),
    ).not.toBeInTheDocument();
  });

  it("reports clipboard failures without removing the code", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: vi.fn().mockRejectedValue(new Error("denied")),
      },
    });

    render(
      <MarkdownContent copyCodeBlocks>
        {"```sh\necho hello\n```"}
      </MarkdownContent>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    expect(
      await screen.findByRole("button", { name: "Copy failed" }),
    ).toBeInTheDocument();
    expect(screen.getByText("echo hello")).toBeInTheDocument();
  });
});

describe("MarkdownContent syntax highlighting", () => {
  it("highlights a recognized closed fence without changing its text", async () => {
    const source = "const answer: number = 42;\nconsole.log(answer);\n";
    const { container } = render(
      <MarkdownContent>{`\`\`\`ts\n${source}\`\`\``}</MarkdownContent>,
    );

    const code = await waitFor(() => {
      const element = container.querySelector<HTMLElement>(
        'code[data-syntax-language="typescript"]',
      );
      expect(element).not.toBeNull();
      return element!;
    });
    expect(code.textContent).toBe(source);
    expect(
      code.querySelectorAll(".markdown-syntax-token").length,
    ).toBeGreaterThan(1);
  });

  it("keeps an incomplete streaming fence plain until it closes", async () => {
    const incomplete = "```ts\nconst answer = 4";
    const rendered = render(
      <MarkdownContent streaming>{incomplete}</MarkdownContent>,
    );

    expect(
      rendered.container.querySelector("[data-syntax-language]"),
    ).toBeNull();
    expect(rendered.container.querySelector("code")).toHaveTextContent(
      "const answer = 4",
    );

    rendered.rerender(
      <MarkdownContent streaming>{`${incomplete}2;\n\`\`\``}</MarkdownContent>,
    );
    await waitFor(() =>
      expect(
        rendered.container.querySelector(
          'code[data-syntax-language="typescript"]',
        ),
      ).not.toBeNull(),
    );
    expect(rendered.container.querySelector("code")?.textContent).toBe(
      "const answer = 42;\n",
    );
  });

  it("renders hostile-looking code only as text after highlighting", async () => {
    const { container } = render(
      <MarkdownContent>
        {"```html\n<script>alert('nope')</script>\n```"}
      </MarkdownContent>,
    );

    await waitFor(() =>
      expect(
        container.querySelector('code[data-syntax-language="html"]'),
      ).not.toBeNull(),
    );
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("code")?.textContent).toBe(
      "<script>alert('nope')</script>\n",
    );
  });

  it("renders cached tokens on the first render after a remount", async () => {
    const markdown = "```cpp\nint remounted_value = 7;\n```";
    const first = render(<MarkdownContent>{markdown}</MarkdownContent>);

    await waitFor(() =>
      expect(
        first.container.querySelector('code[data-syntax-language="cpp"]'),
      ).not.toBeNull(),
    );
    first.unmount();

    const second = render(<MarkdownContent>{markdown}</MarkdownContent>);
    const code = second.container.querySelector(
      'code[data-syntax-language="cpp"]',
    );
    expect(code).not.toBeNull();
    expect(
      code?.querySelectorAll(".markdown-syntax-token").length,
    ).toBeGreaterThan(0);
  });
});

describe("MarkdownContent Mermaid fences", () => {
  it("replaces only an incomplete streaming Mermaid fence with a placeholder", () => {
    const incomplete = "Before\n\n```mermaid\nflowchart LR\nA--";
    const rendered = render(
      <MarkdownContent streaming>{incomplete}</MarkdownContent>,
    );

    expect(screen.getByText("Before")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for diagram…",
    );
    expect(screen.queryByText(/flowchart LR/u)).toBeNull();
    expect(screen.queryByTestId("mermaid-diagram")).toBeNull();

    rendered.rerender(
      <MarkdownContent streaming>{`${incomplete}>B\n\`\`\``}</MarkdownContent>,
    );
    expect(screen.getByTestId("mermaid-diagram")).toHaveTextContent(
      "flowchart LR A-->B",
    );
  });

  it("does not treat a blockquote-looking top-level code line as a closer", () => {
    render(
      <MarkdownContent streaming>
        {"\`\`\`mermaid\nflowchart LR\n> \`\`\`"}
      </MarkdownContent>,
    );

    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for diagram…",
    );
    expect(screen.queryByText(/flowchart LR/u)).toBeNull();
    expect(screen.queryByTestId("mermaid-diagram")).toBeNull();
  });

  it("recognizes a matching closer inside a real blockquote", () => {
    render(
      <MarkdownContent streaming>
        {"> \`\`\`mermaid\n> flowchart LR\n> A-->B\n> \`\`\`"}
      </MarkdownContent>,
    );

    expect(screen.getByTestId("mermaid-diagram")).toHaveTextContent(
      "flowchart LR A-->B",
    );
  });

  it("renders only fenced Mermaid code as a diagram", () => {
    const { container } = render(
      <MarkdownContent>
        {[
          "Inline `mermaid`.",
          "",
          "```mermaid",
          "flowchart LR",
          "A-->B",
          "```",
          "",
          "```mermaid-ish",
          "leave me alone",
          "```",
        ].join("\n")}
      </MarkdownContent>,
    );

    expect(screen.getByTestId("mermaid-diagram")).toHaveTextContent(
      "flowchart LR A-->B",
    );
    expect(screen.getByText("mermaid").tagName).toBe("CODE");
    expect(screen.getByText("leave me alone").tagName).toBe("CODE");
    expect(container.querySelectorAll("pre")).toHaveLength(1);
  });

  it("preserves fence source lines and supports disabling diagrams", () => {
    const source = "Before\n\n```mermaid\nflowchart LR\nA-->B\n```";
    const rendered = render(
      <MarkdownContent sourcePositionMetadata>{source}</MarkdownContent>,
    );
    const diagram = screen.getByTestId("mermaid-diagram");
    expect(diagram).toHaveAttribute("data-markdown-block");
    expect(diagram).toHaveAttribute("data-markdown-source-start-line", "3");
    expect(diagram).toHaveAttribute("data-markdown-source-end-line", "6");

    rendered.rerender(
      <MarkdownContent enableMermaid={false} sourcePositionMetadata>
        {source}
      </MarkdownContent>,
    );
    expect(screen.queryByTestId("mermaid-diagram")).not.toBeInTheDocument();
    expect(screen.getByText("flowchart LR A-->B").tagName).toBe("CODE");
  });

  it("preserves a diagram subtree when owner context rerenders", () => {
    const rootId = workspaceFileRootIdSchema.parse("markdown-context");
    const source = "```mermaid\nflowchart LR\nA-->B\n```";
    const rendered = render(
      <MarkdownContent fileLinkSource={{ rootId, path: "one.md" }}>
        {source}
      </MarkdownContent>,
    );
    const diagram = screen.getByTestId("mermaid-diagram");

    rendered.rerender(
      <MarkdownContent fileLinkSource={{ rootId, path: "two.md" }}>
        {source}
      </MarkdownContent>,
    );

    expect(screen.getByTestId("mermaid-diagram")).toBe(diagram);
  });
});

describe("MarkdownContent workspace file links", () => {
  it.each([
    ["file:///C:/work/project/a%20guide.md", "C:\\work\\project\\a guide.md"],
    ["file:///work/project/a%20guide.md", "/work/project/a guide.md"],
    ["file://localhost/work/project/%2525.md", "/work/project/%25.md"],
  ])("passes %s to workspace file resolution", (href, expectedPath) => {
    const openReference = vi.fn();
    render(
      <WorkspaceFileLinkProvider handler={{ openReference }}>
        <MarkdownContent>{`[Open file](${href})`}</MarkdownContent>
      </WorkspaceFileLinkProvider>,
    );

    const link = screen.getByRole("link", { name: "Open file" });
    expect(link).toHaveAttribute("href", "#");
    fireEvent.click(link);
    expect(openReference).toHaveBeenCalledExactlyOnceWith(
      fileRequest({ kind: "absolute", path: expectedPath }),
    );
  });

  it("uses the stored presentation normally and inverts it for Shift-click", () => {
    const openReference = vi.fn();
    setPanelPresentation("single");
    render(
      <WorkspaceFileLinkProvider handler={{ openReference }}>
        <MarkdownContent>
          [Normal](file:///work/project/normal.md)
          [Shifted](file:///work/project/shifted.md)
        </MarkdownContent>
      </WorkspaceFileLinkProvider>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Normal" }));
    fireEvent.click(screen.getByRole("link", { name: "Shifted" }), {
      shiftKey: true,
    });

    expect(openReference).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ presentation: "single" }),
    );
    expect(openReference).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ presentation: "split" }),
    );
  });

  it.each([
    [
      "/home/user/project/README.md",
      "absolute",
      "/home/user/project/README.md",
      { kind: "file" },
    ],
    [
      "/home/user/project/src/client/styles.css:3887",
      "absolute",
      "/home/user/project/src/client/styles.css",
      { kind: "source_line", lineNumber: 3887 },
    ],
    ["README.md", "workspace_relative", "README.md", { kind: "file" }],
    [
      "README.md:27",
      "workspace_relative",
      "README.md",
      { kind: "source_line", lineNumber: 27 },
    ],
    [
      "README.md:9007199254740992",
      "workspace_relative",
      "README.md",
      { kind: "file" },
    ],
    ["./src/App.tsx", "workspace_relative", "src/App.tsx", { kind: "file" }],
    [
      "./src/App.tsx:42",
      "workspace_relative",
      "src/App.tsx",
      { kind: "source_line", lineNumber: 42 },
    ],
  ] as const)(
    "resolves path-shaped link %s through workspace files",
    (href, kind, path, target) => {
      const openReference = vi.fn();
      render(
        <WorkspaceFileLinkProvider handler={{ openReference }}>
          <MarkdownContent>{`[Open path](${href})`}</MarkdownContent>
        </WorkspaceFileLinkProvider>,
      );

      fireEvent.click(screen.getByRole("link", { name: "Open path" }));
      expect(openReference).toHaveBeenCalledExactlyOnceWith({
        reference: { kind, path },
        target,
        presentation: "split",
      });
    },
  );

  it("keeps file-preview links relative to the source directory and root", () => {
    const openReference = vi.fn();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    const rootId = workspaceFileRootIdSchema.parse("supplemental-context");
    render(
      <WorkspaceFileLinkProvider handler={{ openReference }}>
        <MarkdownContent
          fileLinkSource={{ rootId, path: "docs/guides/current.md" }}
        >
          {
            "[Sibling](next.md) [Explicit sibling](./other.md:27) [Parent](../escape.md) [Above root](../../../escape.md)"
          }
        </MarkdownContent>
      </WorkspaceFileLinkProvider>,
    );

    const sibling = screen.getByRole("link", { name: "Sibling" });
    const explicitSibling = screen.getByRole("link", {
      name: "Explicit sibling",
    });
    const parent = screen.getByRole("link", { name: "Parent" });
    expect(sibling).toHaveAttribute("href", "#");
    expect(explicitSibling).toHaveAttribute("href", "#");
    expect(parent).toHaveAttribute("href", "#");
    fireEvent.click(sibling);
    fireEvent.click(explicitSibling);
    expect(openReference).toHaveBeenNthCalledWith(1, {
      reference: {
        kind: "root_relative",
        rootId,
        path: "docs/guides/next.md",
      },
      target: { kind: "file" },
      presentation: "split",
    });
    expect(openReference).toHaveBeenNthCalledWith(2, {
      reference: {
        kind: "root_relative",
        rootId,
        path: "docs/guides/other.md",
      },
      target: { kind: "source_line", lineNumber: 27 },
      presentation: "split",
    });

    fireEvent.click(parent);
    expect(openReference).toHaveBeenNthCalledWith(3, {
      reference: {
        kind: "root_relative",
        rootId,
        path: "docs/escape.md",
      },
      target: { kind: "file" },
      presentation: "split",
    });
    expect(screen.queryByRole("link", { name: "Above root" })).toBeNull();
    expect(screen.getByText("Above root")).toBeInTheDocument();
    expect(openReference).toHaveBeenCalledTimes(3);
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("leaves file-preview query and fragment links as ordinary navigation", () => {
    const openReference = vi.fn();
    render(
      <WorkspaceFileLinkProvider handler={{ openReference }}>
        <MarkdownContent
          fileLinkSource={{ rootId: "primary", path: "docs/current.md" }}
        >
          {"[Query](next.md?raw=1) [Fragment](next.md#details)"}
        </MarkdownContent>
      </WorkspaceFileLinkProvider>,
    );

    expect(screen.getByRole("link", { name: "Query" })).toHaveAttribute(
      "href",
      "http://localhost:3000/next.md?raw=1",
    );
    expect(screen.getByRole("link", { name: "Fragment" })).toHaveAttribute(
      "href",
      "http://localhost:3000/next.md#details",
    );
    expect(openReference).not.toHaveBeenCalled();
  });

  it.each([
    "file://other-host/work/project/guide.md",
    "file:///work/project/bad%escape.md",
    "file:///work/project/nul%00name.md",
    "file:///work/project%2F%2Fsecret.md",
    "file:///work/project/guide.md?download=1",
    "file:///work/project/guide.md#L20",
  ])("fails closed for invalid local file URL %s", (href) => {
    const openReference = vi.fn();
    render(
      <WorkspaceFileLinkProvider handler={{ openReference }}>
        <MarkdownContent>{`[Do not open](${href})`}</MarkdownContent>
      </WorkspaceFileLinkProvider>,
    );

    expect(
      screen.queryByRole("link", { name: "Do not open" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Do not open")).toBeInTheDocument();
    expect(openReference).not.toHaveBeenCalled();
  });

  it("does not expose a file URL as a browser link without a resolver", () => {
    render(
      <>
        <MarkdownContent>
          [Local](file:///work/project/private.md)
        </MarkdownContent>
        <MarkdownContent
          fileLinkSource={{ rootId: "primary", path: "docs/current.md" }}
        >
          [Preview](next.md)
        </MarkdownContent>
      </>,
    );
    expect(
      screen.queryByRole("link", { name: "Local" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Local")).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Preview" }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Preview")).toBeInTheDocument();
  });

  it.each([
    [
      "is unavailable",
      () => Promise.resolve(false),
      "That file is not available in this workspace.",
    ],
    [
      "fails to resolve",
      () => Promise.reject(new Error("offline")),
      "Could not check that file. Check your connection and try again.",
    ],
  ])(
    "shows feedback when a workspace file %s",
    async (_label, openReference, message) => {
      render(
        <WorkspaceFileLinkProvider handler={{ openReference }}>
          <MarkdownContent>
            [Open file](file:///work/project/missing.md)
          </MarkdownContent>
        </WorkspaceFileLinkProvider>,
      );

      fireEvent.click(screen.getByRole("link", { name: "Open file" }));
      expect(await screen.findByRole("status")).toHaveTextContent(message);
    },
  );

  it("retains file URLs only for links and renders local images as neutral omissions", () => {
    const { container } = render(
      <WorkspaceFileLinkProvider handler={{ openReference: vi.fn() }}>
        <MarkdownContent>
          {
            "![Local image](file:///work/project/private.png) ![Unsafe image](javascript:alert(1)) [Local link](file:///work/project/private.md)"
          }
        </MarkdownContent>
      </WorkspaceFileLinkProvider>,
    );

    expect(
      screen.getByRole("link", { name: "Local link" }),
    ).toBeInTheDocument();
    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.querySelector('[src^="file:"]')).not.toBeInTheDocument();
    expect(screen.getByText("Image omitted · Local image")).toBeVisible();
    expect(screen.getByText("Image omitted · Unsafe image")).toBeVisible();
  });

  it("never turns Markdown image destinations into browser image requests", () => {
    const { container } = render(
      <MarkdownContent>
        {
          "![Relative](images/1.jpg) ![Root relative](/assets/local.png) ![Remote absolute](https://images.example.test/diagram.png) ![Same-origin absolute](http://localhost:3000/assets/same.png) ![Inline data](data:image/png;base64,iVBORw0KGgo=)"
        }
      </MarkdownContent>,
    );

    expect(container.querySelector("img")).not.toBeInTheDocument();
    expect(container.querySelector("[src]")).not.toBeInTheDocument();
    expect(screen.getAllByRole("note")).toHaveLength(5);
    for (const alt of [
      "Relative",
      "Root relative",
      "Remote absolute",
      "Same-origin absolute",
      "Inline data",
    ]) {
      expect(screen.getByText(`Image omitted · ${alt}`)).toBeVisible();
    }
  });

  it("preserves ordinary web, mail, root-relative, and protocol-relative links", () => {
    render(
      <MarkdownContent>
        {
          "[Web](https://example.test/a) [Port](http://localhost:3000/a) [Mail](mailto:user@example.test) [Root](/api/help) [CDN](//cdn.example.test/a)"
        }
      </MarkdownContent>,
    );

    expect(screen.getByRole("link", { name: "Web" })).toHaveAttribute(
      "href",
      "https://example.test/a",
    );
    expect(screen.getByRole("link", { name: "Mail" })).toHaveAttribute(
      "href",
      "mailto:user@example.test",
    );
    expect(screen.getByRole("link", { name: "Port" })).toHaveAttribute(
      "href",
      "http://localhost:3000/a",
    );
    expect(screen.getByRole("link", { name: "Root" })).toHaveAttribute(
      "href",
      "http://localhost:3000/api/help",
    );
    expect(screen.getByRole("link", { name: "CDN" })).toHaveAttribute(
      "href",
      "http://cdn.example.test/a",
    );
  });

  it("does not reinterpret a denied absolute path as a localhost URL", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(
      <WorkspaceFileLinkProvider
        handler={{ openReference: vi.fn().mockResolvedValue(false) }}
      >
        <MarkdownContent>[API help](/api/help)</MarkdownContent>
      </WorkspaceFileLinkProvider>,
    );

    const link = screen.getByRole("link", { name: "API help" });
    expect(link).toHaveAttribute("href", "#");
    fireEvent.click(link, { ctrlKey: true });
    expect(await screen.findByRole("status")).toHaveTextContent(
      "That file is not available in this workspace.",
    );
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("retains ordinary navigation for a denied relative path", async () => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(
      <WorkspaceFileLinkProvider
        handler={{ openReference: vi.fn().mockResolvedValue(false) }}
      >
        <MarkdownContent>[Design](docs/design.md)</MarkdownContent>
      </WorkspaceFileLinkProvider>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Design" }));
    await vi.waitFor(() =>
      expect(open).toHaveBeenCalledWith(
        "http://localhost:3000/docs/design.md",
        "_blank",
        "noopener,noreferrer",
      ),
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    open.mockRestore();
  });

  it("does not send escaping relative paths to the workspace resolver", () => {
    const openReference = vi.fn();
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    render(
      <WorkspaceFileLinkProvider handler={{ openReference }}>
        <MarkdownContent>[Parent](../secret.md)</MarkdownContent>
      </WorkspaceFileLinkProvider>,
    );

    fireEvent.click(screen.getByRole("link", { name: "Parent" }));
    expect(openReference).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledOnce();
    open.mockRestore();
  });

  it("opens only the opaque address returned by workspace-scoped resolution", async () => {
    const resolve = vi.fn().mockResolvedValue({
      status: "resolved",
      rootId: "root-context",
      path: "repos/sedes/AGENTS.md",
      rootVisibility: "link_only",
    });
    const open = vi.fn();
    const handler = createWorkspaceFileLinkHandler({
      threadId: "thread-1",
      workspaceId: "workspace-1",
      resolve,
      open,
    });

    const reference = {
      kind: "absolute" as const,
      path: "/home/user/agent-context/AGENTS.md",
    };
    await handler.openReference({
      reference,
      target: { kind: "source_line", lineNumber: 27 },
      presentation: "single",
    });

    expect(resolve).toHaveBeenCalledExactlyOnceWith(
      "thread-1",
      reference,
      expect.any(AbortSignal),
    );
    expect(open).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        kind: "open-workspace-file",
        workspaceId: "workspace-1",
        rootId: "root-context",
        path: "repos/sedes/AGENTS.md",
        rootVisibility: "link_only",
        target: { kind: "source_line", lineNumber: 27 },
      }),
      "single",
    );
  });

  it("does not open unknown or unavailable paths rejected by the server", async () => {
    const open = vi.fn();
    const handler = createWorkspaceFileLinkHandler({
      threadId: "thread-1",
      workspaceId: "workspace-1",
      resolve: vi.fn().mockResolvedValue({ status: "not_found" }),
      open,
    });

    await expect(
      handler.openReference(
        fileRequest({ kind: "absolute", path: "/outside/secret.txt" }),
      ),
    ).resolves.toBe(false);
    expect(open).not.toHaveBeenCalled();
  });

  it("gives repeated opens distinct intent sequences", async () => {
    const open = vi.fn();
    const handler = createWorkspaceFileLinkHandler({
      threadId: "thread-1",
      workspaceId: "workspace-1",
      resolve: vi.fn().mockResolvedValue({
        status: "resolved",
        rootId: "primary",
        path: "README.md",
        rootVisibility: "listed",
      }),
      open,
    });

    const reference = {
      kind: "absolute" as const,
      path: "/work/project/README.md",
    };
    await handler.openReference(fileRequest(reference));
    await handler.openReference(fileRequest(reference));

    expect(open).toHaveBeenCalledTimes(2);
    const first = open.mock.calls[0]?.[0];
    const second = open.mock.calls[1]?.[0];
    expect(first.sequence).not.toBe(second.sequence);
  });

  it("ignores an older click that resolves after the latest click", async () => {
    const completions = new Map<
      string,
      (value: {
        status: "resolved";
        rootId: "primary";
        path: string;
        rootVisibility: "listed";
      }) => void
    >();
    const resolve = vi.fn(
      (_workspaceId: string, reference: { path: string }) =>
        new Promise<{
          status: "resolved";
          rootId: "primary";
          path: string;
          rootVisibility: "listed";
        }>((done) => completions.set(reference.path, done)),
    );
    const open = vi.fn();
    const handler = createWorkspaceFileLinkHandler({
      threadId: "thread-1",
      workspaceId: "workspace-1",
      resolve,
      open,
    });

    const first = handler.openReference({
      ...fileRequest({
        kind: "absolute",
        path: "/work/project/first.md",
      }),
      presentation: "single",
    });
    const second = handler.openReference(
      fileRequest({ kind: "absolute", path: "/work/project/second.md" }),
    );
    completions.get("/work/project/second.md")?.({
      status: "resolved",
      rootId: "primary",
      path: "second.md",
      rootVisibility: "listed",
    });
    await second;
    completions.get("/work/project/first.md")?.({
      status: "resolved",
      rootId: "primary",
      path: "first.md",
      rootVisibility: "listed",
    });
    await first;

    expect(open).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        rootId: "primary",
        path: "second.md",
      }),
      "split",
    );
  });

  it("does not open after its workspace routing scope is disposed", async () => {
    let completeResolution:
      | ((value: {
          status: "resolved";
          rootId: "primary";
          path: string;
          rootVisibility: "listed";
        }) => void)
      | undefined;
    const resolve = vi.fn(
      (_workspaceId, _path, signal?: AbortSignal) =>
        new Promise<{
          status: "resolved";
          rootId: "primary";
          path: string;
          rootVisibility: "listed";
        }>((done) => {
          completeResolution = done;
          expect(signal?.aborted).toBe(false);
        }),
    );
    const open = vi.fn();
    const handler = createWorkspaceFileLinkHandler({
      threadId: "thread-a",
      workspaceId: "workspace-a",
      resolve,
      open,
    });

    const pending = handler.openReference(
      fileRequest({ kind: "absolute", path: "/work/a/README.md" }),
    );
    handler.dispose?.();
    completeResolution?.({
      status: "resolved",
      rootId: "primary",
      path: "README.md",
      rootVisibility: "listed",
    });
    await pending;

    expect(resolve.mock.calls[0]?.[2]?.aborted).toBe(true);
    expect(open).not.toHaveBeenCalled();
  });

  it("treats an aborted resolver rejection as a silent obsolete request", async () => {
    const handler = createWorkspaceFileLinkHandler({
      threadId: "thread-a",
      workspaceId: "workspace-a",
      resolve: vi.fn(
        (
          _workspaceId: string,
          _reference: { path: string },
          signal?: AbortSignal,
        ) =>
          new Promise<never>((_resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
      open: vi.fn(),
    });

    const pending = handler.openReference(
      fileRequest({ kind: "absolute", path: "/work/a/README.md" }),
    );
    handler.dispose?.();
    await expect(pending).resolves.toBeUndefined();
  });

  it("resolves file links after StrictMode's simulated cleanup and remount", async () => {
    const resolve = vi.fn().mockResolvedValue({
      status: "resolved",
      rootId: "primary",
      path: "README.md",
      rootVisibility: "listed",
    });
    const open = vi.fn();

    render(
      <StrictMode>
        <StrictModeFileLinkRouting resolve={resolve} open={open}>
          <MarkdownContent>
            [README](file:///work/project/README.md)
          </MarkdownContent>
        </StrictModeFileLinkRouting>
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("link", { name: "README" }));

    await vi.waitFor(() => expect(open).toHaveBeenCalledOnce());
    expect(resolve.mock.calls[0]?.[2]?.aborted).toBe(false);
  });
});

function StrictModeFileLinkRouting({
  resolve,
  open,
  children,
}: {
  readonly resolve: Parameters<
    typeof createWorkspaceFileLinkHandler
  >[0]["resolve"];
  readonly open: Parameters<typeof createWorkspaceFileLinkHandler>[0]["open"];
  readonly children: ReactNode;
}): React.JSX.Element {
  const handler = useMemo(
    () =>
      createWorkspaceFileLinkHandler({
        threadId: "thread-1",
        workspaceId: "workspace-1",
        resolve,
        open,
      }),
    [open, resolve],
  );
  useLayoutEffect(() => () => handler.dispose?.(), [handler]);
  return (
    <WorkspaceFileLinkProvider handler={handler}>
      {children}
    </WorkspaceFileLinkProvider>
  );
}
