import * as filesystem from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ExecutionAttachmentStagingEngine,
  ExecutionAttachmentStagingError,
} from "../../src/server/composer-attachments/execution-attachment-staging-engine.js";
import { ComposerAttachmentsSidecarHost } from "../../src/server/sidecar/composer-attachments-sidecar-host.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const roots: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture(captureAdmission?: () => () => void) {
  const root = await mkdtemp(path.join(tmpdir(), "sedes-staging-engine-"));
  roots.push(root);
  await chmod(root, 0o700);
  const baseDirectory = path.join(root, "attachments");
  const engine = new ExecutionAttachmentStagingEngine({
    baseDirectory,
    sessionNonce: randomBytes(32).toString("base64url"),
    captureAdmission,
  });
  return { root, baseDirectory, engine };
}

describe("ExecutionAttachmentStagingEngine", () => {
  it("fences host upload admission after an awaited root check", async () => {
    const value = await fixture();
    const authority = admissionAuthority();
    const host = new ComposerAttachmentsSidecarHost({
      baseDirectory: value.baseDirectory,
      sessionNonce: randomBytes(32).toString("base64url"),
      captureAdmission: authority.capture,
    });
    const original = filesystem.realpath;
    vi.spyOn(filesystem, "realpath").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      authority.replace();
      return result;
    });
    await expect(
      host.handlers.open(
        { admissionId: randomUUID(), ...emptyIdentity() },
        { requestId: randomUUID(), signal: new AbortController().signal },
      ),
    ).rejects.toThrow("controller_stale");
    await expect(lstat(path.join(value.baseDirectory, "v1"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(host.snapshot().state).toBe("idle");
    await host.stop();
  });

  it("fences publication after sealing preparation and lets service stop clean revoked uploads", async () => {
    const authority = admissionAuthority();
    const value = await fixture(authority.capture);
    const identity = emptyIdentity();
    const admissionId = randomUUID();
    const upload = await value.engine.open(admissionId, identity);
    if (upload.state !== "upload") throw new Error("expected_upload");
    const original = filesystem.chmod;
    vi.spyOn(filesystem, "chmod").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (String(args[0]).endsWith("manifest.json")) authority.replace();
      return result;
    });
    await expect(value.engine.commit(upload.uploadHandle)).rejects.toThrow(
      "controller_stale",
    );
    const finalDirectory = path.join(
      value.baseDirectory, "v1", "principals", identity.scopeKey,
      "threads", identity.threadId, "attachments", identity.attachmentId,
    );
    await expect(lstat(finalDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    vi.restoreAllMocks();
    const reopened = await value.engine.open(admissionId, identity);
    expect(reopened).toMatchObject({ state: "upload", nextOffset: 0 });
    if (reopened.state !== "upload") throw new Error("expected_upload");
    expect(reopened.uploadHandle).not.toBe(upload.uploadHandle);
    await value.engine.commit(reopened.uploadHandle);
    await value.engine.open(randomUUID(), emptyIdentity());
    authority.deny();
    await value.engine.close();
    expect(
      await filesystem.readdir(path.join(value.baseDirectory, "v1", "incoming")),
    ).toEqual([]);
  });

  it("fences release after manifest verification without deleting the published attachment", async () => {
    const authority = admissionAuthority();
    const value = await fixture(authority.capture);
    const identity = emptyIdentity();
    const committed = await stage(value.engine, identity, Buffer.alloc(0));
    const original = filesystem.readFile;
    vi.spyOn(filesystem, "readFile").mockImplementationOnce(async (...args) => {
      const result = await original(...args);
      authority.replace();
      return result;
    });
    await expect(value.engine.release(identity)).rejects.toThrow(
      "controller_stale",
    );
    await expect(readFile(committed.agentPath)).resolves.toEqual(Buffer.alloc(0));
    await expect(value.engine.release(identity)).resolves.toEqual({ released: true });
    await value.engine.close();
  });


  it("round-trips through the strict sidecar host adapter", async () => {
    const value = await fixture();
    const host = new ComposerAttachmentsSidecarHost({
      baseDirectory: value.baseDirectory,
      sessionNonce: randomBytes(32).toString("base64url"),
    });
    const bytes = Buffer.from([0, 255, 7]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const opened = await host.handlers.open(
      {
        admissionId: randomUUID(),
        scopeKey: "f".repeat(64),
        threadId: randomUUID(),
        attachmentId: randomUUID(),
        sha256,
        sizeBytes: bytes.byteLength,
        extension: ".bin",
      },
      { requestId: randomUUID(), signal: new AbortController().signal },
    );
    if (opened.state !== "upload") throw new Error("expected_upload");
    await host.handlers.append(
      {
        uploadHandle: opened.uploadHandle,
        offset: 0,
        decodedBytes: bytes.byteLength,
        chunkSha256: sha256,
        contentBase64: bytes.toString("base64"),
      },
      { requestId: randomUUID(), signal: new AbortController().signal },
    );
    await expect(
      host.handlers.commit(
        { uploadHandle: opened.uploadHandle },
        { requestId: randomUUID(), signal: new AbortController().signal },
      ),
    ).resolves.toMatchObject({ sha256 });
    await host.close();
  });

  it("streams exact binary bytes into a deterministic private path", async () => {
    const value = await fixture();
    const bytes = Buffer.from([0, 255, 1, 2, 128, 42]);
    const identity = {
      scopeKey: "a".repeat(64),
      threadId: randomUUID(),
      attachmentId: randomUUID(),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      extension: ".bin",
    };
    const opened = await value.engine.open(randomUUID(), identity);
    expect(opened.state).toBe("upload");
    if (opened.state !== "upload") throw new Error("expected_upload");
    await value.engine.append({
      uploadHandle: opened.uploadHandle,
      offset: 0,
      content: bytes.subarray(0, 3),
      chunkSha256: createHash("sha256")
        .update(bytes.subarray(0, 3))
        .digest("hex"),
    });
    await value.engine.append({
      uploadHandle: opened.uploadHandle,
      offset: 3,
      content: bytes.subarray(3),
      chunkSha256: createHash("sha256").update(bytes.subarray(3)).digest("hex"),
    });
    const committed = await value.engine.commit(opened.uploadHandle);
    expect(committed).toMatchObject({
      sha256: identity.sha256,
      sizeBytes: bytes.byteLength,
    });
    expect(committed.agentPath).toContain(
      `/threads/${identity.threadId}/attachments/${identity.attachmentId}/`,
    );
    await expect(readFile(committed.agentPath)).resolves.toEqual(bytes);
    expect((await lstat(committed.agentPath)).mode & 0o777).toBe(0o400);
    expect((await lstat(path.dirname(committed.agentPath))).mode & 0o777).toBe(
      0o700,
    );

    const reopened = await value.engine.open(randomUUID(), identity);
    expect(reopened).toEqual({ state: "ready", ...committed });
    await value.engine.close();
  });

  it("supports empty files and idempotent release while refusing digest mismatch", async () => {
    const value = await fixture();
    const identity = {
      scopeKey: "b".repeat(64),
      threadId: randomUUID(),
      attachmentId: randomUUID(),
      sha256: createHash("sha256").digest("hex"),
      sizeBytes: 0,
      extension: "",
    };
    const opened = await value.engine.open(randomUUID(), identity);
    if (opened.state !== "upload") throw new Error("expected_upload");
    await value.engine.commit(opened.uploadHandle);
    await expect(
      value.engine.release({ ...identity, sha256: "c".repeat(64) }),
    ).rejects.toBeInstanceOf(ExecutionAttachmentStagingError);
    await expect(value.engine.release(identity)).resolves.toEqual({
      released: true,
    });
    await expect(value.engine.release(identity)).resolves.toEqual({
      released: true,
    });
    await value.engine.close();
  });

  it("atomically restages exact-identity content after alteration or loss", async () => {
    const value = await fixture();
    const bytes = Buffer.from("authoritative bytes");
    const identity = {
      scopeKey: "c".repeat(64),
      threadId: randomUUID(),
      attachmentId: randomUUID(),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      extension: ".txt",
    };
    const first = await stage(value.engine, identity, bytes);
    await expect(
      value.engine.open(randomUUID(), {
        ...identity,
        sha256: "f".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "composer_attachment_staging_conflict",
    });

    await chmod(first.agentPath, 0o600);
    await writeFile(first.agentPath, Buffer.alloc(bytes.byteLength, 0x78));
    await chmod(first.agentPath, 0o400);
    const altered = await value.engine.open(randomUUID(), identity);
    expect(altered.state).toBe("upload");
    if (altered.state !== "upload") throw new Error("expected_upload");
    await appendAndCommit(
      value.engine,
      altered.uploadHandle,
      bytes,
      identity.sha256,
    );
    await expect(readFile(first.agentPath)).resolves.toEqual(bytes);

    await unlink(first.agentPath);
    const missing = await value.engine.open(randomUUID(), identity);
    expect(missing.state).toBe("upload");
    if (missing.state !== "upload") throw new Error("expected_upload");
    await appendAndCommit(
      value.engine,
      missing.uploadHandle,
      bytes,
      identity.sha256,
    );
    await expect(readFile(first.agentPath)).resolves.toEqual(bytes);
    await value.engine.close();
  });

  it("removes a corrupt content symlink without traversing its target", async () => {
    const value = await fixture();
    const bytes = Buffer.from("expected");
    const identity = {
      scopeKey: "e".repeat(64),
      threadId: randomUUID(),
      attachmentId: randomUUID(),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      extension: ".bin",
    };
    const committed = await stage(value.engine, identity, bytes);
    const outside = path.join(value.root, "outside.bin");
    const sentinel = Buffer.from("do not delete");
    await writeFile(outside, sentinel);
    await unlink(committed.agentPath);
    await symlink(outside, committed.agentPath);

    const reopened = await value.engine.open(randomUUID(), identity);
    expect(reopened.state).toBe("upload");
    await expect(readFile(outside)).resolves.toEqual(sentinel);
    if (reopened.state !== "upload") throw new Error("expected_upload");
    await value.engine.abort(reopened.uploadHandle);
    await expect(readFile(outside)).resolves.toEqual(sentinel);
    await value.engine.close();
  });

  it("rejects offset and digest conflicts without publishing content", async () => {
    const value = await fixture();
    const bytes = Buffer.from("bounded");
    const identity = {
      scopeKey: "d".repeat(64),
      threadId: randomUUID(),
      attachmentId: randomUUID(),
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sizeBytes: bytes.byteLength,
      extension: ".txt",
    };
    const opened = await value.engine.open(randomUUID(), identity);
    if (opened.state !== "upload") throw new Error("expected_upload");
    await expect(
      value.engine.append({
        uploadHandle: opened.uploadHandle,
        offset: 1,
        content: bytes,
        chunkSha256: identity.sha256,
      }),
    ).rejects.toMatchObject({
      code: "composer_attachment_upload_offset_conflict",
    });
    await expect(
      value.engine.append({
        uploadHandle: opened.uploadHandle,
        offset: 0,
        content: bytes,
        chunkSha256: "e".repeat(64),
      }),
    ).rejects.toMatchObject({
      code: "composer_attachment_upload_digest_mismatch",
    });
    await expect(value.engine.abort(opened.uploadHandle)).resolves.toEqual({
      aborted: true,
    });
    await expect(value.engine.abort(opened.uploadHandle)).resolves.toEqual({
      aborted: true,
    });
    await value.engine.close();
  });
});

async function stage(
  engine: ExecutionAttachmentStagingEngine,
  identity: Parameters<ExecutionAttachmentStagingEngine["open"]>[1],
  bytes: Uint8Array,
) {
  const opened = await engine.open(randomUUID(), identity);
  if (opened.state !== "upload") throw new Error("expected_upload");
  return appendAndCommit(engine, opened.uploadHandle, bytes, identity.sha256);
}

async function appendAndCommit(
  engine: ExecutionAttachmentStagingEngine,
  uploadHandle: string,
  bytes: Uint8Array,
  sha256: string,
) {
  if (bytes.byteLength > 0) {
    await engine.append({
      uploadHandle,
      offset: 0,
      content: bytes,
      chunkSha256: sha256,
    });
  }
  return engine.commit(uploadHandle);
}

function emptyIdentity() {
  return {
    scopeKey: "a".repeat(64),
    threadId: randomUUID(),
    attachmentId: randomUUID(),
    sha256: createHash("sha256").digest("hex"),
    sizeBytes: 0,
    extension: ".txt",
  };
}

function admissionAuthority() {
  let epoch = 0;
  let denied = false;
  return {
    capture: () => {
      const admittedEpoch = epoch;
      return () => {
        if (denied || admittedEpoch !== epoch) throw new Error("controller_stale");
      };
    },
    replace: () => { epoch += 1; },
    deny: () => { denied = true; },
  };
}
