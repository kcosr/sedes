/**
 * Durable Codex submission retry anchors: a bounded fingerprint of the
 * thread's terminal turn captured before a mutation, compared afterwards to
 * decide whether a retried submission could duplicate accepted work.
 */
import { createHash } from "node:crypto";
import type { CodexThread } from "./codex-c1-protocol.js";
import { codexError } from "./codex-conversation-errors.js";

const MAXIMUM_RETRY_ANCHOR_BYTES = 4_096;
const RETRY_ANCHOR_PREFIX = "codex-retry-anchor:";

type CodexSubmissionRetryAnchor = {
  readonly version: 2;
  readonly threadId: string;
  readonly historyMode: "legacy" | "paginated";
  readonly terminalTurnId: string | null;
  readonly terminalIdentityDigest: string;
};

export function serializeCodexSubmissionRetryAnchor(
  thread: CodexThread,
): string {
  return serializeCodexSubmissionRetryAnchorWithDomain(
    thread,
    "sedes.codex-terminal-identity.v1\0",
  );
}

function serializeCodexSubmissionRetryAnchorWithDomain(
  thread: CodexThread,
  terminalIdentityDomain: string,
): string {
  const terminalTurn = thread.turns.at(-1);
  const anchor: CodexSubmissionRetryAnchor = {
    version: 2,
    threadId: thread.id,
    historyMode: thread.historyMode,
    terminalTurnId: terminalTurn?.id ?? null,
    terminalIdentityDigest: terminalTurnIdentityDigest(
      terminalTurn,
      terminalIdentityDomain,
    ),
  };
  const encoded = Buffer.from(JSON.stringify(anchor), "utf8").toString(
    "base64url",
  );
  const serialized = `${RETRY_ANCHOR_PREFIX}${encoded}`;
  if (Buffer.byteLength(serialized, "utf8") > MAXIMUM_RETRY_ANCHOR_BYTES) {
    throw codexError(
      "internal",
      "Codex could not capture a bounded submission retry anchor.",
      "codex_submission_anchor_oversized",
    );
  }
  return serialized;
}

export function codexSubmissionRetryAnchorMatches(
  serialized: string,
  thread: CodexThread,
): boolean {
  const anchor = parseCodexSubmissionRetryAnchor(serialized);
  if (!anchor) return false;
  const current = serializeCodexSubmissionRetryAnchor(thread);
  if (current === serialized) return true;
  // Pre-rename v2 anchors are durable retry evidence. Recompute their exact
  // historical bytes only for comparison; newly captured anchors stay Sedes.
  return (
    serializeCodexSubmissionRetryAnchorWithDomain(
      thread,
      "harness.codex-terminal-identity.v1\0",
    ) === serialized
  );
}

function parseCodexSubmissionRetryAnchor(
  serialized: string,
): CodexSubmissionRetryAnchor | undefined {
  if (
    !serialized.startsWith(RETRY_ANCHOR_PREFIX) ||
    Buffer.byteLength(serialized, "utf8") > MAXIMUM_RETRY_ANCHOR_BYTES
  ) {
    return undefined;
  }
  const encoded = serialized.slice(RETRY_ANCHOR_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/u.test(encoded)) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Object.keys(decoded).length !== 5 ||
    !("version" in decoded) ||
    decoded.version !== 2 ||
    !("threadId" in decoded) ||
    typeof decoded.threadId !== "string" ||
    decoded.threadId.length === 0 ||
    !("historyMode" in decoded) ||
    (decoded.historyMode !== "legacy" && decoded.historyMode !== "paginated") ||
    !("terminalTurnId" in decoded) ||
    (decoded.terminalTurnId !== null &&
      (typeof decoded.terminalTurnId !== "string" ||
        decoded.terminalTurnId.length === 0)) ||
    !("terminalIdentityDigest" in decoded) ||
    typeof decoded.terminalIdentityDigest !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(decoded.terminalIdentityDigest)
  ) {
    return undefined;
  }
  return decoded as CodexSubmissionRetryAnchor;
}

function terminalTurnIdentityDigest(
  turn: CodexThread["turns"][number] | undefined,
  domain: string,
) {
  const hash = createHash("sha256").update(domain);
  if (!turn) return hash.update("empty").digest("base64url");
  hash
    .update(turn.id)
    .update("\0")
    .update(turn.status)
    .update("\0")
    .update(turn.error?.message ?? "");
  for (const item of turn.items) {
    hash
      .update("\0")
      .update(item.type)
      .update("\0")
      .update(item.id)
      .update("\0");
    if ("status" in item && typeof item.status === "string") {
      hash.update(item.status);
    }
  }
  return hash.digest("base64url");
}
