import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const phase = process.argv[2];

if (phase !== "--synced" && phase !== "--assembled") {
  throw new Error("android_package_verification_phase_required");
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const androidRoot = path.join(repositoryRoot, "android");
const expectedAppId = "dev.sedes.local";

if (phase === "--synced") {
  await verifySyncedAssets();
} else {
  await verifyAssembledPackage();
}

async function verifySyncedAssets() {
  const sourceConfig = await readJson(
    path.join(repositoryRoot, "capacitor.config.json"),
  );
  const copiedConfig = await readJson(
    path.join(androidRoot, "app/src/main/assets/capacitor.config.json"),
  );
  for (const [name, config] of [
    ["source", sourceConfig],
    ["copied", copiedConfig],
  ]) {
    assert(config.appId === expectedAppId, `${name}_app_id_changed`);
    assert(config.webDir === "dist/client", `${name}_web_dir_changed`);
    assert(config.server?.androidScheme === "http", `${name}_origin_not_http`);
    assert(config.server?.cleartext === true, `${name}_cleartext_not_explicit`);
    assert(
      config.server?.hostname === undefined ||
        config.server.hostname === "localhost",
      `${name}_origin_hostname_changed`,
    );
    assert(
      config.android?.loggingBehavior === "none",
      `${name}_capacitor_payload_logging_enabled`,
    );
    assert(!hasKey(config, "url"), `${name}_remote_server_url_forbidden`);
    assert(
      !hasKey(config, "allowNavigation"),
      `${name}_allow_navigation_forbidden`,
    );
  }

  const publicRoot = path.join(androidRoot, "app/src/main/assets/public");
  const indexPath = path.join(publicRoot, "index.html");
  const index = await readFile(indexPath, "utf8");
  assert(index.includes('id="root"'), "packaged_root_missing");
  assert(index.includes("'wasm-unsafe-eval'"), "ghostty_wasm_csp_missing");
  assert(
    index.includes("img-src 'self' data: blob:"),
    "composer_thumbnail_blob_csp_missing",
  );
  assert(
    index.includes("connect-src 'self' data:"),
    "ghostty_data_csp_missing",
  );

  const assetReferences = Array.from(
    index.matchAll(/\b(?:src|href)=["']([^"']+)["']/gu),
    (match) => match[1],
  );
  assert(assetReferences.length > 0, "packaged_asset_references_missing");
  for (const reference of assetReferences) {
    assert(
      !reference.startsWith("//") && !/^[a-z][a-z0-9+.-]*:/iu.test(reference),
      `packaged_remote_asset_forbidden:${reference}`,
    );
    const pathname = reference.split(/[?#]/u, 1)[0].replace(/^\//u, "");
    const target = path.resolve(publicRoot, pathname);
    assert(
      target.startsWith(`${publicRoot}${path.sep}`),
      `packaged_asset_path_escaped:${reference}`,
    );
    assert(
      (await stat(target)).isFile(),
      `packaged_asset_missing:${reference}`,
    );
  }

  const javascriptFiles = (await filesBelow(publicRoot)).filter((file) =>
    file.endsWith(".js"),
  );
  assert(javascriptFiles.length > 0, "packaged_javascript_missing");
  const javascript = (
    await Promise.all(javascriptFiles.map((file) => readFile(file, "utf8")))
  ).join("\n");
  for (const required of [
    "sedes.codex-tui.v1",
    "/api/provider-feature-terminal",
    "terminal-admission",
    "OutputImageActions",
    "ClientCredentials",
  ]) {
    assert(
      javascript.includes(required),
      `packaged_terminal_client_missing:${required}`,
    );
  }

  const sourceManifest = await readFile(
    path.join(androidRoot, "app/src/main/AndroidManifest.xml"),
    "utf8",
  );
  assertRequestedPermissions(sourceManifest, false);
  assert(
    /android:windowSoftInputMode=["']adjustResize["']/u.test(sourceManifest),
    "android_keyboard_resize_policy_missing",
  );
  assertOutputImageNativeContract(sourceManifest);

  const mainActivity = await readFile(
    path.join(
      androidRoot,
      "app/src/main/java/dev/sedes/local/MainActivity.java",
    ),
    "utf8",
  );
  assert(
    mainActivity.includes("registerPlugin(OutputImageActionsPlugin.class)"),
    "output_image_actions_plugin_not_registered",
  );
  assert(mainActivity.includes("registerPlugin(ClientCredentialsPlugin.class)"), "client_credentials_plugin_not_registered");
  assert(/android:allowBackup=["']false["']/u.test(sourceManifest), "android_credential_backup_enabled");
  const outputImagePaths = await readFile(
    path.join(androidRoot, "app/src/main/res/xml/output_image_paths.xml"),
    "utf8",
  );
  assert(
    /<cache-path\b[^>]*\bpath=["']output-image-clipboard\/["'][^>]*\/>/u.test(
      outputImagePaths,
    ),
    "output_image_clipboard_path_missing",
  );
}

async function verifyAssembledPackage() {
  const mergedManifest = await readFile(
    path.join(
      androidRoot,
      "app/build/intermediates/merged_manifest/debug/processDebugMainManifest/AndroidManifest.xml",
    ),
    "utf8",
  );
  assertRequestedPermissions(mergedManifest, true);
  assert(
    mergedManifest.includes(`package="${expectedAppId}"`),
    "android_application_id_changed",
  );
  assert(
    /android:targetSdkVersion=["']36["']/u.test(mergedManifest),
    "android_target_sdk_changed",
  );
  assert(
    /android:windowSoftInputMode=["']adjustResize["']/u.test(mergedManifest),
    "merged_keyboard_resize_policy_missing",
  );
  assert(!/<service\b/iu.test(mergedManifest), "unexpected_android_service");
  assertOutputImageNativeContract(mergedManifest);

  const debugApk = path.join(
    androidRoot,
    "app/build/outputs/apk/debug/app-debug.apk",
  );
  const instrumentationApk = path.join(
    androidRoot,
    "app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk",
  );
  assert((await stat(debugApk)).size > 0, "debug_apk_missing");
  assert(
    (await stat(instrumentationApk)).size > 0,
    "instrumentation_apk_missing",
  );

  const { stdout } = await execFileAsync("unzip", ["-Z1", debugApk], {
    maxBuffer: 4 * 1024 * 1024,
  });
  const entries = new Set(stdout.split(/\r?\n/u).filter(Boolean));
  assert(entries.has("assets/public/index.html"), "apk_index_asset_missing");
  assert(
    entries.has("assets/capacitor.config.json"),
    "apk_capacitor_config_missing",
  );
  assert(
    Array.from(entries).some(
      (entry) =>
        entry.startsWith("assets/public/assets/") && entry.endsWith(".js"),
    ),
    "apk_javascript_assets_missing",
  );
}

function assertOutputImageNativeContract(manifest) {
  const provider = manifest.match(
    /<provider\b[^>]*\bandroid:name=["'][^"']*OutputImageFileProvider["'][^>]*>[\s\S]*?<\/provider>/iu,
  )?.[0];
  assert(provider, "output_image_file_provider_missing");
  assert(
    /android:exported=["']false["']/u.test(provider),
    "output_image_file_provider_exported",
  );
  assert(
    /android:grantUriPermissions=["']true["']/u.test(provider),
    "output_image_file_provider_grants_missing",
  );
  assert(
    /android:authorities=["'][^"']*\.output-image-files["']/u.test(provider),
    "output_image_file_provider_authority_changed",
  );
  assert(
    /android:resource=["']@xml\/output_image_paths["']/u.test(provider),
    "output_image_file_provider_paths_changed",
  );
}

function assertRequestedPermissions(manifest, merged) {
  const permissions = Array.from(
    manifest.matchAll(
      /<uses-permission\b[^>]*\bandroid:name=["']([^"']+)["'][^>]*>/giu,
    ),
    (match) => match[1],
  );
  const platformPermissions = permissions.filter((permission) =>
    permission.startsWith("android.permission."),
  );
  assert(
    platformPermissions.length === 1 &&
      platformPermissions[0] === "android.permission.INTERNET",
    `android_platform_permissions_changed:${platformPermissions.join(",")}`,
  );
  if (!merged) {
    assert(permissions.length === 1, "source_manifest_permission_changed");
    return;
  }
  assert(
    permissions.every(
      (permission) =>
        permission === "android.permission.INTERNET" ||
        permission ===
          `${expectedAppId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`,
    ),
    `merged_manifest_permission_changed:${permissions.join(",")}`,
  );
}

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await filesBelow(target)));
    if (entry.isFile()) files.push(target);
  }
  return files;
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

function hasKey(value, key) {
  if (Array.isArray(value)) return value.some((item) => hasKey(item, key));
  if (!value || typeof value !== "object") return false;
  if (Object.hasOwn(value, key)) return true;
  return Object.values(value).some((item) => hasKey(item, key));
}

function assert(condition, code) {
  if (!condition) throw new Error(code);
}
