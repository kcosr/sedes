import { describe, expect, it } from "vitest";
import { ClaudeOperationalNoticeProjector } from "../../src/server/backends/claude/claude-operational-notices.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-08-23T12:00:00.000Z");

function projector() {
  return new ClaudeOperationalNoticeProjector(SESSION_ID);
}

function envelope(uuid: string) {
  return { uuid, session_id: SESSION_ID };
}

describe("Claude operational notices", () => {
  it("projects and deduplicates bounded API retry notices", () => {
    const subject = projector();
    const message = {
      type: "system",
      subtype: "api_retry",
      attempt: 2,
      max_retries: 5,
      retry_delay_ms: 1_250,
      error_status: 529,
      error: "overloaded",
      ...envelope("22222222-2222-4222-8222-222222222222"),
    };

    expect(subject.project(message, NOW)).toEqual({
      id: "claude-notice:22222222-2222-4222-8222-222222222222",
      tone: "info",
      message: {
        text: "Claude API request failed (overloaded); retrying 2/5 in 2s.",
      },
      createdAt: "2026-08-23T12:00:00.000Z",
    });
    expect(subject.project(message, NOW + 1)).toBeUndefined();
  });

  it.each([
    {
      status: "allowed_warning",
      tone: "warning",
      text: "Claude usage is approaching its current limit.",
    },
    {
      status: "rejected",
      tone: "error",
      text: "Claude usage is currently limited; new requests may be rejected.",
    },
  ])("projects the $status rate-limit state", ({ status, tone, text }) => {
    expect(
      projector().project(
        {
          type: "rate_limit_event",
          rate_limit_info: { status },
          ...envelope(`rate-${status}`),
        },
        NOW,
      ),
    ).toMatchObject({ tone, message: { text } });
  });

  it("suppresses allowed rate-limit state", () => {
    expect(
      projector().project(
        {
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed" },
          ...envelope("rate-allowed"),
        },
        NOW,
      ),
    ).toBeUndefined();
  });

  it.each([
    ["notice", false, "info"],
    ["suggestion", false, "info"],
    ["warning", false, "warning"],
    ["notice", true, "warning"],
  ] as const)(
    "projects %s informational output with prevent=%s",
    (level, preventContinuation, tone) => {
      expect(
        projector().project(
          {
            type: "system",
            subtype: "informational",
            content: "Claude operational detail",
            level,
            prevent_continuation: preventContinuation,
            ...envelope(`informational-${level}-${preventContinuation}`),
          },
          NOW,
        ),
      ).toMatchObject({
        tone,
        message: { text: "Claude operational detail" },
      });
    },
  );

  it("suppresses transcript-only info output", () => {
    expect(
      projector().project(
        {
          type: "system",
          subtype: "informational",
          content: "verbose transcript detail",
          level: "info",
          ...envelope("informational-info"),
        },
        NOW,
      ),
    ).toBeUndefined();
  });

  it.each([
    {
      type: "system",
      subtype: "api_retry",
      attempt: 0,
      max_retries: 5,
      retry_delay_ms: 10,
      error_status: 529,
      error: "overloaded",
      ...envelope("invalid-attempt"),
    },
    {
      type: "rate_limit_event",
      rate_limit_info: { status: "future_status" },
      ...envelope("invalid-rate"),
    },
    {
      type: "system",
      subtype: "informational",
      content: "x".repeat(128 * 1_024 + 1),
      level: "warning",
      ...envelope("oversized-informational"),
    },
    {
      type: "system",
      subtype: "informational",
      content: "wrong session",
      level: "warning",
      uuid: "wrong-session",
      session_id: "22222222-2222-4222-8222-222222222222",
    },
  ])("rejects malformed, oversized, or wrong-scope input", (message) => {
    expect(projector().project(message, NOW)).toBeUndefined();
  });

  it.each([
    {
      type: "tool_progress",
      tool_use_id: "tool-a",
      elapsed_time_seconds: 1,
    },
    { type: "system", subtype: "task_started", task_id: "task-a" },
    { type: "system", subtype: "task_progress", task_id: "task-a" },
    { type: "system", subtype: "task_updated", task_id: "task-a" },
    { type: "system", subtype: "task_notification", task_id: "task-a" },
    { type: "system", subtype: "background_tasks_changed", tasks: [] },
    { type: "tool_use_summary", summary: "Tool summary" },
    {
      type: "assistant",
      parent_tool_use_id: "parent-tool",
      message: { role: "assistant", content: [] },
    },
  ])(
    "keeps non-recoverable task and child telemetry out of notices",
    (body) => {
      expect(
        projector().project(
          {
            ...body,
            ...envelope(
              `ignored-${body.type}-${"subtype" in body ? body.subtype : "message"}`,
            ),
          },
          NOW,
        ),
      ).toBeUndefined();
    },
  );
});
