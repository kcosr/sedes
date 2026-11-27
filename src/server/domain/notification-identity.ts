import { createHash } from "node:crypto";
import type { RequestScope } from "../identity/identity-provider.js";

export function turnNotificationKey(threadId: string, turnId: string): string {
  return JSON.stringify(["turn", threadId, turnId]);
}

export function progressNotificationKey(threadId: string, turnId: string, itemId: string): string {
  return JSON.stringify(["progress", threadId, turnId, itemId]);
}

export function notificationSourceId(eventKey: string): string {
  return createHash("sha256").update(eventKey).digest("hex");
}

export function scopedReplyKey(scope: RequestScope, replyId: string): string {
  return JSON.stringify([scope.tenantId, scope.principalId, replyId]);
}
