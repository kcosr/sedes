// @vitest-environment jsdom
import { useRef, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { onListHeadingKeyDown, useScopedListNav } from "./use-scoped-list-nav.js";

function List({ initial }: { initial: readonly string[] }) {
  const [rows, setRows] = useState(initial);
  const [open, setOpen] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const addRef = useRef<HTMLInputElement>(null);
  const keys = [...rows, "section", ...(open ? ["done"] : [])];
  const nav = useScopedListNav({ keys, listRef, fallback: () => addRef.current });
  return <>
    <input ref={addRef} aria-label="Add" />
    <button type="button">Elsewhere</button>
    <div ref={listRef} {...nav.listProps}>
      {rows.map(row => <div key={row}>
        <button type="button" data-list-nav={row} tabIndex={nav.rovingKey === row ? 0 : -1}>{row}</button>
        <button type="button" data-list-nav-for={row} tabIndex={-1} onClick={() => setRows(current => current.filter(item => item !== row))}>
          Remove {row}
        </button>
      </div>)}
      <button type="button" data-list-nav="section" aria-expanded={open} tabIndex={nav.rovingKey === "section" ? 0 : -1}
        onClick={() => setOpen(value => !value)} onKeyDown={onListHeadingKeyDown}>Section</button>
      {open && <button type="button" data-list-nav="done" tabIndex={nav.rovingKey === "done" ? 0 : -1}>done</button>}
    </div>
  </>;
}
const stop = (name: string) => screen.getByRole("button", { name });
const tabStops = () => [...document.querySelectorAll("[data-list-nav]")].filter(element => element.getAttribute("tabindex") === "0")
  .map(element => element.textContent);

afterEach(cleanup);

describe("useScopedListNav", () => {
  it("keeps one tab stop that follows focus, and moves with ↑/↓/Home/End", () => {
    render(<List initial={["one", "two", "three"]} />);
    expect(tabStops()).toEqual(["one"]);
    act(() => stop("one").focus());
    fireEvent.keyDown(stop("one"), { key: "ArrowDown" });
    expect(stop("two")).toHaveFocus();
    expect(tabStops()).toEqual(["two"]);
    fireEvent.keyDown(stop("two"), { key: "End" });
    expect(stop("Section")).toHaveFocus();
    fireEvent.keyDown(stop("Section"), { key: "Home" });
    expect(stop("one")).toHaveFocus();
    fireEvent.keyDown(stop("one"), { key: "ArrowUp" });
    expect(stop("one")).toHaveFocus();
    // Modified keys are left to the browser and the app.
    fireEvent.keyDown(stop("one"), { key: "ArrowDown", altKey: true });
    expect(stop("one")).toHaveFocus();
  });

  it("opens and closes a section heading with → and ←, its rows joining the stops", () => {
    render(<List initial={["one"]} />);
    act(() => stop("Section").focus());
    fireEvent.keyDown(stop("Section"), { key: "ArrowRight" });
    expect(stop("Section")).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(stop("Section"), { key: "ArrowDown" });
    expect(stop("done")).toHaveFocus();
    fireEvent.keyDown(stop("done"), { key: "ArrowUp" });
    fireEvent.keyDown(stop("Section"), { key: "ArrowLeft" });
    expect(stop("Section")).toHaveAttribute("aria-expanded", "false");
  });

  it("hands focus to the neighbour when a focused row leaves, from its title or its other controls", () => {
    render(<List initial={["one", "two", "three"]} />);
    const remove = stop("Remove two");
    act(() => remove.focus());
    expect(tabStops()).toEqual(["two"]);
    fireEvent.click(remove);
    expect(stop("three")).toHaveFocus();
    fireEvent.click(stop("Remove three"));
    expect(stop("Section")).toHaveFocus();
  });

  it("does not pull back focus that moved elsewhere", async () => {
    render(<List initial={["one", "two"]} />);
    act(() => stop("one").focus());
    act(() => stop("Elsewhere").focus());
    await act(() => new Promise(resolve => requestAnimationFrame(resolve)));
    act(() => stop("Elsewhere").blur());
    fireEvent.click(stop("Remove one"));
    expect(stop("two")).not.toHaveFocus();
  });
});
