import { createHash, randomUUID } from "node:crypto";
import { ExecutionAttachmentStagingEngine } from "../../src/server/composer-attachments/execution-attachment-staging-engine.js";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  assertWindowsStagingPrivacy,
  windowsStagingPrivacy,
} from "../../src/server/composer-attachments/windows-staging-privacy.js";

const sid = "S-1-5-21-100-200-300-1001";
const privateDirectory = {
  sid, owner: sid, directory: true, protected: true, readOnly: false,
  rules: [{ sid, allow: true, rights: 2032127, inheritance: 3, propagation: 0 }],
};
const sealedFile = {
  ...privateDirectory, directory: false, readOnly: true,
  rules: [{ sid, allow: true, rights: 1245577, inheritance: 0, propagation: 0 }],
};

describe("Windows attachment privacy", () => {
  it("accepts current-account-only private directories and nonexecutable sealed files", () => {
    expect(() => assertWindowsStagingPrivacy(privateDirectory, "directory")).not.toThrow();
    expect(() => assertWindowsStagingPrivacy(sealedFile, "readonly-file")).not.toThrow();
  });

  it.each([
    { ...privateDirectory, owner: "S-1-5-18" },
    { ...privateDirectory, protected: false },
    { ...privateDirectory, directory: false },
    { ...privateDirectory, rules: [] },
    { ...privateDirectory, rules: [{ ...privateDirectory.rules[0], inheritance: 0 }] },
    { ...privateDirectory, rules: [{ ...privateDirectory.rules[0], propagation: 2 }] },
    { ...privateDirectory, rules: [...privateDirectory.rules, { sid: "S-1-1-0", allow: true, rights: 2032127 }] },
    { ...privateDirectory, rules: [{ sid, allow: false, rights: 2032127 }] },
    { ...privateDirectory, rules: [{ sid, allow: true, rights: 0 }] },
    null,
  ])("fails closed for invalid ACL evidence: %j", (value) => {
    expect(() => assertWindowsStagingPrivacy(value, "directory")).toThrow("windows_staging_privacy_invalid");
  });

  it.each([
    { ...sealedFile, readOnly: false },
    { ...sealedFile, protected: false },
    { ...sealedFile, rules: privateDirectory.rules },
    { ...sealedFile, rules: [{ sid, allow: true, rights: 1245577 | 32 }] },
  ])("rejects writable or executable file evidence: %j", (value) => {
    expect(() => assertWindowsStagingPrivacy(value, "readonly-file")).toThrow("windows_staging_privacy_invalid");
  });

  it("passes hostile path text only as data and bounds the native command", async () => {
    const run = vi.fn().mockResolvedValue({ stdout: JSON.stringify(privateDirectory) });
    const filename = "C:\\private\\'; throw 'injected'";
    await windowsStagingPrivacy(filename, "ensure-directory", { run, systemRoot: "C:\\Windows", rootDirectory: "C:\\private" });
    const [executable, args, options] = run.mock.calls[0]!;
    expect(executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(args).toContain("-NonInteractive");
    expect(Buffer.from(args.at(-1), "base64").toString("utf16le")).not.toContain(filename);
    expect(options).toMatchObject({ timeout: 15000, maxBuffer: 65536, windowsHide: true,
      env: { SEDES_STAGING_PRIVACY_PATH: path.win32.toNamespacedPath(filename), SEDES_STAGING_PRIVACY_OPERATION: "ensure-directory", SEDES_STAGING_PRIVACY_ROOT: path.win32.toNamespacedPath("C:\\private") } });
  });

  it("propagates native command failure and rejects malformed evidence", async () => {
    const run = vi.fn().mockRejectedValue(new Error("native_timeout"));
    await expect(windowsStagingPrivacy("C:\\private", "ensure-directory", { run, systemRoot: "C:\\Windows" })).rejects.toThrow("native_timeout");
    run.mockResolvedValue({ stdout: "{}" });
    await expect(windowsStagingPrivacy("C:\\private", "ensure-directory", { run, systemRoot: "C:\\Windows" })).rejects.toThrow("windows_staging_privacy_invalid");
  });

  it.skipIf(process.platform !== "win32")("rejects a junction ancestor without creating storage in its target", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedes-win-junction-"));
    try {
      const outside = path.join(root, "outside");
      await mkdir(outside);
      const link = path.join(root, "link");
      await symlink(outside, link, "junction");
      await expect(windowsStagingPrivacy(path.join(link, "staging"), "ensure-directory", {
        rootDirectory: link,
      })).rejects.toThrow();
      await expect(readFile(path.join(outside, "staging"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(process.platform !== "win32")("stages, reopens, and releases a sealed attachment on Windows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedes-win-stage-"));
    const engine = new ExecutionAttachmentStagingEngine({
      baseDirectory: path.join(root, "staging"), sessionNonce: "n".repeat(32),
    });
    try {
      const content = Buffer.from("Windows attachment");
      const identity = { scopeKey: "a".repeat(64), threadId: randomUUID(), attachmentId: randomUUID(),
        sha256: createHash("sha256").update(content).digest("hex"), sizeBytes: content.length, extension: ".txt" };
      const upload = await engine.open(randomUUID(), identity);
      if (upload.state !== "upload") throw new Error("expected_upload");
      await engine.append({ uploadHandle: upload.uploadHandle, offset: 0, content, chunkSha256: identity.sha256 });
      const committed = await engine.commit(upload.uploadHandle);
      expect(await readFile(committed.agentPath)).toEqual(content);
      expect(await engine.open(randomUUID(), identity)).toEqual({ state: "ready", ...committed });
      await engine.release(identity);
      await expect(readFile(committed.agentPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await engine.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 120_000);

  it.skipIf(process.platform !== "win32")("creates inherited private storage, seals content, and permits cleanup on Windows", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "sedes-win-acl-"));
    try {
      const directory = path.join(root, "private", "nested");
      await windowsStagingPrivacy(directory, "ensure-directory", { rootDirectory: path.join(root, "private") });
      await windowsStagingPrivacy(directory, "assert-directory");
      const filename = path.join(directory, "attachment.bin");
      await writeFile(filename, "private content");
      await windowsStagingPrivacy(filename, "seal-file");
      await windowsStagingPrivacy(filename, "assert-readonly-file");
      expect(await readFile(filename, "utf8")).toBe("private content");
      await expect(writeFile(filename, "overwrite")).rejects.toThrow();
      await rm(directory, { recursive: true, force: true });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 60_000);
});
