import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveStateDir } from "../../config/paths.js";
import { requireNodeSqlite } from "../../memory/sqlite.js";

const DB_FILENAME = "message-journal.db";

/** Module-level singleton map: resolved db path → DatabaseSync instance. */
const DB_CACHE = new Map<string, DatabaseSync>();
let registeredCleanupHook = false;

/**
 * Returns (or creates) the journal DatabaseSync instance for a given state dir.
 * Creates the schema on first open. Safe to call repeatedly — returns the same instance.
 */
export function getJournalDb(stateDir?: string): DatabaseSync {
  const base = stateDir ?? resolveStateDir();
  const dbPath = path.resolve(path.join(base, DB_FILENAME));

  const cached = DB_CACHE.get(dbPath);
  if (cached) {
    return cached;
  }

  const { DatabaseSync } = requireNodeSqlite();
  const db = new DatabaseSync(dbPath);
  // WAL mode: improves concurrent read/write and crash safety.
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("PRAGMA synchronous=NORMAL;");
  ensureJournalSchema(db);
  registerProcessCleanupHook();
  DB_CACHE.set(dbPath, db);
  return db;
}

/**
 * Idempotent schema migration. Safe to call on every open — uses IF NOT EXISTS.
 */
export function ensureJournalSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inbound_events (
      id          TEXT NOT NULL PRIMARY KEY,
      channel     TEXT NOT NULL DEFAULT '',
      account_id  TEXT NOT NULL DEFAULT '',
      external_id TEXT,
      dedupe_key  TEXT,
      session_key TEXT NOT NULL DEFAULT '',
      payload     TEXT NOT NULL DEFAULT '{}',
      received_at INTEGER NOT NULL,
      status      TEXT NOT NULL DEFAULT 'processing',
      recovery_attempts INTEGER NOT NULL DEFAULT 0,
      last_recovery_at  INTEGER,
      recovery_error    TEXT
    );
  `);

  // Ensure dedupe_key column exists before creating index (migration for existing DBs).
  ensureColumnExists(db, "inbound_events", "dedupe_key", "TEXT");

  // Unique index for dedup: dedupe_key includes peer/thread so providers with
  // per-chat message IDs (e.g. Telegram) don't incorrectly drop distinct messages.
  // WHERE clause excludes NULL dedupe_key rows so messages without IDs always insert.
  db.exec("DROP INDEX IF EXISTS idx_inbound_dedup");
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_inbound_dedup
      ON inbound_events(dedupe_key)
      WHERE dedupe_key IS NOT NULL;
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS outbound_messages (
      id              TEXT NOT NULL PRIMARY KEY,
      inbound_id      TEXT,
      channel         TEXT NOT NULL,
      account_id      TEXT NOT NULL DEFAULT '',
      session_key     TEXT NOT NULL DEFAULT '',
      target          TEXT NOT NULL DEFAULT '',
      payload         TEXT NOT NULL,
      queued_at       INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'queued',
      retry_count     INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      last_error      TEXT,
      error_class     TEXT,
      delivered_at    INTEGER,
      idempotency_key TEXT
    );
  `);

  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_outbound_idem
      ON outbound_messages(idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);

  ensureColumnExists(db, "inbound_events", "recovery_attempts", "INTEGER NOT NULL DEFAULT 0");
  ensureColumnExists(db, "inbound_events", "last_recovery_at", "INTEGER");
  ensureColumnExists(db, "inbound_events", "recovery_error", "TEXT");
}

function registerProcessCleanupHook(): void {
  if (registeredCleanupHook) {
    return;
  }
  registeredCleanupHook = true;
  process.once("exit", closeJournalDbCache);
}

/** SQLite identifier pattern — prevents injection when used for DDL. */
const SQL_IDENTIFIER = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function ensureColumnExists(
  db: DatabaseSync,
  tableName: string,
  columnName: string,
  definition: string,
): void {
  if (!SQL_IDENTIFIER.test(tableName) || !SQL_IDENTIFIER.test(columnName)) {
    throw new Error(`Invalid table or column name: ${tableName}.${columnName}`);
  }
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name?: string | null;
  }>;
  const hasColumn = rows.some((row) => row.name === columnName);
  if (hasColumn) {
    return;
  }
  // definition is allowlisted at call sites (INTEGER, TEXT, etc.); no user input.
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}

/** Close all open journal connections and clear the cache. */
export function closeJournalDbCache(): void {
  for (const db of DB_CACHE.values()) {
    try {
      db.close();
    } catch {
      // Ignore errors on close (e.g. already closed).
    }
  }
  DB_CACHE.clear();
}

/** For testing: close all open connections and clear the cache so tests can use fresh instances. */
export function clearJournalDbCacheForTest(): void {
  closeJournalDbCache();
}

/** Run operations in a SQLite transaction and rollback on any thrown error. */
export function runJournalTransaction<T>(db: DatabaseSync, op: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = op();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors and rethrow original failure.
    }
    throw err;
  }
}
