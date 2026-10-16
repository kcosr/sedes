import { installE2EServerProcessLifecycle } from "../e2e/server-process-lifecycle.ts";

setInterval(() => {}, 1_000);
installE2EServerProcessLifecycle(
  {
    once: (event, listener) => process.once(event, listener),
    exit: (code) => process.exit(code),
    writeError: (message) => process.stderr.write(message),
  },
  async () => {
    process.stdout.write("cleanup started\n");
    if (process.argv[2] === "stuck") await new Promise(() => {});
    await new Promise((resolve) => setTimeout(resolve, 25));
    process.stdout.write("cleanup complete\n");
  },
);
process.send({ ready: true });
