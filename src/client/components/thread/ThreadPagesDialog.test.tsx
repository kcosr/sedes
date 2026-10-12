// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PageRevision,
  PageRevisionPage,
} from "../../../shared/protocol/pages.js";
import type { ThreadClientStore } from "../../stores/ThreadClientStore.js";
import { ThreadPagesDialog } from "./ThreadPagesDialog.js";

vi.mock("../conversation/PagePreview.js", () => ({
  PagePreview: ({ page }: { page: PageRevision }) => (
    <article>
      {page.title} preview revision {page.revision}
    </article>
  ),
}));
beforeEach(() =>
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
);
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const page: PageRevision = {
  pageId: "30000000-0000-4000-8000-000000000001",
  threadId: "thread-1",
  revision: 2,
  title: "Newest mockup",
  viewport: {},
  createdAt: "2026-10-11T10:00:00.000Z",
  sha256: "a".repeat(64),
  byteSize: 256,
};

describe("thread page discovery", () => {
  it("lists durable publications on demand and opens paginated results independently of transcript history", async () => {
    const older = {
      ...page,
      pageId: "30000000-0000-4000-8000-000000000002",
      title: "Earlier mockup",
      revision: 1,
    };
    const listPages = vi
      .fn<(...args: unknown[]) => Promise<PageRevisionPage>>()
      .mockResolvedValueOnce({ items: [page], nextCursor: "older-pages" })
      .mockResolvedValueOnce({ items: [older] });
    const store = {
      listPages,
      createPageRenderAdmission: vi.fn(),
      listPageRevisions: vi.fn(),
      getPageRevision: vi.fn(),
    } as unknown as ThreadClientStore;
    const props = { onOpenChange: vi.fn(), store };
    const view = render(<ThreadPagesDialog open={false} {...props} />);
    expect(listPages).not.toHaveBeenCalled();
    view.rerender(<ThreadPagesDialog open {...props} />);
    expect(
      await screen.findByText("Newest mockup preview revision 2"),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more pages" }));
    await waitFor(() =>
      expect(listPages).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: "older-pages",
          signal: expect.any(AbortSignal),
        }),
      ),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: /Earlier mockup/ }),
    );
    expect(
      screen.getByText("Earlier mockup preview revision 1"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Newest mockup preview revision 2")).toBeNull();
    expect(
      screen.getByRole("button", { name: /Newest mockup/ }),
    ).toBeInTheDocument();
  });
});
