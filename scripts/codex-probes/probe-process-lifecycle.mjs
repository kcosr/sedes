import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";

/** Read-only observation of an exact PID reported by an isolated probe child. */
export async function isProbeProcessStopped(processId) {
  if (!Number.isSafeInteger(processId) || processId <= 0) {
    throw new Error("codex_probe_process_id_invalid");
  }
  try {
    process.kill(processId, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return true;
    throw error;
  }
  if (process.platform !== "linux") return false;

  let source;
  try {
    source = await readFile(`/proc/${processId}/stat`, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw error;
  }
  // A command name can contain spaces and ')'. The state follows the final
  // closing parenthesis. A zombie has terminated even before its parent reaps it.
  const commandStart = source.indexOf("(");
  const commandEnd = source.lastIndexOf(")");
  const state = source.slice(commandEnd + 2).split(/\s+/u)[0];
  if (
    commandStart < 0 || commandEnd <= commandStart ||
    Number(source.slice(0, commandStart).trim()) !== processId ||
    source[commandEnd + 1] !== " " ||
    !/^[RSDZTtXxKWPI]$/u.test(state ?? "")
  ) {
    throw new Error("codex_probe_process_state_unknown");
  }
  return state === "Z" || state === "X" || state === "x";
}

export async function waitForProbeProcessStopped(processId, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await isProbeProcessStopped(processId)) return;
    if (Date.now() >= deadline) {
      throw new Error("d2a_stale_mcp_process_remained_open");
    }
    await delay(25);
  }
}
