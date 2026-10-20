// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalResource } from "../../shared/index.js";
import type { TerminalPanelHandle } from "./TerminalPanel.js";

Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => null,
});
Object.defineProperty(window, "matchMedia", {
  configurable: true,
  value: vi.fn(() => ({
    matches: false,
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  })),
});

const { TerminalPanel, terminalNotice } = await import("./TerminalPanel.js");

afterEach(cleanup);

describe("TerminalPanel accessibility", () => {
  it("keeps desktop chrome compact and exposes search and transcript on demand", () => {
    const ref = createRef<TerminalPanelHandle>();
    const { container } = render(
      <TerminalPanel
        ref={ref}
        terminal={terminal}
        producerId="00000000-0000-4000-8000-000000000014"
        api={{
          createTerminalAdmission: vi.fn(),
          terminalWebSocketUrl: vi.fn(),
        }}
        visible={false}
      />,
    );

    expect(screen.queryByRole("search", { name: "Search terminal" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Terminal keys" })).toBeNull();
    expect(container.querySelector(".terminal-panel-emulator")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    expect(container.querySelector("[aria-live]")).toBeNull();

    act(() => ref.current?.openSearch());
    expect(
      screen.getByRole("searchbox", { name: "Search terminal text" }),
    ).toBeInTheDocument();
    act(() => ref.current?.openTranscript());
    expect(
      screen.getByRole("document", {
        name: "Terminal terminal transcript text",
      }),
    ).toHaveTextContent("No terminal text is available.");
    expect(
      screen.getByRole("search", { name: "Search terminal transcript" }),
    ).toBeInTheDocument();
    // The shared Input, labelled for assistive technology.
    expect(
      screen.getByRole("textbox", { name: "Search transcript text" }),
    ).toHaveAttribute("data-slot", "input");
    fireEvent.change(
      screen.getByRole("textbox", { name: "Search transcript text" }),
      {
        target: { value: "prompt" },
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(
      within(screen.getByLabelText("Terminal transcript")).getByRole("status"),
    ).toHaveTextContent("0 matches");

    fireEvent.change(
      screen.getByRole("textbox", { name: "Search transcript text" }),
      { target: { value: " a \t" } },
    );
    expect(
      screen.getByRole("textbox", { name: "Search transcript text" }),
    ).toHaveValue(" a \t");
    expect(
      within(screen.getByLabelText("Terminal transcript")).queryByRole("status"),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(
      within(screen.getByLabelText("Terminal transcript")).queryByRole("status"),
    ).toBeNull();
  });

  it("clears search and transcript UI before rendering a different terminal", () => {
    const ref = createRef<TerminalPanelHandle>();
    const props = {
      ref,
      producerId: "00000000-0000-4000-8000-000000000014",
      api: {
        createTerminalAdmission: vi.fn(),
        terminalWebSocketUrl: vi.fn(),
      },
      visible: false,
    } as const;
    const view = render(<TerminalPanel {...props} terminal={terminal} />);
    act(() => ref.current?.openSearch());
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search terminal text" }),
      { target: { value: "private output" } },
    );
    act(() => ref.current?.openTranscript());

    view.rerender(
      <TerminalPanel
        {...props}
        terminal={{
          ...terminal,
          terminalId: "00000000-0000-4000-8000-000000000020",
          incarnationId: "00000000-0000-4000-8000-000000000021",
          displayName: "Other",
        }}
      />,
    );

    expect(screen.queryByRole("search", { name: "Search terminal" })).toBeNull();
    expect(screen.queryByLabelText("Terminal transcript")).toBeNull();
  });
});

const terminal: TerminalResource = {
  terminalId: "00000000-0000-4000-8000-000000000010",
  threadId: "00000000-0000-4000-8000-000000000011",
  workspaceId: "00000000-0000-4000-8000-000000000012",
  environmentId: "local",
  environmentLabel: "Local",
  incarnationId: "00000000-0000-4000-8000-000000000013",
  displayName: "Terminal",
  shellProfile: null,
  initialCwd: "/workspace",
  terminationEffect: "end_process",
  lifecycle: "running",
  lifecycleRevision: 1,
  rows: 24,
  columns: 80,
  initialRows: 24,
  initialColumns: 80,
  historyFloorSeq: 0,
  headSeq: 0,
  exitCode: null,
  exitSignal: null,
  publicReason: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  startedAt: "2026-08-27T00:00:00.000Z",
  exitedAt: null,
  updatedAt: "2026-08-27T00:00:00.000Z",
};

describe("terminalNotice", () => {
  const ready = {
    connection: "ready",
    role: "controller",
    controlRequestPending: false,
    controllerEpoch: 1,
    lifecycle: "running",
    lifecycleRevision: 1,
    rows: 24,
    columns: 80,
    caughtUp: true,
    inputAvailable: true,
    retryInputAvailable: false,
    queuedInputCount: 0,
    queuedInputBytes: 0,
    inputQueueOverflowed: false,
  } as const;

  it("shows nothing for a quiet session", () => {
    expect(terminalNotice(ready)).toBeUndefined();
  });

  it("marks a failed connection as danger", () => {
    expect(
      terminalNotice({ ...ready, connection: "failed", message: "Protocol error." }),
    ).toEqual({ tone: "danger", text: "Protocol error." });
  });

  it("warns while reconnecting, with a line for the Reconnect now action", () => {
    expect(terminalNotice({ ...ready, connection: "reconnecting" })).toEqual({
      tone: "warning",
      text: "Reconnecting to the terminal.",
    });
  });

  it("warns about input that needs a retry or a discard", () => {
    expect(terminalNotice({ ...ready, retryInputAvailable: true })).toEqual({
      tone: "warning",
      text: "Terminal input was not sent; it is safe to retry.",
    });
    expect(
      terminalNotice({
        ...ready,
        uncertainInputSeq: 4,
        message: "Input delivery could not be confirmed. It may already have reached the terminal.",
      })?.tone,
    ).toBe("warning");
  });

  it("shows other session messages as information", () => {
    expect(
      terminalNotice({ ...ready, message: "Terminal history changed; restoring the latest screen." }),
    ).toEqual({
      tone: "info",
      text: "Terminal history changed; restoring the latest screen.",
    });
  });
});
