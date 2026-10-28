import { execFile } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { generate } from "selfsigned";
import { WebSocketServer } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const message = "Verified speech TLS fixture.";

async function authority(name) {
  return generate([{ name: "commonName", value: `Sedes speech ${name} test CA` }], {
    keyType: "ec", curve: "P-256", algorithm: "sha256",
    notBeforeDate: new Date(Date.now() - 3_600_000), notAfterDate: new Date(Date.now() + 86_400_000),
    extensions: [
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, critical: true },
    ],
  });
}

async function fixture(ca, wrongHostname = false) {
  const certificate = await generate([{ name: "commonName", value: wrongHostname ? "wrong.invalid" : "127.0.0.1" }], {
    keyType: "ec", curve: "P-256", algorithm: "sha256", ca: { cert: ca.cert, key: ca.private },
    notBeforeDate: new Date(Date.now() - 3_600_000), notAfterDate: new Date(Date.now() + 86_400_000),
    extensions: [
      { name: "basicConstraints", cA: false, critical: true },
      { name: "keyUsage", digitalSignature: true, critical: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames: [wrongHostname ? { type: 2, value: "wrong.invalid" } : { type: 7, ip: "127.0.0.1" }] },
    ],
  });
  const server = createServer({ key: certificate.private, cert: certificate.cert }, (_request, response) => {
    response.setHeader("Connection", "close");
    response.end(message);
  });
  const sockets = new Set();
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  const wss = new WebSocketServer({ server });
  wss.on("connection", socket => { socket.on("error", () => {}); socket.send(message); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    url: `https://127.0.0.1:${server.address().port}`,
    async close() {
      for (const socket of wss.clients) socket.terminate();
      for (const socket of sockets) socket.destroy();
      await Promise.all([new Promise(resolve => wss.close(resolve)), new Promise(resolve => server.close(resolve))]);
    },
  };
}

// Run trust mutations in a disposable Node process so no Vitest worker or other
// test inherits these roots. Only OS certificate enumeration is substituted:
// fetch, ws, certificate-chain verification, and hostname verification are real.
// This does not test reading a particular macOS Keychain or change OS trust.
const probe = String.raw`async function probe(input) {
  const { default: tls } = await import("node:tls");
  const { X509Certificate } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  const { pathToFileURL } = await import("node:url");
  const { default: WebSocket } = await import("ws");
  const systemRoot = await readFile(input.systemCaPath, "utf8");
  const existingRoot = await readFile(input.existingCaPath, "utf8");
  const getCertificates = tls.getCACertificates.bind(tls);
  tls.setDefaultCACertificates([...getCertificates("default"), existingRoot]);
  const originalDefaults = getCertificates("default");
  const enumerations = [];
  tls.getCACertificates = type => {
    enumerations.push(type);
    return type === "system" ? [...getCertificates("system"), systemRoot] : getCertificates(type);
  };

  async function connections() {
    const https = await fetch(input.url, { signal: AbortSignal.timeout(5_000) })
      .then(async response => ({ connected: true, body: await response.text() }))
      .catch(error => ({ connected: false, code: error.cause?.code ?? error.code }));
    const wss = await new Promise(resolve => {
      const socket = new WebSocket(input.url.replace("https:", "wss:"), { handshakeTimeout: 5_000 });
      let result;
      socket.once("message", data => { result = { connected: true, body: data.toString() }; socket.close(); });
      socket.once("error", error => { result = { connected: false, code: error.code }; });
      socket.once("close", () => resolve(result));
    });
    return { https, wss };
  }

  const before = input.before ? await connections() : undefined;
  const { SpeechTransport } = await import(pathToFileURL(input.transportPath).href);
  // Exercise the production initialization path; injecting request-level CA
  // options here would conceal a missing constructor trust setup.
  new SpeechTransport({ credentials: {} });
  new SpeechTransport({ credentials: {} });
  const fingerprint = certificate => new X509Certificate(certificate).fingerprint256;
  const currentDefaults = new Set(getCertificates("default").map(fingerprint));
  const preserved = certificates => certificates.every(certificate => currentDefaults.has(fingerprint(certificate)));
  const result = {
    before, after: await connections(),
    originalDefaultsPreserved: preserved(originalDefaults),
    bundledRootsPreserved: preserved(getCertificates("bundled")),
    extraRootsPreserved: preserved(getCertificates("extra")),
    systemEnumerations: enumerations.filter(type => type === "system").length,
  };
  process.stdout.write(JSON.stringify(result));
}`;

describe("Electron speech system certificate trust", () => {
  let root;
  let systemCaPath;
  let existingCaPath;
  let extraCaPath;
  const fixtures = {};

  beforeAll(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "sedes-speech-tls-"));
    const [system, existing, extra, untrusted] = await Promise.all(["system", "existing", "extra", "untrusted"].map(authority));
    systemCaPath = path.join(root, "system.pem");
    existingCaPath = path.join(root, "existing.pem");
    extraCaPath = path.join(root, "extra.pem");
    await Promise.all([[systemCaPath, system], [existingCaPath, existing], [extraCaPath, extra]]
      .map(([file, ca]) => writeFile(file, ca.cert, { mode: 0o600 })));
    for (const [name, ca, wrongHostname] of [["system", system], ["existing", existing], ["extra", extra],
      ["untrusted", untrusted], ["wrongHostname", system, true]]) fixtures[name] = await fixture(ca, wrongHostname);
  }, 15_000);

  afterAll(async () => {
    await Promise.all(Object.values(fixtures).map(value => value.close()));
    if (root) await rm(root, { recursive: true, force: true });
  });

  async function run(name, before = false) {
    const env = { ...process.env };
    // Ambient overrides must not turn a rejection into a false passing result.
    for (const key of ["NODE_TLS_REJECT_UNAUTHORIZED", "NODE_OPTIONS", "NODE_USE_SYSTEM_CA", "SSL_CERT_FILE", "SSL_CERT_DIR"])
      delete env[key];
    env.NODE_EXTRA_CA_CERTS = extraCaPath;
    const input = { url: fixtures[name].url, before, systemCaPath, existingCaPath,
      transportPath: path.resolve("packages/electron-speech/electron/dist/transport.mjs") };
    const { stdout, stderr } = await execFileAsync(process.execPath,
      ["--input-type=module", "--eval", `await (${probe})(${JSON.stringify(input)})`],
      { cwd: process.cwd(), env, timeout: 12_000, maxBuffer: 64 * 1024 });
    expect(stderr).toBe("");
    const result = JSON.parse(stdout);
    expect(result).toMatchObject({ originalDefaultsPreserved: true, bundledRootsPreserved: true, extraRootsPreserved: true,
      systemEnumerations: 2 });
    return result;
  }

  const accepted = { connected: true, body: message };
  const untrusted = { connected: false, code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" };

  it("enables real HTTPS and WSS connections to a system-trusted CA through transport initialization", async () => {
    const result = await run("system", true);
    expect(result.before).toEqual({ https: untrusted, wss: untrusted });
    expect(result.after).toEqual({ https: accepted, wss: accepted });
  }, 15_000);

  it.each(["existing", "extra"])("preserves %s CA trust for HTTPS and WSS across repeated initialization", async name => {
    expect((await run(name)).after).toEqual({ https: accepted, wss: accepted });
  }, 15_000);

  it("rejects an unknown certificate authority in HTTPS and WSS", async () => {
    expect((await run("untrusted")).after).toEqual({ https: untrusted, wss: untrusted });
  }, 15_000);

  it("rejects a system-trusted certificate for the wrong hostname in HTTPS and WSS", async () => {
    const rejected = { connected: false, code: "ERR_TLS_CERT_ALTNAME_INVALID" };
    expect((await run("wrongHostname")).after).toEqual({ https: rejected, wss: rejected });
  }, 15_000);
});
