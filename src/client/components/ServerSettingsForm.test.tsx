// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServerSettingsForm, type ServerSettingsControls } from "./ServerSettingsForm.js";
const profile = { id: "10000000-0000-4000-8000-000000000001", name: "Home", baseUrl: "https://sedes.example" };
function controls(): ServerSettingsControls {
  return { connections: { version: 1, profiles: [profile], selectedProfileId: profile.id }, save: vi.fn().mockResolvedValue(undefined), connect: vi.fn().mockResolvedValue(undefined), remove: vi.fn().mockResolvedValue(undefined) };
}
afterEach(cleanup);
describe("Android saved server connections", () => {
  it("selects saved connections and requires confirmation before forgetting one", async () => {
    const actions = controls();
    render(<ServerSettingsForm controls={actions} />);
    fireEvent.click(screen.getByRole("button", { name: "Connect to Home" }));
    await waitFor(() => expect(actions.connect).toHaveBeenCalledWith(profile.id));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove Home" })).not.toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "Remove Home" }));
    expect(actions.remove).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Remove Home?" })).getByRole("button", { name: "Remove connection" }));
    await waitFor(() => expect(actions.remove).toHaveBeenCalledWith(profile.id));
  });
  it("returns focus to Remove on cancel and to a surviving connection after removing", async () => {
    const user = userEvent.setup();
    const office = { id: "10000000-0000-4000-8000-000000000002", name: "Office", baseUrl: "https://office.example" };
    function Harness() {
      const [profiles, setProfiles] = useState([profile, office]);
      const actions: ServerSettingsControls = {
        connections: { version: 1, profiles, selectedProfileId: profile.id },
        save: vi.fn(), connect: vi.fn(),
        remove: async (id) => setProfiles((current) => current.filter((candidate) => candidate.id !== id)),
      };
      return <ServerSettingsForm controls={actions} />;
    }
    render(<Harness />);
    const removeHome = screen.getByRole("button", { name: "Remove Home" });
    await user.click(removeHome);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(removeHome).toHaveFocus());
    await user.click(removeHome);
    await user.click(within(screen.getByRole("dialog", { name: "Remove Home?" })).getByRole("button", { name: "Remove connection" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove Office" })).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Remove Office" }));
    await user.click(screen.getByRole("button", { name: "Remove connection" }));
    await waitFor(() => expect(screen.getByLabelText("Connection name")).toHaveFocus());
  });
  it("adds a normalized named profile without secrets or an unauthenticated API probe", async () => {
    const actions = controls();
    render(<ServerSettingsForm controls={actions} />);
    fireEvent.change(screen.getByLabelText("Connection name"), { target: { value: " Office " } });
    fireEvent.change(screen.getByLabelText("Sedes server URL"), { target: { value: "https://office.example/" } });
    fireEvent.click(screen.getByRole("button", { name: "Add & connect" }));
    await waitFor(() => expect(actions.save).toHaveBeenCalledWith({ id: expect.any(String), name: "Office", baseUrl: "https://office.example" }));
  });
  it("retains input and reports storage failure", async () => {
    const actions = controls();
    vi.mocked(actions.save).mockRejectedValue(new Error("Storage unavailable"));
    render(<ServerSettingsForm controls={actions} />);
    fireEvent.change(screen.getByLabelText("Connection name"), { target: { value: "Office" } });
    fireEvent.change(screen.getByLabelText("Sedes server URL"), { target: { value: "https://office.example" } });
    fireEvent.click(screen.getByRole("button", { name: "Add & connect" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Storage unavailable");
    expect(screen.getByLabelText("Connection name")).toHaveValue("Office");
  });
});
