import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  timingSafeEqual,
} from "node:crypto";
import type { RequestScope } from "../../identity/identity-provider.js";
import { threadIdSchema } from "../../../shared/protocol/domain.js";

// Permanent capability format identifiers. Already-issued source references
// must remain resolvable after restarts and product renames.
const ENCRYPTION_HKDF_INFO =
  "harness.agent-tool.thread-source-reference.v2.encrypt";
const AUTHENTICATION_HKDF_INFO =
  "harness.agent-tool.thread-source-reference.v2.authenticate";
const TOKEN_PREFIX = "htr2_";
const THREAD_ID_BYTES = 16;
const TAG_BYTES = 32;
const PAYLOAD_BYTES = THREAD_ID_BYTES + TAG_BYTES;
const ENCODED_PAYLOAD_CHARACTERS = 64;
const TOKEN_CHARACTERS = TOKEN_PREFIX.length + ENCODED_PAYLOAD_CHARACTERS;
const ENCODED_PAYLOAD_PATTERN = /^[A-Za-z0-9_-]{64}$/u;

export type ThreadSourceReferenceAudience =
  "management_http" | "execution_environment_sidecar";

export const THREAD_SOURCE_REFERENCE_TOKEN_LENGTH = TOKEN_CHARACTERS;
export const THREAD_SOURCE_REFERENCE_PAYLOAD_BYTES = PAYLOAD_BYTES;

export class ThreadSourceReferenceCodec {
  readonly #encryptionKey: Uint8Array;
  readonly #authenticationKey: Uint8Array;

  constructor(installationKey: Uint8Array) {
    if (installationKey.byteLength !== 32) {
      throw new Error("thread_source_reference_key_invalid");
    }
    this.#encryptionKey = new Uint8Array(
      hkdfSync(
        "sha256",
        installationKey,
        Buffer.alloc(0),
        ENCRYPTION_HKDF_INFO,
        32,
      ),
    );
    this.#authenticationKey = new Uint8Array(
      hkdfSync(
        "sha256",
        installationKey,
        Buffer.alloc(0),
        AUTHENTICATION_HKDF_INFO,
        32,
      ),
    );
  }

  issue(
    scope: RequestScope,
    threadId: string,
    audience: ThreadSourceReferenceAudience,
  ): string {
    const canonicalThreadId = parseThreadId(threadId);
    const threadBytes = uuidBytes(canonicalThreadId);
    if (threadBytes.byteLength !== THREAD_ID_BYTES) {
      throw new Error("thread_source_reference_thread_id_invalid");
    }
    const context = referenceContext(scope, audience);
    const cipher = createCipheriv(
      "aes-256-ecb",
      contextualEncryptionKey(this.#encryptionKey, context),
      null,
    );
    cipher.setAutoPadding(false);
    const ciphertext = Buffer.concat([
      cipher.update(threadBytes),
      cipher.final(),
    ]);
    const tag = authenticationTag(this.#authenticationKey, context, ciphertext);
    const payload = Buffer.concat([ciphertext, tag]);
    if (payload.byteLength !== PAYLOAD_BYTES) {
      throw new Error("thread_source_reference_payload_invalid");
    }
    const encoded = payload.toString("base64url");
    if (encoded.length !== ENCODED_PAYLOAD_CHARACTERS) {
      throw new Error("thread_source_reference_encoding_invalid");
    }
    return `${TOKEN_PREFIX}${encoded}`;
  }

  resolve(
    scope: RequestScope,
    token: string,
    audience: ThreadSourceReferenceAudience,
  ): string {
    if (token.length !== TOKEN_CHARACTERS || !token.startsWith(TOKEN_PREFIX)) {
      throw new Error("thread_source_reference_invalid");
    }
    const encoded = token.slice(TOKEN_PREFIX.length);
    if (!ENCODED_PAYLOAD_PATTERN.test(encoded)) {
      throw new Error("thread_source_reference_invalid");
    }
    const payload = Buffer.from(encoded, "base64url");
    if (
      payload.byteLength !== PAYLOAD_BYTES ||
      payload.toString("base64url") !== encoded
    ) {
      throw new Error("thread_source_reference_invalid");
    }

    const ciphertext = payload.subarray(0, THREAD_ID_BYTES);
    const tag = payload.subarray(PAYLOAD_BYTES - TAG_BYTES);
    const context = referenceContext(scope, audience);
    const expectedTag = authenticationTag(
      this.#authenticationKey,
      context,
      ciphertext,
    );
    if (!timingSafeEqual(tag, expectedTag)) {
      throw new Error("thread_source_reference_invalid");
    }
    const decipher = createDecipheriv(
      "aes-256-ecb",
      contextualEncryptionKey(this.#encryptionKey, context),
      null,
    );
    decipher.setAutoPadding(false);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    if (plaintext.byteLength !== THREAD_ID_BYTES) {
      throw new Error("thread_source_reference_invalid");
    }
    return parseThreadId(uuidFromBytes(plaintext));
  }
}

function contextualEncryptionKey(key: Uint8Array, context: Buffer): Buffer {
  return createHmac("sha256", key).update(context).digest();
}

function authenticationTag(
  key: Uint8Array,
  context: Buffer,
  ciphertext: Buffer,
): Buffer {
  return createHmac("sha256", key).update(context).update(ciphertext).digest();
}

function uuidBytes(value: string): Buffer {
  const encoded = Buffer.from(value.replaceAll("-", ""), "hex");
  if (encoded.byteLength !== THREAD_ID_BYTES) {
    throw new Error("thread_source_reference_thread_id_invalid");
  }
  return encoded;
}

function uuidFromBytes(value: Buffer): string {
  const hex = value.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function parseThreadId(threadId: string): string {
  const parsed = threadIdSchema.safeParse(threadId);
  if (!parsed.success) {
    throw new Error("thread_source_reference_thread_id_invalid");
  }
  return parsed.data;
}

function referenceContext(
  scope: RequestScope,
  audience: ThreadSourceReferenceAudience,
): Buffer {
  const tenant = boundedScopePart(scope.tenantId);
  const principal = boundedScopePart(scope.principalId);
  const output = Buffer.allocUnsafe(
    1 + 2 + tenant.byteLength + 2 + principal.byteLength + 1,
  );
  let offset = 0;
  output.writeUInt8(2, offset++);
  output.writeUInt16BE(tenant.byteLength, offset);
  offset += 2;
  tenant.copy(output, offset);
  offset += tenant.byteLength;
  output.writeUInt16BE(principal.byteLength, offset);
  offset += 2;
  principal.copy(output, offset);
  offset += principal.byteLength;
  output.writeUInt8(audience === "management_http" ? 1 : 2, offset);
  return output;
}

function boundedScopePart(value: string): Buffer {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.byteLength < 1 || encoded.byteLength > 0xffff) {
    throw new Error("thread_source_reference_scope_invalid");
  }
  return encoded;
}
