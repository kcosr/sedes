// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationClientStore } from "../../stores/ApplicationClientStore.js";

const controls = vi.hoisted(() => ({
  value: { threadId: null as string | null, pending: false, error: null as string | null, setThread: async () => undefined },
}));
vi.mock("../../app/default-thread.js", () => ({
  useDefaultThread: () => controls.value,
  defaultThreadChoices: () => [],
}));
vi.mock("../../stores/ApplicationClientStore.js", () => ({
  useApplicationStore: () => ({ snapshot: { threads: [] } }),
}));

const { DefaultThreadSetting } = await import("./DefaultThreadSetting.js");

afterEach(cleanup);

describe("DefaultThreadSetting", () => {
  it("opens the picker from an outline trigger and reports a failure as a callout", () => {
    controls.value = { ...controls.value, error: "Could not save the default thread." };
    render(<DefaultThreadSetting store={{} as ApplicationClientStore} />);
    expect(screen.getByRole("button", { name: "Choose thread" })).toHaveAttribute("data-variant", "outline");
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("data-slot", "callout");
    expect(alert).toHaveAttribute("data-tone", "danger");
    expect(alert).toHaveTextContent("Could not save the default thread.");
  });
});
