export function electronBuilderUnpackedDirectory(platform, architecture) {
  if (typeof architecture !== "string" || architecture.length === 0) {
    throw new Error("electron_package_architecture_invalid");
  }
  const architectureSuffix = architecture === "x64" ? "" : `-${architecture}`;
  if (platform === "darwin") return `mac${architectureSuffix}`;
  if (platform === "win32") return `win${architectureSuffix}-unpacked`;
  if (platform === "linux") return `linux${architectureSuffix}-unpacked`;
  throw new Error(`electron_package_platform_unsupported:${platform}`);
}
