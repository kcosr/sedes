import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { generate as generateCertificate } from "selfsigned";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const CHILD_FIXTURE = path.resolve(
  "tests/fixtures/codex-wss-platform-trust-child.ts",
);

type Scenario =
  | "valid"
  | "remote_valid"
  | "untrusted"
  | "hostname_mismatch"
  | "expired"
  | "tls_below_floor";

type CertificateFixture = Readonly<{
  certificatePath: string;
  privateKeyPath: string;
}>;

const REMOTE_PEER_NAME = "codex.remote.test";

describe.sequential("Codex WSS platform trust evidence", () => {
  let root: string;
  let trustedCaPath: string;
  let certificates: Readonly<Record<Scenario, CertificateFixture>>;

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "sedes-codex-wss-pki-"));
    await chmod(root, 0o700);
    const trustedCa = await createCertificateAuthority(root, "trusted");
    const untrustedCa = await createCertificateAuthority(root, "untrusted");
    trustedCaPath = trustedCa.certificatePath;
    const valid = await issueCertificate({
      root,
      name: "valid",
      commonName: "127.0.0.1",
      subjectAlternativeName: { type: "ip", value: "127.0.0.1" },
      authority: trustedCa,
    });
    certificates = {
      valid,
      remote_valid: await issueCertificate({
        root,
        name: "remote-valid",
        commonName: REMOTE_PEER_NAME,
        subjectAlternativeName: { type: "dns", value: REMOTE_PEER_NAME },
        authority: trustedCa,
      }),
      untrusted: await issueCertificate({
        root,
        name: "untrusted",
        commonName: "127.0.0.1",
        subjectAlternativeName: { type: "ip", value: "127.0.0.1" },
        authority: untrustedCa,
      }),
      hostname_mismatch: await issueCertificate({
        root,
        name: "hostname-mismatch",
        commonName: "wrong.invalid",
        subjectAlternativeName: { type: "dns", value: "wrong.invalid" },
        authority: trustedCa,
      }),
      expired: await issueCertificate({
        root,
        name: "expired",
        commonName: "127.0.0.1",
        subjectAlternativeName: { type: "ip", value: "127.0.0.1" },
        authority: trustedCa,
        expired: true,
      }),
      tls_below_floor: valid,
    };
  }, 30_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("uses process-start platform trust and verifies the exact WSS peer plus bearer Upgrade", async () => {
    const result = await runScenario("valid");
    expect(result).toEqual({
      scenario: "valid",
      outcome: "connected",
      bearerVerified: true,
      originAbsent: true,
      textFrameVerified: true,
      tlsAssured: true,
      tlsFloorVerified: true,
      serverSurvivedClientClose: true,
    });
  });

  it("uses the production carrier above a test-only remote-name WSS environment", async () => {
    const result = await runScenario("remote_valid", REMOTE_PEER_NAME);
    expect(result).toEqual({
      scenario: "remote_valid",
      outcome: "connected",
      remoteRouteVerified: true,
      bearerVerified: true,
      originAbsent: true,
      textFrameVerified: true,
      tlsAssured: true,
      tlsFloorVerified: true,
      serverSurvivedClientClose: true,
    });
  });

  it.each([
    ["untrusted", "untrusted certificate chain"],
    ["hostname_mismatch", "certificate hostname/IP mismatch"],
    ["expired", "expired certificate validity"],
  ] as const)("fails closed for %s (%s)", async (scenario, _description) => {
    const result = await runScenario(scenario);
    expect(result).toEqual({
      scenario,
      outcome: "rejected",
      code: "codex_tcp_websocket_tls_identity_invalid",
      permanent: true,
      privateMaterialAbsent: true,
    });
  });

  it("fails closed when the peer supports only TLS below 1.2", async () => {
    const result = await runScenario("tls_below_floor");
    expect(result).toEqual({
      scenario: "tls_below_floor",
      outcome: "rejected",
      code: "codex_tcp_websocket_tls_identity_invalid",
      permanent: true,
      privateMaterialAbsent: true,
    });
  });

  it("scrubs ambient TLS overrides from the platform-trust fixture", async () => {
    const result = await runScenario("untrusted", "127.0.0.1", {
      ...process.env,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      NODE_OPTIONS: "--use-openssl-ca",
      SSL_CERT_FILE: certificates.untrusted.certificatePath,
      SSL_CERT_DIR: root,
    });
    expect(result).toEqual({
      scenario: "untrusted",
      outcome: "rejected",
      code: "codex_tcp_websocket_tls_identity_invalid",
      permanent: true,
      privateMaterialAbsent: true,
    });
  });

  async function runScenario(
    scenario: Scenario,
    host = "127.0.0.1",
    inheritedEnvironment: NodeJS.ProcessEnv = process.env,
  ): Promise<unknown> {
    const certificate = certificates[scenario];
    const childEnvironment = { ...inheritedEnvironment };
    delete childEnvironment.NODE_TLS_REJECT_UNAUTHORIZED;
    delete childEnvironment.NODE_OPTIONS;
    delete childEnvironment.SSL_CERT_FILE;
    delete childEnvironment.SSL_CERT_DIR;
    childEnvironment.NODE_EXTRA_CA_CERTS = trustedCaPath;
    const tlsCounterfactualArguments =
      scenario === "tls_below_floor"
        ? ["--tls-min-v1.0", "--tls-cipher-list=DEFAULT:@SECLEVEL=0"]
        : [];
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [
        ...tlsCounterfactualArguments,
        "--import",
        "tsx",
        CHILD_FIXTURE,
        scenario,
        certificate.certificatePath,
        certificate.privateKeyPath,
        host,
      ],
      {
        cwd: process.cwd(),
        env: childEnvironment,
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      },
    );
    expect(stderr).toBe("");
    return JSON.parse(stdout.trim()) as unknown;
  }
});

type CertificateAuthority = Readonly<{
  certificatePath: string;
  privateKeyPath: string;
  certificate: string;
  privateKey: string;
}>;

async function createCertificateAuthority(
  root: string,
  name: string,
): Promise<CertificateAuthority> {
  const certificatePath = path.join(root, `${name}-ca.pem`);
  const privateKeyPath = path.join(root, `${name}-ca-key.pem`);
  const now = Date.now();
  const generated = await generateCertificate(
    [{ name: "commonName", value: `Sedes ${name} test CA` }],
    {
      keyType: "ec",
      curve: "P-256",
      algorithm: "sha256",
      notBeforeDate: new Date(now - 60 * 60 * 1_000),
      notAfterDate: new Date(now + 48 * 60 * 60 * 1_000),
      extensions: [
        { name: "basicConstraints", cA: true, critical: true },
        {
          name: "keyUsage",
          keyCertSign: true,
          cRLSign: true,
          critical: true,
        },
      ],
    },
  );
  await Promise.all([
    writeFile(certificatePath, generated.cert, {
      encoding: "utf8",
      mode: 0o600,
    }),
    writeFile(privateKeyPath, generated.private, {
      encoding: "utf8",
      mode: 0o600,
    }),
  ]);
  return {
    certificatePath,
    privateKeyPath,
    certificate: generated.cert,
    privateKey: generated.private,
  };
}

async function issueCertificate(input: {
  readonly root: string;
  readonly name: string;
  readonly commonName: string;
  readonly subjectAlternativeName: Readonly<{
    type: "dns" | "ip";
    value: string;
  }>;
  readonly authority: CertificateAuthority;
  readonly expired?: boolean;
}): Promise<CertificateFixture> {
  const certificatePath = path.join(input.root, `${input.name}.pem`);
  const privateKeyPath = path.join(input.root, `${input.name}-key.pem`);
  const now = Date.now();
  const generated = await generateCertificate(
    [{ name: "commonName", value: input.commonName }],
    {
      keyType: "ec",
      curve: "P-256",
      algorithm: "sha256",
      notBeforeDate: input.expired
        ? new Date("2020-01-01T00:00:00.000Z")
        : new Date(now - 60 * 60 * 1_000),
      notAfterDate: input.expired
        ? new Date("2020-01-02T00:00:00.000Z")
        : new Date(now + 24 * 60 * 60 * 1_000),
      ca: {
        key: input.authority.privateKey,
        cert: input.authority.certificate,
      },
      extensions: [
        { name: "basicConstraints", cA: false, critical: true },
        {
          name: "keyUsage",
          digitalSignature: true,
          keyEncipherment: true,
          critical: true,
        },
        { name: "extKeyUsage", serverAuth: true },
        {
          name: "subjectAltName",
          altNames: [
            input.subjectAlternativeName.type === "dns"
              ? { type: 2 as const, value: input.subjectAlternativeName.value }
              : { type: 7 as const, ip: input.subjectAlternativeName.value },
          ],
        },
      ],
    },
  );
  await Promise.all([
    writeFile(certificatePath, generated.cert, {
      encoding: "utf8",
      mode: 0o600,
    }),
    writeFile(privateKeyPath, generated.private, {
      encoding: "utf8",
      mode: 0o600,
    }),
  ]);
  return { certificatePath, privateKeyPath };
}
