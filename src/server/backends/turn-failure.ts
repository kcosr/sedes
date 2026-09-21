import { stripVTControlCharacters } from "node:util";
import type { TurnFailure } from "../../shared/protocol/payload.js";
import { boundText } from "../conversations/payload-policy.js";

export const GENERIC_TURN_FAILURE = "The provider reported a failure but supplied no explanation.";

/** Format an explicitly selected provider diagnostic, never an error object or stderr.
 * Scrubs common credential forms; this is not a general secret detector.
 */
export function turnFailure(value: unknown): TurnFailure {
  const text = typeof value === "string"
    ? stripVTControlCharacters(value)
      .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "")
      .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [redacted]")
      .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
      .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[redacted]@")
      .replace(/([?&](?:api[_-]?key|key|token|access_token)=)[^\s&#]*/gi, "$1[redacted]")
      .trim()
    : "";
  return { message: boundText(text || GENERIC_TURN_FAILURE, 1024) };
}
