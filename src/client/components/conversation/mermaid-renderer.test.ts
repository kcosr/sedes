// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const { initialize, render } = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: { initialize, render },
}));

import { renderMermaid } from "./mermaid-renderer.js";

beforeEach(() => {
  initialize.mockClear();
  render.mockReset();
});

describe("renderMermaid", () => {
  it("serializes strict, bounded renders with unique ids and app themes", async () => {
    render
      .mockResolvedValueOnce({
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Light</text></svg>',
      })
      .mockResolvedValueOnce({
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Dark</text></svg>',
      });

    const light = renderMermaid("flowchart LR\nA-->B", "light");
    const dark = renderMermaid("flowchart LR\nB-->C", "dark");

    await expect(light).resolves.toContain("Light");
    await expect(dark).resolves.toContain("Dark");
    expect(initialize).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        startOnLoad: false,
        securityLevel: "strict",
        htmlLabels: false,
        suppressErrorRendering: true,
        logLevel: "fatal",
        theme: "default",
        maxTextSize: 50_000,
        maxEdges: 500,
      }),
    );
    expect(initialize).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ theme: "dark" }),
    );
    const firstId = render.mock.calls[0]?.[0];
    const secondId = render.mock.calls[1]?.[0];
    expect(firstId).toMatch(/^sedes-mermaid-\d+$/);
    expect(secondId).toMatch(/^sedes-mermaid-\d+$/);
    expect(secondId).not.toBe(firstId);
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><text onclick="alert(1)">Unsafe</text></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.test">Unsafe</a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" xml:base="https://example.test"><use href="#remote" /></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://example.test/a.css";</style></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">Unsafe</div></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><div xmlns="http://www.w3.org/1999/xhtml">Unsafe</div></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="#safe"><set attributeName="href" to="https://example.test" /></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="#safe"><animate attributeName="href" values="#safe;https://example.test" /></image></svg>',
  ])("rejects unsafe SVG returned by the renderer", async (svg) => {
    render.mockResolvedValueOnce({ svg });

    await expect(renderMermaid("flowchart LR\nA-->B", "light")).rejects.toThrow(
      /unsafe|external|foreign/i,
    );
  });
});
