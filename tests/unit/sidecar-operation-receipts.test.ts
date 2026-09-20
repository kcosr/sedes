import { expect, it } from "vitest";
import { SidecarOperationReceipts } from "../../src/server/sidecar/sidecar-operation-receipts.js";

it("keeps automatic retention but permits forced release only after admitted writes finish", async () => {
  const receipts = new SidecarOperationReceipts();
  let complete!: () => void;
  const execution = receipts.run("operation", { content: "private content" }, async () => await new Promise<void>(resolve => { complete = resolve; }));
  await Promise.resolve();
  await expect(receipts.stop(false)).rejects.toThrow("handoff_pending");
  let stopped = false;
  const stopping = receipts.stop(true).then(() => { stopped = true; });
  await expect(receipts.run("new", {}, async () => {})).rejects.toThrow("operation_stopped");
  expect(stopped).toBe(false);
  complete(); await execution; await stopping;
  expect(receipts.abandonmentEvidence()).toMatchObject({ operations: [{ operationId: "operation", state: "succeeded" }] });
  expect(JSON.stringify(receipts.abandonmentEvidence())).not.toContain("private content");
});
