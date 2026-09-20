import { createHmac, hkdfSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  PRINCIPAL_AGENT_TOOL_CLIENT_CREDENTIAL_MAXIMUM_LENGTH,
  PRINCIPAL_AGENT_TOOL_CLIENT_CREDENTIAL_MINIMUM_LENGTH,
  PRINCIPAL_AGENT_TOOL_CLIENT_MAXIMUM_GENERATION,
  parsePrincipalAgentToolClientCredential,
  PrincipalAgentToolClientCredentialCodec,
} from "../../src/server/agent-tools/application/principal-agent-tool-client-credential.js";

describe("principal agent-tool client credentials", () => {
  const installationKey = Uint8Array.from({ length: 32 }, (_, index) => index);
  const clientId = "12345678-1234-4abc-8def-1234567890ab";

  it("issues the exact versioned form and derives the specified verifier", () => {
    const codec = new PrincipalAgentToolClientCredentialCodec(installationKey);
    const issued = codec.issue(1, clientId);
    expect(issued.credential).toMatch(
      /^hatc1_12345678-1234-4abc-8def-1234567890ab_1_[A-Za-z0-9_-]{43}$/u,
    );
    expect(issued.credential).toHaveLength(
      PRINCIPAL_AGENT_TOOL_CLIENT_CREDENTIAL_MINIMUM_LENGTH,
    );
    const parsed = parsePrincipalAgentToolClientCredential(issued.credential)!;
    expect(parsed).toMatchObject({ clientId, generation: 1 });
    expect(parsed.secret).toHaveLength(32);

    const verifierKey = hkdfSync(
      "sha256",
      installationKey,
      Buffer.alloc(0),
      // This is a permanent credential format identifier, not branding.
      "harness.agent-tool.principal-client-verifier.v1",
      32,
    );
    const frame = Buffer.alloc(53);
    frame.writeUInt8(1, 0);
    Buffer.from(clientId.replaceAll("-", ""), "hex").copy(frame, 1);
    frame.writeUInt32BE(1, 17);
    Buffer.from(parsed.secret).copy(frame, 21);
    expect(Buffer.from(issued.verifier)).toEqual(
      createHmac("sha256", verifierKey).update(frame).digest(),
    );
    expect(codec.matches(parsed, issued.verifier)).toBe(true);
  });

  it("accepts the maximum generation without leading zeroes", () => {
    const issued = new PrincipalAgentToolClientCredentialCodec(
      installationKey,
    ).issue(PRINCIPAL_AGENT_TOOL_CLIENT_MAXIMUM_GENERATION, clientId);
    expect(issued.credential).toHaveLength(
      PRINCIPAL_AGENT_TOOL_CLIENT_CREDENTIAL_MAXIMUM_LENGTH,
    );
    expect(parsePrincipalAgentToolClientCredential(issued.credential)).toMatchObject({
      generation: PRINCIPAL_AGENT_TOOL_CLIENT_MAXIMUM_GENERATION,
    });
  });

  it.each([
    "",
    "hatc1_12345678-1234-4abc-8def-1234567890ab_01_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "hatc1_12345678-1234-4abc-8def-1234567890ab_0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "hatc1_12345678-1234-4abc-8def-1234567890ab_4294967296_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "hatc1_12345678-1234-4abc-7def-1234567890ab_1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "hatc1_12345678-1234-4ABC-8def-1234567890ab_1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "hatc1_12345678-1234-4abc-8def-1234567890ab_1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  ])("rejects noncanonical credential %s", (credential) => {
    expect(parsePrincipalAgentToolClientCredential(credential)).toBeUndefined();
  });

  it("rejects a verifier from another installation", () => {
    const issued = new PrincipalAgentToolClientCredentialCodec(
      installationKey,
    ).issue(1, clientId);
    const parsed = parsePrincipalAgentToolClientCredential(issued.credential)!;
    expect(
      new PrincipalAgentToolClientCredentialCodec(
        Uint8Array.from({ length: 32 }, () => 9),
      ).matches(parsed, issued.verifier),
    ).toBe(false);
  });
});
