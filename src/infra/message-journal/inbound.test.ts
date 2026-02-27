import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MsgContext } from "../../auto-reply/templating.js";
import { clearJournalDbCacheForTest, getJournalDb } from "./db.js";
import {
  abortProcessingInboundForSession,
  acceptInboundOrSkip,
  completeInboundTurn,
  findProcessingInbound,
  MAX_INBOUND_RECOVERY_ATTEMPTS,
  pruneInboundJournal,
  recordInboundRecoveryFailure,
} from "./inbound.js";

let tmpDir: string;

/** Build a minimal MsgContext stub for testing inbound journal operations. */
function makeCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    Provider: "test-provider",
    Surface: "test-surface",
    OriginatingChannel: "test-channel",
    AccountId: "acct-1",
    SessionKey: "agent:main:test",
    From: "+1555",
    To: "+1666",
    Body: "Hello",
    MessageSid: undefined,
    PendingReplyId: undefined,
    ...overrides,
  } as unknown as MsgContext;
}

beforeEach(() => {
  clearJournalDbCacheForTest();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-inbound-test-"));
});

afterEach(() => {
  clearJournalDbCacheForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("acceptInboundOrSkip", () => {
  it("returns true and inserts a processing row on first call", () => {
    const ctx = makeCtx({ MessageSid: "msg-001", AccountId: "acct-1" });
    const accepted = acceptInboundOrSkip(ctx, { stateDir: tmpDir });
    expect(accepted).toBe(true);
  });

  it("returns false for a duplicate (same channel+account_id+external_id)", () => {
    const ctx = makeCtx({ MessageSid: "msg-dup", AccountId: "acct-1" });
    const first = acceptInboundOrSkip(ctx, { stateDir: tmpDir });
    const second = acceptInboundOrSkip(ctx, { stateDir: tmpDir });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("uses in-memory dedupe fallback when journal writes fail", () => {
    // Simulate a journal failure while keeping the same process alive.
    const db = getJournalDb(tmpDir);
    db.close();
    const ctx = makeCtx({ MessageSid: "fallback-dup", AccountId: "acct-1" });
    const first = acceptInboundOrSkip(ctx, { stateDir: tmpDir });
    const second = acceptInboundOrSkip(ctx, { stateDir: tmpDir });
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("returns true when external_id is null (no dedup for messages without IDs)", () => {
    const ctx = makeCtx({ MessageSid: undefined, AccountId: "acct-1" });
    const first = acceptInboundOrSkip(ctx, { stateDir: tmpDir });
    const second = acceptInboundOrSkip(ctx, { stateDir: tmpDir });
    expect(first).toBe(true);
    expect(second).toBe(true); // null external_id — always accepted
  });

  it("keeps fail-open behavior when no dedupe key exists and journal writes fail", () => {
    const db = getJournalDb(tmpDir);
    db.close();
    const ctx = makeCtx({ MessageSid: undefined, AccountId: "acct-1" });
    const first = acceptInboundOrSkip(ctx, { stateDir: tmpDir });
    const second = acceptInboundOrSkip(ctx, { stateDir: tmpDir });
    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  it("different accounts with same external_id are not duplicates", () => {
    const ctx1 = makeCtx({ MessageSid: "msg-001", AccountId: "acct-A" });
    const ctx2 = makeCtx({ MessageSid: "msg-001", AccountId: "acct-B" });
    expect(acceptInboundOrSkip(ctx1, { stateDir: tmpDir })).toBe(true);
    expect(acceptInboundOrSkip(ctx2, { stateDir: tmpDir })).toBe(true);
  });

  it("different peers with same message_id are not duplicates (e.g. Telegram per-chat IDs)", () => {
    // Same channel, account, and message_id but different chat (OriginatingTo) — must both be accepted.
    const ctx1 = makeCtx({
      MessageSid: "42",
      AccountId: "acct-1",
      OriginatingTo: "chat-A",
      To: "chat-A",
    });
    const ctx2 = makeCtx({
      MessageSid: "42",
      AccountId: "acct-1",
      OriginatingTo: "chat-B",
      To: "chat-B",
    });
    expect(acceptInboundOrSkip(ctx1, { stateDir: tmpDir })).toBe(true);
    expect(acceptInboundOrSkip(ctx2, { stateDir: tmpDir })).toBe(true);
  });

  it("uses PendingReplyId as the row id when provided", () => {
    const ctx = makeCtx({ PendingReplyId: "custom-pending-id-001", MessageSid: "msg-xyz" });
    const accepted = acceptInboundOrSkip(ctx, { stateDir: tmpDir });
    expect(accepted).toBe(true);

    const rows = findProcessingInbound({ stateDir: tmpDir });
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("custom-pending-id-001");
  });
});

describe("completeInboundTurn", () => {
  it("transitions status from processing to delivered", () => {
    const ctx = makeCtx({ PendingReplyId: "turn-001", MessageSid: "sid-1" });
    acceptInboundOrSkip(ctx, { stateDir: tmpDir });

    completeInboundTurn("turn-001", "delivered", { stateDir: tmpDir });

    // Row should no longer appear in 'processing' list.
    const rows = findProcessingInbound({ stateDir: tmpDir });
    expect(rows).toHaveLength(0);
  });

  it("transitions status from processing to aborted", () => {
    const ctx = makeCtx({ PendingReplyId: "turn-002", MessageSid: "sid-2" });
    acceptInboundOrSkip(ctx, { stateDir: tmpDir });

    completeInboundTurn("turn-002", "aborted", { stateDir: tmpDir });

    const rows = findProcessingInbound({ stateDir: tmpDir });
    expect(rows).toHaveLength(0);
  });

  it("transitions status from processing to failed", () => {
    const ctx = makeCtx({ PendingReplyId: "turn-003", MessageSid: "sid-3" });
    acceptInboundOrSkip(ctx, { stateDir: tmpDir });

    completeInboundTurn("turn-003", "failed", { stateDir: tmpDir });

    const rows = findProcessingInbound({ stateDir: tmpDir });
    expect(rows).toHaveLength(0);
  });

  it("is idempotent — second call on same id is a no-op", () => {
    const ctx = makeCtx({ PendingReplyId: "turn-004", MessageSid: "sid-4" });
    acceptInboundOrSkip(ctx, { stateDir: tmpDir });

    completeInboundTurn("turn-004", "delivered", { stateDir: tmpDir });
    // Second call should not throw.
    expect(() => completeInboundTurn("turn-004", "delivered", { stateDir: tmpDir })).not.toThrow();
  });
});

describe("recordInboundRecoveryFailure", () => {
  it("increments recovery attempts and eventually marks row failed", () => {
    const ctx = makeCtx({ PendingReplyId: "recover-1", MessageSid: "recover-sid-1" });
    acceptInboundOrSkip(ctx, { stateDir: tmpDir });

    for (let attempt = 1; attempt <= MAX_INBOUND_RECOVERY_ATTEMPTS; attempt += 1) {
      const result = recordInboundRecoveryFailure("recover-1", `failure-${attempt}`, {
        stateDir: tmpDir,
      });
      expect(result.attempts).toBe(attempt);
      expect(result.markedFailed).toBe(attempt >= MAX_INBOUND_RECOVERY_ATTEMPTS);
    }

    const processing = findProcessingInbound({ stateDir: tmpDir });
    expect(processing).toHaveLength(0);

    const db = getJournalDb(tmpDir);
    const row = db
      .prepare(
        "SELECT status, recovery_attempts, last_recovery_at, recovery_error FROM inbound_events WHERE id=?",
      )
      .get("recover-1") as
      | {
          status: string;
          recovery_attempts: number;
          last_recovery_at: number | null;
          recovery_error: string | null;
        }
      | undefined;
    expect(row?.status).toBe("failed");
    expect(row?.recovery_attempts).toBe(MAX_INBOUND_RECOVERY_ATTEMPTS);
    expect(typeof row?.last_recovery_at).toBe("number");
    expect(row?.recovery_error).toBe(`failure-${MAX_INBOUND_RECOVERY_ATTEMPTS}`);
  });
});

describe("findProcessingInbound", () => {
  it("returns empty array when no processing rows", () => {
    const rows = findProcessingInbound({ stateDir: tmpDir });
    expect(rows).toHaveLength(0);
  });

  it("respects minAgeMs — skips rows younger than threshold", () => {
    const ctx = makeCtx({ PendingReplyId: "fresh-001", MessageSid: "sm-1" });
    acceptInboundOrSkip(ctx, { stateDir: tmpDir });

    // minAgeMs=60000 — a row inserted just now is younger than 1min, should be excluded.
    const rows = findProcessingInbound({ minAgeMs: 60_000, stateDir: tmpDir });
    expect(rows).toHaveLength(0);
  });

  it("respects maxAgeMs — skips rows older than threshold", () => {
    const ctx = makeCtx({ PendingReplyId: "old-001", MessageSid: "sm-old-1" });
    acceptInboundOrSkip(ctx, { stateDir: tmpDir });

    // Manually backdate the row to be 2 hours old.
    const db = getJournalDb(tmpDir);
    const twoHoursAgo = Date.now() - 2 * 60 * 60_000;
    db.prepare("UPDATE inbound_events SET received_at=? WHERE id=?").run(twoHoursAgo, "old-001");

    // maxAgeMs=1h — rows older than 1h are excluded.
    const rows = findProcessingInbound({ maxAgeMs: 60 * 60_000, stateDir: tmpDir });
    expect(rows).toHaveLength(0);
  });

  it("returns multiple processing rows sorted by received_at ascending", () => {
    for (let i = 1; i <= 3; i++) {
      const ctx = makeCtx({ PendingReplyId: `turn-${i}`, MessageSid: `msg-${i}` });
      acceptInboundOrSkip(ctx, { stateDir: tmpDir });
    }

    const rows = findProcessingInbound({ stateDir: tmpDir });
    expect(rows).toHaveLength(3);
    // Verify ascending order by received_at.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].received_at).toBeGreaterThanOrEqual(rows[i - 1].received_at);
    }
  });

  it("includes payload and session_key in returned rows", () => {
    const ctx = makeCtx({
      PendingReplyId: "payload-test",
      MessageSid: "sm-p1",
      SessionKey: "agent:main:test",
      From: "+1234",
      To: "+5678",
    });
    acceptInboundOrSkip(ctx, { stateDir: tmpDir });

    const rows = findProcessingInbound({ stateDir: tmpDir });
    expect(rows).toHaveLength(1);
    expect(rows[0].session_key).toBe("agent:main:test");
    expect(rows[0].status).toBe("processing");

    const payload = JSON.parse(rows[0].payload);
    expect(payload.from).toBe("+1234");
    expect(payload.to).toBe("+5678");
  });
});

describe("abortProcessingInboundForSession", () => {
  it("marks all processing rows for a session as aborted", () => {
    const session = "agent:main:target";
    for (let i = 1; i <= 3; i++) {
      const ctx = makeCtx({
        PendingReplyId: `abort-${i}`,
        MessageSid: `abort-sid-${i}`,
        SessionKey: session,
      });
      acceptInboundOrSkip(ctx, { stateDir: tmpDir });
    }

    // A row for a different session — should not be affected.
    const otherCtx = makeCtx({
      PendingReplyId: "other-session",
      MessageSid: "other-sid",
      SessionKey: "agent:main:other",
    });
    acceptInboundOrSkip(otherCtx, { stateDir: tmpDir });

    abortProcessingInboundForSession(session, { stateDir: tmpDir });

    const remaining = findProcessingInbound({ stateDir: tmpDir });
    // Only the other-session row should remain processing.
    expect(remaining).toHaveLength(1);
    expect(remaining[0].session_key).toBe("agent:main:other");
  });

  it("is a no-op for empty sessionKey", () => {
    const ctx = makeCtx({ PendingReplyId: "noop-1", MessageSid: "noop-sid" });
    acceptInboundOrSkip(ctx, { stateDir: tmpDir });

    // Should not throw.
    expect(() => abortProcessingInboundForSession("", { stateDir: tmpDir })).not.toThrow();

    const rows = findProcessingInbound({ stateDir: tmpDir });
    expect(rows).toHaveLength(1); // unchanged
  });
});

describe("pruneInboundJournal", () => {
  it("deletes old delivered/aborted/failed rows but leaves processing rows", () => {
    // Insert a processing row.
    const ctx1 = makeCtx({ PendingReplyId: "prune-proc", MessageSid: "p-sid-1" });
    acceptInboundOrSkip(ctx1, { stateDir: tmpDir });

    // Insert a delivered row and backdate it.
    const ctx2 = makeCtx({ PendingReplyId: "prune-done", MessageSid: "p-sid-2" });
    acceptInboundOrSkip(ctx2, { stateDir: tmpDir });
    completeInboundTurn("prune-done", "delivered", { stateDir: tmpDir });

    // Backdate the delivered row so it falls within the prune window.
    const db = getJournalDb(tmpDir);
    const oldTime = Date.now() - 2 * 24 * 60 * 60_000; // 2 days ago
    db.prepare("UPDATE inbound_events SET received_at=? WHERE id=?").run(oldTime, "prune-done");

    // Prune rows older than 1 day.
    pruneInboundJournal(24 * 60 * 60_000, { stateDir: tmpDir });

    // Processing row should survive; delivered row should be gone.
    const processing = findProcessingInbound({ stateDir: tmpDir });
    expect(processing).toHaveLength(1);
    expect(processing[0].id).toBe("prune-proc");
  });

  it("does not delete recent delivered rows", () => {
    const ctx = makeCtx({ PendingReplyId: "recent-done", MessageSid: "r-sid" });
    acceptInboundOrSkip(ctx, { stateDir: tmpDir });
    completeInboundTurn("recent-done", "delivered", { stateDir: tmpDir });

    // Prune rows older than 1 day — the row was just inserted, so it should stay.
    pruneInboundJournal(24 * 60 * 60_000, { stateDir: tmpDir });

    // We can verify via direct DB query that the row still exists.
    const db = getJournalDb(tmpDir);
    const row = db.prepare("SELECT * FROM inbound_events WHERE id='recent-done'").get();
    expect(row).toBeTruthy();
  });
});
