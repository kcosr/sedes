import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, type Stats } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { authenticationClientSchema, authenticationTokenSchema, PAIRING_CODE_ALPHABET, pairingCodeSchema, pairingRequestSchema, type AuthenticationClient, type PairingRequest } from "../../shared/authentication.js";

export const PAIRING_LIFETIME_MS = 5 * 60 * 1_000;
export const PAIRING_MAX_ATTEMPTS = 5;
export const PAIRING_RATE_LIMIT = 60;
export const CREDENTIAL_LIFETIME_MS = 90 * 24 * 60 * 60 * 1_000;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const token = (): string => randomBytes(32).toString("base64url");

function assertOwned(stat: Stats, filename: string): void {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`Authentication path must be owned by the server account: ${filename}`);
}

function prepareDatabase(stateDirectory: string): string {
  if (!path.isAbsolute(stateDirectory)) throw new Error("Authentication state directory must be absolute.");
  const authenticationDirectory = path.join(stateDirectory, "authentication");
  mkdirSync(authenticationDirectory, { recursive: true, mode: 0o700 });
  const directory = lstatSync(authenticationDirectory);
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error("Authentication state directory must be a real directory.");
  assertOwned(directory, authenticationDirectory);
  chmodSync(authenticationDirectory, 0o700);
  const filename = path.join(authenticationDirectory, "authentication.sqlite");
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      const stat = lstatSync(`${filename}${suffix}`);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Authentication database files must be regular, unlinked files.");
      assertOwned(stat, `${filename}${suffix}`);
      chmodSync(`${filename}${suffix}`, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const fd = openSync(filename, constants.O_CREAT | constants.O_RDWR | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    const stat = fstatSync(fd);
    assertOwned(stat, filename);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("Invalid authentication database file.");
    fchmodSync(fd, 0o600);
  } finally { closeSync(fd); }
  return filename;
}

/** Installation-owned credentials authorize the server-derived local principal. */
export class AuthenticationRepository {
  private readonly db: Database.Database;
  private readonly now: () => number;

  constructor(stateDirectory: string, options: { now?: () => number } = {}) {
    this.now = options.now ?? Date.now;
    this.db = new Database(prepareDatabase(stateDirectory));
    this.db.pragma("busy_timeout = 5000");
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pairings (
        token_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('management','sidecar')), expires_at INTEGER NOT NULL,
        managed_local INTEGER NOT NULL DEFAULT 0 CHECK(managed_local IN (0, 1)),
        CHECK(managed_local = 0 OR kind = 'management')
      );
      CREATE TABLE IF NOT EXISTS pairing_attempts (
        token_hash TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS pairing_rate_limit (
        id INTEGER PRIMARY KEY CHECK(id = 1), window_started_at INTEGER NOT NULL, requests INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS clients (
        id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('management','sidecar')), connector_id TEXT,
        created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        managed_local INTEGER NOT NULL DEFAULT 0 CHECK(managed_local IN (0, 1)),
        CHECK(managed_local = 0 OR kind = 'management'),
        CHECK ((kind = 'sidecar' AND connector_id IS NOT NULL) OR (kind = 'management' AND connector_id IS NULL))
      );
      CREATE TABLE IF NOT EXISTS connector_identities (
        connector_id TEXT PRIMARY KEY, credential_hash TEXT NOT NULL
      );
    `);
  }

  createPairing(input: { kind: "management"; managedLocal?: true } | { kind: "sidecar"; managedLocal?: never }): { token: string; expiresAt: string } {
    if (input.kind !== "management" && input.kind !== "sidecar") throw new Error("Invalid pairing kind.");
    if (input.managedLocal !== undefined && (input.managedLocal !== true || input.kind !== "management")) throw new Error("Invalid managed Local pairing grant.");
    let value: string;
    const now = this.now();
    const expiresAt = now + PAIRING_LIFETIME_MS;
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM pairings WHERE expires_at <= ?").run(now);
      this.db.prepare("DELETE FROM pairing_attempts WHERE token_hash NOT IN (SELECT token_hash FROM pairings)").run();
      do {
        value = input.managedLocal ? token() : pairingCodeSchema.parse(Array.from({ length: 8 }, () => PAIRING_CODE_ALPHABET[randomInt(PAIRING_CODE_ALPHABET.length)]).join(""));
      } while (this.db.prepare("INSERT OR IGNORE INTO pairings (token_hash, kind, expires_at, managed_local) VALUES (?, ?, ?, ?)").run(digest(value), input.kind, expiresAt, input.managedLocal ? 1 : 0).changes === 0);
      if (!input.managedLocal) this.db.prepare("INSERT INTO pairing_attempts (token_hash) VALUES (?)").run(digest(value));
    }).immediate();
    return { token: value!, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Installation-wide and durable: changing IP or restarting cannot reset it. */
  admitPairingRequest(): boolean {
    return this.db.transaction(() => {
      const now = this.now();
      this.db.prepare(`INSERT INTO pairing_rate_limit (id, window_started_at, requests) VALUES (1, ?, 1)
        ON CONFLICT(id) DO UPDATE SET
          requests = CASE WHEN ? >= window_started_at + 60000 THEN 1 ELSE requests + 1 END,
          window_started_at = CASE WHEN ? >= window_started_at + 60000 THEN ? ELSE window_started_at END`).run(now, now, now, now);
      const row = this.db.prepare("SELECT requests FROM pairing_rate_limit WHERE id = 1").get() as { requests: number };
      return row.requests <= PAIRING_RATE_LIMIT;
    }).immediate();
  }

  exchangePairing(input: PairingRequest): { client: AuthenticationClient; credential: string } | undefined {
    const parsed = pairingRequestSchema.safeParse(input);
    if (!parsed.success) return undefined;
    const request = parsed.data;
    return this.db.transaction(() => {
      const now = this.now();
      // Every well-formed short-code guess spends an attempt on every active
      // manual grant, including unknown codes and requests with the wrong kind.
      // Private high-entropy managed-Local grants have no human guessing budget.
      const manual = pairingCodeSchema.safeParse(request.token).success;
      let allowedHash: string | undefined;
      if (manual) {
        this.db.prepare("DELETE FROM pairings WHERE expires_at <= ?").run(now);
        this.db.prepare("UPDATE pairing_attempts SET attempts = attempts + 1 WHERE token_hash IN (SELECT token_hash FROM pairings WHERE managed_local = 0)").run();
        const candidate = this.db.prepare("SELECT token_hash FROM pairing_attempts WHERE token_hash = ? AND attempts <= ?").get(digest(request.token), PAIRING_MAX_ATTEMPTS) as { token_hash: string } | undefined;
        allowedHash = candidate?.token_hash;
      }
      const finishAttempts = () => {
        if (!manual) return;
        this.db.prepare("DELETE FROM pairings WHERE token_hash IN (SELECT token_hash FROM pairing_attempts WHERE attempts >= ?)").run(PAIRING_MAX_ATTEMPTS);
        this.db.prepare("DELETE FROM pairing_attempts WHERE token_hash NOT IN (SELECT token_hash FROM pairings)").run();
      };
      if (manual && !allowedHash) { finishAttempts(); return undefined; }
      const kind = request.kind === "sidecar" ? "sidecar" : "management";
      if (request.kind === "sidecar") {
        const identity = this.db.prepare("SELECT credential_hash FROM connector_identities WHERE connector_id = ?").get(request.connectorId!) as { credential_hash: string } | undefined;
        // Revocation removes API authority but retains proof of connector identity.
        // Rotation requires both that proof and a fresh operator enrollment grant.
        if (identity && (!request.previousCredential || identity.credential_hash !== digest(request.previousCredential))) { finishAttempts(); return undefined; }
        if (!identity && request.previousCredential !== undefined) { finishAttempts(); return undefined; }
      }
      const removed = this.db.prepare("DELETE FROM pairings WHERE token_hash = ? AND kind = ? AND expires_at > ? AND managed_local = ? RETURNING managed_local").get(digest(request.token), kind, now, manual ? 0 : 1) as { managed_local: number } | undefined;
      finishAttempts();
      if (!removed) return undefined;
      if (removed.managed_local === 1) this.db.prepare("DELETE FROM clients WHERE managed_local = 1").run();
      const credential = token();
      if (request.kind === "sidecar") {
        this.db.prepare("DELETE FROM clients WHERE kind = 'sidecar' AND connector_id = ?").run(request.connectorId!);
        this.db.prepare("INSERT INTO connector_identities (connector_id, credential_hash) VALUES (?, ?) ON CONFLICT(connector_id) DO UPDATE SET credential_hash = excluded.credential_hash")
          .run(request.connectorId!, digest(credential));
      }
      const client: AuthenticationClient = {
        id: randomUUID(), name: request.clientName, kind,
        ...(request.connectorId ? { connectorId: request.connectorId } : {}),
        createdAt: new Date(now).toISOString(), expiresAt: new Date(now + CREDENTIAL_LIFETIME_MS).toISOString(),
      };
      this.db.prepare("INSERT INTO clients (id, token_hash, name, kind, connector_id, created_at, expires_at, managed_local) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .run(client.id, digest(credential), client.name, kind, request.connectorId ?? null, now, now + CREDENTIAL_LIFETIME_MS, removed.managed_local);
      return { client, credential };
    }).immediate();
  }

  authenticate(credential: string): AuthenticationClient | undefined {
    if (!authenticationTokenSchema.safeParse(credential).success) return undefined;
    const row = this.db.prepare("SELECT * FROM clients WHERE token_hash = ? AND expires_at > ?").get(digest(credential), this.now());
    return row ? this.toClient(row) : undefined;
  }

  listClients(): AuthenticationClient[] {
    return this.db.prepare("SELECT * FROM clients WHERE expires_at > ? ORDER BY created_at, id").all(this.now()).map(row => this.toClient(row));
  }

  revokeClient(id: string): boolean {
    return this.db.prepare("DELETE FROM clients WHERE id = ?").run(id).changes > 0;
  }

  hasConnectorIdentity(connectorId: string): boolean {
    return this.db.prepare("SELECT 1 FROM connector_identities WHERE connector_id = ?").get(connectorId) !== undefined;
  }

  close(): void { this.db.close(); }

  private toClient(value: unknown): AuthenticationClient {
    const row = value as { id: string; name: string; kind: string; connector_id: string | null; created_at: number; expires_at: number };
    return authenticationClientSchema.parse({ id: row.id, name: row.name, kind: row.kind,
      ...(row.connector_id === null ? {} : { connectorId: row.connector_id }),
      createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() });
  }
}
