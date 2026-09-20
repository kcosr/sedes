import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { z } from "zod";

const connectionIdSchema = z.uuid();
const hostAliasSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9_.-]+$/u)
  .refine((value) => !value.startsWith("-"));
const remotePortSchema = z.number().int().min(1).max(65_535);
const loopbackBaseUrlSchema = z.string().refine(isNormalizedLoopbackOrigin, {
  message: "The native connection runtime returned an invalid loopback origin.",
});
const connectionSchema = z.strictObject({
  connectionId: connectionIdSchema,
  baseUrl: loopbackBaseUrlSchema,
});
const localConnectionSchema = connectionSchema.extend({ authenticationRequired: z.boolean() });
const disconnectedStatusSchema = z.strictObject({
  status: z.literal("disconnected"),
});
const connectingStatusSchema = z.strictObject({
  status: z.literal("connecting"),
  connectionId: connectionIdSchema,
});
const localStatusSchema = z.discriminatedUnion("status", [
  disconnectedStatusSchema,
  connectingStatusSchema,
  z.strictObject({
    status: z.literal("connected"),
    connectionId: connectionIdSchema,
    baseUrl: loopbackBaseUrlSchema,
    authenticationRequired: z.boolean(),
  }),
]);
const sshStatusSchema = z.discriminatedUnion("status", [
  disconnectedStatusSchema,
  connectingStatusSchema,
  z.strictObject({
    status: z.literal("connected"),
    connectionId: connectionIdSchema,
    baseUrl: loopbackBaseUrlSchema,
    hostAlias: hostAliasSchema,
    remotePort: remotePortSchema,
  }),
]);
const statusSchema = z.strictObject({
  local: localStatusSchema,
  ssh: sshStatusSchema,
});
const stateChangeSchema = z.strictObject({
  kind: z.enum(["local", "ssh"]),
  connectionId: connectionIdSchema,
  status: z.literal("disconnected"),
  error: z
    .strictObject({
      code: z.string().min(1).max(160),
      message: z.string().min(1).max(1_024),
    })
    .optional(),
});

export type ElectronConnectionRuntimeConnection = z.infer<
  typeof connectionSchema
>;
export type ElectronConnectionRuntimeStatus = z.infer<typeof statusSchema>;
export type ElectronConnectionRuntimeStateChange = z.infer<
  typeof stateChangeSchema
>;

interface NativeElectronConnectionRuntimePlugin {
  startLocal(input: { readonly connectionId: string }): Promise<unknown>;
  connectSsh(input: {
    readonly profileId: string;
    readonly connectionId: string;
    readonly hostAlias: string;
    readonly remotePort: number;
  }): Promise<unknown>;
  disconnect(input: { readonly connectionId: string }): Promise<void>;
  getStatus(): Promise<unknown>;
  addListener(
    eventName: "stateChange",
    listener: (state: unknown) => void,
  ): Promise<PluginListenerHandle>;
}

const nativeRuntime = registerPlugin<NativeElectronConnectionRuntimePlugin>(
  "ElectronConnectionRuntime",
);

export const electronConnectionRuntime = Object.freeze({
  async startLocal(input: {
    readonly connectionId: string;
  }): Promise<z.infer<typeof localConnectionSchema>> {
    const validated = { connectionId: connectionIdSchema.parse(input.connectionId) };
    return localConnectionSchema.parse(await nativeRuntime.startLocal(validated));
  },

  async connectSsh(input: {
    readonly profileId: string;
    readonly connectionId: string;
    readonly hostAlias: string;
    readonly remotePort: number;
  }): Promise<ElectronConnectionRuntimeConnection> {
    const validated = {
      connectionId: connectionIdSchema.parse(input.connectionId),
      profileId: z.uuid().parse(input.profileId),
      hostAlias: hostAliasSchema.parse(input.hostAlias),
      remotePort: remotePortSchema.parse(input.remotePort),
    };
    return connectionSchema.parse(await nativeRuntime.connectSsh(validated));
  },

  disconnect(input: { readonly connectionId: string }): Promise<void> {
    return nativeRuntime.disconnect({
      connectionId: connectionIdSchema.parse(input.connectionId),
    });
  },

  async getStatus(): Promise<ElectronConnectionRuntimeStatus> {
    return statusSchema.parse(await nativeRuntime.getStatus());
  },

  addListener(
    listener: (state: ElectronConnectionRuntimeStateChange) => void,
  ): Promise<PluginListenerHandle> {
    return nativeRuntime.addListener("stateChange", (state) =>
      listener(stateChangeSchema.parse(state)),
    );
  },
});

function isNormalizedLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === "" &&
      url.origin === value
    );
  } catch {
    return false;
  }
}
