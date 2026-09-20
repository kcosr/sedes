// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AuthenticationContext, AuthenticationSettings } from "./AuthenticationSettings.js";
const client = { id: "local-client", name: "This browser", kind: "management" as const, createdAt: "2026-09-13T00:00:00Z", expiresAt: "2027-09-13T00:00:00Z" };
afterEach(cleanup);
it("requires confirmation before unpairing and calls logout for this connection", async () => {
  const controls = { client, list: vi.fn().mockResolvedValue([client]), revoke: vi.fn(), logout: vi.fn().mockResolvedValue(undefined) };
  render(<AuthenticationContext.Provider value={controls}><AuthenticationSettings /></AuthenticationContext.Provider>);
  fireEvent.click(await screen.findByRole("button", { name: "Unpair" }));
  expect(controls.logout).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm unpair" }));
  await waitFor(() => expect(controls.logout).toHaveBeenCalledOnce());
  expect(controls.revoke).not.toHaveBeenCalled();
});
it("revokes another client without logging out this connection", async () => {
  const controls = { client, list: vi.fn().mockResolvedValue([{ ...client, id: "other", name: "Other device" }]), revoke: vi.fn().mockResolvedValue(undefined), logout: vi.fn() };
  render(<AuthenticationContext.Provider value={controls}><AuthenticationSettings /></AuthenticationContext.Provider>);
  fireEvent.click(await screen.findByRole("button", { name: "Unpair" }));
  fireEvent.click(screen.getByRole("button", { name: "Confirm unpair" }));
  await waitFor(() => expect(controls.revoke).toHaveBeenCalledWith("other"));
  expect(controls.logout).not.toHaveBeenCalled();
});
