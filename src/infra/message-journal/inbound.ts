import { buildInboundDedupeKey } from "../../auto-reply/reply/inbound-dedupe.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { logVerbose } from "../../globals.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { generateSecureUuid } from "../secure-random.js";
import { getJournalDb, runJournalTransaction } from "./db.js";

/** Delivered/aborted rows older than this are pruned at gateway startup. */
export const INBOUND_PRUNE_AGE_MS = 48 * 60 * 60_000; // 48 hours
/** Startup orphan recovery stops retrying after this many failed attempts. */
export const MAX_INBOUND_RECOVERY_ATTEMPTS = 3;

const DEDUPE_FALLBACK_TTL_MS = 10 * 60_000;
const JOURNAL_WARN_THROTTLE_MS = 60_000;
const dedupeFallbackCache = new Map<string, number>();
const log = createSubsystemLogger("message-journal/inbound");
let lastJournalWarnAt = 0;

export type InboundEventRow = {
  id: string;
  channel: string;
  account_id: string;
  external_id: string | null;
  session_key: string;
  payload: string;
  received_at: number;
  status: string;
  recovery_attempts: number;
  last_recovery_at: number | null;
  recovery_error: string | null;
};

export type InboundRecoveryFailureResult = {
  attempts: number;
  markedFailed: boolean;
};

function buildFallbackDedupeKey(channel: string, accountId: string, externalId: string): string {
  return `${channel}\u0000${accountId}\u0000${externalId}`;
}

function cleanupDedupeFallback(now: number): void {
  for (const [key, seenAt] of dedupeFallbackCache) {
    if (now - seenAt > DEDUPE_FALLBACK_TTL_MS) {
      dedupeFallbackCache.delete(key);
    }
  }
}

function acceptFromDedupeFallback(key: string, now: number): boolean {
  cleanupDedupeFallback(now);
  const previous = dedupeFallbackCache.get(key);
  dedupeFallbackCache.set(key, now);
  return previous === undefined || now - previous > DEDUPE_FALLBACK_TTL_MS;
}

function warnJournalFailure(message: string): void {
  const now = Date.now();
  if (now - lastJournalWarnAt >= JOURNAL_WARN_THROTTLE_MS) {
    lastJournalWarnAt = now;
    log.warn(message);
    return;
  }
  logVerbose(`message-journal/inbound: ${message}`);
}

/**
 * Attempt to accept an inbound message turn into the journal.
 *
 * Returns true if the turn was newly accepted (status='processing' row inserted).
 * Returns false if it was a duplicate (same channel+account_id+external_id already exists).
 *
 * When external_id is null (channel didn't provide a message ID), the unique index
 * is not enforced — such messages always return true.
 */
export function acceptInboundOrSkip(ctx: MsgContext, opts?: { stateDir?: string }): boolean {
  const db = getJournalDb(opts?.stateDir);
  const id = ctx.PendingReplyId ?? generateSecureUuid();

  // Derive external_id from the context's message identifier.
  // buildInboundDedupeKey returns null when provider/messageId is missing — in
  // that case we leave external_id as NULL (no dedup, always accepted).
  const dedupeKey = buildInboundDedupeKey(ctx);
  const external_id = ctx.MessageSid ?? null;

  const channel = String(ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider ?? "").toLowerCase();
  const account_id = ctx.AccountId?.trim() ?? "";
  const session_key = ctx.SessionKey?.trim() ?? "";

  // Payload captures routing + inbound text fields needed for orphan recovery.
  const payload = JSON.stringify({
    from: ctx.From,
    to: ctx.To,
    body: ctx.Body,
    bodyForAgent: ctx.BodyForAgent,
    bodyForCommands: ctx.BodyForCommands,
    rawBody: ctx.RawBody,
    commandBody: ctx.CommandBody,
    user: ctx.From,
    userName: ctx.SenderName ?? ctx.SenderUsername,
    chatId: ctx.OriginatingTo ?? ctx.To,
    accountId: ctx.AccountId,
    threadId: ctx.MessageThreadId,
    provider: ctx.Provider,
    surface: ctx.Surface,
    originatingChannel:
      typeof ctx.OriginatingChannel === "string" ? ctx.OriginatingChannel : undefined,
    originatingTo: ctx.OriginatingTo,
    chatType: ctx.ChatType,
    commandAuthorized: ctx.CommandAuthorized,
    commandSource: ctx.CommandSource,
    commandTargetSessionKey: ctx.CommandTargetSessionKey,
    senderId: ctx.SenderId,
    senderName: ctx.SenderName,
    senderUsername: ctx.SenderUsername,
    senderE164: ctx.SenderE164,
    wasMentioned: ctx.WasMentioned,
    isForum: ctx.IsForum,
    timestamp: ctx.Timestamp,
    conversationLabel: ctx.ConversationLabel,
    groupSubject: ctx.GroupSubject,
    groupChannel: ctx.GroupChannel,
    groupSpace: ctx.GroupSpace,
    groupMembers: ctx.GroupMembers,
    hookMessages: ctx.HookMessages,
    messageId: ctx.MessageSid,
    messageIdFull: ctx.MessageSidFull,
  });

  // When external_id is present, the unique index on (channel, account_id, external_id)
  // will reject duplicates. We use OR IGNORE so duplicates return cleanly without throwing.
  // When dedupeKey is null (no provider+messageId), we skip dedup entirely and always insert.
  try {
    if (dedupeKey && external_id) {
      // Use INSERT OR IGNORE; check changes() to detect whether the row was actually inserted.
      db.prepare(
        `INSERT OR IGNORE INTO inbound_events
           (id, channel, account_id, external_id, session_key, payload, received_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'processing')`,
      ).run(id, channel, account_id, external_id, session_key, payload, Date.now());
      // If the unique index rejected the insert, changes() returns 0 → duplicate.
      const changes = db.prepare("SELECT changes() AS c").get() as { c: number };
      return changes.c > 0;
    } else {
      // No external_id — always accept (cannot dedup without a message identifier).
      db.prepare(
        `INSERT INTO inbound_events
           (id, channel, account_id, external_id, session_key, payload, received_at, status)
         VALUES (?, ?, ?, NULL, ?, ?, ?, 'processing')`,
      ).run(id, channel, account_id, session_key, payload, Date.now());
      return true;
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    if (dedupeKey && external_id) {
      const now = Date.now();
      const fallbackKey = buildFallbackDedupeKey(channel, account_id, external_id);
      const accepted = acceptFromDedupeFallback(fallbackKey, now);
      warnJournalFailure(
        `acceptInboundOrSkip: journal write failed (${errMsg}); using in-memory dedupe fallback for ${channel}/${account_id}/${external_id} (accepted=${accepted})`,
      );
      return accepted;
    }
    // No stable dedupe key available: continue fail-open for availability.
    warnJournalFailure(
      `acceptInboundOrSkip: journal write failed without dedupe key (${errMsg}); accepting inbound turn`,
    );
    return true;
  }
}

/**
 * Transition an inbound event to a terminal status.
 * Safe to call multiple times — subsequent calls on the same id are no-ops.
 */
export function completeInboundTurn(
  id: string,
  status: "delivered" | "aborted" | "failed",
  opts?: { stateDir?: string },
): void {
  const db = getJournalDb(opts?.stateDir);
  try {
    db.prepare(`UPDATE inbound_events SET status = ? WHERE id = ? AND status = 'processing'`).run(
      status,
      id,
    );
  } catch (err) {
    logVerbose(`message-journal/inbound: completeInboundTurn failed: ${String(err)}`);
  }
}

/**
 * Record a failed orphan-recovery attempt.
 *
 * Rows are retried while status='processing'. Once the attempt cap is reached,
 * the row is marked failed so restart recovery does not loop forever.
 */
export function recordInboundRecoveryFailure(
  id: string,
  error: string,
  opts?: { stateDir?: string },
): InboundRecoveryFailureResult {
  const db = getJournalDb(opts?.stateDir);
  try {
    return runJournalTransaction(db, () => {
      const row = db
        .prepare(
          `SELECT recovery_attempts FROM inbound_events WHERE id = ? AND status = 'processing'`,
        )
        .get(id) as { recovery_attempts: number } | undefined;
      if (!row) {
        return { attempts: 0, markedFailed: false };
      }
      const attempts = row.recovery_attempts + 1;
      const now = Date.now();
      if (attempts >= MAX_INBOUND_RECOVERY_ATTEMPTS) {
        db.prepare(
          `UPDATE inbound_events
             SET status = 'failed', recovery_attempts = ?, last_recovery_at = ?, recovery_error = ?
           WHERE id = ? AND status = 'processing'`,
        ).run(attempts, now, error, id);
        return { attempts, markedFailed: true };
      }
      db.prepare(
        `UPDATE inbound_events
           SET recovery_attempts = ?, last_recovery_at = ?, recovery_error = ?
         WHERE id = ? AND status = 'processing'`,
      ).run(attempts, now, error, id);
      return { attempts, markedFailed: false };
    });
  } catch (err) {
    logVerbose(`message-journal/inbound: recordInboundRecoveryFailure failed: ${String(err)}`);
    return { attempts: 0, markedFailed: false };
  }
}

/**
 * Find inbound events that are still in 'processing' state — candidates for
 * orphan-reply recovery at gateway startup.
 *
 * @param opts.minAgeMs  Skip rows younger than this (still actively running). Default: 0.
 * @param opts.maxAgeMs  Skip rows older than this (too stale to recover). Default: 24h.
 */
export function findProcessingInbound(opts?: {
  minAgeMs?: number;
  maxAgeMs?: number;
  stateDir?: string;
}): InboundEventRow[] {
  const db = getJournalDb(opts?.stateDir);
  const now = Date.now();
  const minAge = opts?.minAgeMs ?? 0;
  const maxAge = opts?.maxAgeMs ?? 24 * 60 * 60_000;
  const newerThan = now - maxAge;
  const olderThan = now - minAge;

  try {
    return db
      .prepare(
        `SELECT id, channel, account_id, external_id, session_key, payload, received_at, status,
                recovery_attempts, last_recovery_at, recovery_error
           FROM inbound_events
          WHERE status = 'processing'
            AND received_at >= ?
            AND received_at <= ?
          ORDER BY received_at ASC`,
      )
      .all(newerThan, olderThan) as InboundEventRow[];
  } catch (err) {
    logVerbose(`message-journal/inbound: findProcessingInbound failed: ${String(err)}`);
    return [];
  }
}

/**
 * Mark all 'processing' inbound events for a given session key as 'aborted'.
 * Called from the abort handler to prevent orphan recovery from re-dispatching
 * turns that were intentionally stopped by the user.
 */
export function abortProcessingInboundForSession(
  sessionKey: string,
  opts?: { stateDir?: string },
): void {
  if (!sessionKey.trim()) {
    return;
  }
  const db = getJournalDb(opts?.stateDir);
  try {
    db.prepare(
      `UPDATE inbound_events SET status = 'aborted'
        WHERE session_key = ? AND status = 'processing'`,
    ).run(sessionKey.trim());
  } catch (err) {
    logVerbose(`message-journal/inbound: abortProcessingInboundForSession failed: ${String(err)}`);
  }
}

/**
 * Delete delivered/aborted/failed rows older than ageMs.
 * Run at startup to keep the journal table bounded.
 */
export function pruneInboundJournal(ageMs: number, opts?: { stateDir?: string }): void {
  const db = getJournalDb(opts?.stateDir);
  const cutoff = Date.now() - ageMs;
  try {
    db.prepare(
      `DELETE FROM inbound_events
        WHERE status IN ('delivered', 'aborted', 'failed')
          AND received_at < ?`,
    ).run(cutoff);
  } catch (err) {
    logVerbose(`message-journal/inbound: pruneInboundJournal failed: ${String(err)}`);
  }
}
