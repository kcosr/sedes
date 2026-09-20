import { build } from 'esbuild';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--output-directory' || !path.isAbsolute(args[1]))) throw new Error('outbound_connector_build_arguments_invalid');
const directory = args[1] ?? path.join(root, 'dist', 'connector');
const metadata = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
await mkdir(directory, { recursive: true });
await build({
  entryPoints: [path.join(root, 'src/server/sidecar/outbound-connector-main.ts')],
  outfile: path.join(directory, 'sedes-sidecar.mjs'),
  bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'bundle',
  banner: { js: "import { createRequire as connectorCreateRequire } from 'node:module'; const require = connectorCreateRequire(import.meta.url);" },
  define: { __SEDES_CONNECTOR_VERSION__: JSON.stringify(metadata.version), 'process.env.WS_NO_BUFFER_UTIL': '"true"', 'process.env.WS_NO_UTF_8_VALIDATE': '"true"' },
  sourcemap: false, legalComments: 'none',
});
await writeFile(path.join(directory, 'sedes-sidecar'), '#!/bin/sh\nexec node "$(dirname "$0")/sedes-sidecar.mjs" "$@"\n', { mode: 0o755 });
await chmod(path.join(directory, 'sedes-sidecar'), 0o755);
await writeFile(path.join(directory, 'sedes-sidecar.cmd'), '@echo off\r\nnode "%~dp0sedes-sidecar.mjs" %*\r\n');
await writeFile(path.join(directory, 'README.txt'), `Sedes outbound connector ${metadata.version}\n\nRequires Node.js 22.19.0 or newer. Keep all three launcher/bundle files together.\nRun: sedes-sidecar connect --server http://your-server:4784\nHTTPS automatically uses WSS; HTTP automatically uses WS.\nOn Windows use sedes-sidecar.cmd or node sedes-sidecar.mjs.\n\nApprove the pending host in Settings / Environments before adding a backend.\nRun as the account whose provider tools and workspace should be available.\nProvider installations and their authentication remain separately managed.\nBefore starting the connector on macOS, install Xcode Command Line Tools; the\nprocess ownership helper needs its C compiler during initial startup.\n\nThe connector stores identity under ~/.local/state/sedes/connector. Preserve this\ndirectory during manual connector upgrades. A different --state-directory creates\na separate connector identity. --retry-registration explicitly retries a denied\nor expired unpaired registration. It never replaces an accepted pairing.\nAfter server-side Reapprove, restart with --resume-pairing to resume the exact\nretained revoked pairing. This preserves connector and environment identity.\n\nStopping the connector detaches the network connection. Runtime processes remain\nowned by the persistent sidecar. Use Sedes runtime controls to stop that work.\nIf installing a service, isolate connector and runtime supervision: a default\nsystemd service stop can kill its entire control group despite process detachment.\nConnector updates are manual. Runtime artifacts are downloaded from this server\nand verified before replacement; active or uncertain work blocks automatic updates.\n`);
await writeFile(path.join(directory, 'LICENSE'), await readFile(path.join(root, 'LICENSE')));
