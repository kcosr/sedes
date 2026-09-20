import { outboundServerUrl } from './outbound-connector-url.js';
import { runOutboundConnector } from './outbound-connector.js';

declare const __SEDES_CONNECTOR_VERSION__: string;

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.length === 1 && ['--help', '-h'].includes(arguments_[0]!)) {
    process.stdout.write('Usage: sedes-sidecar connect [--server <http(s)://server>] [--pairing-url <url> | --pairing-code <code>] [--state-directory <absolute-path>] [--retry-registration | --resume-pairing]\nNode.js 22.19.0+ required. macOS startup also requires Xcode Command Line Tools.\n');
    return;
  }
  if (arguments_[0] !== 'connect') throw new Error('outbound_connector_arguments_invalid');
  let serverUrl: string | undefined;
  let pairingUrl: string | undefined;
  let pairingCode: string | undefined;
  let stateDirectory: string | undefined;
  let retryRegistration = false;
  let resumePairing = false;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === '--server' && serverUrl === undefined) serverUrl = arguments_[++index];
    else if (argument === '--pairing-url' && pairingUrl === undefined) pairingUrl = arguments_[++index];
    else if (argument === '--pairing-code' && pairingCode === undefined) pairingCode = arguments_[++index];
    else if (argument === '--state-directory' && stateDirectory === undefined) stateDirectory = arguments_[++index];
    else if (argument === '--retry-registration' && !retryRegistration) retryRegistration = true;
    else if (argument === '--resume-pairing' && !resumePairing) resumePairing = true;
    else throw new Error('outbound_connector_arguments_invalid');
    if (['--server', '--state-directory', '--pairing-url', '--pairing-code'].includes(argument!) && (!arguments_[index] || arguments_[index]!.startsWith('--'))) throw new Error('outbound_connector_arguments_invalid');
  }
  if (pairingUrl) {
    if (pairingCode) throw new Error('outbound_connector_arguments_invalid');
    const url = new URL(pairingUrl);
    pairingCode = new URLSearchParams(url.hash.slice(1)).get('pair') ?? undefined;
    url.hash = '';
    const pairedServer = outboundServerUrl(url.href).href;
    if (!pairingCode || (serverUrl && outboundServerUrl(serverUrl).href !== pairedServer)) throw new Error('outbound_pairing_url_invalid');
    serverUrl = pairedServer;
  }
  if (!serverUrl) throw new Error('outbound_connector_server_required');
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('outbound_connector_stopped'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    await runOutboundConnector({ serverUrl, pairingCode, stateDirectory, retryRegistration, resumePairing,
      connectorVersion: typeof __SEDES_CONNECTOR_VERSION__ === 'string' ? __SEDES_CONNECTOR_VERSION__ : 'development',
      signal: controller.signal, log: message => process.stdout.write(`${message}\n`) });
  } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
}

void main().catch(error => {
  process.stderr.write(`${(error instanceof Error ? error.message : 'outbound_connector_failed').replace(/[^A-Za-z0-9_.:-]/gu, '_').slice(0, 240)}\n`);
  process.exitCode = 1;
});
