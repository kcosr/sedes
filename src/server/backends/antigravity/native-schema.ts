import { z } from "zod";
import { MAXIMUM_PROVIDER_FRAME_BYTES } from "../../provider-protocol/transport/framed-message-limits.js";

// Execution-host/private projection of the native SQLite protobuf store. These
// types never cross the backend boundary into the browser protocol.
const text = z.string().max(MAXIMUM_PROVIDER_FRAME_BYTES);
const id = z.string().min(1).max(512);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const tool = z.strictObject({ id, name: z.string().max(512), argumentsJson: text });
export const antigravityNativeStepSchema = z.strictObject({
  index: count,
  type: count,
  status: count,
  hasSubtrajectory: z.boolean(),
  subtrajectoryState: z.enum(["active", "terminal", "unknown"]).optional(),
  task: z.strictObject({ id, title: z.string().max(4096), description: text, daemon: z.boolean() }).optional(),
  continuation: z.strictObject({ id, recipient: id, sender: id, kind: z.enum(["task_notification", "agent_message"]), content: text }).optional(),
  subagents: z.array(z.strictObject({ sessionId: z.string().uuid(), state: z.enum(["active", "terminal", "cancelled", "failed", "unknown"]), revision: z.string().regex(/^[a-f0-9]{64}$/u).optional() })).max(32).optional(),
  schedule: z.strictObject({ mode: z.string().max(512), outcome: z.string().max(512), iterations: count }).optional(),
  createdAt: z.iso.datetime().optional(),
  startedAt: z.iso.datetime().optional(),
  completedAt: z.iso.datetime().optional(),
  executionId: id.optional(),
  standaloneSystemDiagnostic: z.literal(true).optional(),
  failedSubagentSessionId: z.string().uuid().optional(),
  isInterruptingStep: z.literal(true).optional(),
  user: z.strictObject({ text, clientMessageId: z.string().max(4096).optional(), isQueuedMessage: z.literal(true).optional() }).optional(),
  response: z.strictObject({ text, thinking: text, messageId: z.string().max(512).optional(),
    stopReason: count, toolCalls: z.array(tool).max(1000) }).optional(),
  tool: tool.extend({ result: text.optional(), summary: text.optional() }).optional(),
  command: z.strictObject({ command: text, cwd: z.string().max(4096), commandId: z.string().max(512).optional(),
    exitCode: z.number().int().optional(), output: text, persistent: z.boolean() }).optional(),
  commandStatus: z.strictObject({ commandId: id, status: count, exitCode: z.number().int().optional(), output: text }).optional(),
  error: text.optional(),
  usage: z.strictObject({ inputTokens: count, outputTokens: count, cacheReadTokens: count,
    cacheWriteTokens: count, thinkingTokens: count }).optional(),
});
export const antigravityNativeHistorySchema = z.strictObject({
  steps: z.array(antigravityNativeStepSchema).max(100_000),
  executions: z.array(z.strictObject({
    executionId: id,
    lastStepIndex: z.number().int().min(-1).max(Number.MAX_SAFE_INTEGER),
    terminationReason: count,
    proceededWithAutoContinue: z.boolean(),
  })).max(100_000),
  parentSessionId: z.string().uuid().optional(),
  revision: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type AntigravityNativeStep = z.infer<typeof antigravityNativeStepSchema>;
export type AntigravityNativeHistory = z.infer<typeof antigravityNativeHistorySchema>;
