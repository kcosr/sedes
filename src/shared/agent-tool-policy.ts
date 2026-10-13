import type { NormalizedThreadAgentToolPolicy } from "./protocol/conversation.js";

/** Runtime eligibility changes independently of the saved policy revision. */
export function sameAgentToolPolicyRevision(
  left: NormalizedThreadAgentToolPolicy,
  right: NormalizedThreadAgentToolPolicy,
): boolean {
  const { runtimeAvailability: _leftRuntime, ...leftPolicy } = left;
  const { runtimeAvailability: _rightRuntime, ...rightPolicy } = right;
  return sameJsonValue(leftPolicy, rightPolicy);
}

/** Compare validated JSON values without treating object insertion order as data. */
function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameJsonValue(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).filter(key => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord).filter(key => rightRecord[key] !== undefined);
  return leftKeys.length === rightKeys.length && leftKeys.every(key =>
    Object.hasOwn(rightRecord, key) && sameJsonValue(leftRecord[key], rightRecord[key]));
}
