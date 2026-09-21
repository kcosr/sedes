import { beforeEach, describe, expect, it, vi } from "vitest";

const preference = vi.hoisted(() => ({ value: null as string | null }));
const preferences = vi.hoisted(() => ({
  get: vi.fn(async () => ({ value: preference.value })),
  set: vi.fn(
    async ({ value }: { readonly key: string; readonly value: string }) => {
      preference.value = value;
    },
  ),
  remove: vi.fn(async () => {
    preference.value = null;
  }),
}));

vi.mock("@capacitor/preferences", () => ({ Preferences: preferences }));

import {
  availableElectronConnectionPreferences,
  commitElectronConnectionProfileSelection,
  createElectronConnectionProfile,
  DEFAULT_SSH_REMOTE_PORT,
  deleteElectronConnectionProfile,
  ELECTRON_LOCAL_CONNECTION_PROFILE,
  ELECTRON_LOCAL_CONNECTION_PROFILE_ID,
  listElectronConnectionProfiles,
  resetElectronConnectionProfiles,
  setElectronConnectionAutoConnectAtStartup,
  updateElectronConnectionProfile,
} from "./electron-connections.js";

const firstId = "10000000-0000-4000-8000-000000000001";
const secondId = "10000000-0000-4000-8000-000000000002";

beforeEach(() => {
  preference.value = null;
  preferences.get.mockClear();
  preferences.set.mockClear();
  preferences.remove.mockClear();
  vi.restoreAllMocks();
});

describe("Electron connection preferences", () => {
  it("projects the fixed Local connection from one strict empty Electron-only document", async () => {
    await expect(listElectronConnectionProfiles()).resolves.toEqual({
      profiles: [ELECTRON_LOCAL_CONNECTION_PROFILE],
      selectedProfileId: null,
      autoConnectAtStartup: true,
    });
    expect(preferences.get).toHaveBeenCalledWith({
      key: "sedes.electron.connections.v1",
    });
    expect(preferences.set).not.toHaveBeenCalled();
  });

  it("explicitly resets a corrupt Electron preference", async () => {
    preference.value = "not-json";
    await expect(listElectronConnectionProfiles()).rejects.toThrow(
      "The saved connections are corrupted.",
    );

    await expect(resetElectronConnectionProfiles()).resolves.toEqual({
      profiles: [ELECTRON_LOCAL_CONNECTION_PROFILE],
      selectedProfileId: null,
      autoConnectAtStartup: true,
    });
    expect(preferences.remove).toHaveBeenCalledWith({
      key: "sedes.electron.connections.v1",
    });
    await expect(listElectronConnectionProfiles()).resolves.toEqual({
      profiles: [ELECTRON_LOCAL_CONNECTION_PROFILE],
      selectedProfileId: null,
      autoConnectAtStartup: true,
    });
  });

  it("creates normalized direct and SSH profiles with stable UUIDs", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(firstId)
      .mockReturnValueOnce(secondId);

    await expect(
      createElectronConnectionProfile({
        name: "  Home server  ",
        kind: "direct",
        baseUrl: " http://192.168.1.20:4784/ ",
      }),
    ).resolves.toEqual({
      id: firstId,
      name: "Home server",
      kind: "direct",
      baseUrl: "http://192.168.1.20:4784",
    });
    await expect(
      createElectronConnectionProfile({
        name: " Remote ",
        kind: "ssh",
        sshHost: " dev_box.example ",
      }),
    ).resolves.toEqual({
      id: secondId,
      name: "Remote",
      kind: "ssh",
      sshHost: "dev_box.example",
      remotePort: DEFAULT_SSH_REMOTE_PORT,
    });

    expect(JSON.parse(preference.value!)).toEqual({
      version: 2,
      profiles: [
        {
          id: firstId,
          name: "Home server",
          kind: "direct",
          baseUrl: "http://192.168.1.20:4784",
        },
        {
          id: secondId,
          name: "Remote",
          kind: "ssh",
          sshHost: "dev_box.example",
          remotePort: 4784,
        },
      ],
      selectedProfileId: null,
      autoConnectAtStartup: true,
    });
  });

  it("clears last-successful selection when an update changes its target", async () => {
    preference.value = JSON.stringify({
      version: 2,
      profiles: [
        {
          id: firstId,
          name: "Remote",
          kind: "ssh",
          sshHost: "old-host",
          remotePort: 4784,
        },
      ],
      selectedProfileId: firstId,
      autoConnectAtStartup: true,
    });

    await expect(
      updateElectronConnectionProfile(firstId, {
        name: "Remote direct",
        kind: "direct",
        baseUrl: "https://sedes.example:443/",
      }),
    ).resolves.toEqual({
      id: firstId,
      name: "Remote direct",
      kind: "direct",
      baseUrl: "https://sedes.example",
    });
    await expect(listElectronConnectionProfiles()).resolves.toEqual({
      profiles: [
        ELECTRON_LOCAL_CONNECTION_PROFILE,
        {
          id: firstId,
          name: "Remote direct",
          kind: "direct",
          baseUrl: "https://sedes.example",
        },
      ],
      selectedProfileId: null,
      autoConnectAtStartup: true,
    });
  });

  it("preserves last-successful selection for a name-only update", async () => {
    preference.value = documentWithTwoProfiles(firstId);

    await updateElectronConnectionProfile(firstId, {
      name: "Renamed home",
      kind: "direct",
      baseUrl: "http://home:4784",
    });

    await expect(listElectronConnectionProfiles()).resolves.toMatchObject({
      profiles: expect.arrayContaining([
        expect.objectContaining({ id: firstId, name: "Renamed home" }),
      ]),
      selectedProfileId: firstId,
    });
  });

  it("marks only an existing profile as the last successful selection", async () => {
    preference.value = documentWithTwoProfiles();
    const signal = new AbortController().signal;

    await expect(
      commitElectronConnectionProfileSelection(
        ELECTRON_LOCAL_CONNECTION_PROFILE_ID,
        signal,
      ),
    ).resolves.toMatchObject({
      selectedProfileId: ELECTRON_LOCAL_CONNECTION_PROFILE_ID,
    });
    await expect(
      commitElectronConnectionProfileSelection(secondId, signal),
    ).resolves.toMatchObject({ selectedProfileId: secondId });
    await expect(
      commitElectronConnectionProfileSelection(
        "10000000-0000-4000-8000-000000000099",
        signal,
      ),
    ).rejects.toThrow("no longer exists");
  });

  it("persists auto-connect independently of profiles and selection", async () => {
    preference.value = documentWithTwoProfiles(firstId, true);

    await expect(
      setElectronConnectionAutoConnectAtStartup(false),
    ).resolves.toMatchObject({
      selectedProfileId: firstId,
      autoConnectAtStartup: false,
    });
    expect(JSON.parse(preference.value!)).toMatchObject({
      selectedProfileId: firstId,
      autoConnectAtStartup: false,
    });

    await createElectronConnectionProfile({
      name: "Another",
      kind: "direct",
      baseUrl: "http://another:4784",
    });
    expect(JSON.parse(preference.value!)).toMatchObject({
      selectedProfileId: firstId,
      autoConnectAtStartup: false,
    });
  });

  it("restores the prior selection when cancellation lands during its write", async () => {
    preference.value = documentWithTwoProfiles(firstId);
    let releaseSelectionWrite!: () => void;
    preferences.set.mockImplementationOnce(
      ({ value }: { readonly key: string; readonly value: string }) => {
        preference.value = value;
        return new Promise<void>((resolve) => {
          releaseSelectionWrite = resolve;
        });
      },
    );
    const abort = new AbortController();

    const pending = commitElectronConnectionProfileSelection(
      secondId,
      abort.signal,
    );
    await vi.waitFor(() => expect(preferences.set).toHaveBeenCalledOnce());
    expect(JSON.parse(preference.value!)).toMatchObject({
      selectedProfileId: secondId,
    });

    abort.abort();
    releaseSelectionWrite();

    await expect(pending).resolves.toMatchObject({
      selectedProfileId: firstId,
    });
    expect(preferences.set).toHaveBeenCalledTimes(2);
    expect(JSON.parse(preference.value!)).toMatchObject({
      selectedProfileId: firstId,
    });
  });

  it("clears the selection when its profile is deleted", async () => {
    preference.value = documentWithTwoProfiles(firstId);

    await expect(deleteElectronConnectionProfile(firstId)).resolves.toEqual({
      profiles: [
        ELECTRON_LOCAL_CONNECTION_PROFILE,
        {
          id: secondId,
          name: "Remote",
          kind: "ssh",
          sshHost: "remote-dev",
          remotePort: 2200,
        },
      ],
      selectedProfileId: null,
      autoConnectAtStartup: true,
    });
    await expect(deleteElectronConnectionProfile(firstId)).rejects.toThrow(
      "no longer exists",
    );
  });

  it("enforces unique trimmed names independently of case", async () => {
    preference.value = documentWithTwoProfiles();
    await expect(
      updateElectronConnectionProfile(secondId, {
        name: "  HOME  ",
        kind: "ssh",
        sshHost: "remote-dev",
      }),
    ).rejects.toThrow('A connection named "HOME" already exists.');
  });

  it("does not allow the code-owned Local connection to be edited or deleted", async () => {
    preference.value = documentWithTwoProfiles(ELECTRON_LOCAL_CONNECTION_PROFILE_ID);
    await expect(
      updateElectronConnectionProfile(ELECTRON_LOCAL_CONNECTION_PROFILE_ID, {
        name: "Replacement",
        kind: "direct",
        baseUrl: "http://replacement:4784",
      }),
    ).rejects.toThrow("cannot be edited");
    await expect(
      deleteElectronConnectionProfile(ELECTRON_LOCAL_CONNECTION_PROFILE_ID),
    ).rejects.toThrow("cannot be deleted");
    expect(JSON.parse(preference.value!)).toMatchObject({
      version: 2,
      selectedProfileId: ELECTRON_LOCAL_CONNECTION_PROFILE_ID,
    });
  });

  it("rejects invalid direct URLs, SSH aliases, names, and ports", async () => {
    vi.spyOn(crypto, "randomUUID").mockReturnValue(firstId);
    const invalidInputs = [
      {
        name: "Direct",
        kind: "direct" as const,
        baseUrl: "sedes.example:4784",
      },
      {
        name: "SSH",
        kind: "ssh" as const,
        sshHost: "-oProxyCommand=bad",
      },
      {
        name: "SSH",
        kind: "ssh" as const,
        sshHost: "user@host",
      },
      {
        name: " ",
        kind: "ssh" as const,
        sshHost: "host",
      },
      {
        name: "SSH",
        kind: "ssh" as const,
        sshHost: "host",
        remotePort: 65_536,
      },
    ];
    for (const input of invalidInputs) {
      await expect(createElectronConnectionProfile(input)).rejects.toThrow();
    }
    expect(preferences.set).not.toHaveBeenCalled();
  });

  it("fails closed for corrupt, unknown, non-normalized, and inconsistent documents", async () => {
    const invalidDocuments: unknown[] = [
      "not JSON",
      {
        version: 1,
        profiles: [],
        selectedProfileId: null,
        autoConnectAtStartup: true,
      },
      { version: 2, profiles: [], selectedProfileId: null },
      {
        version: 2,
        profiles: [],
        selectedProfileId: null,
        autoConnectAtStartup: "yes",
      },
      {
        version: 2,
        profiles: [
          {
            id: firstId,
            name: "Home",
            kind: "direct",
            baseUrl: "http://sedes.example/",
          },
        ],
        selectedProfileId: null,
        autoConnectAtStartup: true,
      },
      {
        version: 2,
        profiles: [],
        selectedProfileId: firstId,
        autoConnectAtStartup: true,
      },
      {
        version: 2,
        profiles: [
          {
            id: firstId,
            name: "Home",
            kind: "direct",
            baseUrl: "http://sedes.example",
          },
          {
            id: secondId,
            name: "home",
            kind: "ssh",
            sshHost: "remote",
            remotePort: 4784,
          },
        ],
        selectedProfileId: null,
        autoConnectAtStartup: true,
      },
    ];

    for (const document of invalidDocuments) {
      preference.value =
        typeof document === "string" ? document : JSON.stringify(document);
      await expect(listElectronConnectionProfiles()).rejects.toThrow(
        /corrupted|invalid/u,
      );
    }
  });

  it("serializes concurrent whole-document mutations without losing profiles", async () => {
    vi.spyOn(crypto, "randomUUID")
      .mockReturnValueOnce(firstId)
      .mockReturnValueOnce(secondId);
    let releaseFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    preferences.set
      .mockImplementationOnce(async ({ value }) => {
        await firstWriteBlocked;
        preference.value = value;
      })
      .mockImplementation(async ({ value }) => {
        preference.value = value;
      });

    const first = createElectronConnectionProfile({
      name: "Home",
      kind: "direct",
      baseUrl: "http://home:4784",
    });
    const second = createElectronConnectionProfile({
      name: "Remote",
      kind: "ssh",
      sshHost: "remote",
    });
    await vi.waitFor(() => expect(preferences.set).toHaveBeenCalledTimes(1));
    releaseFirstWrite();
    await Promise.all([first, second]);

    await expect(listElectronConnectionProfiles()).resolves.toMatchObject({
      profiles: [
        ELECTRON_LOCAL_CONNECTION_PROFILE,
        { id: firstId },
        { id: secondId },
      ],
    });
  });
});

function documentWithTwoProfiles(
  selectedProfileId: string | null = null,
  autoConnectAtStartup = true,
): string {
  return JSON.stringify({
    version: 2,
    profiles: [
      {
        id: firstId,
        name: "Home",
        kind: "direct",
        baseUrl: "http://home:4784",
      },
      {
        id: secondId,
        name: "Remote",
        kind: "ssh",
        sshHost: "remote-dev",
        remotePort: 2200,
      },
    ],
    selectedProfileId,
    autoConnectAtStartup,
  });
}


describe("Electron distribution preference presentation", () => {
  it("hides unavailable Local and skips its selection without rewriting saved preferences", async () => {
    await createElectronConnectionProfile({ name: "Remote", kind: "direct", baseUrl: "https://server.example.test" });
    await commitElectronConnectionProfileSelection(ELECTRON_LOCAL_CONNECTION_PROFILE_ID, new AbortController().signal);
    const original = preference.value;
    preferences.set.mockClear();
    const saved = await listElectronConnectionProfiles();
    const client = availableElectronConnectionPreferences(saved, { localServer: false });
    expect(client.profiles.map(profile => profile.kind)).toEqual(["direct"]);
    expect(client.selectedProfileId).toBeNull();
    expect(client.autoConnectAtStartup).toBe(true);
    expect(preferences.set).not.toHaveBeenCalled();
    expect(preference.value).toBe(original);
    const full = availableElectronConnectionPreferences(await listElectronConnectionProfiles(), { localServer: true });
    expect(full.profiles.map(profile => profile.kind)).toEqual(["local", "direct"]);
    expect(full.selectedProfileId).toBe(ELECTRON_LOCAL_CONNECTION_PROFILE_ID);
  });
});
