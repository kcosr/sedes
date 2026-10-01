// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AuthenticationContext, AuthenticationSettings } from "./AuthenticationSettings.js";
const client = { id: "local-client", name: "This browser", kind: "management" as const, createdAt: "2026-09-13T00:00:00Z", expiresAt: "2027-09-13T00:00:00Z" };
afterEach(cleanup);
it("requires confirmation before unpairing and calls logout for this connection", async () => {
  const controls = { client, list: vi.fn().mockResolvedValue([client]), revoke: vi.fn(), logout: vi.fn().mockResolvedValue(undefined) };
  render(<AuthenticationContext.Provider value={controls}><AuthenticationSettings /></AuthenticationContext.Provider>);
  expect(await screen.findByText("This connection")).toBeVisible();
  fireEvent.click(await screen.findByRole("button", { name: "Unpair" }));
  expect(controls.logout).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog", { name: "Unpair This browser?" });
  expect(within(dialog).getByRole("button", { name: "Unpair this browser" })).toHaveAttribute("data-variant", "destructive");
  fireEvent.click(within(dialog).getByRole("button", { name: "Unpair this browser" }));
  await waitFor(() => expect(controls.logout).toHaveBeenCalledOnce());
  expect(controls.revoke).not.toHaveBeenCalled();
});
it("revokes another client without logging out this connection", async () => {
  const controls = { client, list: vi.fn().mockResolvedValue([{ ...client, id: "other", name: "Other device" }]), revoke: vi.fn().mockResolvedValue(undefined), logout: vi.fn() };
  render(<AuthenticationContext.Provider value={controls}><AuthenticationSettings /></AuthenticationContext.Provider>);
  fireEvent.click(await screen.findByRole("button", { name: "Unpair" }));
  fireEvent.click(within(screen.getByRole("dialog", { name: "Unpair Other device?" })).getByRole("button", { name: "Unpair client" }));
  await waitFor(() => expect(controls.revoke).toHaveBeenCalledWith("other"));
  await waitFor(() => expect(screen.queryByText("Other device")).toBeNull());
  expect(controls.logout).not.toHaveBeenCalled();
});
it("keeps the dialog open with the error when unpairing fails", async () => {
  const controls = { client, list: vi.fn().mockResolvedValue([{ ...client, id: "other", name: "Other device" }]), revoke: vi.fn().mockRejectedValue(new Error("offline")), logout: vi.fn() };
  render(<AuthenticationContext.Provider value={controls}><AuthenticationSettings /></AuthenticationContext.Provider>);
  fireEvent.click(await screen.findByRole("button", { name: "Unpair" }));
  const dialog = screen.getByRole("dialog", { name: "Unpair Other device?" });
  fireEvent.click(within(dialog).getByRole("button", { name: "Unpair client" }));
  expect(await within(dialog).findByRole("alert")).toHaveTextContent("Could not unpair this client. Try again.");
  expect(screen.getByText("Other device")).toBeInTheDocument();
});
