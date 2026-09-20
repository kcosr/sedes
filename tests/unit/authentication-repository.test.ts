import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { pairingCodeSchema, authenticationTokenSchema } from "../../src/shared/authentication.js";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthenticationRepository, CREDENTIAL_LIFETIME_MS, PAIRING_LIFETIME_MS, PAIRING_MAX_ATTEMPTS, PAIRING_RATE_LIMIT } from "../../src/server/authentication/authentication-repository.js";
import { runAuthCli } from "../../src/cli/auth-cli.js";

const paths: string[] = [];
const databases: AuthenticationRepository[] = [];
function directory(): string { const result = mkdtempSync(path.join(os.tmpdir(), "sedes-auth-")); paths.push(result); return result; }
function repository(dir = directory(), now?: () => number): AuthenticationRepository {
  const result = new AuthenticationRepository(dir, now ? { now } : {}); databases.push(result); return result;
}
afterEach(() => { for (const db of databases.splice(0)) db.close(); for (const dir of paths.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("installation authentication", () => {
  it("issues five-minute eight-letter codes and normalizes human input without changing credentials", () => {
    const db = repository();
    for (const transform of [(s: string) => s.toLowerCase(), (s: string) => `  ${s.replace("-", "").toLowerCase()}\n`]) {
      const grant = db.createPairing({ kind: "management" });
      expect(grant.token).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u);
      expect(PAIRING_LIFETIME_MS).toBe(300_000);
      const paired = db.exchangePairing({ token: transform(grant.token), clientName: "Phone", kind: "device" })!;
      expect(authenticationTokenSchema.safeParse(paired.credential).success).toBe(true);
      expect(db.exchangePairing({ token: grant.token, clientName: "Phone", kind: "device" })).toBeUndefined();
    }
    for (const value of ["ABCD-FGHJ", "BCDF GHJK", "BCD-FGHJK", "BCDF--GHJK", "BCDF-GHJKX", "1234-5678"]) {
      expect(pairingCodeSchema.safeParse(value).success).toBe(false);
    }
  });

  it("persists the global guessing budget across connections and exhausts all outstanding manual grants", () => {
    const dir = directory(); const db = repository(dir);
    const a = db.createPairing({ kind: "management" });
    const b = db.createPairing({ kind: "sidecar" });
    const privateGrant = db.createPairing({ kind: "management", managedLocal: true });
    const wrong = a.token === "BCDF-GHJK" || b.token === "BCDF-GHJK" ? "JKLM-NPQR" : "BCDF-GHJK";
    for (let attempt = 0; attempt < PAIRING_MAX_ATTEMPTS; attempt++) {
      expect(repository(dir).exchangePairing({ token: wrong, clientName: "Guess", kind: "device" })).toBeUndefined();
    }
    expect(db.exchangePairing({ token: a.token, clientName: "Phone", kind: "device" })).toBeUndefined();
    expect(db.exchangePairing({ token: b.token, clientName: "Host", kind: "sidecar", connectorId: "host" })).toBeUndefined();
    expect(db.exchangePairing({ token: privateGrant.token, clientName: "Local", kind: "device" })).toBeDefined();
    const fresh = db.createPairing({ kind: "management" });
    expect(db.exchangePairing({ token: fresh.token, clientName: "Phone", kind: "device" })).toBeDefined();
  });

  it("allows the last budgeted attempt and persists HTTP rate limiting across restarts", () => {
    const dir = directory(); let now = 1000; const db = repository(dir, () => now);
    const grant = db.createPairing({ kind: "management" });
    const wrong = grant.token === "BCDF-GHJK" ? "JKLM-NPQR" : "BCDF-GHJK";
    for (let n = 0; n < PAIRING_MAX_ATTEMPTS - 1; n++) db.exchangePairing({ token: wrong, clientName: "B", kind: "device" });
    expect(db.exchangePairing({ token: grant.token, clientName: "B", kind: "device" })).toBeDefined();
    for (let n = 0; n < PAIRING_RATE_LIMIT; n++) expect(db.admitPairingRequest()).toBe(true);
    const reopened = repository(dir, () => now);
    expect(reopened.admitPairingRequest()).toBe(false);
    now += 59_999; expect(reopened.admitPairingRequest()).toBe(false);
    now++; expect(reopened.admitPairingRequest()).toBe(true);
  });

  it("preserves previously issued credentials when opening a database without short-code tables", () => {
    const dir = directory(); const db = repository(dir);
    const paired = db.exchangePairing({ token: db.createPairing({ kind: "management" }).token, clientName: "Existing", kind: "device" })!;
    const legacy = new Database(path.join(dir, "authentication", "authentication.sqlite"));
    legacy.exec("DROP TABLE pairing_attempts; DROP TABLE pairing_rate_limit;");
    expect(legacy.prepare("SELECT token_hash FROM clients WHERE id = ?").get(paired.client.id)).toEqual({ token_hash: createHash("sha256").update(paired.credential).digest("hex") });
    legacy.close();
    expect(repository(dir).authenticate(paired.credential)).toEqual(paired.client);
  });

  it("exchanges once across live connections and revokes immediately", () => {
    const dir = directory(); const first = repository(dir); const second = repository(dir);
    const pairing = first.createPairing({ kind: "management" });
    const request = { token: pairing.token, clientName: "Browser", kind: "browser" as const };
    const result = second.exchangePairing(request)!;
    expect(result.client.kind).toBe("management");
    expect(first.exchangePairing(request)).toBeUndefined();
    expect(first.authenticate(result.credential)).toEqual(result.client);
    expect(second.listClients()).toEqual([result.client]);
    expect(second.revokeClient(result.client.id)).toBe(true);
    expect(first.authenticate(result.credential)).toBeUndefined();
  });
  it("enforces expiry at the boundary for both enrollment and credentials", () => {
    let now = 1_000; const db = repository(undefined, () => now);
    const expired = db.createPairing({ kind: "management" });
    now += PAIRING_LIFETIME_MS;
    expect(db.exchangePairing({ token: expired.token, clientName: "B", kind: "device" })).toBeUndefined();
    const fresh = db.createPairing({ kind: "management" });
    const client = db.exchangePairing({ token: fresh.token, clientName: "B", kind: "device" })!;
    now += CREDENTIAL_LIFETIME_MS;
    expect(db.authenticate(client.credential)).toBeUndefined();
    expect(db.listClients()).toEqual([]);
  });
  it("rejects kind escalation and binds sidecar identity without consuming wrong-kind codes", () => {
    const db = repository(); const pair = db.createPairing({ kind: "sidecar" });
    expect(db.exchangePairing({ token: pair.token, clientName: "B", kind: "browser" })).toBeUndefined();
    expect(db.exchangePairing({ token: pair.token, clientName: "B", kind: "sidecar" })).toBeUndefined();
    const sidecar = db.exchangePairing({ token: pair.token, clientName: "Worker", kind: "sidecar", connectorId: "host-1" })!;
    expect(db.authenticate(sidecar.credential)?.connectorId).toBe("host-1");
    const management = db.createPairing({ kind: "management" });
    expect(db.exchangePairing({ token: management.token, clientName: "B", kind: "sidecar", connectorId: "host-1" })).toBeUndefined();
    expect(db.exchangePairing({ token: management.token, clientName: "B", kind: "device", connectorId: "host-1" })).toBeUndefined();
  });
  it("stores no raw secrets and restricts filesystem access", () => {
    const dir = directory(); chmodSync(dir, 0o755); const db = repository(dir);
    const pair = db.createPairing({ kind: "management" });
    const result = db.exchangePairing({ token: pair.token, clientName: "B", kind: "browser" })!;
    for (const suffix of ["", "-wal", "-shm"]) {
      const filename = path.join(dir, "authentication", `authentication.sqlite${suffix}`);
      const contents = readFileSync(filename).toString("latin1");
      expect(contents).not.toContain(pair.token); expect(contents).not.toContain(result.credential);
      if (process.platform !== "win32") expect(statSync(filename).mode & 0o777).toBe(0o600);
    }
    if (process.platform !== "win32") {
      expect(statSync(path.join(dir, "authentication")).mode & 0o777).toBe(0o700);
      expect(statSync(dir).mode & 0o777).toBe(0o755);
    }
  });
  it("requires retained connector proof and a fresh grant to rotate even after revocation", () => {
    const dir = directory(); const db = repository(dir);
    const firstGrant = db.createPairing({ kind: "sidecar" });
    const first = db.exchangePairing({ token: firstGrant.token, clientName: "Host", kind: "sidecar", connectorId: "connector-1" })!;
    expect(db.hasConnectorIdentity("connector-1")).toBe(true);
    const rotationGrant = db.createPairing({ kind: "sidecar" });
    const copied = { token: rotationGrant.token, clientName: "Copy", kind: "sidecar" as const, connectorId: "connector-1" };
    expect(db.exchangePairing(copied)).toBeUndefined();
    expect(db.exchangePairing({ ...copied, previousCredential: "x".repeat(43) })).toBeUndefined();
    expect(db.authenticate(first.credential)).toEqual(first.client);
    const second = db.exchangePairing({ ...copied, previousCredential: first.credential })!;
    expect(second).toBeDefined();
    expect(db.authenticate(first.credential)).toBeUndefined();
    expect(db.authenticate(second.credential)?.id).toBe(second.client.id);
    expect(db.listClients()).toEqual([second.client]);
    db.revokeClient(second.client.id);
    const anotherConnection = repository(dir);
    expect(anotherConnection.hasConnectorIdentity("connector-1")).toBe(true);
    expect(anotherConnection.authenticate(second.credential)).toBeUndefined();
    const thirdGrant = anotherConnection.createPairing({ kind: "sidecar" });
    expect(anotherConnection.exchangePairing({ ...copied, token: thirdGrant.token })).toBeUndefined();
    expect(anotherConnection.exchangePairing({ ...copied, token: thirdGrant.token, previousCredential: first.credential })).toBeUndefined();
    expect(anotherConnection.exchangePairing({ ...copied, token: "z".repeat(43), previousCredential: second.credential })).toBeUndefined();
    const third = anotherConnection.exchangePairing({ ...copied, token: thirdGrant.token, previousCredential: second.credential })!;
    expect(anotherConnection.authenticate(third.credential)?.id).toBe(third.client.id);
  });
  it("rejects symlink database and directory targets", () => {
    const dir = directory(); const target = path.join(dir, "target"); writeFileSync(target, "");
    mkdirSync(path.join(dir, "authentication"));
    symlinkSync(target, path.join(dir, "authentication", "authentication.sqlite"));
    expect(() => repository(dir)).toThrow(/regular/);
    const other = directory(); symlinkSync(dir, path.join(other, "authentication"), "dir");
    expect(() => repository(other)).toThrow(/real directory/);
  });
  it("replaces only the private managed Local credential when a new parent-issued grant is consumed", () => {
    const db = repository();
    const exchange = (token: string) => db.exchangePairing({ token, clientName: "Device", kind: "device" })!;
    const initial = exchange(db.createPairing({ kind: "management", managedLocal: true }).token);
    const ordinary = exchange(db.createPairing({ kind: "management" }).token);
    expect(db.authenticate(initial.credential)).toEqual(initial.client);
    const nextGrant = db.createPairing({ kind: "management", managedLocal: true });
    expect(db.authenticate(initial.credential)).toEqual(initial.client);
    const next = exchange(nextGrant.token);
    expect(db.authenticate(initial.credential)).toBeUndefined();
    expect(db.authenticate(next.credential)).toEqual(next.client);
    expect(db.authenticate(ordinary.credential)).toEqual(ordinary.client);
    const publicGrant = db.createPairing({ kind: "management" });
    expect(db.exchangePairing({ token: publicGrant.token, clientName: "Device", kind: "device", managedLocal: true } as never)).toBeUndefined();
    expect(db.authenticate(next.credential)).toEqual(next.client);
    expect(exchange(publicGrant.token)).toBeDefined();
  });
});

it("operator CLI uses bootstrap state and supports pair/list/revoke without server restart", async () => {
  const dir = directory(); const config = path.join(dir, "server.json");
  const state = path.join(dir, "state");
  writeFileSync(config, JSON.stringify({ schemaVersion: 11, stateDirectory: state }));
  let stdout = ""; let stderr = "";
  const deps = { environment: { SEDES_CONFIG_FILE: config, APP_STATE_DIR: path.join(dir, "wrong") }, io: { stdout: { write: (value: string) => { stdout += value; } }, stderr: { write: (value: string) => { stderr += value; } } } };
  expect(await runAuthCli(["pair", "--server", "https://sedes.example"], deps)).toBe(0);
  const pair = JSON.parse(stdout); expect(new URL(pair.url).hash).toBe(`#pair=${pair.code}`);
  const db = repository(state);
  const result = db.exchangePairing({ token: pair.code, clientName: "Phone", kind: "device" })!;
  stdout = "";
  expect(await runAuthCli(["list"], deps)).toBe(0);
  expect(JSON.parse(stdout).clients).toEqual([result.client]);
  expect(await runAuthCli(["revoke", result.client.id], deps)).toBe(0);
  expect(db.authenticate(result.credential)).toBeUndefined(); expect(stderr).toBe("");
});

it("auth help needs no config and malformed URL fails before creating state", async () => {
  const output: string[] = []; const io = { stdout: { write: (s: string) => output.push(s) }, stderr: { write: (s: string) => output.push(s) } };
  expect(await runAuthCli(["--help"], { environment: {}, io })).toBe(0);
  expect(await runAuthCli(["pair", "--server", "https://user:pass@example.com/"], { environment: {}, io })).toBe(1);
  expect(output.join("")).toContain("without credentials");
});
