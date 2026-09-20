import { describe, expect, it } from "vitest";
import {
  isNormalizedRemotePath,
  isWithinRemoteRoot,
} from "../../src/server/execution/remote-path.js";
import { prepareSidecarWorkspaceToolPath } from "../../src/server/workspace-tools/sidecar-workspace-path.js";
import {
  workspaceToolsAbsolutePathSchema,
  directoryBrowserListImmediateOperation,
  workspaceFilesRootOpenOperation,
} from "../../src/internal/sidecar-protocol/index.js";

describe("execution-host remote paths", () => {
  it("rejects root escapes, other volumes, alternate streams and device namespaces", () => {
    const root = "C:\\Users\\alex\\work";
    expect(isWithinRemoteRoot(`${root}\\src`, root)).toBe(true);
    expect(isWithinRemoteRoot("c:\\users\\alex\\work\\src", root)).toBe(true);
    for (const candidate of [
      "D:\\Users\\alex\\work",
      `${root}-other`,
      `${root}\\..\\secret`,
      `${root}\\file:stream`,
      "\\\\?\\C:\\Users\\alex\\work",
      "/Users/alex/work",
    ]) {
      expect(isWithinRemoteRoot(candidate, root)).toBe(false);
    }
    expect(
      isWithinRemoteRoot(
        "\\\\server\\share\\work\\project",
        "\\\\server\\share\\work",
      ),
    ).toBe(true);
    expect(
      isWithinRemoteRoot("\\\\other\\share\\work", "\\\\server\\share"),
    ).toBe(false);
    expect(isNormalizedRemotePath("\\\\server\\share\\", "win32")).toBe(true);
    expect(isNormalizedRemotePath("\\\\server\\share", "win32")).toBe(false);
    expect(isWithinRemoteRoot("\\\\server\\share\\work", "\\\\server\\share\\")).toBe(true);
    expect(isNormalizedRemotePath(root, "darwin")).toBe(false);
    expect(isNormalizedRemotePath("/Users/alex/work", "win32")).toBe(false);
  });

  it("converts Windows semantic paths into the shared slash-separated relative wire path", () => {
    const options = {
      workspacePath: "C:\\Users\\alex\\work",
      allowRoot: false,
    };
    for (const input of [
      "src\\file.ts",
      "src/file.ts",
      "C:\\Users\\alex\\work\\src\\file.ts",
      "file:///C:/Users/alex/work/src/file.ts",
    ]) {
      expect(prepareSidecarWorkspaceToolPath(input, options)()).toBe(
        "src/file.ts",
      );
    }
    expect(
      prepareSidecarWorkspaceToolPath(
        "~/work/src/file.ts",
        options,
      )("C:\\Users\\alex"),
    ).toBe("src/file.ts");
    for (const input of [
      "..\\secret",
      "D:\\work\\file",
      "C:relative",
      "src\\file:stream",
      "src\\CON",
    ]) {
      expect(() => prepareSidecarWorkspaceToolPath(input, options)()).toThrow();
    }
    expect(() =>
      prepareSidecarWorkspaceToolPath("bad\\file", {
        workspacePath: "/work",
        allowRoot: false,
      }),
    ).toThrow();
  });

  it("validates native Windows absolute paths at the shared sidecar protocol boundary", () => {
    const rootPath = "C:\\Users\\alex\\work";
    expect(workspaceToolsAbsolutePathSchema.safeParse(rootPath).success).toBe(
      true,
    );
    expect(
      directoryBrowserListImmediateOperation.requestSchema.safeParse({
        rootPath,
        directoryPath: rootPath,
        pageSize: 50,
      }).success,
    ).toBe(true);
    expect(
      workspaceFilesRootOpenOperation.requestSchema.safeParse({
        admissionId: "11111111-1111-4111-8111-111111111111",
        rootId: "11111111-1111-4111-8111-111111111112",
        rootKind: "primary",
        declaredPath: rootPath,
        policyRootPath: rootPath,
      }).success,
    ).toBe(true);
  });
});
