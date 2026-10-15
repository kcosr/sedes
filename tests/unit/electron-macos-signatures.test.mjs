import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { verifyMacSignatures } from '../../scripts/electron-macos-signatures.mjs';

const temporary = [];
const appId = 'dev.sedes.signature-test';
afterEach(async () => {
  for (const directory of temporary.splice(0)) await rm(directory, { recursive: true, force: true });
});

async function bundle(directory, id) {
  await mkdir(path.join(directory, 'Contents/MacOS'), { recursive: true });
  await copyFile('/usr/bin/true', path.join(directory, 'Contents/MacOS/Sedes'));
  await writeFile(path.join(directory, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${id}</string>
<key>CFBundleExecutable</key><string>Sedes</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`);
}

function sign(directory, id) {
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--identifier', id, directory], { stdio: 'pipe' });
}

async function fixture(appSignature = appId, helperSignature = `${appId}.helper`) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'sedes-signature-test-'));
  temporary.push(root);
  const app = path.join(root, 'Sedes.app');
  const helper = path.join(app, 'Contents/Frameworks/Sedes Helper.app');
  await bundle(app, appId);
  await bundle(helper, `${appId}.helper`);
  sign(helper, helperSignature);
  sign(app, appSignature);
  return app;
}

// Exercise real bundle signatures without accessing the Keychain or launching code.
describe.skipIf(process.platform !== 'darwin')('macOS packaged signature identity', () => {
  it('accepts ad hoc signatures matching the app and helper bundle identities', async () => {
    await expect(verifyMacSignatures(await fixture(), appId)).resolves.toBeUndefined();
  });
  it('rejects an otherwise valid app still signed as Electron', async () => {
    await expect(verifyMacSignatures(await fixture('Electron'), appId))
      .rejects.toThrow('electron_mac_signature_identity_invalid:Sedes.app');
  });
  it('rejects a helper still signed as Electron even when the app identity is correct', async () => {
    await expect(verifyMacSignatures(await fixture(appId, 'Electron Helper'), appId))
      .rejects.toThrow('electron_mac_signature_identity_invalid:Sedes Helper.app');
  });
  it('rejects a property list changed after signing', async () => {
    const app = await fixture();
    await writeFile(path.join(app, 'Contents/Info.plist'), 'tampered');
    await expect(verifyMacSignatures(app, appId)).rejects.toThrow();
  });
});
