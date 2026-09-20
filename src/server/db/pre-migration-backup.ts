import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";

const BACKUP_PATTERN =
  /^overlay-schema-v(?<version>[0-9]+)-(?<timestamp>[0-9]+)-(?<id>[A-Fa-f0-9-]+)\.sqlite$/;

export interface PreMigrationBackupOptions {
  readonly database: Database.Database;
  readonly stateDirectory: string;
  readonly sourceSchemaVersion: number;
  readonly now?: number;
}

export interface BackupRetentionOptions {
  readonly now?: number;
  readonly minimumNewest?: number;
  readonly maximumAgeMilliseconds?: number;
}

type BackupFile = {
  readonly filename: string;
  readonly pathname: string;
  readonly schemaVersion: number;
  readonly timestamp: number;
};

export async function createPreMigrationBackup(
  options: PreMigrationBackupOptions,
): Promise<string> {
  if (
    !Number.isSafeInteger(options.sourceSchemaVersion) ||
    options.sourceSchemaVersion < 1
  ) {
    throw new Error("A positive source schema version is required for backup.");
  }
  const applied = options.database
    .prepare(
      `
        SELECT coalesce(max(version), 0) AS version
        FROM schema_migrations
      `,
    )
    .get() as { readonly version: number };
  if (applied.version !== options.sourceSchemaVersion) {
    throw new Error(
      `Backup source schema mismatch: expected ${options.sourceSchemaVersion}, found ${applied.version}.`,
    );
  }

  const checkpoint = options.database.pragma(
    "wal_checkpoint(TRUNCATE)",
  ) as Array<{ busy: number; log: number; checkpointed: number }>;
  if (checkpoint.some(({ busy }) => busy !== 0)) {
    throw new Error("The database WAL could not be checkpointed for migration.");
  }

  const canonicalStateDirectory = await realpath(options.stateDirectory);
  const backupDirectory = path.join(canonicalStateDirectory, "backups");
  const existingBackupDirectory = await lstat(backupDirectory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  if (existingBackupDirectory?.isSymbolicLink()) {
    throw new Error("The migration backup directory must not be a symlink.");
  }
  if (existingBackupDirectory && !existingBackupDirectory.isDirectory()) {
    throw new Error("The migration backup path is not a directory.");
  }
  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await chmod(backupDirectory, 0o700);

  const timestamp = options.now ?? Date.now();
  const basename = `overlay-schema-v${options.sourceSchemaVersion}-${timestamp}-${randomUUID()}.sqlite`;
  const destination = path.join(backupDirectory, basename);
  const temporary = `${destination}.partial`;

  try {
    await options.database.backup(temporary);
    const verification = new Database(temporary, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const rows = verification.pragma("integrity_check") as Array<{
        integrity_check: string;
      }>;
      if (
        rows.length !== 1 ||
        rows[0]?.integrity_check.toLocaleLowerCase() !== "ok"
      ) {
        throw new Error("The pre-migration backup failed integrity verification.");
      }
    } finally {
      verification.close();
    }
    await chmod(temporary, 0o600);
    await rename(temporary, destination);
    return destination;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function prunePreMigrationBackups(
  stateDirectory: string,
  options: BackupRetentionOptions = {},
): Promise<string[]> {
  const backupDirectory = path.join(stateDirectory, "backups");
  const entries = await readdir(backupDirectory).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const backups = (
    await Promise.all(
      entries.map(async (filename): Promise<BackupFile | null> => {
        const parsed = BACKUP_PATTERN.exec(filename);
        if (!parsed?.groups) return null;
        const pathname = path.join(backupDirectory, filename);
        const metadata = await stat(pathname);
        if (!metadata.isFile()) return null;
        return {
          filename,
          pathname,
          schemaVersion: Number(parsed.groups.version),
          timestamp: Number(parsed.groups.timestamp),
        };
      }),
    )
  )
    .filter((entry): entry is BackupFile => entry !== null)
    .sort(
      (left, right) =>
        right.timestamp - left.timestamp ||
        right.filename.localeCompare(left.filename),
    );

  const now = options.now ?? Date.now();
  const minimumNewest = options.minimumNewest ?? 5;
  const maximumAgeMilliseconds =
    options.maximumAgeMilliseconds ?? 30 * 24 * 60 * 60 * 1_000;
  const keep = new Set(
    backups
      .slice(0, minimumNewest)
      .map(({ pathname }) => pathname),
  );

  for (const backup of backups) {
    if (now - backup.timestamp <= maximumAgeMilliseconds) {
      keep.add(backup.pathname);
    }
  }
  for (const version of new Set(backups.map(({ schemaVersion }) => schemaVersion))) {
    const newestForVersion = backups.find(
      ({ schemaVersion }) => schemaVersion === version,
    );
    if (newestForVersion) keep.add(newestForVersion.pathname);
  }

  const removed: string[] = [];
  for (const backup of backups) {
    if (keep.has(backup.pathname)) continue;
    await rm(backup.pathname);
    removed.push(backup.pathname);
  }
  return removed;
}
