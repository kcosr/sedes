import type { InitializeResponse } from "@agentclientprotocol/sdk";
import { AntigravityError } from "./port.js";

// The qualified profile labels Sedes configuration. The ACP version gate below
// independently admits compatible stock runtimes starting with 1.5.14.
export const ANTIGRAVITY_PROTOCOL_RELEASE = "1.5.18";
export function admitAntigravityInitialize(value: InitializeResponse): string {
  const version = value.agentInfo?.version;
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (!match || Number(match[1]) !== 1 || Number(match[2]) < 5 ||
      (Number(match[2]) === 5 && Number(match[3]) < 14) || value.protocolVersion !== 1 ||
      value.agentCapabilities?.loadSession !== true || !value.agentCapabilities.sessionCapabilities?.list) {
    throw new AntigravityError("antigravity_runtime_incompatible", "rejected");
  }
  return version!;
}
