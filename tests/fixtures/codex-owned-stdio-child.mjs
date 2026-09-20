import { spawn } from "node:child_process";

const mode = process.env.CODEX_STDIO_FIXTURE_MODE ?? "echo";

if (mode === "split") {
  process.stdout.write('{"sequence":1}\n{"sequence":');
  setTimeout(() => process.stdout.write("2}\n"), 10);
} else if (mode === "invalid_utf8") {
  process.stdout.write(Buffer.from([0xff, 0x0a]));
} else if (mode === "stderr") {
  process.stderr.write(
    `authorization=${process.env.CODEX_STDIO_FIXTURE_SECRET} ` +
      `Bearer ${process.env.CODEX_STDIO_FIXTURE_BEARER} ` +
      `${process.env.CODEX_HOME}\n`,
  );
} else if (mode === "stderr_split") {
  const chunks = [
    "authorization=sec",
    "ret-one Bear",
    "er secret-two /private/",
    "codex-home\n",
  ];
  const writeNext = () => {
    const chunk = chunks.shift();
    if (chunk === undefined) return;
    process.stderr.write(chunk);
    setTimeout(writeNext, 5);
  };
  writeNext();
} else if (mode === "descendant") {
  const descendant = spawn(
    process.execPath,
    ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    { stdio: "ignore" },
  );
  process.stdout.write(
    `${JSON.stringify({ descendantPid: descendant.pid })}\n`,
  );
  process.on("SIGTERM", () => {});
}

if (mode === "blocked_stdin") {
  process.stdin.pause();
} else {
  let buffered = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffered += chunk;
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (mode === "echo") process.stdout.write(`${line}\n`);
    }
  });
}

if (mode !== "descendant") {
  process.stdin.once("end", () => process.exit(0));
}

setInterval(() => {}, 1_000);
