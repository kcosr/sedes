import { createHash } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";

/** Effective provider-native home selected by the Grok installation. */
export function effectiveGrokNativeHome(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const home = environment.HOME ?? homedir();
  const nativeHome = environment.GROK_HOME ?? path.join(home, ".grok");
  if (
    nativeHome.length === 0 ||
    Buffer.byteLength(nativeHome) > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(nativeHome) ||
    !path.isAbsolute(nativeHome) ||
    path.resolve(nativeHome) !== nativeHome
  ) {
    throw new Error("grok_native_home_invalid");
  }
  return nativeHome;
}

/**
 * Opaque discovery namespace only. This neither inspects the native home nor
 * claims that its current account identity has been verified.
 */
export function grokNativeNamespaceKey(
  executionEnvironmentId: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  if (
    executionEnvironmentId.length === 0 ||
    Buffer.byteLength(executionEnvironmentId) > 1_024 ||
    /[\u0000-\u001f\u007f-\u009f]/u.test(executionEnvironmentId)
  ) {
    throw new Error("grok_native_namespace_scope_invalid");
  }
  const identity = createHash("sha256")
    // This is a durable opaque namespace, not a product-facing label. Existing
    // binding details persist its exact value, so the original domain must stay
    // byte-stable across the Harness-to-Sedes product rename.
    .update("harness.grok.native-discovery.v1\n")
    .update(
      JSON.stringify([
        executionEnvironmentId,
        effectiveGrokNativeHome(environment),
      ]),
    )
    .digest("base64url");
  return `grok:${identity}`;
}
