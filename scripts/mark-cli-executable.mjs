import { chmod, copyFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const providerBinDirectory = new URL("../dist/cli/provider-bin/", import.meta.url);
await mkdir(providerBinDirectory, { recursive: true });
await copyFile(
  new URL("sedes.js", providerBinDirectory),
  new URL("sedes", providerBinDirectory),
);

const executables = [
  "../dist/cli/sedes-cli-main.js",
  "../dist/cli/automation-cli.js",
  "../dist/cli/provider-bin/sedes",
].map((relative) => fileURLToPath(new URL(relative, import.meta.url)));

await Promise.all(executables.map((executable) => chmod(executable, 0o755)));
