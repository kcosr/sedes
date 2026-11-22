import type { InitializeResponse } from "@agentclientprotocol/sdk";
import { AntigravityError } from "./port.js";

export const ANTIGRAVITY_PROTOCOL_RELEASE = "1.5.14";
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
