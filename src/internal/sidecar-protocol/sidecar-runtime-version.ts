export const SIDECAR_MINIMUM_NODE_VERSION = "22.19.0" as const;

const minimumParts = Object.freeze([22, 19, 0] as const);

export function supportsSidecarNodeVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (
    parts.length !== minimumParts.length ||
    parts.some((part) => !Number.isSafeInteger(part) || part < 0)
  ) {
    return false;
  }
  for (let index = 0; index < minimumParts.length; index += 1) {
    const part = parts[index]!;
    const minimum = minimumParts[index]!;
    if (part > minimum) return true;
    if (part < minimum) return false;
  }
  return true;
}
