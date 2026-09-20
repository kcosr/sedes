import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSidecarNativeLinux } from "../../scripts/build-sidecar-native-linux.mjs";

const temporary = [];
afterEach(async () => {
  await Promise.all(
    temporary
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
describe.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "portable native build authority",
  () => {
    it("publishes nothing when the supplied sysroot is incomplete", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "sedes-sysroot-"));
      temporary.push(root);
      const outputDirectory = path.join(root, "output");
      await writeFile(
        path.join(root, "node_version.h"),
        `#define NODE_MODULE_VERSION ${process.versions.modules}\n`,
      );
      await expect(
        buildSidecarNativeLinux({
          sysroot: root,
          nodeHeaders: root,
          outputDirectory,
          compiler: "/nonexistent/compiler",
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(outputDirectory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    });

    it("rejects headers for another Node build before executing a compiler", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "sedes-sysroot-"));
      temporary.push(root);
      await writeFile(
        path.join(root, "node_version.h"),
        "#define NODE_MODULE_VERSION 9999\n",
      );
      await expect(
        buildSidecarNativeLinux({
          sysroot: root,
          nodeHeaders: root,
          compiler: "/nonexistent/compiler",
        }),
      ).rejects.toThrow("sidecar_native_build_headers_mismatch");
    });

    it("rejects a sysroot header symlink into the build host before executing a compiler", async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "sedes-sysroot-"));
      temporary.push(root);
      const sysroot = path.join(root, "root");
      await mkdir(path.join(sysroot, "usr/include"), { recursive: true });
      await writeFile(
        path.join(root, "node_version.h"),
        `#define NODE_MODULE_VERSION ${process.versions.modules}\n`,
      );
      await symlink(
        path.join(root, "node_version.h"),
        path.join(sysroot, "usr/include/features.h"),
      );
      await expect(
        buildSidecarNativeLinux({
          sysroot,
          nodeHeaders: root,
          compiler: "/nonexistent/compiler",
        }),
      ).rejects.toThrow("sidecar_native_sysroot_escape");
    });
  },
);
