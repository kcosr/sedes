import type { CodexThread } from "../../src/server/backends/codex/codex-c1-protocol.js";

export const benchmarkTurns = 100;
export const benchmarkMessageCharacters = 32_768;
export const benchmarkStreamItems = 60;

export function benchmarkHistory(thread: CodexThread): CodexThread {
  const paragraph = "The workspace inspection identified a bounded update to the request lifecycle. Keep ownership checks at the service boundary and verify the resulting state before publishing events.\n\n";
  return {
    ...thread,
    historyMode: "legacy",
    status: { type: "idle" },
    turns: Array.from({ length: benchmarkTurns }, (_, index) => ({
      id: `benchmark-turn-${index}`,
      itemsView: "full",
      status: "completed",
      error: null,
      startedAt: 1_700_020_000 + index,
      completedAt: 1_700_020_001 + index,
      durationMs: 1_000,
      items: [
        { type: "userMessage", id: `benchmark-user-${index}`, clientId: null,
          content: [{ type: "text", text: `Review checkpoint ${index} and explain the implementation.`, text_elements: [] }] },
        { type: "commandExecution", id: `benchmark-command-${index}`, pluginId: null, scriptPath: null,
          command: `rg --files src/server/workspaces/checkpoint-${index}`, cwd: thread.cwd,
          processId: null, source: "agent", status: "completed", commandActions: [],
          aggregatedOutput: `src/server/workspaces/checkpoint-${index}/service.ts\n`, exitCode: 0, durationMs: 23 },
        { type: "agentMessage", id: `benchmark-agent-${index}`, phase: "final_answer", memoryCitation: null, delivery: null, questions: null,
          text: `## Checkpoint ${index}\n\n\`src/server/workspaces/service.ts\`\n\n\`\`\`ts\nexport const checkpoint = ${index};\n\`\`\`\n\n` + paragraph.repeat(Math.ceil(benchmarkMessageCharacters / paragraph.length)).slice(0, benchmarkMessageCharacters) },
      ],
    })),
  };
}
