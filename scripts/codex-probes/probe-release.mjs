import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  probeEnvironment,
  RawCodexAppServerClient,
} from "./raw-app-server-client.mjs";
import {
  assertPinnedCodexRelease,
  codexBinary,
} from "./pinned-codex-release.mjs";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const pinnedRelease = assertPinnedCodexRelease();
const temporaryRoot = await mkdtemp(
  path.join(os.tmpdir(), "sedes-codex-release-probe-"),
);
const codexHome = path.join(temporaryRoot, "codex-home");
await mkdir(codexHome, { recursive: true });
await writeFile(
  path.join(codexHome, "config.toml"),
  "[features]\napps = false\nplugins = false\n",
  { encoding: "utf8", mode: 0o600 },
);
const client = new RawCodexAppServerClient({
  codexBinary,
  cwd: repositoryRoot,
  environment: probeEnvironment(codexHome),
});

try {
  const initialize = await client.start();
  const threads = await client.request("thread/list", {
    limit: 1,
    sourceKinds: [],
  });
  let experimentalRejected = false;
  try {
    await client.request("thread/settings/update", {
      threadId: "00000000-0000-0000-0000-000000000000",
    });
  } catch (error) {
    experimentalRejected =
      error?.rpcError?.code === -32600 &&
      error.rpcError.message ===
        "thread/settings/update requires experimentalApi capability";
  }
  if (!experimentalRejected) {
    throw new Error("experimental_method_was_not_rejected");
  }
  console.log(
    JSON.stringify(
      {
        release: pinnedRelease.release,
        nativeExecutableSha256: pinnedRelease.nativeExecutableSha256,
        initialized: true,
        userAgent: initialize.userAgent,
        platformFamily: initialize.platformFamily,
        platformOs: initialize.platformOs,
        stableThreadList: Array.isArray(threads.data),
        experimentalMethodRejected: true,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
  await rm(temporaryRoot, { recursive: true, force: true });
}
