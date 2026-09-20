import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

const MAXIMUM_ARGUMENTS = 4_096;
const MAXIMUM_ARGUMENT_BYTES = 1_048_576;
const READ_BYTES = 1_048_576;

async function main() {
  const configuration = decodeConfiguration(process.argv[2]);
  const retained = await open(
    configuration.sourcePath,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await retained.stat({ bigint: true });
    if (
      !metadata.isFile() ||
      metadata.dev.toString() !== configuration.device ||
      metadata.ino.toString() !== configuration.inode ||
      Number(metadata.size) !== configuration.expectedBytes ||
      Number(metadata.mode & 0o777n) !== 0o500
    ) {
      throw new Error("grok_probe_retained_file_identity_invalid");
    }
    if ((await sha256(retained)) !== configuration.expectedSha256) {
      throw new Error("grok_probe_retained_file_digest_invalid");
    }
    const child = spawn(configuration.executablePath, configuration.arguments, {
      cwd: configuration.workingDirectory,
      detached: false,
      env: configuration.environment,
      shell: false,
      stdio: ["inherit", "inherit", "inherit", retained.fd],
      windowsHide: true,
    });
    const outcome = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (outcome.signal !== null) {
      process.kill(process.pid, outcome.signal);
      return;
    }
    process.exitCode = outcome.code ?? 1;
  } finally {
    await retained.close();
  }
}

function decodeConfiguration(encoded) {
  if (
    typeof encoded !== "string" ||
    Buffer.byteLength(encoded, "utf8") > MAXIMUM_ARGUMENT_BYTES
  ) {
    throw new Error("grok_probe_launcher_configuration_invalid");
  }
  const value = JSON.parse(encoded);
  const keys = [
    "arguments",
    "device",
    "environment",
    "executablePath",
    "expectedBytes",
    "expectedSha256",
    "inode",
    "sourcePath",
    "workingDirectory",
  ];
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== keys.join("\0") ||
    !absolutePath(value.sourcePath) ||
    !absolutePath(value.executablePath) ||
    !absolutePath(value.workingDirectory) ||
    typeof value.device !== "string" ||
    !/^\d+$/u.test(value.device) ||
    typeof value.inode !== "string" ||
    !/^\d+$/u.test(value.inode) ||
    !Number.isSafeInteger(value.expectedBytes) ||
    value.expectedBytes < 1 ||
    typeof value.expectedSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.expectedSha256) ||
    !Array.isArray(value.arguments) ||
    value.arguments.length > MAXIMUM_ARGUMENTS ||
    value.arguments.some(
      (argument) =>
        typeof argument !== "string" || Buffer.byteLength(argument) > 65_536,
    ) ||
    value.environment === null ||
    typeof value.environment !== "object" ||
    Array.isArray(value.environment) ||
    Object.entries(value.environment).some(
      ([key, entry]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) ||
        typeof entry !== "string" ||
        key.includes("=") ||
        key.includes("\0") ||
        entry.includes("\0"),
    )
  ) {
    throw new Error("grok_probe_launcher_configuration_invalid");
  }
  return value;
}

function absolutePath(value) {
  return (
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= 4_096
  );
}

async function sha256(file) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(READ_BYTES);
  let position = 0;
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  return hash.digest("hex");
}

await main().catch(() => {
  process.stderr.write("grok_probe_inherited_launcher_failed\n");
  process.exitCode = 1;
});
