import { createHash } from "node:crypto";
import type { RequestScope } from "../identity/identity-provider.js";

export function turnNotificationKey(threadId: string, turnId: string): string {
  return JSON.stringify(["turn", threadId, turnId]);
}

export function notificationSourceId(eventKey: string): string {
  return createHash("sha256").update(eventKey).digest("hex");
}

export function scopedTurnKey(scope: RequestScope, threadId: string, turnId: string): string {
  return JSON.stringify([scope.tenantId, scope.principalId, threadId, turnId]);
}
