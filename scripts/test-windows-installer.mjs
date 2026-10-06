// Native, isolated NSIS fixtures: no product registry, installed files or UI.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') throw new Error('Installer regression fixtures require native Windows.');
const root = fileURLToPath(new URL('../', import.meta.url));
const requireElectron = createRequire(path.join(root, 'electron/package.json'));
const { getMakeNsisPath, getNsisPluginsPath } = requireElectron('app-builder-lib/out/toolsets/windows.js');
const { spawnAndWriteWithOutput } = requireElectron('builder-util');
const compiler = await getMakeNsisPath();
const plugins = await getNsisPluginsPath();
const fixture = await mkdtemp(path.join(os.tmpdir(), 'sedes-nsis-test-'));
const environment = { ...process.env };
delete environment.NODE_ENV;
const temp = path.join(fixture, 'temp with spaces');
await mkdir(temp);
environment.TEMP = temp;
environment.TMP = temp;
// Escape data, never allow fixture paths to become NSIS instructions.
const quote = value => '"' + value.replaceAll('$', '$$').replaceAll('"', '$\\"') + '"';
const hook = quote(path.join(root, 'electron/installer.nsh'));
async function compile(name, body) {
  const exe = path.join(fixture, `${name}.exe`);
  await spawnAndWriteWithOutput(compiler.path, ['-V2', '-'], `
Unicode true
Name "Sedes isolated installer regression"
OutFile ${quote(exe)}
RequestExecutionLevel user
SilentInstall silent
!addplugindir /x86-unicode ${quote(path.join(plugins, 'x86-unicode'))}
!include ${hook}
!define APP_ID "dev.sedes.installer-regression"
!define APP_DESCRIPTION "Sedes isolated shortcut regression"
Var appExe
Var keepShortcuts
Var newStartMenuLink
Var newDesktopLink
Var launchLink
Var noDesktopShortcut
!define isNoDesktopShortcut '$noDesktopShortcut == "true"'
${body}
`, { cwd: fixture, env: { ...environment, ...compiler.env } });
  return exe;
}
function run(exe, env = environment) {
  const result = spawnSync(exe, [], { env, cwd: fixture, windowsHide: true, timeout: 30000 });
  if (result.error) throw result.error;
  assert.equal(result.signal, null);
  return result.status;
}

try {
  // Model the pinned builder's atomicRMDir primitive with its real NSIS engine.
  // The unprefixed destination is exactly 260 characters, including a .d.ts
  // filename as in the old Pi/AWS tree. A locked source must still fail closed.
  const child = async (name, { locked = false } = {}) => compile(name, `
Function .onInit
  InitPluginsDir
FunctionEnd
Section
  StrCpy $1 "$PLUGINSDIR\\old-install\\"
  StrLen $2 $1
  StrCpy $3 $1 4
  StrCmp $3 "\\\\?\\" 0 +2
    IntOp $2 $2 - 4
  # filename is 41 chars; leave its parent below the legacy directory limit.
  IntOp $2 260 - $2
  IntOp $2 $2 - 42
  loop:
    StrCpy $1 "$1a"
    IntOp $2 $2 - 1
    IntCmp $2 0 done done loop
  done:
  CreateDirectory "$1"
  FileOpen $0 "$EXEDIR\\source.txt" w
  FileWrite $0 "keep this exact fixture content"
  FileClose $0
  ${locked ? "System::Call 'kernel32::CreateFile(t \"$EXEDIR\\source.txt\", i 0x80000000, i 0, p 0, i 3, i 0, p 0) p.r4'" : ''}
  ClearErrors
  Rename "$EXEDIR\\source.txt" "$1\\recursionDetectionMiddleware.browser.d.ts"
  IfErrors failed
  # Model rollback as well: restore the file through the extended source path.
  Rename "$1\\recursionDetectionMiddleware.browser.d.ts" "$EXEDIR\\source.txt"
  IfErrors failed
  SetErrorLevel 0
  Goto finish
  failed:
    SetErrorLevel 2
  finish:
    ${locked ? "System::Call 'kernel32::CloseHandle(p r4)'" : ''}
SectionEnd
`);
  const legacy = await child('legacy');
  const locked = await child('locked', { locked: true });
  assert.equal(run(legacy), 2, 'baseline must reproduce the old rename failure');
  const source = () => readFile(path.join(fixture, 'source.txt'), 'utf8');
  assert.equal(await source(), 'keep this exact fixture content');

  const parent = await compile('upgrade', `
Function .onInit
  InitPluginsDir
  !insertmacro customInit
FunctionEnd
Section
  ExecWait ${quote('"' + legacy + '"')} $0
  StrCmp $0 0 +2
    Abort "Old uninstaller still failed"
  ExecWait ${quote('"' + locked + '"')} $0
  StrCmp $0 2 +2
    Abort "A locked file was not rejected"
  !insertmacro customInstall
  ReadEnvStr $0 TEMP
  ReadEnvStr $1 TMP
  StrCmp $0 $sedesOriginalTemp +2
    Abort "TEMP was not restored"
  StrCmp $1 $sedesOriginalTmp +2
    Abort "TMP was not restored"
  # Conversion is idempotent, handles UNC, and supports in-place use.
  !insertmacro sedesExtendedPath "C:\\temp with spaces" $0
  StrCmp $0 "\\\\?\\C:\\temp with spaces" +2
    Abort "DOS path conversion failed"
  !insertmacro sedesExtendedPath $0 $0
  StrCmp $0 "\\\\?\\C:\\temp with spaces" +2
    Abort "Idempotent conversion failed"
  !insertmacro sedesExtendedPath "\\\\server\\share\\temp" $0
  StrCmp $0 "\\\\?\\UNC\\server\\share\\temp" +2
    Abort "UNC conversion failed"
  FileOpen $0 "$EXEDIR\\passed.txt" w
  FileWrite $0 "passed"
  FileClose $0
SectionEnd
`);
  for (const variant of ['normal', 'extended', 'missing-tmp']) {
    const env = { ...environment };
    if (variant === 'extended') env.TEMP = env.TMP = `\\\\?\\${temp}`;
    if (variant === 'missing-tmp') delete env.TMP;
    await rm(path.join(fixture, 'passed.txt'), { force: true });
    assert.equal(run(parent, env), 0, `upgrade fixture: ${variant}`);
    assert.equal(await readFile(path.join(fixture, 'passed.txt'), 'utf8'), 'passed');
    assert.equal(await source(), 'keep this exact fixture content');
  }

  const launchProbe = await compile('launch-probe', `
Section
  FileOpen $0 "$EXEDIR\\launched.txt" w
  FileWrite $0 "launched"
  FileClose $0
SectionEnd
`);
  const startLink = path.join(fixture, 'Start Menu.lnk');
  const desktopLink = path.join(fixture, 'Desktop.lnk');
  const repair = await compile('repair-shortcuts', `
Function .onInit
  InitPluginsDir
  !insertmacro customInit
FunctionEnd
Section
  StrCpy $appExe ${quote(launchProbe)}
  StrCpy $newStartMenuLink ${quote(startLink)}
  StrCpy $newDesktopLink ${quote(desktopLink)}
  StrCpy $keepShortcuts "true"
  ReadEnvStr $noDesktopShortcut SEDES_FIXTURE_NO_DESKTOP
  SetOutPath "$EXEDIR"
  !insertmacro customInstall
  StrCmp $launchLink $appExe +2
    Abort "Post-install launch still depends on the shortcut"
SectionEnd
`);
  // Corrupt retained links must be replaced, not trusted merely because present.
  for (const link of [startLink, desktopLink]) await writeFile(link, 'stale shell link');
  assert.equal(run(repair), 0);
  for (const link of [startLink, desktopLink]) {
    const check = spawnSync(path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), [
      '-NoProfile', '-NonInteractive', '-Command', `
        $ErrorActionPreference='Stop'
        $link=(New-Object -ComObject WScript.Shell).CreateShortcut($env:SEDES_FIXTURE_LINK)
        if ($link.TargetPath -ne $env:SEDES_FIXTURE_TARGET) { throw 'Incorrect shortcut target' }
        if ($link.WorkingDirectory -ne $env:SEDES_FIXTURE_ROOT) { throw 'Incorrect shortcut working directory' }
        if ($link.Arguments -ne '') { throw 'Unexpected shortcut arguments' }
        $folder=(New-Object -ComObject Shell.Application).NameSpace($env:SEDES_FIXTURE_ROOT)
        $item=$folder.ParseName([IO.Path]::GetFileName($env:SEDES_FIXTURE_LINK))
        if ($item.ExtendedProperty('System.AppUserModel.ID') -ne 'dev.sedes.installer-regression') { throw 'Missing shortcut app ID' }
        Start-Process -FilePath $env:SEDES_FIXTURE_LINK -Wait
      `,
    ], { env: { ...environment, SEDES_FIXTURE_LINK: link, SEDES_FIXTURE_TARGET: launchProbe, SEDES_FIXTURE_ROOT: fixture }, windowsHide: true, timeout: 30000, encoding: 'utf8' });
    if (check.error) throw check.error;
    assert.equal(check.status, 0, check.stderr);
    assert.equal(await readFile(path.join(fixture, 'launched.txt'), 'utf8'), 'launched');
    await rm(path.join(fixture, 'launched.txt'));
  }
  // Deleted shortcuts stay deleted; explicit no-desktop leaves that link alone.
  await rm(startLink);
  await writeFile(desktopLink, 'operator-retained desktop link');
  assert.equal(run(repair, { ...environment, SEDES_FIXTURE_NO_DESKTOP: 'true' }), 0);
  await assert.rejects(access(startLink), { code: 'ENOENT' });
  assert.equal(await readFile(desktopLink, 'utf8'), 'operator-retained desktop link');
  await rm(desktopLink);
  assert.equal(run(repair), 0);
  for (const link of [startLink, desktopLink]) await assert.rejects(access(link), { code: 'ENOENT' });
  console.log('Windows installer regressions passed: long-path upgrade/rollback, locked-file refusal, environment restoration, path conversion, retained shortcut repair/launch/app ID, deleted/disabled shortcut preservation, direct post-install launch.');
} finally {
  // The only recursive cleanup is the unique disposable directory created above.
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
  assert.ok(path.basename(fixture).startsWith('sedes-nsis-test-'));
  await rm(fixture, { recursive: true, force: true });
}
