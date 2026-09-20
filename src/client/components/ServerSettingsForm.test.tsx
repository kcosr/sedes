// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    fireEvent.click(screen.getByRole("button", { name: "Confirm remove Home" }));
    await waitFor(() => expect(actions.remove).toHaveBeenCalledWith(profile.id));
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
    expect(await screen.findByRole("status")).toHaveTextContent("Storage unavailable");
    expect(screen.getByLabelText("Connection name")).toHaveValue("Office");
  });
});
