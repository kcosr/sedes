#!/usr/bin/env node
import { runSedesCli } from "../sedes-cli.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort(new Error("interrupted")));
process.exitCode = await runSedesCli(process.argv.slice(2), {
  signal: controller.signal,
});
