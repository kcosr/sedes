/** Pure text limits shared by application validation and private tool transports. */
export const WORKPAD_CONTENT_MAX_CHARACTERS = 262_144;
export const WORKPAD_CONTENT_LENGTH_MESSAGE = "Workpad content is too long (maximum 262,144 UTF-16 units).";
export const WORKPAD_CONTENT_UNICODE_MESSAGE = "Workpad content must contain valid Unicode text.";

export function hasWellFormedWorkpadContent(value: string): boolean {
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
