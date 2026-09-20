// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { NormalizedEnvironmentSummary } from "../../shared/index.js";
import {
  DirectoryPickerDialog,
  type DirectoryPickerApi,
} from "./DirectoryPickerDialog.js";

const environments: readonly NormalizedEnvironmentSummary[] = [
  {
    id: "local",
    kind: "local",
    label: { text: "Local" },
    available: true,
    directoryBrowsing: "available",
  },
  {
    id: "remote",
    kind: "ssh",
    label: { text: "Remote" },
    available: true,
    directoryBrowsing: "unavailable",
  },
  {
    id: "offline",
    kind: "ssh",
    label: { text: "Offline carrier" },
    available: false,
    directoryBrowsing: "available",
  },
];

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {
    observe(): void {}
    disconnect(): void {}
    unobserve(): void {}
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function picker(
  api: DirectoryPickerApi,
  options: {
    readonly environmentId?: string;
    readonly mobileSheet?: boolean;
    readonly path?: string;
    readonly onPathChange?: (path: string) => void;
    readonly onSubmit?: () => void;
  } = {},
) {
  return (
    <DirectoryPickerDialog
      open
      onOpenChange={vi.fn()}
      title="Choose directory"
      description="Pick one."
      environments={environments}
      environmentId={options.environmentId ?? "local"}
      mobileSheet={options.mobileSheet}
      onEnvironmentChange={vi.fn()}
      path={options.path ?? ""}
      onPathChange={options.onPathChange ?? vi.fn()}
      api={api}
      submitLabel="Choose"
      onSubmit={options.onSubmit ?? vi.fn()}
    />
  );
}

describe("DirectoryPickerDialog", () => {
  it("navigates returned directories and moves focus into the new listing", async () => {
    const onPathChange = vi.fn();
    const browseExecutionEnvironmentDirectories = vi
      .fn()
      .mockResolvedValueOnce({
        location: { kind: "roots" },
        entries: [{ name: "worktrees", path: "/home/me/worktrees" }],
        truncated: false,
      })
      .mockResolvedValueOnce({
        location: {
          kind: "directory",
          path: "/home/me/worktrees",
          parentPath: "/home/me",
        },
        entries: [{ name: "sedes", path: "/home/me/worktrees/sedes" }],
        truncated: false,
      });

    render(
      picker(
        { browseExecutionEnvironmentDirectories },
        { onPathChange },
      ),
    );

    fireEvent.click(await screen.findByRole("button", { name: /worktrees/ }));
    expect(onPathChange).toHaveBeenCalledWith("/home/me/worktrees");
    const sedes = await screen.findByRole("button", { name: /sedes/ });
    await waitFor(() => expect(sedes).toHaveFocus());
    expect(browseExecutionEnvironmentDirectories).toHaveBeenLastCalledWith(
      "local",
      expect.objectContaining({
        location: { kind: "directory", path: "/home/me/worktrees" },
      }),
      expect.any(AbortSignal),
    );
    expect(screen.getByRole("navigation", { name: "Directory breadcrumbs" })).toHaveTextContent(
      "Rootsworktrees",
    );
  });

  it("disambiguates configured roots that share a basename", async () => {
    const browseExecutionEnvironmentDirectories = vi.fn(async () => ({
      location: { kind: "roots" as const },
      entries: [
        { name: "worktrees", path: "/srv/worktrees" },
        { name: "worktrees", path: "/home/me/worktrees" },
      ],
      truncated: false,
    }));
    render(picker({ browseExecutionEnvironmentDirectories }));

    expect(
      await screen.findByRole("button", {
        name: "worktrees — /srv/worktrees",
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", {
        name: "worktrees — /home/me/worktrees",
      }),
    ).toBeVisible();
  });

  it("layers the picker above a nested mobile workspace sheet", async () => {
    render(
      picker({
        browseExecutionEnvironmentDirectories: vi.fn(async () => ({
          location: { kind: "roots" as const },
          entries: [],
          truncated: false,
        })),
      }),
    );

    expect(screen.getByRole("dialog")).toHaveClass("z-[111]");
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toHaveClass(
      "z-[110]",
    );
  });

  it("lifts the mobile sheet when the keyboard shrinks the visual viewport", async () => {
    const viewport = Object.assign(new EventTarget(), { height: window.innerHeight - 280, offsetTop: 0 });
    vi.stubGlobal("visualViewport", viewport);
    render(picker({ browseExecutionEnvironmentDirectories: vi.fn(async () => ({
      location: { kind: "roots" as const }, entries: [], truncated: false,
    })) }, { mobileSheet: true }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("data-mobile-sheet", "true");
    expect(dialog.style.getPropertyValue("--directory-keyboard-inset")).toBe("280px");
    act(() => {
      viewport.height = window.innerHeight;
      viewport.dispatchEvent(new Event("resize"));
    });
    expect(dialog.style.getPropertyValue("--directory-keyboard-inset")).toBe("0px");
  });

  it("bounds narrow breadcrumbs while keeping toolbar actions outside their scroll area", async () => {
    const browseExecutionEnvironmentDirectories = vi
      .fn()
      .mockResolvedValueOnce({
        location: { kind: "roots" },
        entries: [
          {
            name: "sedes-directory-browser",
            path: "/home/me/sedes-directory-browser",
          },
        ],
        truncated: false,
      })
      .mockResolvedValueOnce({
        location: {
          kind: "directory",
          path: "/home/me/sedes-directory-browser",
        },
        entries: [{ name: "docs", path: "/home/me/sedes-directory-browser/docs" }],
        truncated: false,
      });
    render(picker({ browseExecutionEnvironmentDirectories }));

    fireEvent.click(
      await screen.findByRole("button", {
        name: /sedes-directory-browser/,
      }),
    );
    await screen.findByRole("button", { name: "docs" });
    const breadcrumbs = screen.getByRole("navigation", {
      name: "Directory breadcrumbs",
    });
    const refresh = screen.getByRole("button", { name: "Refresh directory" });
    expect(breadcrumbs).toHaveClass("min-w-0", "flex-1", "overflow-x-auto");
    expect(refresh).toHaveClass("shrink-0");
    expect(breadcrumbs).not.toContainElement(refresh);
    expect(
      within(breadcrumbs).getByRole("button", {
        name: "sedes-directory-browser",
      }),
    ).toHaveClass(
      "max-w-[min(8rem,35vw)]",
      "justify-start",
      "truncate",
      "sm:max-w-48",
    );
  });

  it("caps intermediate breadcrumbs so the current leaf fits at mobile width", async () => {
    const browseExecutionEnvironmentDirectories = vi
      .fn()
      .mockResolvedValueOnce({
        location: { kind: "roots" },
        entries: [
          {
            name: "sedes-directory-browser",
            path: "/home/me/sedes-directory-browser",
          },
        ],
        truncated: false,
      })
      .mockResolvedValueOnce({
        location: {
          kind: "directory",
          path: "/home/me/sedes-directory-browser",
        },
        entries: [{ name: "docs", path: "/home/me/sedes-directory-browser/docs" }],
        truncated: false,
      })
      .mockResolvedValueOnce({
        location: {
          kind: "directory",
          path: "/home/me/sedes-directory-browser/docs",
          parentPath: "/home/me/sedes-directory-browser",
        },
        entries: [],
        truncated: false,
      });
    render(picker({ browseExecutionEnvironmentDirectories }));

    fireEvent.click(
      await screen.findByRole("button", { name: /sedes-directory-browser/ }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "docs" }));
    await waitFor(() =>
      expect(browseExecutionEnvironmentDirectories).toHaveBeenCalledTimes(3),
    );
    await screen.findByText("No child directories.");

    const breadcrumbs = screen.getByRole("navigation", {
      name: "Directory breadcrumbs",
    });
    const repo = within(breadcrumbs).getByRole("button", {
      name: "sedes-directory-browser",
    });
    const leaf = within(breadcrumbs).getByRole("button", { name: "docs" });
    expect(repo).toHaveClass(
      "max-w-14",
      "justify-start",
      "sm:max-w-32",
      "truncate",
    );
    expect(repo).toHaveAttribute("title", "sedes-directory-browser");
    expect(leaf).toHaveClass(
      "max-w-[min(8rem,35vw)]",
      "justify-start",
      "sm:max-w-48",
      "truncate",
    );
    expect(leaf).toHaveAttribute("title", "docs");
    expect(leaf).toBeDisabled();
  });

  it("paginates the current location without replacing earlier entries", async () => {
    const browseExecutionEnvironmentDirectories = vi
      .fn()
      .mockResolvedValueOnce({
        location: { kind: "roots" },
        entries: [{ name: "one", path: "/one" }],
        nextCursor: "cursor-2",
        truncated: true,
      })
      .mockResolvedValueOnce({
        location: { kind: "roots" },
        entries: [{ name: "two", path: "/two" }],
        truncated: false,
      });
    render(picker({ browseExecutionEnvironmentDirectories }));

    await screen.findByRole("button", { name: "one — /one" });
    expect(screen.getByText(/reached the browsing safety limit/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(
      await screen.findByRole("button", { name: "two — /two" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "one — /one" }),
    ).toBeVisible();
    expect(browseExecutionEnvironmentDirectories).toHaveBeenLastCalledWith(
      "local",
      expect.objectContaining({ cursor: "cursor-2" }),
      expect.any(AbortSignal),
    );
  });

  it("preserves loaded rows and offers inline retry when pagination fails", async () => {
    const browseExecutionEnvironmentDirectories = vi
      .fn()
      .mockResolvedValueOnce({
        location: { kind: "roots" },
        entries: [{ name: "one", path: "/one" }],
        nextCursor: "cursor-2",
        truncated: false,
      })
      .mockRejectedValueOnce(new Error("More directories could not be loaded"))
      .mockResolvedValueOnce({
        location: { kind: "roots" },
        entries: [{ name: "two", path: "/two" }],
        truncated: false,
      });
    render(picker({ browseExecutionEnvironmentDirectories }));

    expect(
      await screen.findByRole("button", { name: "one — /one" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "More directories could not be loaded",
    );
    expect(screen.getByRole("button", { name: "one — /one" })).toBeVisible();
    expect(screen.getByRole("list", { name: "Directories" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      screen.getByRole("button", { name: "Try loading more again" }),
    );
    expect(
      await screen.findByRole("button", { name: "two — /two" }),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "one — /one" })).toBeVisible();
    expect(browseExecutionEnvironmentDirectories).toHaveBeenLastCalledWith(
      "local",
      expect.objectContaining({ cursor: "cursor-2" }),
      expect.any(AbortSignal),
    );
  });

  it("keeps status and pagination controls outside the directory list", async () => {
    const browseExecutionEnvironmentDirectories = vi.fn(async () => ({
      location: { kind: "roots" as const },
      entries: [{ name: "one", path: "/one" }],
      nextCursor: "cursor-2",
      truncated: true,
    }));
    render(picker({ browseExecutionEnvironmentDirectories }));

    const list = await screen.findByRole("list", { name: "Directories" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(1);
    expect(within(list).queryByRole("status")).not.toBeInTheDocument();
    expect(
      within(list).queryByRole("button", { name: "Load more" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load more" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "reached the browsing safety limit",
    );
  });

  it("uses the server-authoritative parent when backing out of a typed path", async () => {
    const browseExecutionEnvironmentDirectories = vi
      .fn()
      .mockResolvedValueOnce({
        location: { kind: "roots" },
        entries: [],
        truncated: false,
      })
      .mockResolvedValueOnce({
        location: {
          kind: "directory",
          path: "/home/me/projects/sedes",
          parentPath: "/home/me/projects",
        },
        entries: [],
        truncated: false,
      })
      .mockResolvedValueOnce({
        location: {
          kind: "directory",
          path: "/home/me/projects",
          parentPath: "/home/me",
        },
        entries: [],
        truncated: false,
      });
    render(
      picker(
        { browseExecutionEnvironmentDirectories },
        { path: "/home/me/projects/sedes" },
      ),
    );

    await waitFor(() =>
      expect(browseExecutionEnvironmentDirectories).toHaveBeenCalledOnce(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    await waitFor(() =>
      expect(browseExecutionEnvironmentDirectories).toHaveBeenCalledTimes(2),
    );
    fireEvent.click(screen.getByRole("button", { name: "Back one directory" }));

    await waitFor(() =>
      expect(browseExecutionEnvironmentDirectories).toHaveBeenLastCalledWith(
        "local",
        expect.objectContaining({
          location: { kind: "directory", path: "/home/me/projects" },
        }),
        expect.any(AbortSignal),
      ),
    );
  });

  it("retries the failed attempted location rather than the last successful one", async () => {
    const browseExecutionEnvironmentDirectories = vi
      .fn()
      .mockResolvedValueOnce({
        location: { kind: "roots" },
        entries: [],
        truncated: false,
      })
      .mockRejectedValueOnce(new Error("Directory could not be read"))
      .mockResolvedValueOnce({
        location: {
          kind: "directory",
          path: "/home/me/projects/sedes",
          parentPath: "/home/me/projects",
        },
        entries: [],
        truncated: false,
      });
    render(
      picker(
        { browseExecutionEnvironmentDirectories },
        { path: "/home/me/projects/sedes" },
      ),
    );

    await waitFor(() =>
      expect(browseExecutionEnvironmentDirectories).toHaveBeenCalledOnce(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Browse" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Directory could not be read",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() =>
      expect(browseExecutionEnvironmentDirectories).toHaveBeenLastCalledWith(
        "local",
        expect.objectContaining({
          location: {
            kind: "directory",
            path: "/home/me/projects/sedes",
          },
        }),
        expect.any(AbortSignal),
      ),
    );
    expect(browseExecutionEnvironmentDirectories).toHaveBeenCalledTimes(3);
  });

  it("searches environments by label or kind and clears the path only on selection", async () => {
    const onEnvironmentChange = vi.fn();
    const onPathChange = vi.fn();
    render(
      <DirectoryPickerDialog
        open
        onOpenChange={vi.fn()}
        title="Choose directory"
        description="Pick one."
        environments={environments}
        environmentId="local"
        onEnvironmentChange={onEnvironmentChange}
        path="/local/project"
        onPathChange={onPathChange}
        api={{ browseExecutionEnvironmentDirectories: vi.fn(async () => ({
          location: { kind: "roots" as const },
          entries: [],
          truncated: false,
        })) }}
        submitLabel="Choose"
        onSubmit={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Directory environment" });
    fireEvent.click(trigger);
    const currentSearch = await screen.findByRole("combobox", { name: "Search environments" });
    fireEvent.change(currentSearch, { target: { value: "LOCAL" } });
    fireEvent.keyDown(currentSearch, { key: "Enter" });
    expect(onPathChange).not.toHaveBeenCalled();
    expect(onEnvironmentChange).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(trigger);
    const search = await screen.findByRole("combobox", { name: "Search environments" });
    await waitFor(() => expect(search).toHaveFocus());
    fireEvent.change(search, { target: { value: "SSH" } });
    expect(screen.getAllByRole("option")).toHaveLength(2);
    expect(screen.getByRole("option", { name: "Offline carrier — Unavailable" })).toBeVisible();
    expect(screen.queryByRole("option", { name: "Local" })).not.toBeInTheDocument();
    fireEvent.change(search, { target: { value: "REMOTE" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "Remote" })).toBeVisible();
    expect(onPathChange).not.toHaveBeenCalled();
    expect(onEnvironmentChange).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "Enter" });

    expect(onPathChange).toHaveBeenCalledWith("");
    expect(onEnvironmentChange).toHaveBeenCalledWith("remote");
    expect(screen.queryByRole("combobox", { name: "Search environments" })).not.toBeInTheDocument();
  });

  it("aborts and ignores an older environment request", async () => {
    let resolveOld: ((value: unknown) => void) | undefined;
    const oldRequest = new Promise((resolve) => {
      resolveOld = resolve;
    });
    const browseExecutionEnvironmentDirectories = vi
      .fn()
      .mockReturnValueOnce(oldRequest)
      .mockResolvedValueOnce({
        location: { kind: "roots" },
        entries: [{ name: "new", path: "/new" }],
        truncated: false,
      });
    const { rerender } = render(
      picker({ browseExecutionEnvironmentDirectories }),
    );
    const oldSignal = browseExecutionEnvironmentDirectories.mock.calls[0]?.[2] as AbortSignal;

    rerender(
      <DirectoryPickerDialog
        open
        onOpenChange={vi.fn()}
        title="Choose directory"
        description="Pick one."
        environments={[
          environments[0]!,
          { ...environments[1]!, directoryBrowsing: "available" },
        ]}
        environmentId="remote"
        onEnvironmentChange={vi.fn()}
        path=""
        onPathChange={vi.fn()}
        api={{ browseExecutionEnvironmentDirectories }}
        submitLabel="Choose"
        onSubmit={vi.fn()}
      />,
    );

    expect(oldSignal.aborted).toBe(true);
    expect(await screen.findByRole("button", { name: /new/ })).toBeVisible();
    resolveOld?.({
      location: { kind: "roots" },
      entries: [{ name: "old", path: "/old" }],
      truncated: false,
    });
    await Promise.resolve();
    expect(screen.queryByRole("button", { name: /old/ })).not.toBeInTheDocument();
  });

  it("keeps manual path submission available when browsing is unsupported", () => {
    const onSubmit = vi.fn();
    const browseExecutionEnvironmentDirectories = vi.fn();
    render(
      picker(
        { browseExecutionEnvironmentDirectories },
        { environmentId: "remote", path: "/remote/project", onSubmit },
      ),
    );

    expect(screen.getByText(/Directory browsing is unavailable/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Browse" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Choose" }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(browseExecutionEnvironmentDirectories).not.toHaveBeenCalled();
  });

  it("allows browsing and admission when foreground environment health is unavailable", async () => {
    const onSubmit = vi.fn();
    const browseExecutionEnvironmentDirectories = vi.fn(async () => ({
      location: { kind: "roots" as const },
      entries: [{ name: "projects", path: "/srv/projects" }],
      truncated: false,
    }));
    render(
      picker(
        { browseExecutionEnvironmentDirectories },
        { environmentId: "offline", path: "/srv/projects", onSubmit },
      ),
    );

    expect(
      await screen.findByRole("button", {
        name: "projects — /srv/projects",
      }),
    ).toBeVisible();
    const submit = screen.getByRole("button", { name: "Choose" });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(onSubmit).toHaveBeenCalledOnce();
  });
});
