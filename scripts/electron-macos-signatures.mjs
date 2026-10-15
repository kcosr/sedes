import { execFileSync, spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

export async function verifyMacSignatures(app, expectedAppId) {
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  const frameworks = path.join(app, "Contents/Frameworks");
  const helpers = (await readdir(frameworks, { withFileTypes: true }))
    .filter(entry => entry.isDirectory() && entry.name.endsWith(".app"))
    .map(entry => path.join(frameworks, entry.name));
  if (helpers.length === 0) throw new Error("electron_mac_helpers_missing");
  for (const bundle of [app, ...helpers]) {
    const bundleId = execFileSync("/usr/libexec/PlistBuddy", [
      "-c", "Print :CFBundleIdentifier", path.join(bundle, "Contents/Info.plist"),
    ], { encoding: "utf8" }).trim();
    if (bundle === app ? bundleId !== expectedAppId : !bundleId.startsWith(`${expectedAppId}.`)) {
      throw new Error(`electron_mac_bundle_identity_invalid:${path.basename(bundle)}`);
    }
    const signature = spawnSync("/usr/bin/codesign", ["--display", "--verbose=2", bundle], { encoding: "utf8" });
    if (signature.error) throw signature.error;
    if (signature.status !== 0 ||
        /^Identifier=(.+)$/mu.exec(signature.stderr)?.[1] !== bundleId ||
        /^(?:Info.plist=not bound|Sealed Resources=none)$/mu.test(signature.stderr)) {
      throw new Error(`electron_mac_signature_identity_invalid:${path.basename(bundle)}`);
    }
  }
}
