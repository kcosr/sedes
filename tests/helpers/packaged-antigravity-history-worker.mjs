import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writePackagedAntigravityHistoryWorker(root) {
  const directory = path.join(root, 'dist/antigravity-history-worker');
  const filename = 'sedes-antigravity-history-worker.mjs';
  const source = '// Isolated package verification fixture.\n';
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, filename), source);
  await writeFile(path.join(directory, 'manifest.json'), JSON.stringify({
    schemaVersion: 1, artifactId: 'openai.sedes.antigravity-history-worker', filename,
    bytes: Buffer.byteLength(source), sha256: createHash('sha256').update(source).digest('hex'),
  }));
}
