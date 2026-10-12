import { registerPlugin } from "@capacitor/core";
import { isAndroidClient } from "./client-platform.js";

interface PageSafetyPlugin {
  capabilities(): Promise<{ readonly safeFrames: boolean }>;
}

const pageSafety = registerPlugin<PageSafetyPlugin>("PageSafety");
const NATIVE_HANDSHAKE_TIMEOUT_MS = 3_000;

async function boundedNativeCall<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("page_safety_unavailable")), NATIVE_HANDSHAKE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A failed or unsupported Android native bridge must never mount HTML. */
export async function supportsSafePageFrames(): Promise<boolean> {
  if (!isAndroidClient()) return true;
  try {
    return (await boundedNativeCall(pageSafety.capabilities())).safeFrames === true;
  } catch {
    return false;
  }
}
