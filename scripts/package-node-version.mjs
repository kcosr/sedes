/** Run before CLI entry detection: older Node lacks import.meta.main. */
export function assertPackageNodeVersion(version = process.versions.node) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
  if (!match || Number(match[1]) < 24 || (Number(match[1]) === 24 && Number(match[2]) < 18)) {
    throw new Error('Sedes requires Node.js 24.18.0 or newer.');
  }
}
