import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("generates identical shipped notices when ignored install scripts leave different Claude executables", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "sedes-notices-"));
  const runtime = path.join(root, "packages/server-runtime");
  const sdk = "@anthropic-ai/claude-agent-sdk";
  const platforms = ["linux-x64", "win32-x64"];
  const json = (filename, value) => {
    mkdirSync(path.dirname(filename), { recursive: true });
    writeFileSync(filename, JSON.stringify(value));
  };
  try {
    mkdirSync(path.join(root, "scripts"));
    copyFileSync(fileURLToPath(new URL("../../scripts/generate-third-party-notices.mjs", import.meta.url)),
      path.join(root, "scripts/generate-third-party-notices.mjs"));
    json(path.join(root, "package.json"), { name: "fixture-root", private: true });
    json(path.join(root, "package-lock.json"), { packages: { "": {} } });
    json(path.join(runtime, "package.json"), { name: "fixture-runtime", dependencies: { [sdk]: "1.0.0" } });
    const optionalDependencies = Object.fromEntries(platforms.map(platform => [`${sdk}-${platform}`, "1.0.0"]));
    json(path.join(runtime, "package-lock.json"), {
      packages: {
        "": {},
        [`node_modules/${sdk}`]: { version: "1.0.0", license: "MIT", optionalDependencies },
        ...Object.fromEntries(platforms.map(platform => [`node_modules/${sdk}-${platform}`,
          { version: "1.0.0", license: "LicenseRef-Not-Shipped", optional: true }])),
      },
    });
    json(path.join(runtime, "node_modules", sdk, "package.json"),
      { name: sdk, version: "1.0.0", license: "MIT" });
    writeFileSync(path.join(runtime, "node_modules", sdk, "LICENSE"), "Fixture SDK license retained in notices.");
    const outputs = [];
    for (const platform of platforms) {
      const executable = path.join(runtime, "node_modules", `${sdk}-${platform}`);
      json(path.join(executable, "package.json"),
        { name: `${sdk}-${platform}`, version: "1.0.0", license: "LicenseRef-Not-Shipped" });
      writeFileSync(path.join(executable, "LICENSE"), "Executable license must not appear in shipped notices.");
      execFileSync(process.execPath, [path.join(root, "scripts/generate-third-party-notices.mjs")], { stdio: "pipe" });
      const notices = readFileSync(path.join(root, "THIRD-PARTY-NOTICES.md"), "utf8");
      expect(notices).toContain(`### ${sdk} 1.0.0`);
      expect(notices).toContain("Fixture SDK license retained in notices.");
      expect(notices).not.toContain(`### ${sdk}-${platform}`);
      expect(notices).not.toContain("Executable license must not appear");
      outputs.push(notices);
      rmSync(executable, { recursive: true });
    }
    expect(outputs[1]).toBe(outputs[0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
