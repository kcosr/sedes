import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface WindowsStagingPrivacyRunner {
  (executable: string, args: string[], options: {
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
    timeout: number;
    maxBuffer: number;
  }): Promise<{ stdout: string }>;
}

// Windows PowerShell 5.1 uses .NET Framework's atomic DirectorySecurity mkdir.
// All path data travels in an environment variable, never PowerShell source.
const WINDOWS_STAGING_PRIVACY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$p = $env:SEDES_STAGING_PRIVACY_PATH
$operation = $env:SEDES_STAGING_PRIVACY_OPERATION
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
function New-PrivateAcl {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetOwner($sid)
  $acl.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', $inherit, 'None', 'Allow')
  $acl.AddAccessRule($rule)
  return $acl
}
function Assert-NotReparse([string]$candidate) {
  $item = Get-Item -LiteralPath $candidate -Force
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'staging_reparse_point' }
  return $item
}
function Ensure-Directory([string]$candidate) {
  if (!(Test-Path -LiteralPath $candidate)) {
    $parent = [System.IO.Path]::GetDirectoryName($candidate)
    if (!$parent -or $parent -eq $candidate) { throw 'staging_parent_invalid' }
    if (!(Test-Path -LiteralPath $parent)) { Ensure-Directory $parent }
    $null = Assert-NotReparse $parent
    $null = [System.IO.Directory]::CreateDirectory($candidate, (New-PrivateAcl))
  }
  $item = Assert-NotReparse $candidate
  if (!$item.PSIsContainer) { throw 'staging_not_directory' }
  $acl = $item.GetAccessControl()
  if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'staging_wrong_owner' }
  $item.SetAccessControl((New-PrivateAcl))
}
$ancestor = [System.IO.Path]::GetDirectoryName($p)
while ($ancestor) {
  if (Test-Path -LiteralPath $ancestor) { $null = Assert-NotReparse $ancestor }
  $next = [System.IO.Path]::GetDirectoryName($ancestor)
  if ($next -eq $ancestor) { break }
  $ancestor = $next
}
if ($operation -eq 'ensure-directory') {
  $root = $env:SEDES_STAGING_PRIVACY_ROOT
  if ($root) {
    $prefix = $root.TrimEnd('\') + '\'
    if ($p -ne $root -and !$p.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'staging_outside_root' }
    Ensure-Directory $root
    $current = $root
    if ($p -ne $root) {
      foreach ($segment in $p.Substring($prefix.Length).Split('\')) {
        if (!$segment -or $segment -eq '.' -or $segment -eq '..') { throw 'staging_path_invalid' }
        $current = [System.IO.Path]::Combine($current, $segment)
        Ensure-Directory $current
      }
    }
  } else {
    Ensure-Directory $p
  }
}
$item = Assert-NotReparse $p
if ($operation -eq 'seal-file') {
  if ($item.PSIsContainer) { throw 'staging_not_file' }
  if ($item.GetAccessControl().GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'staging_wrong_owner' }
  $sealed = New-Object System.Security.AccessControl.FileSecurity
  $sealed.SetOwner($sid)
  $sealed.SetAccessRuleProtection($true, $false)
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'Read, Delete, WriteAttributes, Synchronize', 'Allow')
  $sealed.AddAccessRule($rule)
  $item.SetAccessControl($sealed)
  $item.Attributes = $item.Attributes -bor [System.IO.FileAttributes]::ReadOnly
  $item.Refresh()
}
$acl = $item.GetAccessControl()
$rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]) | ForEach-Object {
  @{ sid = $_.IdentityReference.Value; allow = ($_.AccessControlType -eq 'Allow'); rights = [int]$_.FileSystemRights; inheritance = [int]$_.InheritanceFlags; propagation = [int]$_.PropagationFlags }
})
@{
  sid = $sid.Value
  owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  directory = [bool]$item.PSIsContainer
  protected = $acl.AreAccessRulesProtected
  readOnly = (($item.Attributes -band [System.IO.FileAttributes]::ReadOnly) -ne 0)
  rules = $rules
} | ConvertTo-Json -Depth 4 -Compress
`;

interface PrivacySnapshot {
  sid?: unknown;
  owner?: unknown;
  directory?: unknown;
  protected?: unknown;
  readOnly?: unknown;
  rules?: unknown;
}

/** Require the current account to be the only DACL trustee, with a real grant. */
export function assertWindowsStagingPrivacy(
  value: unknown,
  kind: "directory" | "readonly-file",
): void {
  const snapshot = value as PrivacySnapshot | null;
  if (
    !snapshot ||
    typeof snapshot.sid !== "string" ||
    !/^S-1-\d+(?:-\d+)+$/u.test(snapshot.sid) ||
    snapshot.owner !== snapshot.sid ||
    snapshot.directory !== (kind === "directory") ||
    snapshot.protected !== true ||
    (kind === "readonly-file" && snapshot.readOnly !== true) ||
    !Array.isArray(snapshot.rules) ||
    snapshot.rules.length !== 1 ||
    snapshot.rules.some((rule: unknown) => {
      if (!rule || typeof rule !== "object") return true;
      const entry = rule as { sid?: unknown; allow?: unknown; rights?: unknown; inheritance?: unknown; propagation?: unknown };
      return entry.sid !== snapshot.sid || entry.allow !== true ||
        entry.rights !== (kind === "directory" ? 2032127 : 1245577) ||
        entry.inheritance !== (kind === "directory" ? 3 : 0) ||
        entry.propagation !== 0;
    })
  ) {
    throw new Error("windows_staging_privacy_invalid");
  }
}

export async function windowsStagingPrivacy(
  filename: string,
  operation: "ensure-directory" | "assert-directory" | "assert-readonly-file" | "seal-file",
  dependencies: {
    run?: WindowsStagingPrivacyRunner;
    systemRoot?: string;
    rootDirectory?: string;
  } = {},
): Promise<void> {
  const systemRoot = dependencies.systemRoot ?? process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("windows_staging_privacy_unavailable");
  }
  const { stdout } = await (dependencies.run ?? run)(
    path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_STAGING_PRIVACY_SCRIPT, "utf16le").toString("base64")],
    {
      env: {
        ...process.env,
        // Final attachment paths routinely exceed PowerShell 5.1's MAX_PATH.
        SEDES_STAGING_PRIVACY_PATH: path.win32.toNamespacedPath(filename),
        SEDES_STAGING_PRIVACY_OPERATION: operation,
        SEDES_STAGING_PRIVACY_ROOT: dependencies.rootDirectory
          ? path.win32.toNamespacedPath(dependencies.rootDirectory)
          : "",
      },
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 64 * 1024,
    },
  );
  assertWindowsStagingPrivacy(JSON.parse(stdout.trim()), (operation === "assert-readonly-file" || operation === "seal-file") ? "readonly-file" : "directory");
}
