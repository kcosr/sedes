import { Preferences } from "@capacitor/preferences";
import { z } from "zod";
import { normalizeSedesServerUrl } from "./server-endpoint.js";

const ELECTRON_CONNECTIONS_PREFERENCE_KEY = "sedes.electron.connections.v1";
export const ELECTRON_LOCAL_CONNECTION_PROFILE_ID =
  "00000000-0000-4000-8000-000000000001" as const;
export const DEFAULT_SSH_REMOTE_PORT = 4784;
export const ELECTRON_CONNECTION_NAME_MAX_LENGTH = 80;
export const ELECTRON_SSH_HOST_MAX_LENGTH = 255;

const profileIdSchema = z.uuid();
const profileNameSchema = z
  .string()
  .min(1)
  .max(ELECTRON_CONNECTION_NAME_MAX_LENGTH)
  .refine((value) => value === value.trim(), {
    message: "Connection names must not have leading or trailing whitespace.",
  });
const normalizedServerUrlSchema = z.string().refine(
  (value) => {
    try {
      return normalizeSedesServerUrl(value) === value;
    } catch {
      return false;
    }
  },
  { message: "Direct connection server URLs must be normalized origins." },
);
const sshHostSchema = z
  .string()
  .min(1)
  .max(ELECTRON_SSH_HOST_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_.-]+$/u)
  .refine((value) => !value.startsWith("-"), {
    message: "SSH hosts must not begin with a hyphen.",
  });
const remotePortSchema = z.number().int().min(1).max(65_535);

const directProfileSchema = z.strictObject({
  id: profileIdSchema,
  name: profileNameSchema,
  kind: z.literal("direct"),
  baseUrl: normalizedServerUrlSchema,
});
const sshProfileSchema = z.strictObject({
  id: profileIdSchema,
  name: profileNameSchema,
  kind: z.literal("ssh"),
  sshHost: sshHostSchema,
  remotePort: remotePortSchema,
});
const savedProfileSchema = z.discriminatedUnion("kind", [
  directProfileSchema,
  sshProfileSchema,
]);
const localProfileSchema = z.strictObject({
  id: z.literal(ELECTRON_LOCAL_CONNECTION_PROFILE_ID),
  name: z.literal("Local"),
  kind: z.literal("local"),
});
const profileSchema = z.discriminatedUnion("kind", [
  localProfileSchema,
  directProfileSchema,
  sshProfileSchema,
]);
const preferencesSchema = z
  .strictObject({
    version: z.literal(2),
    profiles: z.array(savedProfileSchema),
    selectedProfileId: profileIdSchema.nullable(),
    autoConnectAtStartup: z.boolean(),
  })
  .superRefine((document, context) => {
    const ids = new Set<string>();
    const names = new Set<string>();
    for (const [index, profile] of document.profiles.entries()) {
      if (ids.has(profile.id)) {
        context.addIssue({
          code: "custom",
          path: ["profiles", index, "id"],
          message: "Connection profile IDs must be unique.",
        });
      }
      ids.add(profile.id);

      const nameKey = connectionNameKey(profile.name);
      if (names.has(nameKey)) {
        context.addIssue({
          code: "custom",
          path: ["profiles", index, "name"],
          message: "Connection profile names must be unique.",
        });
      }
      names.add(nameKey);
    }
    if (
      document.selectedProfileId !== null &&
      document.selectedProfileId !== ELECTRON_LOCAL_CONNECTION_PROFILE_ID &&
      !ids.has(document.selectedProfileId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedProfileId"],
        message: "The selected connection profile must exist.",
      });
    }
  });

export type ElectronConnectionProfile = z.infer<typeof profileSchema>;
export type ElectronLocalConnectionProfile = z.infer<
  typeof localProfileSchema
>;
export type ElectronSavedConnectionProfile = z.infer<
  typeof savedProfileSchema
>;
export type ElectronDirectConnectionProfile = z.infer<
  typeof directProfileSchema
>;
export type ElectronSshConnectionProfile = z.infer<typeof sshProfileSchema>;

export type ElectronConnectionProfileInput =
  | {
      readonly name: string;
      readonly kind: "direct";
      readonly baseUrl: string;
    }
  | {
      readonly name: string;
      readonly kind: "ssh";
      readonly sshHost: string;
      readonly remotePort?: number;
    };

export interface ElectronConnectionPreferences {
  readonly profiles: readonly ElectronConnectionProfile[];
  /**
   * The profile whose connection most recently completed successfully. Callers
   * must not select a profile before its connection has been established.
   */
  readonly selectedProfileId: string | null;
  readonly autoConnectAtStartup: boolean;
}

interface StoredElectronConnectionPreferences {
  readonly version: 2;
  readonly profiles: readonly ElectronSavedConnectionProfile[];
  readonly selectedProfileId: string | null;
  readonly autoConnectAtStartup: boolean;
}

const emptyPreferences: StoredElectronConnectionPreferences = Object.freeze({
  version: 2,
  profiles: Object.freeze([]),
  selectedProfileId: null,
  autoConnectAtStartup: true,
});

export const ELECTRON_LOCAL_CONNECTION_PROFILE: ElectronLocalConnectionProfile =
  Object.freeze({
    id: ELECTRON_LOCAL_CONNECTION_PROFILE_ID,
    name: "Local",
    kind: "local",
  });

let operationTail: Promise<void> = Promise.resolve();

export function listElectronConnectionProfiles(): Promise<ElectronConnectionPreferences> {
  return serializeOperation(async () =>
    publicPreferences(await readDocument()),
  );
}

export function resetElectronConnectionProfiles(): Promise<ElectronConnectionPreferences> {
  return serializeOperation(async () => {
    await Preferences.remove({ key: ELECTRON_CONNECTIONS_PREFERENCE_KEY });
    return publicPreferences(emptyPreferences);
  });
}

export function setElectronConnectionAutoConnectAtStartup(
  autoConnectAtStartup: boolean,
): Promise<ElectronConnectionPreferences> {
  return serializeOperation(async () => {
    const document = await readDocument();
    const next = { ...document, autoConnectAtStartup };
    await writeDocument(next);
    return publicPreferences(next);
  });
}

export function createElectronConnectionProfile(
  input: ElectronConnectionProfileInput,
): Promise<ElectronConnectionProfile> {
  return serializeOperation(async () => {
    const document = await readDocument();
    const profile = normalizeProfileInput(crypto.randomUUID(), input);
    assertUniqueName(document.profiles, profile.name);
    await writeDocument({
      ...document,
      profiles: [...document.profiles, profile],
    });
    return profile;
  });
}

export function updateElectronConnectionProfile(
  profileId: string,
  input: ElectronConnectionProfileInput,
): Promise<ElectronConnectionProfile> {
  return serializeOperation(async () => {
    const id = profileIdSchema.parse(profileId);
    if (id === ELECTRON_LOCAL_CONNECTION_PROFILE_ID) {
      throw new Error("The built-in Local connection cannot be edited.");
    }
    const document = await readDocument();
    const index = document.profiles.findIndex((profile) => profile.id === id);
    if (index < 0) throw new Error("The connection profile no longer exists.");

    const profile = normalizeProfileInput(id, input);
    assertUniqueName(document.profiles, profile.name, id);
    const profiles = [...document.profiles];
    const previousProfile = profiles[index]!;
    profiles[index] = profile;
    await writeDocument({
      ...document,
      profiles,
      selectedProfileId:
        document.selectedProfileId === id &&
        !sameConnectionTarget(previousProfile, profile)
          ? null
          : document.selectedProfileId,
    });
    return profile;
  });
}

export function deleteElectronConnectionProfile(
  profileId: string,
): Promise<ElectronConnectionPreferences> {
  return serializeOperation(async () => {
    const id = profileIdSchema.parse(profileId);
    if (id === ELECTRON_LOCAL_CONNECTION_PROFILE_ID) {
      throw new Error("The built-in Local connection cannot be deleted.");
    }
    const document = await readDocument();
    if (
      id !== ELECTRON_LOCAL_CONNECTION_PROFILE_ID &&
      !document.profiles.some((profile) => profile.id === id)
    ) {
      throw new Error("The connection profile no longer exists.");
    }
    const next = {
      ...document,
      profiles: document.profiles.filter((profile) => profile.id !== id),
      selectedProfileId:
        document.selectedProfileId === id ? null : document.selectedProfileId,
    };
    await writeDocument(next);
    return publicPreferences(next);
  });
}

export function commitElectronConnectionProfileSelection(
  profileId: string,
  signal: AbortSignal,
): Promise<ElectronConnectionPreferences> {
  return serializeOperation(async () => {
    const id = profileIdSchema.parse(profileId);
    const document = await readDocument();
    if (
      id !== ELECTRON_LOCAL_CONNECTION_PROFILE_ID &&
      !document.profiles.some((profile) => profile.id === id)
    ) {
      throw new Error("The connection profile no longer exists.");
    }
    if (signal.aborted) return publicPreferences(document);

    const next = { ...document, selectedProfileId: id };
    let selectionWriteError: unknown;
    try {
      await writeDocument(next);
    } catch (error) {
      selectionWriteError = error;
    }
    if (signal.aborted) {
      try {
        // Keep the compensation inside this serialized operation so a newer
        // profile mutation or successful selection cannot be overwritten by
        // the cancelled attempt's rollback.
        await writeDocument(document);
      } catch (rollbackError) {
        throw new AggregateError(
          selectionWriteError
            ? [selectionWriteError, rollbackError]
            : [rollbackError],
          "Could not restore the connection selection after cancellation.",
        );
      }
      return publicPreferences(document);
    }
    if (selectionWriteError) throw selectionWriteError;
    return publicPreferences(next);
  });
}

function normalizeProfileInput(
  id: string,
  input: ElectronConnectionProfileInput,
): ElectronSavedConnectionProfile {
  const name = normalizeName(input.name);
  if (input.kind === "direct") {
    return directProfileSchema.parse({
      id,
      name,
      kind: "direct",
      baseUrl: normalizeSedesServerUrl(input.baseUrl),
    });
  }
  return sshProfileSchema.parse({
    id,
    name,
    kind: "ssh",
    sshHost: normalizeSshHost(input.sshHost),
    remotePort: input.remotePort ?? DEFAULT_SSH_REMOTE_PORT,
  });
}

function normalizeName(input: string): string {
  const name = input.trim();
  if (!name) throw new Error("Enter a connection name.");
  if (name.length > ELECTRON_CONNECTION_NAME_MAX_LENGTH) {
    throw new Error(
      `Connection names must be ${ELECTRON_CONNECTION_NAME_MAX_LENGTH} characters or fewer.`,
    );
  }
  return name;
}

function normalizeSshHost(input: string): string {
  const host = input.trim();
  if (!host) throw new Error("Enter an SSH host.");
  if (host.length > ELECTRON_SSH_HOST_MAX_LENGTH) {
    throw new Error(
      `SSH hosts must be ${ELECTRON_SSH_HOST_MAX_LENGTH} characters or fewer.`,
    );
  }
  if (host.startsWith("-") || !/^[A-Za-z0-9_.-]+$/u.test(host)) {
    throw new Error(
      "SSH hosts may contain only letters, numbers, periods, underscores, and hyphens, and must not begin with a hyphen.",
    );
  }
  return host;
}

function assertUniqueName(
  profiles: readonly ElectronSavedConnectionProfile[],
  name: string,
  exceptProfileId?: string,
): void {
  const key = connectionNameKey(name);
  if (
    profiles.some(
      (profile) =>
        profile.id !== exceptProfileId &&
        connectionNameKey(profile.name) === key,
    )
  ) {
    throw new Error(`A connection named "${name}" already exists.`);
  }
}

function connectionNameKey(name: string): string {
  return name.toLowerCase();
}

function sameConnectionTarget(
  first: ElectronSavedConnectionProfile,
  second: ElectronSavedConnectionProfile,
): boolean {
  if (first.kind !== second.kind) return false;
  if (first.kind === "direct" && second.kind === "direct") {
    return first.baseUrl === second.baseUrl;
  }
  return (
    first.kind === "ssh" &&
    second.kind === "ssh" &&
    first.sshHost === second.sshHost &&
    first.remotePort === second.remotePort
  );
}

async function readDocument(): Promise<StoredElectronConnectionPreferences> {
  const { value } = await Preferences.get({
    key: ELECTRON_CONNECTIONS_PREFERENCE_KEY,
  });
  if (value === null) return emptyPreferences;

  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("The saved connections are corrupted.");
  }
  const parsed = preferencesSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error("The saved connections are invalid.");
  }
  return parsed.data;
}

async function writeDocument(
  document: StoredElectronConnectionPreferences,
): Promise<void> {
  const validated = preferencesSchema.parse(document);
  await Preferences.set({
    key: ELECTRON_CONNECTIONS_PREFERENCE_KEY,
    value: JSON.stringify(validated),
  });
}

function publicPreferences(
  document: StoredElectronConnectionPreferences,
): ElectronConnectionPreferences {
  return {
    profiles: [ELECTRON_LOCAL_CONNECTION_PROFILE, ...document.profiles],
    selectedProfileId: document.selectedProfileId,
    autoConnectAtStartup: document.autoConnectAtStartup,
  };
}

function serializeOperation<T>(operation: () => Promise<T>): Promise<T> {
  const result = operationTail.then(operation, operation);
  operationTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}
