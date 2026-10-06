// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaveBar, SAVED_NOTICE_MS } from "./SaveBar.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SaveBar", () => {
  it("disables Cancel and Save until the form is dirty", () => {
    const { rerender } = render(<SaveBar dirty={false} onCancel={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("");

    rerender(<SaveBar dirty onCancel={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("lets a creation form save before any edit, and says nothing until one", () => {
    const { rerender } = render(<SaveBar creating dirty={false} onCancel={vi.fn()} onSave={vi.fn()} saveLabel="Create" />);
    expect(screen.getByRole("status")).toHaveTextContent("");
    expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();

    rerender(<SaveBar creating dirty onCancel={vi.fn()} onSave={vi.fn()} saveLabel="Create" />);
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");

    rerender(<SaveBar creating dirty={false} saveDisabled onCancel={vi.fn()} onSave={vi.fn()} saveLabel="Create" />);
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("puts Cancel before Save and calls the handlers", () => {
    const onCancel = vi.fn();
    const onSave = vi.fn();
    const { container } = render(<SaveBar dirty onCancel={onCancel} onSave={onSave} saveLabel="Save changes" />);
    const buttons = [...container.querySelectorAll("[data-slot=save-bar-actions] button")].map((button) => button.textContent);
    expect(buttons).toEqual(["Cancel", "Save changes"]);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledOnce();
  });

  it("submits its form when there is no save handler", () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
    render(
      <>
        <form id="environment-form" onSubmit={onSubmit} />
        <SaveBar dirty form="environment-form" />
      </>,
    );
    const save = screen.getByRole("button", { name: "Save" });
    expect(save).toHaveAttribute("type", "submit");
    expect(save).toHaveAttribute("form", "environment-form");
    fireEvent.click(save);
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("locks both buttons and relabels Save while saving", () => {
    render(<SaveBar dirty saving onCancel={vi.fn()} onSave={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    expect(screen.getByRole("status")).toHaveTextContent("Saving…");
  });

  it("shows Saved briefly after a save", () => {
    vi.useFakeTimers();
    const { rerender } = render(<SaveBar dirty={false} onSave={vi.fn()} />);
    rerender(<SaveBar dirty={false} savedAt={1} onSave={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    act(() => vi.advanceTimersByTime(SAVED_NOTICE_MS));
    expect(screen.getByRole("status")).toHaveTextContent("");

    rerender(<SaveBar dirty={false} savedAt={2} onSave={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Saved");
    rerender(<SaveBar dirty savedAt={2} onSave={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("Unsaved changes");
    rerender(<SaveBar dirty={false} savedAt={2} onSave={vi.fn()} />);
    expect(screen.getByRole("status")).toHaveTextContent("");
  });

  it("announces an error in place of the state", () => {
    render(<SaveBar dirty error="The server rejected the change." onSave={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("The server rejected the change.");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  });

  it("sits in flow at the end of a pane when placed there", () => {
    const { container, rerender } = render(<SaveBar dirty onSave={vi.fn()} />);
    expect(container.querySelector("[data-slot=save-bar]")).toHaveAttribute("data-placement", "page");
    rerender(<SaveBar dirty placement="pane" onSave={vi.fn()} />);
    expect(container.querySelector("[data-slot=save-bar]")).toHaveAttribute("data-placement", "pane");
  });

  it("puts a secondary save between Cancel and Save, enabled with Save", () => {
    const onSave = vi.fn();
    const onSecondary = vi.fn();
    const secondary = { label: "Save as paused", onSave: onSecondary };
    const { container, rerender } = render(
      <SaveBar creating dirty={false} saveDisabled onCancel={vi.fn()} onSave={onSave} saveLabel="Save and enable" secondaryAction={secondary} />,
    );
    const buttons = () => [...container.querySelectorAll("[data-slot=save-bar-actions] button")];
    expect(buttons().map((button) => button.textContent)).toEqual(["Cancel", "Save as paused", "Save and enable"]);
    expect(screen.getByRole("button", { name: "Save as paused" })).toHaveAttribute("data-variant", "outline");
    expect(screen.getByRole("button", { name: "Save as paused" })).toBeDisabled();

    rerender(<SaveBar creating dirty onCancel={vi.fn()} onSave={onSave} saveLabel="Save and enable" secondaryAction={secondary} />);
    fireEvent.click(screen.getByRole("button", { name: "Save as paused" }));
    expect(onSecondary).toHaveBeenCalledOnce();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("gives the saving label to whichever save is in flight", () => {
    const secondary = { label: "Save as paused", onSave: vi.fn() };
    const { rerender } = render(
      <SaveBar creating dirty saving onSave={vi.fn()} saveLabel="Save and enable" secondaryAction={{ ...secondary, saving: true }} />,
    );
    expect(screen.getByRole("button", { name: "Saving…" })).toHaveAttribute("data-variant", "outline");
    expect(screen.getByRole("button", { name: "Save and enable" })).toBeDisabled();

    rerender(<SaveBar creating dirty saving onSave={vi.fn()} saveLabel="Save and enable" secondaryAction={secondary} />);
    expect(screen.getByRole("button", { name: "Save as paused" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Saving…" })).toHaveAttribute("data-variant", "default");
  });

  it("blocks Save while the form is invalid", () => {
    render(<SaveBar dirty saveDisabled onSave={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });
});
