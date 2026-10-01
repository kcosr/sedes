import { it } from "vitest";
import { parseLiveInput, readLiveCredential } from "../support/opencode-live-gate.js";
import { runOpenCodeReadonlyGate } from "../support/opencode-live-gate-runner.js";

it.runIf(process.env.SEDES_RUN_LIVE_OPENCODE === "1")("qualifies one explicitly selected live provider/model with a read-only canary", async () => {
  const input = parseLiveInput(process.env);
  const credential = readLiveCredential(input, name => process.env[name]);
  await runOpenCodeReadonlyGate(input, credential);
}, 180_000);
