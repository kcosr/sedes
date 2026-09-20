import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface WindowsSidecarRunner {
  (executable: string, args: string[], options: {
    env: NodeJS.ProcessEnv; windowsHide: boolean; timeout: number; maxBuffer: number;
  }): Promise<{ stdout: string }>;
}

/** Dependencies and scripts remain inside the factory for the SSH management carrier. */
export function createWindowsSidecarPlatform(
  run: WindowsSidecarRunner,
  systemRoot = process.env.SystemRoot,
) {
  const nativePath = (filename: string) => {
    const value = filename.replace(/\//gu, "\\");
    if (value.startsWith("\\\\?\\")) return value;
    return value.startsWith("\\\\") ? `\\\\?\\UNC\\${value.slice(2)}` : `\\\\?\\${value}`;
  };
  const execute = async (script: string, environment: Record<string, string> = {}) => {
    if (!systemRoot || !/^[A-Za-z]:[\\/]/u.test(systemRoot) || systemRoot.includes("\0")) {
      throw new Error("sidecar_windows_platform_unavailable");
    }
    const { stdout } = await run(`${systemRoot.replace(/[\\/]+$/u, "")}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { env: { ...process.env, ...environment }, windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 });
    return JSON.parse(stdout.trim()) as unknown;
  };
  // CreationDate uses CIM's microsecond representation. Process.StartTime reads
  // the kernel FILETIME, retaining all 100ns ticks for PID-reuse comparison.
  // The kernel boot GUID, unlike wall-clock LastBootUpTime, identifies the
  // boot lifetime without interpreting clock corrections as reboot evidence.
  // Errors querying an existing process must never become evidence of death.
  const identityScript = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SedesBootIdentity {
  [StructLayout(LayoutKind.Explicit, Size=32)] struct BOOT_ENVIRONMENT {
    [FieldOffset(0)] public Guid BootIdentifier;
    [FieldOffset(16)] public int FirmwareType;
    [FieldOffset(24)] public ulong BootFlags;
  }
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int informationClass, out BOOT_ENVIRONMENT information, uint length, out uint returnedLength);
  public static string Read() {
    BOOT_ENVIRONMENT boot;
    uint returned;
    int status = NtQuerySystemInformation(90, out boot, 32, out returned);
    if (status != 0 || returned != 32 || boot.BootIdentifier == Guid.Empty) throw new InvalidOperationException("sidecar_windows_boot_unavailable");
    return boot.BootIdentifier.ToString("D");
  }
}
'@
$bootIdentifier = [SedesBootIdentity]::Read()
$target = [int]$env:SEDES_SIDECAR_PROCESS_ID
$start = $null
if ($target -gt 0) {
  $candidate = Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = ' + $target) -Property ProcessId, CreationDate
  if ($candidate) {
    if (!$candidate.CreationDate) { throw 'sidecar_windows_process_identity_unavailable' }
    $native = [Diagnostics.Process]::GetProcessById($target)
    try {
      $started = $native.StartTime.ToUniversalTime()
      $observed = $candidate.CreationDate.ToUniversalTime()
      if ([Math]::Abs($started.Ticks - $observed.Ticks) -ge 10) { throw 'sidecar_windows_process_identity_changed' }
      $start = $started.Ticks.ToString([Globalization.CultureInfo]::InvariantCulture)
    } finally { $native.Dispose() }
  }
}
if ([SedesBootIdentity]::Read() -ne $bootIdentifier) { throw 'sidecar_windows_boot_changed' }
@{ bootId = ('windows-' + $bootIdentifier); startTicks = $start; pid = $target } | ConvertTo-Json -Compress
`;
  const readIdentity = async (pid: number) => {
    const raw = await execute(identityScript, { SEDES_SIDECAR_PROCESS_ID: String(pid) });
    if (!raw || typeof raw !== "object") throw new Error("sidecar_service_target_identity_unavailable");
    const value = raw as Record<string, unknown>;
    const ticks = (value: unknown): value is string => typeof value === "string" && /^[1-9][0-9]{16,18}$/u.test(value);
    if (Object.keys(value).sort().join(",") !== "bootId,pid,startTicks" || value.pid !== pid || typeof value.bootId !== "string" || !/^windows-(?!00000000-0000-0000-0000-000000000000$)[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value.bootId) ||
      (value.startTicks !== null && !ticks(value.startTicks)) || (pid === 0 && value.startTicks !== null)) {
      throw new Error("sidecar_service_target_identity_unavailable");
    }
    return { bootId: value.bootId, startTicks: value.startTicks as string | null };
  };
  const readProcess = async (pid: number) => {
    if (!Number.isSafeInteger(pid) || pid < 1 || pid > 0xffff_ffff) throw new Error("sidecar_service_target_identity_unavailable");
    const identity = await readIdentity(pid);
    return identity.startTicks === null ? undefined : {
      pid, startTime: identity.startTicks, bootId: identity.bootId, pidNamespace: "windows",
    };
  };
  const readTargetLifetime = async () => {
    const identity = await readIdentity(0);
    return { bootId: identity.bootId, pidNamespace: "windows", namespaceInitStartTime: "0",
      boottimeOffset: { seconds: "0", nanoseconds: 0 } };
  };
  const privacyProgram = String.raw`
function Read-SedesPrivacy([string]$p, [string]$operation) {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($operation -ne 'ensure-directory' -and !(Test-Path -LiteralPath $p)) { return @{ missing = $true } }
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
function New-PrivateAcl([bool]$directory) {
  if ($directory) {
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
  } else {
    $acl = New-Object Security.AccessControl.FileSecurity
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')
  }
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $acl.AddAccessRule($rule)
  return $acl
}
function Get-SafeItem([string]$candidate) {
  $item = Get-Item -LiteralPath $candidate -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'sidecar_windows_reparse_point' }
  return $item
}
function Assert-Owner($item) {
  if ($item.GetAccessControl().GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'sidecar_windows_wrong_owner' }
}
function Ensure-Directory([string]$candidate) {
  if (!(Test-Path -LiteralPath $candidate)) {
    $parent = [IO.Path]::GetDirectoryName($candidate)
    if (!$parent -or $parent -eq $candidate) { throw 'sidecar_windows_parent_invalid' }
    if (!(Test-Path -LiteralPath $parent)) { Ensure-Directory $parent }
    $null = Get-SafeItem $parent
    $null = [IO.Directory]::CreateDirectory($candidate, (New-PrivateAcl $true))
  }
  $item = Get-SafeItem $candidate
  if (!$item.PSIsContainer) { throw 'sidecar_windows_not_directory' }
  Assert-Owner $item
  $item.SetAccessControl((New-PrivateAcl $true))
}
$ancestor = [IO.Path]::GetDirectoryName($p)
while ($ancestor) {
  if (Test-Path -LiteralPath $ancestor) { $null = Get-SafeItem $ancestor }
  $next = [IO.Path]::GetDirectoryName($ancestor)
  if ($next -eq $ancestor) { break }
  $ancestor = $next
}
if ($operation -eq 'ensure-directory') { Ensure-Directory $p }
$item = Get-SafeItem $p
if ($operation -eq 'secure-file' -or $operation -eq 'secure-executable') {
  if ($item.PSIsContainer) { throw 'sidecar_windows_not_file' }
  Assert-Owner $item
  if ($operation -eq 'secure-executable') {
    $sealed = New-Object Security.AccessControl.FileSecurity
    $sealed.SetOwner($sid)
    $sealed.SetAccessRuleProtection($true, $false)
    $rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'ReadAndExecute, Delete, WriteAttributes, Synchronize', 'Allow')
    $sealed.AddAccessRule($rule)
    $item.SetAccessControl($sealed)
    $item.Attributes = $item.Attributes -bor [IO.FileAttributes]::ReadOnly
    $item.Refresh()
  } else { $item.SetAccessControl((New-PrivateAcl $false)) }
}
$acl = $item.GetAccessControl()
@{
  sid = $sid.Value
  owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  directory = [bool]$item.PSIsContainer
  protected = $acl.AreAccessRulesProtected
  readOnly = (($item.Attributes -band [IO.FileAttributes]::ReadOnly) -ne 0)
  rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
    @{ sid = $_.IdentityReference.Value; allow = ($_.AccessControlType -eq 'Allow'); rights = [int]$_.FileSystemRights; inheritance = [int]$_.InheritanceFlags; propagation = [int]$_.PropagationFlags }
  })
}
}
`;
  const privacyScript = `${privacyProgram}
Read-SedesPrivacy $env:SEDES_SIDECAR_PRIVATE_PATH $env:SEDES_SIDECAR_PRIVATE_OPERATION | ConvertTo-Json -Depth 4 -Compress`;
  const privacyBatchScript = `${privacyProgram}
$ErrorActionPreference = 'Stop'
# Exact filename evidence must survive Windows PowerShell's legacy stdout encoding.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
# Windows PowerShell 5 emits the parsed JSON array as one pipeline object.
# Wrapping that pipeline in @() nests the array and combines entry properties.
$requests = $env:SEDES_SIDECAR_PRIVATE_BATCH | ConvertFrom-Json
if ($requests -isnot [Array]) { $requests = @($requests) }
$results = @(for ($index = 0; $index -lt $requests.Count; $index++) {
  $request = $requests[$index]
  @{ index = $index; filename = $request.filename; operation = $request.operation; evidence = (Read-SedesPrivacy $request.filename $request.operation) }
})
ConvertTo-Json -InputObject $results -Depth 8 -Compress
`;
  type PrivacyOperation = "ensure-directory" | "assert-directory" | "assert-file" | "secure-file" | "secure-executable" | "assert-executable";
  const validatePrivacy = (raw: unknown, operation: PrivacyOperation) => {
    const value = raw as Record<string, unknown> | null;
    if (value?.missing === true) throw Object.assign(new Error("sidecar_windows_private_path_missing"), { code: "ENOENT" });
    const directory = operation === "ensure-directory" || operation === "assert-directory";
    const executable = operation === "secure-executable" || operation === "assert-executable";
    if (!value || typeof value.sid !== "string" || !/^S-1-\d+(?:-\d+)+$/u.test(value.sid) || value.owner !== value.sid ||
      value.directory !== directory || value.protected !== true || (executable && value.readOnly !== true) || !Array.isArray(value.rules) || value.rules.length !== 1 ||
      value.rules.some((raw: unknown) => {
        if (!raw || typeof raw !== "object") return true;
        const rule = raw as Record<string, unknown>;
        return rule.sid !== value.sid || rule.allow !== true || rule.rights !== (executable ? 1245609 : 2032127) ||
          rule.inheritance !== (directory ? 3 : 0) || rule.propagation !== 0;
      })) throw new Error("sidecar_windows_privacy_invalid");
  };
  const validatePrivatePath = (filename: string) => {
    if (!/^(?:[A-Za-z]:[\\/]|\\\\)/u.test(filename) || filename.includes("\0")) throw new Error("sidecar_windows_private_path_invalid");
  };
  const privacy = async (filename: string, operation: PrivacyOperation) => {
    validatePrivatePath(filename);
    validatePrivacy(await execute(privacyScript, { SEDES_SIDECAR_PRIVATE_PATH: nativePath(filename), SEDES_SIDECAR_PRIVATE_OPERATION: operation }), operation);
  };
  /** Fresh per-entry evidence, bounded by both record count and Windows env size. */
  const privacyBatch = async (entries: readonly { filename: string; operation: PrivacyOperation }[]) => {
    if (entries.length > 64) throw new Error("sidecar_windows_privacy_batch_invalid");
    for (const entry of entries) validatePrivatePath(entry.filename);
    let pending: { filename: string; operation: PrivacyOperation }[] = [];
    const flush = async () => {
      if (!pending.length) return;
      const raw = await execute(privacyBatchScript, { SEDES_SIDECAR_PRIVATE_BATCH: JSON.stringify(pending) });
      if (!Array.isArray(raw) || raw.length !== pending.length) throw new Error("sidecar_windows_privacy_invalid");
      for (const [index, entry] of pending.entries()) {
        const result = raw[index] as Record<string, unknown> | null;
        if (!result || result.index !== index || result.filename !== entry.filename || result.operation !== entry.operation) throw new Error("sidecar_windows_privacy_invalid");
        validatePrivacy(result.evidence, entry.operation);
      }
      pending = [];
    };
    for (const entry of entries) {
      const value = { filename: nativePath(entry.filename), operation: entry.operation };
      // An unusually long path fits the existing scalar transport but may not
      // fit after JSON escaping. Keep it scalar; never truncate path authority.
      if (Buffer.byteLength(JSON.stringify([value]), "utf8") > 24_000) { await flush(); await privacy(entry.filename, entry.operation); continue; }
      if (Buffer.byteLength(JSON.stringify([...pending, value]), "utf8") > 24_000) await flush();
      pending.push(value);
    }
    await flush();
  };
  const retireStartupLock = async (directory: string, expectedBytes: string): Promise<boolean> => {
    try { await privacy(directory, "assert-directory"); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return false; throw error; }
    const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class SedesRetireStartupLock {
  [StructLayout(LayoutKind.Sequential)] struct DISPOSITION { [MarshalAs(UnmanagedType.U1)] public bool Delete; }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, ref DISPOSITION info, uint size);
  public static bool Retire(string directory, string expected) {
    // DELETE access + no FILE_SHARE_DELETE serializes reclaimers and pins the
    // directory against rename/replacement until deletion becomes pending.
    using (SafeFileHandle handle = CreateFileW(directory, 0x10080, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
      if (handle.IsInvalid) {
        int error = Marshal.GetLastWin32Error();
        if (error == 2 || error == 3 || error == 32) return false;
        throw new Win32Exception(error);
      }
      FileAttributes attributes = File.GetAttributes(directory);
      if ((attributes & FileAttributes.Directory) == 0 || (attributes & FileAttributes.ReparsePoint) != 0) throw new IOException("sidecar_windows_lock_not_directory");
      string owner = Path.Combine(directory, "owner.json");
      string actual = File.ReadAllText(owner, new UTF8Encoding(false, true));
      if (actual != expected) throw new IOException("sidecar_service_lock_owner_changed");
      if (Directory.GetFileSystemEntries(directory).Length != 1) throw new IOException("sidecar_service_lock_not_empty");
      File.Delete(owner);
      DISPOSITION disposition = new DISPOSITION(); disposition.Delete = true;
      if (!SetFileInformationByHandle(handle, 4, ref disposition, (uint)Marshal.SizeOf(typeof(DISPOSITION)))) throw new Win32Exception(Marshal.GetLastWin32Error());
      return true;
    }
  }
}
'@
$expected = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:SEDES_SIDECAR_LOCK_OWNER))
@{ retired = [SedesRetireStartupLock]::Retire($env:SEDES_SIDECAR_LOCK_DIRECTORY, $expected) } | ConvertTo-Json -Compress
`;
    const raw = await execute(script, { SEDES_SIDECAR_LOCK_DIRECTORY: nativePath(directory),
      SEDES_SIDECAR_LOCK_OWNER: Buffer.from(expectedBytes, "utf8").toString("base64") });
    if (!raw || typeof raw !== "object" || !("retired" in raw) || typeof raw.retired !== "boolean") throw new Error("sidecar_service_recovery_required");
    return raw.retired;
  };
  return { readProcess, readTargetLifetime, privacy, privacyBatch, retireStartupLock };
}

export const windowsSidecarPlatform = createWindowsSidecarPlatform((executable, args, options) => promisify(execFile)(executable, args, options));
