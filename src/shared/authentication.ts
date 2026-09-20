import { z } from "zod";

export const authenticationTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
export const PAIRING_CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export const pairingCodeSchema = z.string().trim().regex(/^[BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz]{4}-?[BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz]{4}$/u)
  .transform(value => { const letters = value.replace("-", "").toUpperCase(); return `${letters.slice(0, 4)}-${letters.slice(4)}`; });
// Long grants are exclusively issued through private managed-Local IPC, never
// displayed as manual enrollment codes. Saved credentials remain independent.
export const pairingTokenSchema = z.union([pairingCodeSchema, authenticationTokenSchema]);
const connectorIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/u);
export const authenticationClientSchema = z.strictObject({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(128),
  kind: z.enum(["management", "sidecar"]),
  connectorId: connectorIdSchema.optional(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export type AuthenticationClient = z.infer<typeof authenticationClientSchema>;
export const pairingRequestSchema = z.strictObject({
  token: pairingTokenSchema,
  clientName: z.string().trim().min(1).max(128),
  kind: z.enum(["browser", "device", "sidecar"]),
  connectorId: connectorIdSchema.optional(),
  previousCredential: authenticationTokenSchema.optional(),
}).refine(value => value.kind === "sidecar" ? value.connectorId !== undefined : value.connectorId === undefined,
  "Only sidecar clients must supply a connectorId.")
  .refine(value => value.kind === "sidecar" || value.previousCredential === undefined,
    "Only sidecar clients may supply a previous credential.");
export type PairingRequest = z.infer<typeof pairingRequestSchema>;
export const pairingResponseSchema = z.strictObject({
  client: authenticationClientSchema,
  credential: authenticationTokenSchema.optional(),
});
export const authenticationStatusSchema = z.strictObject({
  required: z.boolean(),
  authenticated: z.boolean(),
  client: authenticationClientSchema.optional(),
});
export const authenticationClientsResponseSchema = z.strictObject({ clients: z.array(authenticationClientSchema) });
