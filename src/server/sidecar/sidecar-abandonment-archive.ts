import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import type { SidecarServiceScope } from "../../internal/sidecar-protocol/service-management-v1.js";
import { windowsSidecarPlatform } from "./sidecar-windows-platform.js";

export interface SidecarAbandonmentRecord {
  readonly resourceId: string;
  readonly kind: "codex_app_server" | "claude_agent_sdk" | "workspace_files" | "workspace_tools" | "workspace_shell" | "terminal";
  readonly reason: string;
  /** Provider-owned metadata only: identities and delivery disposition, never
   * credentials, prompts, tool arguments, or a copy of the native transcript. */
  readonly evidence: unknown;
}

/** Evidence retention must not become a new prerequisite for operator Stop.
 * Capacity exhaustion and write failures are reported, never silently promoted
 * into a claim that uncertain provider operations completed successfully. */
export function createSidecarAbandonmentArchive(input: {
  directory: string;
  scope: SidecarServiceScope;
  serviceIncarnation(): string;
  onError(error: unknown): void;
}): (record: SidecarAbandonmentRecord) => Promise<void> {
  if (!path.isAbsolute(input.directory)) throw new Error("sidecar_abandonment_directory_invalid");
  let tail: Promise<void> = Promise.resolve();
  const report = (code: string) => { try { input.onError(new Error(code)); } catch { /* diagnostic observer */ } };
  const write = async (record: SidecarAbandonmentRecord) => {
    await mkdir(input.directory, { mode: 0o700 }).catch(error => { if (error?.code !== "EEXIST") throw error; });
    const metadata = await lstat(input.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("sidecar_abandonment_directory_invalid");
    if (process.platform === "win32") await windowsSidecarPlatform.privacy(input.directory, "ensure-directory");
    else if (metadata.uid !== process.getuid?.() || (metadata.mode & 0o777) !== 0o700) throw new Error("sidecar_abandonment_directory_invalid");
    if ((await readdir(input.directory)).length >= 128) throw new Error("sidecar_abandonment_capacity_exceeded");
    const evidence = JSON.stringify(record.evidence);
    const evidenceBytes = Buffer.byteLength(evidence, "utf8");
    const document = { version: 1, recordedAt: new Date().toISOString(), scope: input.scope,
      serviceIncarnation: input.serviceIncarnation(), resourceId: record.resourceId, kind: record.kind,
      reason: record.reason, disposition: "operator_abandoned", evidence: evidenceBytes <= 1024 * 1024 ? record.evidence : {
        omitted: "size_limit", bytes: evidenceBytes, sha256: createHash("sha256").update(evidence).digest("hex"),
      } };
    const filename = path.join(input.directory, `${randomUUID()}.json`);
    const handle = await open(filename, "wx", 0o600);
    try {
      if (process.platform === "win32") await windowsSidecarPlatform.privacy(filename, "secure-file");
      await handle.writeFile(JSON.stringify(document));
      await handle.sync();
    } finally { await handle.close(); }
    if (process.platform !== "win32") {
      const directory = await open(input.directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  };
  return async record => {
    const writing = tail.then(() => write(record));
    tail = writing.catch(error => { report(error instanceof Error && error.message === "sidecar_abandonment_capacity_exceeded"
      ? error.message : "sidecar_abandonment_archive_failed"); });
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([tail, new Promise<void>(resolve => {
      timer = setTimeout(() => { report("sidecar_abandonment_archive_timeout"); resolve(); }, 2_000);
    })]);
    if (timer) clearTimeout(timer);
  };
}
