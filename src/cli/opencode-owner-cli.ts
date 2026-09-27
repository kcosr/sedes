import path from "node:path";
import { inspectOpenCodeNativeStoreOwner, recoverOpenCodeNativeStoreOwner } from "../server/backends/opencode/opencode-native-store.js";
import { OpenCodeRuntimeError } from "../server/backends/opencode/opencode-release.js";
import type { SedesCliIo } from "./sedes-cli.js";

const usage = `Usage:
  sedes opencode-owner inspect --store /absolute/canonical/opencode.db
  sedes opencode-owner recover --store /absolute/canonical/opencode.db --expected-inspection FINGERPRINT [--terminate-owned-descendants]

Run on the Linux execution host as the account that owns the OpenCode store.
Inspect is read-only. Recover requires a dead Sedes owner and the exact inspected
fingerprint. Owned descendants are terminated only with the explicit flag.
External OpenCode daemons are never signalled. Ambiguous records stay fenced.
`;

class UsageError extends Error {}

function parse(arguments_: readonly string[]) {
  const action = arguments_[0];
  if (action !== "inspect" && action !== "recover") throw new UsageError();
  let store: string | undefined, fingerprint: string | undefined;
  let terminateOwnedDescendants = false;
  for (let index = 1; index < arguments_.length; index++) {
    const option = arguments_[index];
    if (option === "--store" && store === undefined) store = arguments_[++index];
    else if (action === "recover" && option === "--expected-inspection" && fingerprint === undefined) fingerprint = arguments_[++index];
    else if (action === "recover" && option === "--terminate-owned-descendants" && !terminateOwnedDescendants) terminateOwnedDescendants = true;
    else throw new UsageError();
    if ((option === "--store" && store === undefined) || (option === "--expected-inspection" && fingerprint === undefined)) throw new UsageError();
  }
  if (!store || store.length > 4_096 || store.includes("\0") || !path.posix.isAbsolute(store) || path.posix.normalize(store) !== store ||
      (action === "recover" && !/^[a-f0-9]{64}$/u.test(fingerprint ?? ""))) throw new UsageError();
  return { action, store, fingerprint, terminateOwnedDescendants };
}

/** Operator command, independent of agent-tool endpoint, credentials or CLI mode. */
export async function runOpenCodeOwnerCli(arguments_: readonly string[], io: SedesCliIo): Promise<number> {
  if (arguments_.length === 1 && arguments_[0] === "--help") { io.stdout.write(usage); return 0; }
  try {
    const input = parse(arguments_);
    if (process.platform !== "linux") throw new OpenCodeRuntimeError("opencode_platform_unsupported");
    if (input.action === "inspect") {
      const { record, fingerprint } = await inspectOpenCodeNativeStoreOwner(input.store);
      // Do not print the token or process marker. They belong to the persisted
      // fence, not to the operator's copy/paste recovery contract.
      io.stdout.write(`${JSON.stringify({ store: record.canonicalStorePath, ownership: record.ownership,
        hostIncarnation: record.hostIncarnation, ownerPid: record.process.pid, inspectionFingerprint: fingerprint })}\n`);
    } else {
      await recoverOpenCodeNativeStoreOwner({ canonicalStorePath: input.store,
        expectedInspectionFingerprint: input.fingerprint!, terminateOwnedDescendants: input.terminateOwnedDescendants });
      io.stdout.write(`${JSON.stringify({ store: input.store, recovered: true })}\n`);
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) { io.stderr.write(usage); return 2; }
    const allowed = new Set(["opencode_platform_unsupported", "opencode_native_store_recovery_required",
      "opencode_native_store_recovery_changed", "opencode_native_store_already_owned", "opencode_native_store_release_unproved"]);
    const code = error instanceof OpenCodeRuntimeError && allowed.has(error.code) ? error.code : "opencode_native_store_recovery_required";
    io.stderr.write(`${code}: OpenCode owner recovery was not completed; preserve the owner record and inspect the execution host.\n`);
    return 1;
  }
}
