import {
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import type {
  BackingState,
  InventoryState,
} from "./legacy-domain.js";
import type { RequestScope } from "../../../src/server/identity/identity-provider.js";
import { DomainError } from "../../../src/server/domain/errors.js";

export type ThreadCursorPayload = {
  inventoryState: InventoryState;
  backingState: BackingState | null;
  searchHash: string;
  generation: number;
  primarySort: number;
  threadId: string;
};

type EncodedCursor = ThreadCursorPayload & {
  version: 1;
  scope: string;
};

function encodeBase64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function normalizeSearch(value: string): string {
  return value.trim().toLocaleLowerCase("en-US");
}

export function hashSearch(value: string): string {
  return createHash("sha256").update(normalizeSearch(value)).digest("hex");
}

export class ThreadCursorCodec {
  readonly #secret: Buffer;

  constructor(secret: Buffer) {
    if (secret.byteLength < 32) {
      throw new Error("Cursor signing secret must contain at least 32 bytes.");
    }
    this.#secret = Buffer.from(secret);
  }

  encode(scope: RequestScope, payload: ThreadCursorPayload): string {
    const encoded: EncodedCursor = {
      version: 1,
      scope: this.#scopeFingerprint(scope),
      ...payload,
    };
    const body = encodeBase64Url(JSON.stringify(encoded));
    const signature = this.#sign(body);
    return `${body}.${signature}`;
  }

  decode(
    scope: RequestScope,
    token: string,
    expected: Pick<
      ThreadCursorPayload,
      "inventoryState" | "backingState" | "searchHash" | "generation"
    >,
  ): ThreadCursorPayload {
    const pieces = token.split(".");
    const body = pieces[0];
    const signature = pieces[1];
    if (!body || !signature || pieces.length !== 2) {
      throw this.#invalid();
    }
    const expectedSignature = this.#sign(body);
    const actualBytes = Buffer.from(signature);
    const expectedBytes = Buffer.from(expectedSignature);
    if (
      actualBytes.byteLength !== expectedBytes.byteLength ||
      !timingSafeEqual(actualBytes, expectedBytes)
    ) {
      throw this.#invalid();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      throw this.#invalid();
    }
    if (!this.#isEncodedCursor(parsed)) {
      throw this.#invalid();
    }
    if (
      parsed.scope !== this.#scopeFingerprint(scope) ||
      parsed.inventoryState !== expected.inventoryState ||
      parsed.backingState !== expected.backingState ||
      parsed.searchHash !== expected.searchHash ||
      parsed.generation !== expected.generation
    ) {
      throw this.#invalid();
    }
    return {
      inventoryState: parsed.inventoryState,
      backingState: parsed.backingState,
      searchHash: parsed.searchHash,
      generation: parsed.generation,
      primarySort: parsed.primarySort,
      threadId: parsed.threadId,
    };
  }

  #sign(body: string): string {
    return createHmac("sha256", this.#secret).update(body).digest("base64url");
  }

  #scopeFingerprint(scope: RequestScope): string {
    return createHmac("sha256", this.#secret)
      .update(scope.tenantId)
      .update("\0")
      .update(scope.principalId)
      .digest("base64url");
  }

  #isEncodedCursor(value: unknown): value is EncodedCursor {
    if (!value || typeof value !== "object") {
      return false;
    }
    const candidate = value as Partial<EncodedCursor>;
    return (
      candidate.version === 1 &&
      typeof candidate.scope === "string" &&
      ["active", "snoozed", "settled", "archived"].includes(
        String(candidate.inventoryState),
      ) &&
      (candidate.backingState === null ||
        ["draft", "materializing", "native", "materialization_failed"].includes(
          String(candidate.backingState),
        )) &&
      typeof candidate.searchHash === "string" &&
      candidate.searchHash.length === 64 &&
      Number.isSafeInteger(candidate.generation) &&
      Number.isSafeInteger(candidate.primarySort) &&
      typeof candidate.threadId === "string"
    );
  }

  #invalid(): DomainError {
    return new DomainError(
      "cursor_invalid",
      "The thread list changed; refresh the list.",
    );
  }
}
