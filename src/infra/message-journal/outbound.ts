import fs from "node:fs";
import path from "node:path";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import { logVerbose } from "../../globals.js";
import type { OutboundChannel } from "../outbound/targets.js";
import { generateSecureUuid } from "../secure-random.js";
import { getJournalDb, runJournalTransaction } from "./db.js";

const MAX_RETRIES = 5;
export { MAX_RETRIES };

/** Backoff delays indexed by retry count (1-based). */
const BACKOFF_MS: readonly number[] = [
  5_000, // retry 1: 5s
  25_000, // retry 2: 25s
  120_000, // retry 3: 2m
  600_000, // retry 4: 10m
];

/** Messages in 'queued' state older than this are expired to 'failed' at recovery. */
const QUEUE_TTL_MS = 30 * 60_000; // 30 minutes

type DeliveryMirrorPayload = {
  sessionKey: string;
  agentId?: string;
  text?: string;
  mediaUrls?: string[];
};

type QueuedDeliveryPayload = {
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  /**
   * Original payloads before plugin hooks. On recovery, hooks re-run on these
   * payloads — this is intentional since hooks are stateless transforms.
   */
  payloads: ReplyPayload[];
  threadId?: string | number | null;
  replyToId?: string | null;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  silent?: boolean;
  mirror?: DeliveryMirrorPayload;
};

export type QueuedDeliveryParams = QueuedDeliveryPayload;

/** Shape returned when loading pending entries for recovery. */
export interface QueuedDelivery extends QueuedDeliveryPayload {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  /** Timestamp of the most recent failed attempt; undefined for never-attempted entries. */
  lastAttemptAt?: number;
  lastError?: string;
}

export type DeliverFn = (
  params: { cfg: OpenClawConfig } & QueuedDeliveryParams & { skipQueue?: boolean },
) => Promise<unknown>;

export interface RecoveryLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/** Persist a delivery entry to the journal before attempting send. Returns the entry id. */
export async function enqueueDelivery(
  params: QueuedDeliveryParams,
  stateDir?: string,
): Promise<string> {
  const db = getJournalDb(stateDir);
  const id = generateSecureUuid();
  const payload = JSON.stringify({
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    payloads: params.payloads,
    threadId: params.threadId,
    replyToId: params.replyToId,
    bestEffort: params.bestEffort,
    gifPlayback: params.gifPlayback,
    silent: params.silent,
    mirror: params.mirror,
  });

  db.prepare(
    `INSERT INTO outbound_messages
       (id, channel, account_id, target, payload, queued_at, status, retry_count)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', 0)`,
  ).run(id, String(params.channel), params.accountId ?? "", params.to, payload, Date.now());

  return id;
}

/** Mark a successfully delivered entry as 'delivered'. */
export async function ackDelivery(id: string, stateDir?: string): Promise<void> {
  const db = getJournalDb(stateDir);
  try {
    db.prepare(`UPDATE outbound_messages SET status='delivered', delivered_at=? WHERE id=?`).run(
      Date.now(),
      id,
    );
  } catch (err) {
    logVerbose(`message-journal/outbound: ackDelivery failed: ${String(err)}`);
  }
}

/**
 * Record a delivery failure.
 * - Permanent errors: status → 'failed', error_class → 'permanent'
 * - Transient errors: retry_count++, stays 'queued' (up to MAX_RETRIES)
 * - After MAX_RETRIES transient failures: status → 'failed', error_class → 'terminal'
 */
export async function failDelivery(id: string, error: string, stateDir?: string): Promise<void> {
  const db = getJournalDb(stateDir);
  try {
    if (isPermanentDeliveryError(error)) {
      db.prepare(
        `UPDATE outbound_messages
           SET status='failed', error_class='permanent', last_error=?
         WHERE id=?`,
      ).run(error, id);
      return;
    }
    // Transient path is read+write and must be atomic to avoid duplicate increments.
    runJournalTransaction(db, () => {
      const row = db.prepare(`SELECT retry_count FROM outbound_messages WHERE id=?`).get(id) as
        | { retry_count: number }
        | undefined;
      if (!row) {
        return;
      }
      const nextCount = row.retry_count + 1;
      const attemptedAt = Date.now();
      if (nextCount >= MAX_RETRIES) {
        db.prepare(
          `UPDATE outbound_messages
             SET status='failed', error_class='terminal', last_error=?, retry_count=?, last_attempt_at=?
           WHERE id=?`,
        ).run(error, nextCount, attemptedAt, id);
        return;
      }
      db.prepare(
        `UPDATE outbound_messages
           SET retry_count=?, last_error=?, last_attempt_at=?
         WHERE id=?`,
      ).run(nextCount, error, attemptedAt, id);
    });
  } catch (err) {
    logVerbose(`message-journal/outbound: failDelivery failed: ${String(err)}`);
  }
}

/** Load all pending ('queued') deliveries sorted by queued_at ascending. */
export async function loadPendingDeliveries(stateDir?: string): Promise<QueuedDelivery[]> {
  const db = getJournalDb(stateDir);
  try {
    const rows = db
      .prepare(
        `SELECT id, payload, queued_at, retry_count, last_attempt_at, last_error
           FROM outbound_messages
          WHERE status='queued'
          ORDER BY queued_at ASC`,
      )
      .all() as Array<{
      id: string;
      payload: string;
      queued_at: number;
      retry_count: number;
      last_attempt_at: number | null;
      last_error: string | null;
    }>;

    return rows.map((row) => {
      const p = JSON.parse(row.payload) as QueuedDeliveryPayload;
      return {
        ...p,
        id: row.id,
        enqueuedAt: row.queued_at,
        retryCount: row.retry_count,
        ...(row.last_attempt_at != null ? { lastAttemptAt: row.last_attempt_at } : {}),
        ...(row.last_error ? { lastError: row.last_error } : {}),
      };
    });
  } catch (err) {
    logVerbose(`message-journal/outbound: loadPendingDeliveries failed: ${String(err)}`);
    return [];
  }
}

/** Move an entry to status='failed' (equivalent of old moveToFailed). */
export async function moveToFailed(id: string, stateDir?: string): Promise<void> {
  const db = getJournalDb(stateDir);
  try {
    db.prepare(
      `UPDATE outbound_messages SET status='failed', error_class='terminal' WHERE id=?`,
    ).run(id);
  } catch (err) {
    logVerbose(`message-journal/outbound: moveToFailed failed: ${String(err)}`);
  }
}

/** Compute exponential backoff delay in ms for a given retry count. */
export function computeBackoffMs(retryCount: number): number {
  if (retryCount <= 0) {
    return 0;
  }
  return BACKOFF_MS[Math.min(retryCount - 1, BACKOFF_MS.length - 1)] ?? BACKOFF_MS.at(-1) ?? 0;
}

/**
 * Check whether a queued entry is ready for a recovery attempt right now.
 * Uses last_attempt_at (when available) to avoid re-blocking on backoff that
 * already elapsed before the restart — entries are skipped rather than delayed.
 */
export function isEntryEligibleForRecoveryRetry(
  entry: QueuedDelivery,
  now: number,
): { eligible: true } | { eligible: false; remainingBackoffMs: number } {
  const backoff = computeBackoffMs(entry.retryCount + 1);
  if (backoff <= 0) {
    return { eligible: true };
  }
  // First-ever attempt after a crash (never previously tried): retry immediately.
  const firstReplayAfterCrash = entry.retryCount === 0 && entry.lastAttemptAt === undefined;
  if (firstReplayAfterCrash) {
    return { eligible: true };
  }
  const hasAttemptTimestamp =
    typeof entry.lastAttemptAt === "number" &&
    Number.isFinite(entry.lastAttemptAt) &&
    entry.lastAttemptAt > 0;
  // Fall back to enqueuedAt when lastAttemptAt is unavailable (e.g. migrated entries).
  const baseAttemptAt = hasAttemptTimestamp ? entry.lastAttemptAt! : entry.enqueuedAt;
  const nextEligibleAt = baseAttemptAt + backoff;
  if (now >= nextEligibleAt) {
    return { eligible: true };
  }
  return { eligible: false, remainingBackoffMs: nextEligibleAt - now };
}

/**
 * On startup, expire stale queued entries and retry the rest.
 * TTL: entries queued more than 30min ago expire to 'failed'.
 * Entries whose backoff window has not elapsed are deferred to the next restart
 * rather than blocking recovery with an inline sleep.
 */
export async function recoverPendingDeliveries(opts: {
  deliver: DeliverFn;
  log: RecoveryLogger;
  cfg: OpenClawConfig;
  stateDir?: string;
  /** Maximum wall-clock time for recovery in ms. Default: 60 000. */
  maxRecoveryMs?: number;
}): Promise<{ recovered: number; failed: number; skipped: number; deferredBackoff: number }> {
  const db = getJournalDb(opts.stateDir);

  // Expire stale entries before recovery.
  const staleCutoff = Date.now() - QUEUE_TTL_MS;
  try {
    db.prepare(
      `UPDATE outbound_messages
         SET status='failed', error_class='terminal', last_error='expired: queued_at too old'
       WHERE status='queued' AND queued_at < ?`,
    ).run(staleCutoff);
  } catch (err) {
    logVerbose(`message-journal/outbound: stale-entry expiry failed: ${String(err)}`);
  }

  const pending = await loadPendingDeliveries(opts.stateDir);
  if (pending.length === 0) {
    return { recovered: 0, failed: 0, skipped: 0, deferredBackoff: 0 };
  }

  opts.log.info(`Found ${pending.length} pending delivery entries — starting recovery`);

  const deadline = Date.now() + (opts.maxRecoveryMs ?? 60_000);

  let recovered = 0;
  let failed = 0;
  let skipped = 0;
  let deferredBackoff = 0;

  for (const entry of pending) {
    const now = Date.now();
    if (now >= deadline) {
      const remaining = pending.length - recovered - failed - skipped - deferredBackoff;
      opts.log.warn(
        `Recovery time budget exceeded — ${remaining} entries deferred to next restart`,
      );
      break;
    }
    if (entry.retryCount >= MAX_RETRIES) {
      opts.log.warn(
        `Delivery ${entry.id} exceeded max retries (${entry.retryCount}/${MAX_RETRIES}) — marking failed`,
      );
      await moveToFailed(entry.id, opts.stateDir);
      skipped += 1;
      continue;
    }

    const eligibility = isEntryEligibleForRecoveryRetry(entry, now);
    if (!eligibility.eligible) {
      deferredBackoff += 1;
      opts.log.info(
        `Delivery ${entry.id} not ready for retry — backoff ${eligibility.remainingBackoffMs}ms remaining`,
      );
      continue;
    }

    try {
      await opts.deliver({
        cfg: opts.cfg,
        channel: entry.channel,
        to: entry.to,
        accountId: entry.accountId,
        payloads: entry.payloads,
        threadId: entry.threadId,
        replyToId: entry.replyToId,
        bestEffort: entry.bestEffort,
        gifPlayback: entry.gifPlayback,
        silent: entry.silent,
        mirror: entry.mirror,
        skipQueue: true, // Prevent re-enqueueing during recovery.
      });
      await ackDelivery(entry.id, opts.stateDir);
      recovered += 1;
      opts.log.info(`Recovered delivery ${entry.id} to ${entry.channel}:${entry.to}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (isPermanentDeliveryError(errMsg)) {
        opts.log.warn(`Delivery ${entry.id} hit permanent error — marking failed: ${errMsg}`);
        await moveToFailed(entry.id, opts.stateDir);
        failed += 1;
        continue;
      }
      await failDelivery(entry.id, errMsg, opts.stateDir);
      failed += 1;
      opts.log.warn(`Retry failed for delivery ${entry.id}: ${errMsg}`);
    }
  }

  opts.log.info(
    `Delivery recovery complete: ${recovered} recovered, ${failed} failed, ${skipped} skipped (max retries), ${deferredBackoff} deferred (backoff)`,
  );
  return { recovered, failed, skipped, deferredBackoff };
}

const PERMANENT_ERROR_PATTERNS: readonly RegExp[] = [
  /no conversation reference found/i,
  /chat not found/i,
  /user not found/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /chat_id is empty/i,
  /recipient is not a valid/i,
  /outbound not configured for channel/i,
];

export function isPermanentDeliveryError(error: string): boolean {
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(error));
}

/** Delivered/failed outbound rows older than this are pruned periodically. */
export const OUTBOUND_PRUNE_AGE_MS = 48 * 60 * 60_000; // 48 hours

/**
 * Delete terminal (delivered/failed) outbound rows older than ageMs.
 * Keyed on queued_at so the index is used efficiently.
 */
export function pruneOutboundJournal(ageMs: number, opts?: { stateDir?: string }): void {
  const db = getJournalDb(opts?.stateDir);
  const cutoff = Date.now() - ageMs;
  try {
    db.prepare(
      `DELETE FROM outbound_messages
        WHERE status IN ('delivered', 'failed')
          AND queued_at < ?`,
    ).run(cutoff);
  } catch (err) {
    logVerbose(`message-journal/outbound: pruneOutboundJournal failed: ${String(err)}`);
  }
}

/**
 * One-time migration: read any remaining *.json files from the old delivery-queue/
 * directory, insert them as journal rows, and delete the files.
 * After first startup this is a no-op (the directory will be empty or missing).
 */
export async function migrateFileQueueToJournal(stateDir?: string): Promise<void> {
  const base = stateDir ?? resolveStateDir();
  const queueDir = path.join(base, "delivery-queue");
  let files: string[];
  try {
    files = fs.readdirSync(queueDir);
  } catch (err) {
    logVerbose(`message-journal/outbound: migrate queue read failed: ${String(err)}`);
    return; // Directory missing — nothing to migrate.
  }

  const db = getJournalDb(stateDir);

  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(queueDir, file);
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        continue;
      }
      const raw = fs.readFileSync(filePath, "utf-8");
      const entry: QueuedDelivery = JSON.parse(raw);
      if (!entry.id || !entry.channel || !entry.to) {
        continue;
      }
      // Insert as 'queued' (mimicking what enqueueDelivery would do).
      const payload = JSON.stringify({
        channel: entry.channel,
        to: entry.to,
        accountId: entry.accountId,
        payloads: entry.payloads,
        threadId: entry.threadId,
        replyToId: entry.replyToId,
        bestEffort: entry.bestEffort,
        gifPlayback: entry.gifPlayback,
        silent: entry.silent,
        mirror: entry.mirror,
      });
      try {
        db.prepare(
          `INSERT OR IGNORE INTO outbound_messages
             (id, channel, account_id, target, payload, queued_at, status, retry_count, last_error)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
        ).run(
          entry.id,
          String(entry.channel),
          entry.accountId ?? "",
          entry.to,
          payload,
          entry.enqueuedAt ?? Date.now(),
          entry.retryCount ?? 0,
          entry.lastError ?? null,
        );
      } catch (err) {
        logVerbose(
          `message-journal/outbound: migrate insert failed for ${entry.id}: ${String(err)}`,
        );
        // Skip entries that fail to insert (e.g. id collision).
        continue;
      }
      // Remove the migrated file.
      try {
        fs.unlinkSync(filePath);
      } catch (err) {
        logVerbose(
          `message-journal/outbound: migrate unlink failed for ${filePath}: ${String(err)}`,
        );
      }
    } catch (err) {
      logVerbose(
        `message-journal/outbound: migrate parse/read failed for ${filePath}: ${String(err)}`,
      );
    }
  }
}
