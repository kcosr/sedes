import { z } from "zod";
import { registerHostRequestSchema } from "../shared/protocol/host-pairing.js";
import {
  sidecarServiceConfigurationSchema,
  sidecarServiceScopeSchema,
} from "./sidecar-protocol/service-management-v1.js";

/** Connector control is independent of the sidecar runtime wire version. */
export const OUTBOUND_CONTROL_PATH = "/api/outbound/control";
export const OUTBOUND_RUNTIME_PATH = "/api/outbound/runtime";
export const OUTBOUND_ARTIFACT_PATH = "/api/outbound/artifacts";
export const OUTBOUND_CONTROL_PROTOCOL = "sedes-outbound-control-v1";
export const OUTBOUND_RUNTIME_PROTOCOL = "sedes-outbound-runtime-v1";
export const OUTBOUND_CONTROL_MAX_BYTES = 512 * 1024;
export const OUTBOUND_RUNTIME_CHUNK_BYTES = 64 * 1024;
export const OUTBOUND_RUNTIME_MAX_BUFFER_BYTES = 4 * 1024 * 1024;

export const outboundHelloSchema = registerHostRequestSchema.extend({
  type: z.literal("hello"),
  protocolVersion: z.literal(1),
  binding: z.strictObject({
    pairingId: z.uuid(),
    installationId: z.string().min(1).max(160),
  }).optional(),
});
export type OutboundHello = z.infer<typeof outboundHelloSchema>;

export const outboundRuntimeBootstrapSchema = z.strictObject({
  scope: sidecarServiceScopeSchema,
  configuration: sidecarServiceConfigurationSchema,
  expectedDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  expectedBuild: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
  agentToolEndpointKey: z.string().regex(/^[a-f0-9]{24}$/u),
  startIfAbsent: z.boolean(),
});
export type OutboundRuntimeBootstrap = z.infer<typeof outboundRuntimeBootstrapSchema>;

export const outboundPairingMessageSchema = z.strictObject({
  type: z.literal("pairing"),
  status: z.enum(["pending", "accepted", "denied", "revoked", "expired"]),
  registrationId: z.uuid().optional(),
  pairingId: z.uuid().optional(),
  correlationCode: z.string().max(32).optional(),
  generation: z.number().int().positive(),
  scope: sidecarServiceScopeSchema.optional(),
});

export const outboundResultSchema = z.strictObject({
  type: z.literal("result"),
  requestId: z.uuid(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().min(1).max(512).optional(),
});
export const outboundInstallationSchema = z.strictObject({
  accountHome: z.string().min(1).max(32768),
  nodeExecutable: z.string().min(1).max(32768),
  stateRoot: z.string().min(1).max(32768),
  environment: z.record(z.string().max(1024), z.string().max(32768)),
  executableDirectory: z.string().min(1).max(32768),
  executablePath: z.string().min(1).max(32768),
});
export type OutboundInstallation = z.infer<typeof outboundInstallationSchema>;
export const outboundRuntimeReadySchema = z.strictObject({
  type: z.literal("runtimeReady"),
  ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  ok: z.boolean(),
  installation: outboundInstallationSchema.optional(),
  error: z.string().min(1).max(512).optional(),
});
export const outboundClientMessageSchema = z.discriminatedUnion("type", [
  outboundHelloSchema,
  outboundResultSchema,
  outboundRuntimeReadySchema,
]);
export const outboundServerMessageSchema = z.discriminatedUnion("type", [
  outboundPairingMessageSchema,
  z.strictObject({
    type: z.literal("command"),
    requestId: z.uuid(),
    operation: z.enum(["install", "management"]),
    payload: z.unknown(),
  }),
  z.strictObject({
    type: z.literal("attach"),
    ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
    payload: outboundRuntimeBootstrapSchema,
  }),
  z.strictObject({ type: z.literal("cancel"), requestId: z.uuid() }),
  z.strictObject({ type: z.literal("cancelAttach"), ticket: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }),
]);
export type OutboundClientMessage = z.infer<typeof outboundClientMessageSchema>;
export type OutboundServerMessage = z.infer<typeof outboundServerMessageSchema>;
