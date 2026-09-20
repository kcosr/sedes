import path from "node:path";
import type {
  PiSandboxNetworkMode,
  PiSandboxWorkspaceAccess,
} from "./contracts.js";
import { PI_SANDBOX_HOME, PI_SANDBOX_WORKSPACE } from "./contracts.js";

const DEFAULT_SYSTEM_MOUNTS = Object.freeze([
  "/usr",
  "/bin",
  "/lib",
  "/lib64",
  "/etc/alternatives",
  "/etc/ca-certificates",
  "/etc/ssl",
  "/etc/hosts",
  "/etc/nsswitch.conf",
  "/etc/resolv.conf",
] as const);

export interface PiBubblewrapPolicyInput {
  readonly hostHomePath: string;
  readonly hostWorkspacePath: string;
  readonly workspaceAccess: PiSandboxWorkspaceAccess;
  readonly workerArtifactPath: string;
  readonly workerNodePath: string;
  readonly searchExecutablePaths?: Readonly<{ rg: string; fd: string }>;
  readonly networkMode: PiSandboxNetworkMode;
  /** Existing reviewed paths. The runtime resolves this list before launch. */
  readonly systemMounts?: readonly string[];
}

export const PI_SANDBOX_WORKER_PATH = "/run/sedes/pi-sandbox-worker.mjs";
export const PI_SANDBOX_NODE_PATH = "/runtime/node";

/**
 * Constructs the complete sandbox boundary. No host path is inherited from
 * the environment and no fallback mount is inferred by the worker.
 */
export function buildPiBubblewrapArguments(
  input: PiBubblewrapPolicyInput,
): readonly string[] {
  assertCanonicalAbsolute(input.hostHomePath, "pi_sandbox_home_invalid");
  assertCanonicalAbsolute(
    input.hostWorkspacePath,
    "pi_sandbox_workspace_invalid",
  );
  assertCanonicalAbsolute(
    input.workerArtifactPath,
    "pi_sandbox_worker_artifact_invalid",
  );
  assertCanonicalAbsolute(input.workerNodePath, "pi_sandbox_node_invalid");
  if (input.searchExecutablePaths) {
    assertCanonicalAbsolute(
      input.searchExecutablePaths.rg,
      "pi_sandbox_search_executable_invalid",
    );
    assertCanonicalAbsolute(
      input.searchExecutablePaths.fd,
      "pi_sandbox_search_executable_invalid",
    );
  }
  if (
    input.workspaceAccess === "writable_clone" &&
    !isWithin(input.hostHomePath, input.hostWorkspacePath)
  ) {
    throw new Error("pi_sandbox_workspace_outside_home");
  }
  if (
    input.workspaceAccess === "read_only" &&
    (isWithin(input.hostHomePath, input.hostWorkspacePath) ||
      isWithin(input.hostWorkspacePath, input.hostHomePath))
  ) {
    throw new Error("pi_sandbox_read_only_workspace_overlaps_home");
  }
  const systemMounts = input.systemMounts ?? DEFAULT_SYSTEM_MOUNTS;
  if (systemMounts.length === 0 || systemMounts.length > 32) {
    throw new Error("pi_sandbox_system_mounts_invalid");
  }
  for (const mount of systemMounts) {
    assertCanonicalAbsolute(mount, "pi_sandbox_system_mount_invalid");
    if (
      isWithin(input.hostHomePath, mount) ||
      isWithin(mount, input.hostHomePath) ||
      (input.workspaceAccess === "read_only" &&
        (isWithin(input.hostWorkspacePath, mount) ||
          isWithin(mount, input.hostWorkspacePath)))
    ) {
      throw new Error("pi_sandbox_system_mount_overlaps_home");
    }
  }

  const arguments_: string[] = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    // Bubblewrap requires the user namespace to be explicit when nested user
    // namespaces are disabled and asserted, even though --unshare-all includes it.
    "--unshare-user",
    "--disable-userns",
    "--assert-userns-disabled",
    ...(input.networkMode === "execution_host" ? ["--share-net"] : []),
    "--clearenv",
    "--cap-drop",
    "ALL",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    "--dir",
    "/run/sedes",
    "--dir",
    "/runtime",
    "--dir",
    "/home",
    "--dir",
    "/etc",
    "--bind",
    input.hostHomePath,
    PI_SANDBOX_HOME,
  ];
  arguments_.push(
    input.workspaceAccess === "read_only" ? "--ro-bind" : "--bind",
    input.hostWorkspacePath,
    PI_SANDBOX_WORKSPACE,
  );
  for (const mount of systemMounts) {
    arguments_.push("--ro-bind", mount, mount);
  }
  arguments_.push(
    "--ro-bind",
    input.workerArtifactPath,
    PI_SANDBOX_WORKER_PATH,
    "--ro-bind",
    input.workerNodePath,
    PI_SANDBOX_NODE_PATH,
    ...(input.searchExecutablePaths
      ? [
          "--ro-bind",
          input.searchExecutablePaths.rg,
          "/runtime/rg",
          "--ro-bind",
          input.searchExecutablePaths.fd,
          "/runtime/fd",
        ]
      : []),
    "--setenv",
    "HOME",
    PI_SANDBOX_HOME,
    "--setenv",
    "USER",
    "agent",
    "--setenv",
    "LOGNAME",
    "agent",
    "--setenv",
    "SHELL",
    "/bin/bash",
    "--setenv",
    "PATH",
    "/runtime:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    "--setenv",
    "LANG",
    "C.UTF-8",
    "--setenv",
    "LC_ALL",
    "C.UTF-8",
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "XDG_CONFIG_HOME",
    `${PI_SANDBOX_HOME}/.config`,
    "--setenv",
    "XDG_CACHE_HOME",
    `${PI_SANDBOX_HOME}/.cache`,
    "--setenv",
    "XDG_STATE_HOME",
    `${PI_SANDBOX_HOME}/.local/state`,
    ...(process.env.ELECTRON_RUN_AS_NODE === "1"
      ? ["--setenv", "ELECTRON_RUN_AS_NODE", "1"]
      : []),
    "--chdir",
    PI_SANDBOX_HOME,
    "--",
    PI_SANDBOX_NODE_PATH,
    PI_SANDBOX_WORKER_PATH,
  );
  return Object.freeze(arguments_);
}

function assertCanonicalAbsolute(value: string, code: string): void {
  if (
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    value.includes("\0") ||
    /[\u0001-\u001f\u007f]/u.test(value)
  ) {
    throw new Error(code);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export function defaultPiSandboxSystemMounts(): readonly string[] {
  return DEFAULT_SYSTEM_MOUNTS;
}
