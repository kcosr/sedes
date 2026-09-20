/**
 * Release-pinned disposition for Pi 0.86.0's built-in tool catalog.
 *
 * Keep this provider-private and exhaustive. A Pi dependency update must give
 * every newly registered built-in an explicit Sedes disposition before it can
 * acquire execution authority.
 */
export const PI_BUILTIN_TOOL_DISPOSITIONS = Object.freeze({
  read: { support: "supported", effect: "read_only" },
  grep: { support: "supported", effect: "read_only" },
  find: { support: "supported", effect: "read_only" },
  ls: { support: "supported", effect: "read_only" },
  bash: { support: "supported", effect: "mutating" },
  write: { support: "supported", effect: "mutating" },
  edit: { support: "supported", effect: "mutating" },
  powershell: {
    support: "intentionally_unsupported",
    reason:
      "Sedes supports Linux and macOS hosts and has no reviewed PowerShell approval or executor projection.",
  },
} as const);

export type PiReviewedBuiltinToolName =
  keyof typeof PI_BUILTIN_TOOL_DISPOSITIONS;

export const PI_SUPPORTED_BUILTIN_TOOL_NAMES = Object.freeze([
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
] as const);

export type PiBuiltinToolKind =
  (typeof PI_SUPPORTED_BUILTIN_TOOL_NAMES)[number];

export const PI_READ_ONLY_BUILTIN_TOOL_NAMES = Object.freeze([
  "read",
  "grep",
  "find",
  "ls",
] as const satisfies readonly PiBuiltinToolKind[]);

export const PI_MUTATING_BUILTIN_TOOL_NAMES = Object.freeze([
  "bash",
  "write",
  "edit",
] as const satisfies readonly PiBuiltinToolKind[]);

export const PI_INTENTIONALLY_UNSUPPORTED_BUILTIN_TOOL_NAMES = Object.freeze([
  "powershell",
] as const satisfies readonly PiReviewedBuiltinToolName[]);

export const PI_EXCLUDED_TOOL_NAMES =
  PI_INTENTIONALLY_UNSUPPORTED_BUILTIN_TOOL_NAMES;

const supportedBuiltinNames = new Set<string>(PI_SUPPORTED_BUILTIN_TOOL_NAMES);
const unsupportedBuiltinNames = new Set<string>(
  PI_INTENTIONALLY_UNSUPPORTED_BUILTIN_TOOL_NAMES,
);

export interface PiBuiltinToolInfoLike {
  readonly name: string;
  readonly sourceInfo: {
    readonly path: string;
    readonly source: string;
  };
}

export function isPiBuiltinToolKind(value: string): value is PiBuiltinToolKind {
  return supportedBuiltinNames.has(value);
}

/**
 * Return the supported built-in identity represented by one registry entry.
 * Non-built-in extension entries return undefined. Built-in-shaped entries
 * that are unsupported, unreviewed, malformed, or untrusted fail closed.
 */
export function classifyPiBuiltinTool(
  tool: PiBuiltinToolInfoLike,
  trustedBuiltinOverrides: ReadonlySet<PiBuiltinToolKind> = new Set(),
): PiBuiltinToolKind | undefined {
  const { name, sourceInfo } = tool;
  if (unsupportedBuiltinNames.has(name)) {
    throw new Error("pi_builtin_tool_intentionally_unsupported");
  }

  const builtinShaped =
    sourceInfo.source === "builtin" || sourceInfo.path.startsWith("<builtin:");
  if (builtinShaped) {
    if (
      sourceInfo.source !== "builtin" ||
      sourceInfo.path !== `<builtin:${name}>`
    ) {
      throw new Error("pi_builtin_tool_identity_malformed");
    }
    if (!isPiBuiltinToolKind(name)) {
      throw new Error("pi_builtin_tool_disposition_missing");
    }
    if (
      trustedBuiltinOverrides.size === PI_SUPPORTED_BUILTIN_TOOL_NAMES.length
    ) {
      throw new Error("pi_executor_host_builtin_residual");
    }
    return name;
  }

  if (isPiBuiltinToolKind(name) && sourceInfo.source === "sdk") {
    if (
      !trustedBuiltinOverrides.has(name) ||
      sourceInfo.path !== `<sdk:${name}>`
    ) {
      throw new Error("pi_builtin_tool_override_untrusted");
    }
    return name;
  }

  if (trustedBuiltinOverrides.has(name as PiBuiltinToolKind)) {
    throw new Error("pi_builtin_tool_override_malformed");
  }
  return undefined;
}

export function assertAuditedPiBuiltinToolCatalog(
  tools: readonly PiBuiltinToolInfoLike[],
  trustedBuiltinOverrides: ReadonlySet<PiBuiltinToolKind> = new Set(),
): void {
  const matchedOverrides = new Set<PiBuiltinToolKind>();
  for (const tool of tools) {
    const builtin = classifyPiBuiltinTool(tool, trustedBuiltinOverrides);
    if (builtin && trustedBuiltinOverrides.has(builtin)) {
      if (matchedOverrides.has(builtin)) {
        throw new Error("pi_executor_builtin_override_ambiguous");
      }
      matchedOverrides.add(builtin);
    }
  }
  if (
    trustedBuiltinOverrides.size > 0 &&
    matchedOverrides.size !== trustedBuiltinOverrides.size
  ) {
    throw new Error("pi_executor_builtin_override_incomplete");
  }
}
