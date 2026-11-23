import { createHash } from "node:crypto";
import { normalizedAbsolutePath } from "../../shared/absolute-path.js";

/** Socket names are unique per authorized route incarnation. Only this opaque
 * stamp travels back with a session attachment. */
export function toolPeerStamp(endpoint?: string | null): string | undefined {
  return endpoint ? createHash("sha256").update(endpoint).digest("hex") : undefined;
}

export function validToolPath(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= 16_384 && !/[\u0000-\u001f\u007f]/u.test(value);
}
export function validToolDirectory(value: string): boolean {
  return Buffer.byteLength(value, "utf8") <= 4_096 && !/[\u0000-\u001f\u007f]/u.test(value) &&
    value.startsWith("/") && !value.includes("\\") && normalizedAbsolutePath(value);
}
