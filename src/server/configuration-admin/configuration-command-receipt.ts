import { z } from "zod";
import type { ConfigurationDocument, ConfigurationSnapshot } from "../../shared/protocol/configuration-admin.js";
import { DomainError } from "../domain/errors.js";

export const configurationCommandIdentitySchema = z.strictObject({
  toolId: z.string().min(1).max(128),
  sourceThreadId: z.string().min(1).max(160),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
});
export const configurationCommandScopeFactsSchema = z.strictObject({
  environmentIds: z.array(z.string().uuid()).max(16),
  crossEnvironment: z.boolean(),
});
export const configurationCommandMetadataSchema = z.strictObject({
  identity: configurationCommandIdentitySchema,
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  scopeFacts: configurationCommandScopeFactsSchema,
});
export type ConfigurationCommandIdentity = z.infer<typeof configurationCommandIdentitySchema>;
export type ConfigurationCommandScopeFacts = z.infer<typeof configurationCommandScopeFactsSchema>;
export type ConfigurationCommandMetadata = z.infer<typeof configurationCommandMetadataSchema>;

export interface ConfigurationCommand<T> {
  readonly mutationId: string;
  readonly expectedRevision: number;
  readonly identity: ConfigurationCommandIdentity;
  /** Rechecks current caller authority using retained facts, including after removal.
   * Must be synchronous so the check also runs inside the save transaction. */
  readonly authorize: (facts: ConfigurationCommandScopeFacts) => void;
  readonly build: (snapshot: ConfigurationSnapshot) => {
    readonly configuration: ConfigurationDocument;
    readonly scopeFacts: ConfigurationCommandScopeFacts;
    /** Only the bounded, value-free tool result; never the full snapshot. */
    readonly present: (snapshot: ConfigurationSnapshot) => T;
  };
}

export interface ConfigurationCommandReceipt<T> {
  readonly metadata: ConfigurationCommandMetadata;
  readonly result: T;
}

/** Round-trip the actual durable result so first replies and replay agree. */
export function serializeConfigurationCommandResult(value: unknown): string {
  const result = JSON.stringify(value);
  if (!result || Buffer.byteLength(result, "utf8") > 65_536) {
    throw new DomainError("bad_request", "The configuration command result exceeds its receipt limit.");
  }
  return result;
}
