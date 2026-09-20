// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ELECTRON_LOCAL_CONNECTION_PROFILE,
  type ElectronConnectionProfile,
} from "../app/electron-connections.js";
import {
  ElectronConnectionLanding,
  type ElectronConnectionLandingProps,
} from "./ElectronConnectionLanding.js";

const directProfile: ElectronConnectionProfile = {
  id: "10000000-0000-4000-8000-000000000001",
  name: "Office",
  kind: "direct",
  baseUrl: "https://sedes.example",
};

const sshProfile: ElectronConnectionProfile = {
  id: "10000000-0000-4000-8000-000000000002",
  name: "Lab",
  kind: "ssh",
  sshHost: "lab-box",
  remotePort: 4783,
};

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function props(
  overrides: Partial<ElectronConnectionLandingProps> = {},
): ElectronConnectionLandingProps {
  return {
    profiles: [directProfile, sshProfile],
    autoConnectAtStartup: true,
    onConnect: vi.fn().mockResolvedValue(undefined),
    onCancelConnect: vi.fn().mockResolvedValue(undefined),
    onAutoConnectAtStartupChange: vi.fn().mockResolvedValue(undefined),
    onSaveAndConnect: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("ElectronConnectionLanding", () => {
  it("presents immutable Local first without opening a saved-profile editor", () => {
    render(
      <ElectronConnectionLanding
        {...props({ profiles: [ELECTRON_LOCAL_CONNECTION_PROFILE] })}
      />,
    );

    expect(screen.getByRole("heading", { name: "Local" })).toBeVisible();
    expect(screen.getByText(/while the desktop app is open/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Connect" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /Edit Local/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Delete Local/ })).toBeNull();
    expect(screen.queryByLabelText("Name")).toBeNull();
  });

  it("persists the startup connection choice without exposing the implementation stack", async () => {
    const onAutoConnectAtStartupChange = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <ElectronConnectionLanding
        {...props({ onAutoConnectAtStartupChange })}
      />,
    );

    const checkbox = screen.getByRole("checkbox", {
      name: "Connect automatically at startup",
    });
    expect(checkbox).toBeChecked();
    expect(view.container).not.toHaveTextContent(/\bElectron\b/u);

    fireEvent.click(checkbox);
    await waitFor(() =>
      expect(onAutoConnectAtStartupChange).toHaveBeenCalledWith(false),
    );
  });

  it("keeps the startup setting unchanged and reports persistence failures", async () => {
    const onAutoConnectAtStartupChange = vi
      .fn()
      .mockRejectedValue(new Error("Storage unavailable."));
    render(
      <ElectronConnectionLanding
        {...props({ onAutoConnectAtStartupChange })}
      />,
    );

    const checkbox = screen.getByRole("checkbox", {
      name: "Connect automatically at startup",
    });
    fireEvent.click(checkbox);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Storage unavailable.",
    );
    expect(checkbox).toBeChecked();
  });

  it("keeps running Local visible and confirms a destructive replacement", async () => {
    const onConnect = vi.fn().mockResolvedValue(undefined);
    const onReturnToCurrent = vi.fn().mockResolvedValue(undefined);
    render(
      <ElectronConnectionLanding
        {...props({
          profiles: [ELECTRON_LOCAL_CONNECTION_PROFILE, directProfile],
          currentProfileId: ELECTRON_LOCAL_CONNECTION_PROFILE.id,
          onConnect,
          onReturnToCurrent,
        })}
      />,
    );

    expect(screen.getByText("Currently running")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Back to Local" }));
    await waitFor(() => expect(onReturnToCurrent).toHaveBeenCalledOnce());

    const directCard = screen.getByRole("heading", { name: "Office" }).closest("li")!;
    fireEvent.click(within(directCard).getByRole("button", { name: "Connect" }));
    const dialog = screen.getByRole("dialog", { name: "Switch away from Local?" });
    expect(dialog).toHaveTextContent("Active local agents and terminals will stop");
    expect(onConnect).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(within(directCard).getByRole("button", { name: "Connect" }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Connect to Office",
      }),
    );
    await waitFor(() => expect(onConnect).toHaveBeenCalledWith(directProfile.id));
  });

  it("presents the canonical add form on first run and saves a normalized direct profile", async () => {
    const onSaveAndConnect = vi.fn().mockResolvedValue(undefined);
    render(
      <ElectronConnectionLanding
        {...props({ profiles: [], onSaveAndConnect })}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Connect to Sedes" }),
    ).toBeVisible();
    expect(screen.getByRole("radio", { name: /Direct/ })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Save & connect" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Enter a connection name.",
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "  Home  " },
    });
    fireEvent.change(screen.getByLabelText("Sedes server URL"), {
      target: { value: "HTTPS://SEDES.EXAMPLE:443/" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & connect" }));

    await waitFor(() =>
      expect(onSaveAndConnect).toHaveBeenCalledWith(
        {
          kind: "direct",
          name: "Home",
          baseUrl: "https://sedes.example",
        },
        undefined,
      ),
    );
  });

  it("lists direct and SSH summaries and keeps a failure beside its profile", async () => {
    const onConnect = vi.fn().mockRejectedValue(new Error("Host unreachable."));
    render(
      <ElectronConnectionLanding
        {...props({
          onConnect,
          profileErrors: { [sshProfile.id]: "SSH authentication failed." },
        })}
      />,
    );

    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("OfficeDirect");
    expect(items[0]).toHaveTextContent("https://sedes.example");
    expect(items[1]).toHaveTextContent("LabSSH");
    expect(items[1]).toHaveTextContent("lab-box · remote port 4783");
    expect(within(items[1]!).getByRole("alert")).toHaveTextContent(
      "SSH authentication failed.",
    );

    fireEvent.click(within(items[0]!).getByRole("button", { name: "Connect" }));
    expect(await within(items[0]!).findByRole("alert")).toHaveTextContent(
      "Host unreachable.",
    );
    expect(onConnect).toHaveBeenCalledWith(directProfile.id);
  });

  it("shows cancellable progress and locks every competing action", async () => {
    const onCancelConnect = vi.fn().mockResolvedValue(undefined);
    render(
      <ElectronConnectionLanding
        {...props({ connectingProfileId: sshProfile.id, onCancelConnect })}
      />,
    );

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(cancel).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Connecting…");
    expect(
      screen.getAllByRole("button", { name: "Connect" })[0],
    ).toBeDisabled();
    expect(screen.getByRole("button", { name: "Edit Office" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Delete Lab" })).toBeDisabled();

    fireEvent.click(cancel);
    await waitFor(() => expect(onCancelConnect).toHaveBeenCalledOnce());
  });

  it("disables cancellation while a successful replacement is being finalized", () => {
    render(
      <ElectronConnectionLanding
        {...props({
          connectingProfileId: sshProfile.id,
          connectionFinalizing: true,
        })}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Finishing switch…" }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("edits an SSH profile with only the OpenSSH alias and remote port", async () => {
    const onSaveAndConnect = vi.fn().mockResolvedValue(undefined);
    render(<ElectronConnectionLanding {...props({ onSaveAndConnect })} />);

    fireEvent.click(screen.getByRole("button", { name: "Edit Lab" }));
    expect(screen.getByRole("radio", { name: /SSH/ })).toBeChecked();
    expect(screen.getByLabelText("Name")).toHaveValue("Lab");
    expect(screen.getByLabelText("Name")).toHaveFocus();
    expect(screen.getByLabelText("SSH host alias")).toHaveValue("lab-box");
    expect(screen.getByLabelText("Remote Sedes port")).toHaveValue(4783);
    expect(screen.getByText(/normal SSH setup/)).toBeVisible();
    expect(screen.getByText("ssh lab-box", { exact: false })).toBeVisible();
    expect(screen.queryByLabelText(/password|key file|user name/i)).toBeNull();

    fireEvent.change(screen.getByLabelText("SSH host alias"), {
      target: { value: "gpu-host" },
    });
    fireEvent.change(screen.getByLabelText("Remote Sedes port"), {
      target: { value: "4900" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & connect" }));

    await waitFor(() =>
      expect(onSaveAndConnect).toHaveBeenCalledWith(
        {
          kind: "ssh",
          name: "Lab",
          sshHost: "gpu-host",
          remotePort: 4900,
        },
        sshProfile.id,
      ),
    );
  });

  it("defaults new SSH profiles to port 4784 and validates host, port, and unique names", () => {
    render(<ElectronConnectionLanding {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
    fireEvent.click(screen.getByRole("radio", { name: /SSH/ }));

    expect(screen.getByLabelText("Remote Sedes port")).toHaveValue(4784);
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "office" },
    });
    fireEvent.change(screen.getByLabelText("SSH host alias"), {
      target: { value: "-unsafe" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & connect" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "A connection named “office” already exists.",
    );

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Cluster" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & connect" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "SSH host aliases may contain only",
    );

    fireEvent.change(screen.getByLabelText("SSH host alias"), {
      target: { value: "cluster" },
    });
    fireEvent.change(screen.getByLabelText("Remote Sedes port"), {
      target: { value: "70000" },
    });
    // Native constraints block ordinary form submission, so invoke validation
    // through submit to cover stale or programmatically restored values.
    fireEvent.submit(
      screen.getByRole("button", { name: "Save & connect" }).closest("form")!,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Remote Sedes port must be an integer",
    );
  });

  it("retains editor values and exposes save errors accessibly", async () => {
    const onSaveAndConnect = vi
      .fn()
      .mockRejectedValue(new Error("Connection name was changed elsewhere."));
    render(<ElectronConnectionLanding {...props({ onSaveAndConnect })} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Office" }));
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Main office" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save & connect" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Connection name was changed elsewhere.",
    );
    expect(screen.getByLabelText("Name")).toHaveValue("Main office");
  });

  it("requires confirmation to delete and reports deletion failure in the dialog", async () => {
    const onDelete = vi
      .fn()
      .mockRejectedValueOnce(new Error("Profile is still active."))
      .mockResolvedValueOnce(undefined);
    render(<ElectronConnectionLanding {...props({ onDelete })} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete Office" }));
    const dialog = screen.getByRole("dialog", { name: "Delete connection?" });
    expect(dialog).toHaveTextContent("Delete Office?");
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete connection" }),
    );
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "Profile is still active.",
    );
    expect(screen.getByRole("dialog")).toBeVisible();

    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete connection" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onDelete).toHaveBeenCalledTimes(2);
  });

  it("cancels editing back to an explicit empty state", () => {
    render(<ElectronConnectionLanding {...props({ profiles: [] })} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("heading", { name: "Connect to Sedes" }),
    ).toBeNull();
    expect(
      screen.getByRole("heading", { name: "No saved connections" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Add connection" }),
    ).toBeEnabled();
  });

  it("shows loading and supports recovery from a corrupt saved document", async () => {
    const onResetPreferences = vi.fn().mockResolvedValue(undefined);
    const view = render(
      <ElectronConnectionLanding
        {...props({
          profiles: [],
          loading: true,
          globalError: "The saved connections are invalid.",
          onResetPreferences,
        })}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Loading saved connections…",
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The saved connections are invalid.",
    );
    expect(
      screen.queryByRole("heading", { name: "Connect to Sedes" }),
    ).toBeNull();

    view.rerender(
      <ElectronConnectionLanding
        {...props({
          profiles: [],
          globalError: "The saved connections are invalid.",
          onResetPreferences,
        })}
      />,
    );
    expect(screen.queryByRole("button", { name: "Add connection" })).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Reset saved connections" }),
    );
    await waitFor(() => expect(onResetPreferences).toHaveBeenCalledOnce());
    expect(
      screen.getByRole("heading", { name: "Connect to Sedes" }),
    ).toBeVisible();
  });
});
