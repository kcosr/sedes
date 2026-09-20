import { describe, expect, it } from "vitest";
import { deferAgentToolAutomationShutdown } from "../../src/server/agent-tools/application/agent-tool-shutdown.js";
import { StartupResourceStack } from "../../src/server/runtime/startup-resource-stack.js";

describe("agent tool automation shutdown", () => {
  it("settles dispatcher work before draining canonical executions", async () => {
    const resources = new StartupResourceStack();
    const order: string[] = [];
    let settleExecution!: () => void;
    const execution = new Promise<void>((resolve) => {
      settleExecution = resolve;
    });
    deferAgentToolAutomationShutdown(resources, {
      closeCanonical: async () => {
        order.push("canonical-draining");
        await execution;
        order.push("canonical-drained");
      },
      disposeDispatcher: async () => {
        order.push("dispatcher-disposing");
        settleExecution();
        await execution;
        order.push("dispatcher-disposed");
      },
    });

    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        resources.dispose(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("shutdown_order_timeout")),
            250,
          );
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    expect(order).toEqual([
      "dispatcher-disposing",
      "dispatcher-disposed",
      "canonical-draining",
      "canonical-drained",
    ]);
  });

  it("drains control-tool executions before their thread mutation dependency closes", async () => {
    const resources = new StartupResourceStack();
    const order: string[] = [];
    let dependencyOpen = true;
    let settleExecution!: () => void;
    const execution = new Promise<void>((resolve) => {
      settleExecution = resolve;
    });

    resources.defer(
      "thread mutations",
      () => {
        expect(order).toContain("canonical-drained");
        dependencyOpen = false;
        order.push("mutations-closed");
      },
      { mode: "ownership_critical" },
    );
    deferAgentToolAutomationShutdown(resources, {
      closeCanonical: async () => {
        order.push("canonical-draining");
        expect(dependencyOpen).toBe(true);
        await execution;
        expect(dependencyOpen).toBe(true);
        order.push("canonical-drained");
      },
      disposeDispatcher: () => {
        order.push("dispatcher-disposed");
        settleExecution();
      },
    });

    await resources.dispose();

    expect(order).toEqual([
      "dispatcher-disposed",
      "canonical-draining",
      "canonical-drained",
      "mutations-closed",
    ]);
  });
});
