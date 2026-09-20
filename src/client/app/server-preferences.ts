import { Preferences } from "@capacitor/preferences";
import { z } from "zod";
import { normalizeSedesServerUrl } from "./server-endpoint.js";

const preferenceKey = "sedes.connections.v1";
const profileSchema = z.strictObject({
  id: z.uuid(),
  name: z.string().trim().min(1).max(100),
  baseUrl: z.string(),
});
const connectionsSchema = z.strictObject({
  version: z.literal(1),
  profiles: z.array(profileSchema).max(100),
  selectedProfileId: z.uuid().nullable(),
});

/** Presentation-owned profiles. Credentials belong exclusively to native secure storage. */
export type PackagedConnectionProfile = z.infer<typeof profileSchema>;
export type PackagedConnectionPreferences = z.infer<typeof connectionsSchema>;

export function emptyPackagedConnections(): PackagedConnectionPreferences {
  return { version: 1, profiles: [], selectedProfileId: null };
}

function validateConnections(value: unknown): PackagedConnectionPreferences {
  const parsed = connectionsSchema.safeParse(value);
  if (!parsed.success) throw new Error("The saved Sedes connections are invalid.");
  const result = parsed.data;
  const ids = new Set(result.profiles.map((profile) => profile.id));
  if (ids.size !== result.profiles.length ||
    (result.selectedProfileId !== null && !ids.has(result.selectedProfileId))) {
    throw new Error("The saved Sedes connections contain invalid profile references.");
  }
  for (const profile of result.profiles) {
    if (normalizeSedesServerUrl(profile.baseUrl) !== profile.baseUrl) {
      throw new Error("The saved Sedes server URL is not normalized.");
    }
  }
  return result;
}

export async function loadPackagedConnections(): Promise<PackagedConnectionPreferences> {
  const { value } = await Preferences.get({ key: preferenceKey });
  if (value === null) return emptyPackagedConnections();
  let decoded: unknown;
  try {
    decoded = JSON.parse(value) as unknown;
  } catch {
    throw new Error("The saved Sedes connections are corrupted.");
  }
  return validateConnections(decoded);
}

export async function savePackagedConnections(
  connections: PackagedConnectionPreferences,
): Promise<PackagedConnectionPreferences> {
  const validated = validateConnections(connections);
  await Preferences.set({ key: preferenceKey, value: JSON.stringify(validated) });
  return validated;
}
