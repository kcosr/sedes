import {
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

// Permanent credential format identifier. Existing verifiers cannot be
// re-derived after issuance because the client secret is not persisted.
const HKDF_INFO = "harness.agent-tool.principal-client-verifier.v1";
const TOKEN_PREFIX = "hatc1_";
const SECRET_BYTES = 32;
const SECRET_CHARACTERS = 43;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const GENERATION_PATTERN = /^(?:[1-9]|[1-9][0-9]{1,9})$/u;
const TOKEN_PATTERN =
  /^hatc1_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})_([1-9][0-9]{0,9})_([A-Za-z0-9_-]{43})$/u;

export const PRINCIPAL_AGENT_TOOL_CLIENT_CREDENTIAL_MINIMUM_LENGTH = 88;
export const PRINCIPAL_AGENT_TOOL_CLIENT_CREDENTIAL_MAXIMUM_LENGTH = 97;
export const PRINCIPAL_AGENT_TOOL_CLIENT_MAXIMUM_GENERATION = 0xffff_ffff;

export interface ParsedPrincipalAgentToolClientCredential {
  readonly clientId: string;
  readonly generation: number;
  readonly secret: Uint8Array;
}

export interface IssuedPrincipalAgentToolClientCredential {
  readonly clientId: string;
  readonly generation: number;
  readonly credential: string;
  readonly verifier: Uint8Array;
}

export function parsePrincipalAgentToolClientCredential(
  credential: string,
): ParsedPrincipalAgentToolClientCredential | undefined {
  if (
    typeof credential !== "string" ||
    credential.length < PRINCIPAL_AGENT_TOOL_CLIENT_CREDENTIAL_MINIMUM_LENGTH ||
    credential.length > PRINCIPAL_AGENT_TOOL_CLIENT_CREDENTIAL_MAXIMUM_LENGTH ||
    !credential.startsWith(TOKEN_PREFIX)
  ) {
    return undefined;
  }
  const match = TOKEN_PATTERN.exec(credential);
  if (!match) return undefined;
  const [, clientId, generationText, encodedSecret] = match;
  if (
    !clientId ||
    !generationText ||
    !encodedSecret ||
    !UUID_PATTERN.test(clientId) ||
    !GENERATION_PATTERN.test(generationText) ||
    !SECRET_PATTERN.test(encodedSecret)
  ) {
    return undefined;
  }
  const generation = Number(generationText);
  if (
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    generation > PRINCIPAL_AGENT_TOOL_CLIENT_MAXIMUM_GENERATION
  ) {
    return undefined;
  }
  const secret = Buffer.from(encodedSecret, "base64url");
  if (
    secret.byteLength !== SECRET_BYTES ||
    secret.toString("base64url") !== encodedSecret
  ) {
    return undefined;
  }
  return Object.freeze({
    clientId,
    generation,
    secret: new Uint8Array(secret),
  });
}

export function isCanonicalPrincipalAgentToolClientId(
  clientId: string,
): boolean {
  return UUID_PATTERN.test(clientId);
}

export class PrincipalAgentToolClientCredentialCodec {
  readonly #verifierKey: Uint8Array;

  constructor(installationKey: Uint8Array) {
    if (installationKey.byteLength !== 32) {
      throw new Error("principal_agent_tool_client_key_invalid");
    }
    this.#verifierKey = new Uint8Array(
      hkdfSync(
        "sha256",
        installationKey,
        Buffer.alloc(0),
        HKDF_INFO,
        32,
      ),
    );
  }

  issue(
    generation = 1,
    clientId: string = randomUUID(),
  ): IssuedPrincipalAgentToolClientCredential {
    assertClientId(clientId);
    assertGeneration(generation);
    const secret = randomBytes(SECRET_BYTES);
    const credential = `${TOKEN_PREFIX}${clientId}_${generation}_${secret.toString("base64url")}`;
    const parsed = parsePrincipalAgentToolClientCredential(credential);
    if (!parsed) {
      throw new Error("principal_agent_tool_client_credential_invalid");
    }
    return Object.freeze({
      clientId,
      generation,
      credential,
      verifier: this.verifier(parsed),
    });
  }

  verifier(
    parsed: ParsedPrincipalAgentToolClientCredential,
  ): Uint8Array {
    assertClientId(parsed.clientId);
    assertGeneration(parsed.generation);
    if (parsed.secret.byteLength !== SECRET_BYTES) {
      throw new Error("principal_agent_tool_client_secret_invalid");
    }
    const uuidBytes = Buffer.from(parsed.clientId.replaceAll("-", ""), "hex");
    if (uuidBytes.byteLength !== 16) {
      throw new Error("principal_agent_tool_client_id_invalid");
    }
    const framed = Buffer.allocUnsafe(1 + 16 + 4 + SECRET_BYTES);
    framed.writeUInt8(1, 0);
    uuidBytes.copy(framed, 1);
    framed.writeUInt32BE(parsed.generation, 17);
    Buffer.from(parsed.secret).copy(framed, 21);
    return new Uint8Array(
      createHmac("sha256", this.#verifierKey).update(framed).digest(),
    );
  }

  matches(
    parsed: ParsedPrincipalAgentToolClientCredential,
    expectedVerifier: Uint8Array,
  ): boolean {
    const actual = this.verifier(parsed);
    const expected = Buffer.from(expectedVerifier);
    return (
      expected.byteLength === 32 &&
      timingSafeEqual(Buffer.from(actual), expected)
    );
  }
}

function assertClientId(clientId: string): void {
  if (!isCanonicalPrincipalAgentToolClientId(clientId)) {
    throw new Error("principal_agent_tool_client_id_invalid");
  }
}

function assertGeneration(generation: number): void {
  if (
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    generation > PRINCIPAL_AGENT_TOOL_CLIENT_MAXIMUM_GENERATION
  ) {
    throw new Error("principal_agent_tool_client_generation_invalid");
  }
}
