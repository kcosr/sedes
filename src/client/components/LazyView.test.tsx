// @vitest-environment jsdom

import { Component, type ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { lazyView } from "./LazyView.js";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function Greeting({ name }: { readonly name: string }): React.JSX.Element {
  return <p>Hello {name}</p>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function Frame({ children }: { readonly children: ReactNode }): React.JSX.Element {
  return <main aria-label="Framed view">{children}</main>;
}

describe("lazy views", () => {
  it("shows a loading status in its frame until the view's code loads", async () => {
    const load = deferred<typeof Greeting>();
    const View = lazyView("greetings", () => load.promise, Frame);
    render(<View name="Ada" />);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("Loading greetings…");
    expect(screen.getByRole("main", { name: "Framed view" })).toContainElement(status);

    await act(async () => load.resolve(Greeting));
    expect(screen.getByText("Hello Ada")).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers to try again after its code fails to load, and loads it again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const load = vi
      .fn<() => Promise<typeof Greeting>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch dynamically imported module"))
      .mockResolvedValueOnce(Greeting);
    const View = lazyView("greetings", load, Frame);
    render(<View name="Ada" />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn’t load greetings");
    expect(screen.getByRole("main", { name: "Framed view" })).toContainElement(alert);
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("Hello Ada")).toBeInTheDocument();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("leaves failures of the loaded view to the boundaries above it", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    function Broken(): React.JSX.Element {
      throw new Error("view failed");
    }
    class Outer extends Component<{ children: ReactNode }, { error?: Error }> {
      override state: { error?: Error } = {};
      static getDerivedStateFromError(error: Error) {
        return { error };
      }
      override render() {
        return this.state.error ? <p>Outer caught {this.state.error.message}</p> : this.props.children;
      }
    }
    const View = lazyView("broken view", async () => Broken);
    render(
      <Outer>
        <View />
      </Outer>,
    );

    expect(await screen.findByText("Outer caught view failed")).toBeInTheDocument();
    expect(screen.queryByText(/Couldn’t load/)).toBeNull();
  });
});
