import { writeFile } from "node:fs/promises";
import path from "node:path";
import { LocalEnvironmentChannelProvider } from "../../../src/server/execution/local-environment-channel.js";
import {
  DEFAULT_OWNED_NDJSON_STDIO_LIMITS,
  OwnedNdjsonStdioTransport,
} from "../../../src/server/provider-protocol/transport/owned-ndjson-stdio-transport.js";

const markerPath = process.argv[2];
if (!markerPath || !path.isAbsolute(markerPath)) {
  throw new Error("owned_ndjson_cleanup_marker_invalid");
}

const scope = Object.freeze({
  tenantId: "tenant-owned-cleanup-fixture",
  principalId: "principal-owned-cleanup-fixture",
  backendInstanceId: "backend-owned-cleanup-fixture",
  executionEnvironmentId: "environment-owned-cleanup-fixture",
});
const provider = new LocalEnvironmentChannelProvider({
  scope,
  executionEnvironmentId: scope.executionEnvironmentId,
  environment: {},
});
const prepared = await provider.prepareOwnedProcess(scope, {
  executablePath: process.execPath,
  workingDirectory: path.dirname(markerPath),
});
const descendantReadyPath = path.join(
  path.dirname(markerPath),
  "descendant-ready",
);
const channel = await provider.openOwnedProcess(
  scope,
  {
    prepared,
    arguments: [
      "-e",
      `const fs = require('node:fs');
       const child = require('node:child_process').spawn(process.execPath, [
         '-e', "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], 'ready'); setInterval(() => {}, 1000)",
         process.argv[1],
       ], { stdio: 'ignore' });
       child.unref();
       const timer = setInterval(() => {
         if (fs.existsSync(process.argv[1])) process.exit(0);
       }, 10);`,
      descendantReadyPath,
    ],
    environment: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
    cleanup: {
      gracefulCloseMilliseconds: 50,
      terminateMilliseconds: 100,
      killMilliseconds: 500,
    },
  },
  new AbortController().signal,
);
const transport = new OwnedNdjsonStdioTransport({
  scope,
  connectionGeneration: 1,
  channel,
  limits: DEFAULT_OWNED_NDJSON_STDIO_LIMITS,
  sensitiveValues: [],
  assuranceDiagnosticPrefix: "owned_cleanup_fixture_assurance",
  transportDiagnosticPrefix: "owned_cleanup_fixture_transport",
});

await transport.closed;
const diagnostics = transport.diagnostics();
if (!diagnostics.streamsDrained) {
  throw new Error("owned_ndjson_cleanup_streams_not_drained");
}
await writeFile(markerPath, "cleanup-settled\n", { mode: 0o600 });
provider.close();
