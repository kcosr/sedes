export const MAXIMUM_SUBMISSION_RETRY_ANCHOR_BYTES = 4_096;

export function isValidSubmissionRetryAnchor(value: string): boolean {
  return (
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <=
      MAXIMUM_SUBMISSION_RETRY_ANCHOR_BYTES
  );
}

export function requireSubmissionRetryAnchor(value: string): string {
  if (!isValidSubmissionRetryAnchor(value)) {
    throw new Error("submission_retry_anchor_invalid");
  }
  return value;
}
