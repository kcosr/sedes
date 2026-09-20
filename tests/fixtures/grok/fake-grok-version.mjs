#!/usr/bin/env node

if (
  process.argv.length !== 4 ||
  process.argv[2] !== "version" ||
  process.argv[3] !== "--json"
) {
  process.stderr.write("unexpected arguments\n");
  process.exitCode = 2;
} else if (
  process.env.XAI_API_KEY !== undefined ||
  process.env.SEDES_ADMIN_TOKEN !== undefined ||
  process.env.GROK_PLUGIN_PATH !== undefined
) {
  process.stderr.write("ambient authority leaked\n");
  process.exitCode = 3;
} else {
  process.stdout.write(
    `${JSON.stringify({ currentVersion: "1.0.4 (d846eb93d9)", channel: "test" })}\n`,
  );
}
