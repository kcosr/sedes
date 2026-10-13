#!/usr/bin/env node
import { runSedesCli } from "./sedes-cli.js";

const controller = new AbortController();
process.once("SIGINT", () => controller.abort(new Error("interrupted")));
const args = process.argv.slice(2);
process.exitCode = args[0] === "auth"
  ? await (await import("./auth-cli.js")).runAuthCli(args.slice(1))
  : args[0] === "repair"
    ? await (await import("./creation-provenance-cli.js")).runCreationProvenanceCli(args.slice(1))
  : args[0] === "config"
    ? await (await import("./config-cli.js")).runConfigCli(args.slice(1))
    : args[0] === "page-preview-browser"
      ? await (await import("./page-preview-browser-cli.js")).runPagePreviewBrowserCli(args.slice(1))
      : await runSedesCli(args, { signal: controller.signal });
