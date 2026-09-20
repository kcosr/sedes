import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  piManagedSearchExecutablePath,
  systemSearchExecutablePaths,
  TrustedSearchExecutableResolver,
} from "../../src/server/workspace-tools/trusted-search-executables.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
      }),
    ),
  );
});

describe("trusted search executable admission", () => {
  it("derives native Windows executable paths and requires fresh ACL authority", async () => {
    expect(
      systemSearchExecutablePaths(
        "rg",
        "C:\\Tools;relative;C:\\Tools;D:\\bin",
        "win32",
      ),
    ).toEqual(["C:\\Tools\\rg.exe", "D:\\bin\\rg.exe"]);
    expect(
      piManagedSearchExecutablePath("fd", "C:\\Users\\alex", "win32"),
    ).toBe("C:\\Users\\alex\\.pi\\agent\\bin\\fd.exe");
    const inspectWindowsPath = vi.fn(async () => undefined);
    const resolver = new TrustedSearchExecutableResolver({
      platform: "win32",
      homeDirectory: "C:\\Users\\alex",
      environmentPath: "C:\\Tools",
      inspectWindowsPath,
      fileSystem: {
        lstat: async () => metadata("file"),
        realpath: async (path) => path,
      },
      readVersion: async () => "ripgrep 15.1.0\n",
    });
    const admitted = await resolver.resolve("rg");
    expect(admitted.executablePath).toBe("C:\\Tools\\rg.exe");
    expect(inspectWindowsPath).toHaveBeenCalledWith(admitted.executablePath);
    inspectWindowsPath.mockRejectedValueOnce(new Error("ACL changed"));
    await expect(resolver.revalidate(admitted)).rejects.toThrow(
      "trusted_search_rg_revalidation_failed",
    );
  });

  it("admits the explicit macOS Homebrew installation while rejecting unrelated user-owned PATH entries", async () => {
    const brew = "/opt/homebrew/bin/rg";
    const canonical = "/opt/homebrew/Cellar/ripgrep/15.1.0/bin/rg";
    let unsafe = false;
    const resolver = new TrustedSearchExecutableResolver({
      platform: "darwin",
      accountUid: 501,
      homeDirectory: "/Users/alex",
      environmentPath: "/Users/alex/tools:/opt/homebrew/bin",
      fileSystem: {
        realpath: async (candidate) =>
          candidate === brew ? canonical : candidate,
        lstat: async (candidate) => ({
          ...metadata(candidate.endsWith("/rg") ? "file" : "directory"),
          uid:
            candidate.startsWith("/opt/homebrew") ||
            candidate.startsWith("/Users/alex")
              ? 501
              : 0,
          gid: 80,
          mode: candidate.startsWith("/opt/homebrew")
            ? unsafe
              ? 0o777
              : 0o775
            : 0o755,
        }),
      },
      readVersion: async () => "ripgrep 15.1.0\n",
    });
    const admitted = await resolver.resolve("rg");
    expect(admitted.executablePath).toBe(brew);
    expect(admitted.canonicalPath).toBe(canonical);
    unsafe = true;
    await expect(resolver.revalidate(admitted)).rejects.toThrow(
      "trusted_search_rg_revalidation_failed",
    );
  });

  it("derives normalized system PATH candidates and standard Pi managed-bin paths", () => {
    expect(
      systemSearchExecutablePaths(
        "rg",
        "/usr/local/bin/:/usr/bin:/usr/local/bin:relative::/opt/../bin:/bad\nentry",
      ),
    ).toEqual(["/usr/local/bin/rg", "/usr/bin/rg", "/bin/rg"]);
    expect(piManagedSearchExecutablePath("rg", "/home/agent")).toBe(
      "/home/agent/.pi/agent/bin/rg",
    );
    expect(piManagedSearchExecutablePath("fd", "/home/agent")).toBe(
      "/home/agent/.pi/agent/bin/fd",
    );
    expect(() => piManagedSearchExecutablePath("rg", "relative/home")).toThrow(
      "trusted_search_path_invalid",
    );
  });

  it("prefers the first valid system PATH executable", async () => {
    const inspected: { candidate: string; source: string }[] = [];
    const resolver = new TrustedSearchExecutableResolver({
      homeDirectory: "/home/agent",
      environmentPath: "/usr/local/bin:/usr/bin",
      inspectPath: vi.fn(async (candidate, source) => {
        inspected.push({ candidate, source });
        if (candidate === "/usr/local/bin/rg") throw new Error("missing");
        return {
          canonicalPath: candidate,
          device: 1,
          inode: 2,
          size: 3,
          modifiedMilliseconds: 4,
          mode: 0o100755,
        };
      }),
      readVersion: vi.fn(async () => "ripgrep 15.1.0 (rev e89fff89ac)\n"),
    });
    await expect(resolver.resolve("rg")).resolves.toMatchObject({
      source: "system_path",
      executablePath: "/usr/bin/rg",
      version: "15.1.0",
    });
    expect(inspected).toEqual([
      { candidate: "/usr/local/bin/rg", source: "system_path" },
      { candidate: "/usr/bin/rg", source: "system_path" },
    ]);
  });

  it("admits a system executable before evaluating a malformed managed home", async () => {
    const resolver = new TrustedSearchExecutableResolver({
      homeDirectory: "/home/agent/",
      environmentPath: "/usr/bin/",
      inspectPath: vi.fn(async (candidate) => ({
        canonicalPath: candidate,
        device: 1,
        inode: 2,
        size: 3,
        modifiedMilliseconds: 4,
        mode: 0o100755,
      })),
      readVersion: vi.fn(async () => "ripgrep 15.1.0\n"),
    });
    await expect(resolver.resolve("rg")).resolves.toMatchObject({
      source: "system_path",
      executablePath: "/usr/bin/rg",
    });
  });

  it("admits a root-owned system executable through the real system inspector", async () => {
    const lstat = vi.fn(async (candidate: string) => {
      if (candidate === "/usr/bin/rg") return metadata("file");
      if (candidate === "/" || candidate === "/usr" || candidate === "/usr/bin")
        return metadata("directory");
      throw new Error(`unexpected path: ${candidate}`);
    });
    const resolver = new TrustedSearchExecutableResolver({
      homeDirectory: "/home/agent",
      environmentPath: "/usr/bin",
      fileSystem: {
        lstat,
        realpath: vi.fn(async (candidate) => candidate),
      },
      readVersion: vi.fn(async () => "ripgrep 15.1.0\n"),
    });
    await expect(resolver.resolve("rg")).resolves.toMatchObject({
      source: "system_path",
      executablePath: "/usr/bin/rg",
      canonicalPath: "/usr/bin/rg",
    });
    expect(lstat).toHaveBeenCalledWith("/");
  });

  it("falls back to the standard Pi managed path", async () => {
    const inspected: string[] = [];
    const homeDirectory = "/home/agent";
    const resolver = new TrustedSearchExecutableResolver({
      homeDirectory,
      environmentPath: "/usr/bin",
      inspectPath: vi.fn(async (candidate, source) => {
        inspected.push(candidate);
        if (source === "system_path") throw new Error("missing");
        return {
          canonicalPath: candidate,
          device: 1,
          inode: 2,
          size: 3,
          modifiedMilliseconds: 4,
          mode: 0o100755,
        };
      }),
      readVersion: vi.fn(async () => "ripgrep 15.1.0 (rev e89fff89ac)\n"),
    });
    await expect(resolver.resolve("rg")).resolves.toMatchObject({
      source: "pi_managed",
      executablePath: "/home/agent/.pi/agent/bin/rg",
      version: "15.1.0",
    });
    expect(inspected).toEqual(["/usr/bin/rg", "/home/agent/.pi/agent/bin/rg"]);
  });

  it("rejects a missing or malformed managed executable", async () => {
    const resolver = new TrustedSearchExecutableResolver({
      homeDirectory: "/home/agent",
      environmentPath: "",
      inspectPath: vi.fn(async (candidate) => ({
        canonicalPath: candidate,
        device: 1,
        inode: 2,
        size: 3,
        modifiedMilliseconds: 4,
        mode: 0o100755,
      })),
      readVersion: vi.fn(async () => "not ripgrep\n"),
    });
    await expect(resolver.resolve("rg")).rejects.toMatchObject({
      diagnosticCode: "trusted_search_rg_unavailable",
    });
  });

  it("revalidates stable identity and version before spawn", async () => {
    const homeDirectory = "/home/agent";
    const candidate = piManagedSearchExecutablePath("rg", homeDirectory);
    const trustedEvidence = {
      canonicalPath: candidate,
      device: 1,
      inode: 2,
      size: 3,
      modifiedMilliseconds: 4,
      mode: 0o100755,
    };
    const inspectPath = vi
      .fn()
      .mockResolvedValueOnce(trustedEvidence)
      .mockResolvedValueOnce({ ...trustedEvidence, inode: 99 });
    const resolver = new TrustedSearchExecutableResolver({
      homeDirectory,
      environmentPath: "",
      inspectPath,
      readVersion: vi.fn(async () => "ripgrep 15.1.0\n"),
    });
    const admitted = await resolver.resolve("rg");
    await expect(resolver.revalidate(admitted)).rejects.toMatchObject({
      diagnosticCode: "trusted_search_rg_revalidation_failed",
    });
  });

  it("admits an owner-managed executable from a real Pi bin directory", async () => {
    const homeDirectory = await mkdtemp(
      path.join(tmpdir(), "sedes-pi-search-home-"),
    );
    temporaryRoots.push(homeDirectory);
    const userWritablePathDirectory = path.join(homeDirectory, "bin");
    await mkdir(userWritablePathDirectory, { mode: 0o755 });
    await writeFile(
      path.join(userWritablePathDirectory, "fd"),
      "#!/bin/sh\necho 'fd 99.0.0'\n",
      { mode: 0o755 },
    );
    const binDirectory = path.join(homeDirectory, ".pi", "agent", "bin");
    await mkdir(binDirectory, { recursive: true, mode: 0o755 });
    const executablePath = path.join(binDirectory, "fd");
    await writeFile(executablePath, "#!/bin/sh\necho 'fd 11.0.0'\n", {
      mode: 0o755,
    });
    await chmod(executablePath, 0o755);

    const resolver = new TrustedSearchExecutableResolver({
      homeDirectory,
      environmentPath: userWritablePathDirectory,
    });
    await expect(resolver.resolve("fd")).resolves.toMatchObject({
      source: "pi_managed",
      executablePath,
      canonicalPath: executablePath,
      version: "11.0.0",
    });
  });
});

function metadata(kind: "directory" | "file") {
  return {
    uid: 0,
    mode: kind === "directory" ? 0o40755 : 0o100755,
    dev: 1,
    ino: kind === "directory" ? 2 : 3,
    size: kind === "directory" ? 4_096 : 128,
    mtimeMs: 1,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => false,
  };
}
