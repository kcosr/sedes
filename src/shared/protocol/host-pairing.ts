import { z } from "zod";
import {
  configurationHostPlatformSchema, configurationRemoteOperationsSchema,
  configurationRevisionSchema, configurationSnapshotSchema, configurationOutboundWorkspaceRootsSchema,
} from "./configuration-admin.js";

const text = z.string().min(1).max(255).refine(value => !/\p{Cc}/u.test(value));
const timestamp = z.string().datetime();
export const hostMetadataSchema = z.strictObject({
  hostname: text, platform: configurationHostPlatformSchema, architecture: text,
  account: text, connectorVersion: text, nodeVersion: text.optional(),
});
export const registerHostRequestSchema = z.strictObject({
  connectorId: z.string().uuid(), registrationAttemptId: z.string().uuid(), metadata: hostMetadataSchema,
});
export const hostRegistrationSchema = z.strictObject({
  id: z.string().uuid(), connectorId: z.string().uuid(), registrationAttemptId: z.string().uuid(),
  correlationCode: z.string().regex(/^[A-F0-9]{4}-[A-F0-9]{4}$/), metadata: hostMetadataSchema,
  state: z.enum(["pending", "accepted", "denied", "expired"]), revision: configurationRevisionSchema,
  createdAt: timestamp, updatedAt: timestamp, lastSeenAt: timestamp, expiresAt: timestamp,
  pairingId: z.string().uuid().nullable(),
});
export const hostPairingSchema = z.strictObject({
  id: z.string().uuid(), connectorId: z.string().uuid(), executionEnvironmentId: z.string().uuid(),
  platform: configurationHostPlatformSchema, metadata: hostMetadataSchema,
  state: z.enum(["accepted", "revoked"]), revision: configurationRevisionSchema,
  createdAt: timestamp, updatedAt: timestamp, lastSeenAt: timestamp,
});
export const hostPairingListSchema = z.strictObject({
  registrations: z.array(hostRegistrationSchema.extend({ connected: z.boolean() })).max(256),
  pairings: z.array(hostPairingSchema.extend({ connected: z.boolean() })).max(256),
});
export const acceptHostRegistrationRequestSchema = z.strictObject({
  mutationId: z.string().uuid(), registrationId: z.string().uuid(),
  expectedRegistrationRevision: configurationRevisionSchema, expectedConfigurationRevision: configurationRevisionSchema,
  label: z.string().min(1).max(120).refine(value => !/\p{Cc}/u.test(value)),
  workspaceRoots: configurationOutboundWorkspaceRootsSchema, operations: configurationRemoteOperationsSchema,
});
export const denyHostRegistrationRequestSchema = z.strictObject({
  mutationId: z.string().uuid(), registrationId: z.string().uuid(), expectedRegistrationRevision: configurationRevisionSchema,
});
export const changeHostPairingRequestSchema = z.strictObject({
  mutationId: z.string().uuid(), pairingId: z.string().uuid(),
  expectedPairingRevision: configurationRevisionSchema, expectedConfigurationRevision: configurationRevisionSchema,
});
export const acceptHostRegistrationResultSchema = z.strictObject({
  registration: hostRegistrationSchema, pairing: hostPairingSchema, configuration: configurationSnapshotSchema,
});
export const changeHostPairingResultSchema = z.strictObject({ pairing: hostPairingSchema, configuration: configurationSnapshotSchema });
export type HostMetadata = z.infer<typeof hostMetadataSchema>;
export type RegisterHostRequest = z.infer<typeof registerHostRequestSchema>;
export type HostRegistration = z.infer<typeof hostRegistrationSchema>;
export type HostPairing = z.infer<typeof hostPairingSchema>;
export type HostPairingList = z.infer<typeof hostPairingListSchema>;
export type AcceptHostRegistrationRequest = z.infer<typeof acceptHostRegistrationRequestSchema>;
export type DenyHostRegistrationRequest = z.infer<typeof denyHostRegistrationRequestSchema>;
export type ChangeHostPairingRequest = z.infer<typeof changeHostPairingRequestSchema>;
export type AcceptHostRegistrationResult = z.infer<typeof acceptHostRegistrationResultSchema>;
export type ChangeHostPairingResult = z.infer<typeof changeHostPairingResultSchema>;
