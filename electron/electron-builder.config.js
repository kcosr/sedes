const { chmod } = require('node:fs/promises');
const path = require('node:path');

async function restoreManagedRuntimeModes(context) {
  if (context.packager.platform.name === 'windows') return;
  const runtimeRoot = path.join(
    context.packager.getResourcesDir(context.appOutDir),
    'local-server',
    'dist',
  );
  await Promise.all(
    [
      ['sidecar', 'manifest.json', 0o400],
      ['sidecar', 'sedes', 0o500],
      ['pi-sandbox-worker', 'manifest.json', 0o400],
      ['pi-sandbox-worker', 'sedes-pi-sandbox-worker.mjs', 0o500],
      ['claude-runtime-worker', 'manifest.json', 0o400],
      ['claude-runtime-worker', 'sedes-claude-runtime-worker.mjs', 0o500],
    ].map(([directory, filename, mode]) =>
      chmod(path.join(runtimeRoot, directory, filename), mode),
    ),
  );
}

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'dev.sedes.local',
  productName: 'Sedes',
  directories: {
    output: 'dist',
    buildResources: 'assets',
  },
  artifactName: 'sedes-${version}-${os}-${arch}.${ext}',
  afterPack: restoreManagedRuntimeModes,
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Development',
    icon: 'assets/icon.png',
    syncDesktopName: true,
  },
  mac: {
    category: 'public.app-category.developer-tools',
    icon: 'assets/icon.png',
  },
  win: {
    icon: 'assets/icon.png',
  },
  files: [
    'build/**/*',
    'app/**/*',
    'generated/**/*',
    '!generated/local-server{,/**/*}',
    'package.json',
    // Platform runtime + plugins, prepared by `capacitor-electron vendor`.
    { from: 'vendor/node_modules', to: 'node_modules' },
  ],
  extraResources: [
    {
      from: 'generated/local-server',
      to: 'local-server',
      filter: [
        'package.json',
        'package-lock.json',
        'native-modules.json',
        'defaults/server.json',
        'protocol/codex-app-server/*/release.json',
        'dist/**/*',
      ],
    },
    {
      from: 'generated/local-server/node_modules',
      to: 'local-server/node_modules',
      filter: ['**/*', '!.bin{,/**/*}'],
    },
  ],
};
