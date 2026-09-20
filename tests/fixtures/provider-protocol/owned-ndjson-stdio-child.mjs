#!/usr/bin/env node

const mode = process.env.PROVIDER_STDIO_FIXTURE_MODE;
if (mode === "partial") {
  process.stdout.write("partial-without-newline");
} else if (mode === "frame") {
  process.stdout.write('{"sequence":1}\n');
}

process.stdin.resume();
process.stdin.once("end", () => process.exit(0));
setInterval(() => {}, 1_000);
