/** Executable admission is separate from the reviewed 1.4.0 RPC profile. */
export const PI_RUNTIME_MINIMUM_SUPPORTED_RELEASE = "1.4.0";
export const PI_RUNTIME_TESTED_THROUGH_RELEASE = "1.5.0";
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export interface VerifiedPiRuntimeVersion {
  readonly version: string;
  readonly newerThanTested: boolean;
}
function parse(version: string): readonly bigint[] | undefined {
  if (version.length > 128) return undefined;
  const match = stableVersion.exec(version);
  return match ? [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)] : undefined;
}
function compare(left: readonly bigint[], right: readonly bigint[]): number {
  for (let index = 0; index < 3; index++) {
    if (left[index]! < right[index]!) return -1;
    if (left[index]! > right[index]!) return 1;
  }
  return 0;
}
export function assessPiRuntimeVersion(version: string): VerifiedPiRuntimeVersion {
  const parsed = parse(version);
  if (!parsed || compare(parsed, parse(PI_RUNTIME_MINIMUM_SUPPORTED_RELEASE)!) < 0)
    throw new Error("pi_native_version_unsupported");
  return Object.freeze({ version, newerThanTested: compare(parsed, parse(PI_RUNTIME_TESTED_THROUGH_RELEASE)!) > 0 });
}
export function decodePiRuntimeVersionProbe(stdout: string, stderr: string): VerifiedPiRuntimeVersion {
  const match = /^([^\s]+)(?:\r?\n)?$/u.exec(stdout);
  if (!match || stderr.length) throw new Error("pi_native_version_unsupported");
  return assessPiRuntimeVersion(match[1]!);
}
