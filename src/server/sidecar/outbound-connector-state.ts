import { randomUUID } from 'node:crypto';
import { open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { sidecarServiceScopeSchema } from '../../internal/sidecar-protocol/service-management-v1.js';
import { acquireStartupLock } from './persistent-sidecar-bootstrap.js';
import { assertConnectorFile, ensureConnectorDirectory, sealConnectorFile, syncConnectorDirectory } from './outbound-connector-filesystem.js';

const stateSchema = z.strictObject({
  version: z.literal(1),
  connectorId: z.uuid(),
  registrationAttemptId: z.uuid(),
  serverUrl: z.url(),
  credential: z.string().min(32).max(1024).optional(),
  terminalDecision: z.enum(['denied', 'revoked', 'expired']).optional(),
  binding: z.strictObject({ pairingId: z.uuid(), scope: sidecarServiceScopeSchema }).optional(),
});
export type OutboundConnectorState = z.infer<typeof stateSchema>;

/** Lock lifetime covers every read/write and the connector's network session. */
export async function openOutboundConnectorState(directory: string, serverUrl: string): Promise<{
  state: OutboundConnectorState;
  save(value: OutboundConnectorState): Promise<void>;
  close(): Promise<void>;
}> {
  if (!path.isAbsolute(directory) || path.resolve(directory) !== directory) throw new Error('outbound_state_path_invalid');
  await ensureConnectorDirectory(directory);
  // System aliases such as macOS /tmp are resolved once; the state directory
  // itself was checked above and may never be a symlink.
  directory = await realpath(directory);
  const release = await acquireStartupLock(path.join(directory, 'connector.lock'));
  const filename = path.join(directory, 'identity.json');
  const save = async (value: OutboundConnectorState) => {
    const bytes = JSON.stringify(stateSchema.parse(value));
    const temporary = path.join(directory, `${randomUUID()}.tmp`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    try {
      await sealConnectorFile(temporary);
      await rename(temporary, filename);
      await syncConnectorDirectory(directory);
    } finally { await unlink(temporary).catch(() => undefined); }
  };
  try {
    let state: OutboundConnectorState;
    try {
      await assertConnectorFile(filename, 16 * 1024);
      state = stateSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'ENOENT') throw error;
      state = { version: 1, connectorId: randomUUID(), registrationAttemptId: randomUUID(), serverUrl };
      await save(state);
    }
    return { state, save, close: release };
  } catch (error) { await release(); throw error; }
}
