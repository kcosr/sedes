import os from "node:os";
import { isIP } from "node:net";
import path from "node:path";
import { z } from "zod";
import { parseConversationRetentionMilliseconds } from "../conversations/conversation-retention-policy.js";
import { parseConversationRuntimeBudget } from "../conversations/conversation-runtime-budget-policy.js";
import { parseProviderPulseUrl } from "../provider-pulse/gateway.js";
import type { BootstrapConfiguration } from "./bootstrap-configuration.js";

const portSchema = z
  .string()
  .regex(/^(?:0|[1-9]\d*)$/u)
  .transform(Number)
  .refine((value) => value === 0 || (value >= 1024 && value <= 65_535), {
    message: "PORT must be 0 or an integer from 1024 through 65535.",
  });

export const CAPACITOR_ANDROID_ORIGIN = "http://localhost" as const;
export const CAPACITOR_ELECTRON_ORIGIN =
  "capacitor-electron://localhost" as const;
export type PackagedClientOrigin =
  typeof CAPACITOR_ANDROID_ORIGIN | typeof CAPACITOR_ELECTRON_ORIGIN;

export interface AppConfig {
  readonly authenticationRequired: boolean;
  readonly host: "127.0.0.1" | "0.0.0.0";
  readonly trustedLanHost?: string;
  readonly port: number;
  readonly stateDirectory: string;
  readonly allowedTailscaleHosts: readonly string[];
  readonly packagedClientOrigins: readonly PackagedClientOrigin[];
  readonly conversationRetentionMilliseconds: number;
  readonly conversationRuntimeBudget: number;
  readonly providerPulseUrl?: string | null;
}

function parseAuthenticationRequired(value: string | undefined): boolean {
  if (value === undefined || value === "true") return true;
  if (value === "false") return false;
  throw new Error("SEDES_AUTH_REQUIRED must be exactly true or false.");
}

function absolutePath(value: string, name: string): string {
  if (!path.isAbsolute(value)) {
    throw new Error(`${name} must be an absolute path.`);
  }
  return path.resolve(value);
}

function parseTailscaleHosts(value: string | undefined): readonly string[] {
  if (!value) {
    return [];
  }

  const entries = value.split(",");
  if (entries.length > 16) {
    throw new Error("ALLOWED_TAILSCALE_HOSTS supports at most 16 hostnames.");
  }
  const hosts = entries.map((rawHost) => {
    const host = rawHost.trim().toLowerCase().replace(/\.$/, "");
    if (
      host.length === 0 ||
      host.length > 253 ||
      host.includes("/") ||
      host.includes(":") ||
      host.includes("\\") ||
      host.includes("@") ||
      host.includes("*") ||
      isIP(host) !== 0 ||
      !/^[\x00-\x7F]+$/.test(host) ||
      host
        .split(".")
        .some(
          (label) =>
            label.length === 0 ||
            label.length > 63 ||
            !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
        )
    ) {
      throw new Error("ALLOWED_TAILSCALE_HOSTS contains an invalid hostname.");
    }
    return host;
  });
  return [...new Set(hosts)];
}

function parseTrustedLanHost(value: string): string {
  if (value.trim() !== value || isIP(value) !== 4) {
    throw new Error(
      "SEDES_TRUSTED_LAN_HOST must be an exact private IPv4 address.",
    );
  }
  const octets = value.split(".").map(Number);
  const [first, second, third, fourth] = octets;
  const privateAddress =
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168);
  const privateBlockEndpoint =
    (first === 10 &&
      ((second === 0 && third === 0 && fourth === 0) ||
        (second === 255 && third === 255 && fourth === 255))) ||
    (first === 172 &&
      ((second === 16 && third === 0 && fourth === 0) ||
        (second === 31 && third === 255 && fourth === 255))) ||
    (first === 192 &&
      second === 168 &&
      ((third === 0 && fourth === 0) || (third === 255 && fourth === 255)));
  if (!privateAddress || privateBlockEndpoint) {
    throw new Error(
      "SEDES_TRUSTED_LAN_HOST must be an RFC1918 unicast IPv4 address.",
    );
  }
  return value;
}

function parseBindConfiguration(
  bindHostValue: string | undefined,
  trustedLanHostValue: string | undefined,
  packagedClientOrigins: readonly PackagedClientOrigin[],
): Pick<AppConfig, "host" | "trustedLanHost"> {
  const host = bindHostValue ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "0.0.0.0") {
    throw new Error("SEDES_BIND_HOST must be exactly 127.0.0.1 or 0.0.0.0.");
  }
  if (host === "127.0.0.1") {
    if (trustedLanHostValue !== undefined) {
      throw new Error(
        "SEDES_TRUSTED_LAN_HOST requires SEDES_BIND_HOST=0.0.0.0.",
      );
    }
    return { host };
  }
  if (packagedClientOrigins.length === 0) {
    throw new Error(
      "SEDES_BIND_HOST=0.0.0.0 requires at least one configured packaged client.",
    );
  }
  if (trustedLanHostValue === undefined) {
    throw new Error("SEDES_BIND_HOST=0.0.0.0 requires SEDES_TRUSTED_LAN_HOST.");
  }
  return { host, trustedLanHost: parseTrustedLanHost(trustedLanHostValue) };
}

export function resolveStateDirectory(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const defaultStateDirectory = path.join(
    environment.XDG_STATE_HOME
      ? absolutePath(environment.XDG_STATE_HOME, "XDG_STATE_HOME")
      : path.join(os.homedir(), ".local", "state"),
    "sedes",
  );
  return absolutePath(
    environment.APP_STATE_DIR ?? defaultStateDirectory,
    "APP_STATE_DIR",
  );
}

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  bootstrap: BootstrapConfiguration = { schemaVersion: 11, packagedClients: [] },
): AppConfig {
  if (environment.WORKSPACE_ROOTS !== undefined) {
    throw new Error("WORKSPACE_ROOTS is no longer startup configuration. Import existing grants with configuration:import --workspace-roots, or edit the environment in Settings, then unset WORKSPACE_ROOTS.");
  }
  const installation = bootstrap;
  const packagedClients = bootstrap.packagedClients;
  const stateDirectory = installation?.stateDirectory ?? resolveStateDirectory(environment);
  const packagedClientOrigins = packagedClients.map((client) =>
    client === "android" ? CAPACITOR_ANDROID_ORIGIN : CAPACITOR_ELECTRON_ORIGIN,
  );
  const bind = parseBindConfiguration(
    environment.SEDES_BIND_HOST ?? installation?.listen?.host,
    environment.SEDES_TRUSTED_LAN_HOST ?? installation?.listen?.trustedLanHost,
    packagedClientOrigins,
  );
  return {
    ...bind,
    authenticationRequired: parseAuthenticationRequired(environment.SEDES_AUTH_REQUIRED),
    port: portSchema.parse(environment.PORT ?? String(installation?.listen?.port ?? 4784)),
    stateDirectory,
    allowedTailscaleHosts: parseTailscaleHosts(
      environment.ALLOWED_TAILSCALE_HOSTS ?? installation?.allowedTailscaleHosts?.join(","),
    ),
    packagedClientOrigins: Object.freeze(packagedClientOrigins),
    conversationRetentionMilliseconds: parseConversationRetentionMilliseconds(
      environment.SEDES_CONVERSATION_RETENTION_MILLISECONDS,
    ),
    conversationRuntimeBudget: parseConversationRuntimeBudget(
      environment.SEDES_CONVERSATION_RUNTIME_BUDGET,
    ),
    providerPulseUrl: parseProviderPulseUrl(
      environment.SEDES_PROVIDER_PULSE_URL,
    ),
  };
}
