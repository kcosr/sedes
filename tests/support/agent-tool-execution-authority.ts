import type { ThreadRuntimeCoordinator } from "../../src/server/events/thread-runtime-coordinator.js";

/** Actor-free fixtures use this mock; coordinator and OpenCode tests cover real runtime retention. */
export const testAgentToolExecutionAuthority: Pick<ThreadRuntimeCoordinator, "acquireAgentToolExecutionAuthority"> = {
  async acquireAgentToolExecutionAuthority() {
    return {generation: "test-generation",signal: new AbortController().signal,isCurrent: () => true,release() {}};
  },
};
