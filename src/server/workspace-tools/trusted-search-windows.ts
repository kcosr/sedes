import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { normalizedAbsolutePath } from "../../shared/absolute-path.js";

type Runner = (
  executable: string,
  args: string[],
  options: {
    env: NodeJS.ProcessEnv;
    windowsHide: boolean;
    timeout: number;
    maxBuffer: number;
  },
) => Promise<{ stdout: string }>;

/** Inspect existing installations; never rewrite the operator's ACLs. */
export async function assertTrustedWindowsSearchPath(
  candidate: string,
  run: Runner = promisify(execFile),
  systemRoot = process.env.SystemRoot,
): Promise<void> {
  if (
    !normalizedAbsolutePath(candidate) ||
    !/^[a-z]:\\/iu.test(candidate) ||
    !systemRoot ||
    !normalizedAbsolutePath(systemRoot) ||
    !/^[a-z]:\\/iu.test(systemRoot)
  ) {
    throw new Error("trusted_search_path_invalid");
  }
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$current = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$trusted = @($current, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
$candidate = $env:SEDES_SEARCH_EXECUTABLE
$item = Get-Item -LiteralPath $candidate -Force
if ($item.PSIsContainer -or $item.Extension -ine '.exe' -or $item.Length -le 0) { throw 'trusted_search_executable_invalid' }
while ($item) {
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'trusted_search_path_untrusted' }
  $acl = Get-Acl -LiteralPath $item.FullName
  $owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value
  if ($trusted -notcontains $owner) { throw 'trusted_search_owner_untrusted' }
  $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  # Creating an unrelated child cannot replace an existing admitted path.
  $writeMask = if ($item.PSIsContainer) { 0x500d0150 } else { 0x500d0156 }
  foreach ($rule in $rules) {
    if (($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
    if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and
        (([long]$rule.FileSystemRights -band $writeMask) -ne 0) -and
        ($trusted -notcontains $rule.IdentityReference.Value)) { throw 'trusted_search_write_authority_untrusted' }
  }
  if ($item -is [IO.FileInfo]) { $item = $item.Directory } else { $item = $item.Parent }
}
@{ path = $candidate; trusted = $true } | ConvertTo-Json -Compress
`;
  const { stdout } = await run(
    path.win32.join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    {
      env: { ...process.env, SEDES_SEARCH_EXECUTABLE: candidate },
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 4096,
    },
  );
  const result: unknown = JSON.parse(stdout);
  if (
    !result ||
    typeof result !== "object" ||
    Object.keys(result).sort().join(",") !== "path,trusted" ||
    !("path" in result) ||
    result.path !== candidate ||
    !("trusted" in result) ||
    result.trusted !== true
  ) {
    throw new Error("trusted_search_path_untrusted");
  }
}
