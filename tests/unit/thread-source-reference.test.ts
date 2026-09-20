import { describe, expect, it } from "vitest";
import {
  THREAD_SOURCE_REFERENCE_PAYLOAD_BYTES,
  THREAD_SOURCE_REFERENCE_TOKEN_LENGTH,
  ThreadSourceReferenceCodec,
} from "../../src/server/agent-tools/application/thread-source-reference.js";

const key = new Uint8Array(32).fill(0x42);
const scope = { tenantId: "tenant-1", principalId: "principal-1" };
const threadId = "019196f7-a0a8-7bc4-a89b-8cf013978405";

describe("ThreadSourceReferenceCodec", () => {
  it("emits one stable opaque reference and resolves it after reconstruction", () => {
    const firstCodec = new ThreadSourceReferenceCodec(key);
    const first = firstCodec.issue(scope, threadId, "management_http");
    const second = firstCodec.issue(scope, threadId, "management_http");

    expect(first).toHaveLength(THREAD_SOURCE_REFERENCE_TOKEN_LENGTH);
    expect(first).toMatch(/^htr2_[A-Za-z0-9_-]{64}$/u);
    expect(Buffer.from(first.slice(5), "base64url")).toHaveLength(
      THREAD_SOURCE_REFERENCE_PAYLOAD_BYTES,
    );
    expect(first).toBe(second);
    expect(first).toBe(
      "htr2_ORSmjitr9YABylsJ2JXE03FVnmrhlQC-WrIK1T94FbR-xbWdaxHmKvY8h2SHSr-9",
    );
    expect(first).not.toContain(threadId);

    const restarted = new ThreadSourceReferenceCodec(key);
    expect(restarted.resolve(scope, first, "management_http")).toBe(threadId);
    expect(restarted.resolve(scope, second, "management_http")).toBe(threadId);
    expect(
      restarted.issue(scope, threadId, "execution_environment_sidecar"),
    ).not.toBe(first);
  });

  it.each([
    [
      "wrong installation key",
      new ThreadSourceReferenceCodec(new Uint8Array(32).fill(9)),
      scope,
      "management_http" as const,
    ],
    [
      "wrong tenant",
      new ThreadSourceReferenceCodec(key),
      { ...scope, tenantId: "tenant-2" },
      "management_http" as const,
    ],
    [
      "wrong principal",
      new ThreadSourceReferenceCodec(key),
      { ...scope, principalId: "principal-2" },
      "management_http" as const,
    ],
    [
      "wrong audience",
      new ThreadSourceReferenceCodec(key),
      scope,
      "execution_environment_sidecar" as const,
    ],
  ])("rejects the %s", (_label, decoder, candidateScope, audience) => {
    const token = new ThreadSourceReferenceCodec(key).issue(
      scope,
      threadId,
      "management_http",
    );
    expect(() => decoder.resolve(candidateScope, token, audience)).toThrow();
  });

  it("rejects tampering, noncanonical framing, old values, and invalid thread ids", () => {
    const codec = new ThreadSourceReferenceCodec(key);
    const token = codec.issue(scope, threadId, "management_http");
    const replacement = token.at(-1) === "A" ? "B" : "A";

    expect(() =>
      codec.resolve(
        scope,
        `${token.slice(0, -1)}${replacement}`,
        "management_http",
      ),
    ).toThrow();
    expect(() =>
      codec.resolve(scope, `${token}=`, "management_http"),
    ).toThrow();
    expect(() =>
      codec.resolve(scope, "a".repeat(43), "management_http"),
    ).toThrow();
    expect(() =>
      codec.resolve(scope, `htr1_${"a".repeat(88)}`, "management_http"),
    ).toThrow();
    expect(() =>
      codec.issue(scope, "not-a-thread-id", "management_http"),
    ).toThrow();
  });
});
