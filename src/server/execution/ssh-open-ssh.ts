import { spawn, type ChildProcess } from "node:child_process";

export type SshEnvironmentFailureKind =
  "unavailable" | "timeout" | "identity_invalid";

export class SshEnvironmentError extends Error {
  readonly kind: SshEnvironmentFailureKind;
  readonly diagnosticCode: string;

  constructor(kind: SshEnvironmentFailureKind, diagnosticCode: string) {
    super(diagnosticCode);
    this.name = "SshEnvironmentError";
    this.kind = kind;
    this.diagnosticCode = diagnosticCode;
  }
}

export type SshProcessSpawner = (
  executable: string,
  arguments_: readonly string[],
) => ChildProcess;

export const defaultSshProcessSpawner: SshProcessSpawner = (
  executable,
  arguments_,
) =>
  spawn(executable, [...arguments_], {
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

export const OPEN_SSH_BASE_ARGUMENTS = Object.freeze([
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "NumberOfPasswordPrompts=0",
  "-o",
  "ForwardAgent=no",
  "-o",
  "ForwardX11=no",
  "-o",
  "PermitLocalCommand=no",
  "-o",
  "ControlMaster=no",
  "-o",
  "ControlPath=none",
  "-o",
  "ConnectTimeout=10",
  "-o",
  "ServerAliveInterval=10",
  "-o",
  "ServerAliveCountMax=2",
  "-o",
  "RequestTTY=no",
  "-o",
  "RemoteCommand=none",
]);

export async function terminateExactSshChild(
  child: ChildProcess,
  stopTimeoutMilliseconds: number,
): Promise<void> {
  if (
    !Number.isSafeInteger(stopTimeoutMilliseconds) ||
    stopTimeoutMilliseconds <= 0
  ) {
    throw new Error("ssh_stop_timeout_invalid");
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<true>((resolve) =>
    child.once("exit", () => resolve(true)),
  );
  child.kill("SIGTERM");
  const terminated = await Promise.race([
    exited,
    new Promise<false>((resolve) =>
      setTimeout(() => resolve(false), stopTimeoutMilliseconds),
    ),
  ]);
  if (!terminated && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    const killed = await Promise.race([
      exited,
      new Promise<false>((resolve) =>
        setTimeout(() => resolve(false), stopTimeoutMilliseconds),
      ),
    ]);
    if (!killed && child.exitCode === null && child.signalCode === null) {
      throw new SshEnvironmentError(
        "unavailable",
        "ssh_child_survived_cleanup",
      );
    }
  }
}

export function safeSshHostAlias(host: string): boolean {
  return (
    host.length > 0 &&
    host.length <= 255 &&
    /^[A-Za-z0-9_.-]+$/.test(host) &&
    !host.startsWith("-")
  );
}
