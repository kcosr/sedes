// @vitest-environment jsdom
import { useEffect, useSyncExternalStore } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileText } from "lucide-react";
import type { ApplicationClientStore } from "../stores/ApplicationClientStore.js";
import type { ThreadStoreRegistry } from "../stores/ThreadStoreRegistry.js";
import type { WorkspacePanelContext, WorkspacePanelTenant } from "./registry.js";
import { TenantContent } from "./TenantContent.js";

/** Whether the panel's next render fails, as data arriving later can make it. */
const failure = (() => {
  let value = false;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next: boolean) => { value = next; listeners.forEach(listener => listener()); },
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
})();
function Fragile({ context }: { context: WorkspacePanelContext }) {
  const failing = useSyncExternalStore(failure.subscribe, failure.get);
  useEffect(() => { context.host.setDirty(true); }, [context.host]);
  if (failing) throw new Error("Unexpected chart data");
  return <p>Panel content</p>;
}
const tenant: WorkspacePanelTenant = {
  id: "fragile",
  title: "Usage",
  icon: FileText,
  scope: "thread",
  size: { minWidth: 300, minHeight: 240, preferredWidth: 360, preferredHeight: 320 },
  availability: () => ({ available: true }) as ReturnType<WorkspacePanelTenant["availability"]>,
  render: context => <Fragile context={context} />,
};

function renderTenant(overrides: Partial<WorkspacePanelTenant> = {}) {
  const onStatus = vi.fn();
  const onClose = vi.fn();
  render(<>
    <p>Chat</p>
    <TenantContent tenant={{ ...tenant, ...overrides }} threadId="thread-1"
      applicationStore={{} as ApplicationClientStore} threadRegistry={{} as ThreadStoreRegistry}
      visible presentation="dock" chromeActionsTarget={document.createElement("div")}
      onStatus={onStatus} onConsumeIntent={() => undefined} onClose={onClose} />
  </>);
  return { onStatus, onClose };
}

beforeEach(() => {
  failure.set(false);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("TenantContent", () => {
  it("contains a failing panel, keeps the rest, and reloads it", () => {
    const { onStatus } = renderTenant();
    expect(screen.getByText("Panel content")).toBeInTheDocument();
    expect(onStatus).toHaveBeenLastCalledWith({ dirty: true });
    act(() => failure.set(true));
    expect(screen.getByText("Usage couldn’t be displayed.")).toBeInTheDocument();
    expect(screen.queryByText("Panel content")).not.toBeInTheDocument();
    expect(screen.getByText("Chat")).toBeInTheDocument();
    // What the crashed content reported does not outlive it.
    expect(onStatus).toHaveBeenLastCalledWith({});
    act(() => failure.set(false));
    expect(screen.getByText("Usage couldn’t be displayed.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reload panel" }));
    expect(screen.getByText("Panel content")).toBeInTheDocument();
    expect(onStatus).toHaveBeenLastCalledWith({ dirty: true });
  });

  it("contains a tenant whose render function throws, and closes the panel", () => {
    const { onClose } = renderTenant({ render: () => { throw new Error("Bad intent"); } });
    expect(screen.getByText("Usage couldn’t be displayed.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Close panel" }));
    expect(onClose).toHaveBeenCalledOnce();
  });
});
