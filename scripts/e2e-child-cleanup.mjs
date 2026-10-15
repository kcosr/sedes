export function requestE2EChildShutdown(
  child,
  signal = "SIGTERM",
  { server = false, platform = process.platform } = {},
) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  try {
    // Windows SIGTERM forcibly terminates Node without running its handlers.
    // Disconnect a forked server's IPC channel so its existing lifecycle can
    // close application resources. Repeated requests must leave that close
    // path running until the caller's bounded forced-shutdown deadline.
    if (platform === "win32" && server && signal !== "SIGKILL") {
      if (child.connected) child.disconnect();
      return;
    }
    if (platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH" && error?.code !== "ERR_IPC_DISCONNECTED") throw error;
  }
}

async function waitForExit(childExit, milliseconds) {
  let timer;
  try {
    return await Promise.race([
      childExit,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function stopE2EChild(
  child,
  childExit,
  {
    signal = "SIGTERM",
    server = false,
    platform = process.platform,
    gracefulMilliseconds = 20_000,
    forcedMilliseconds = 2_000,
  } = {},
) {
  if (!child) return;
  const options = { server, platform };
  requestE2EChildShutdown(child, signal, options);
  let result = await waitForExit(childExit, gracefulMilliseconds);
  if (!result) {
    requestE2EChildShutdown(child, "SIGKILL", options);
    result = await waitForExit(childExit, forcedMilliseconds);
    if (!result) throw new Error("e2e_child_shutdown_deadline_exceeded");
  }
  return result;
}
