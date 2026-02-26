import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { clearJournalDbCacheForTest, getJournalDb } from "./db.js";
import {
  ackDelivery,
  computeBackoffMs,
  enqueueDelivery,
  failDelivery,
  isEntryEligibleForRecoveryRetry,
  isPermanentDeliveryError,
  loadPendingDeliveries,
  MAX_RETRIES,
  migrateFileQueueToJournal,
  moveToFailed,
  recoverPendingDeliveries,
} from "./outbound.js";

let tmpDir: string;

beforeEach(() => {
  clearJournalDbCacheForTest();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-outbound-test-"));
});

afterEach(() => {
  clearJournalDbCacheForTest();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("enqueue + ack lifecycle", () => {
  it("enqueues an entry and ackDelivery marks it delivered", async () => {
    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "hello" }] },
      tmpDir,
    );
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);

    const before = await loadPendingDeliveries(tmpDir);
    expect(before).toHaveLength(1);
    expect(before[0].id).toBe(id);
    expect(before[0].channel).toBe("whatsapp");
    expect(before[0].to).toBe("+1555");

    await ackDelivery(id, tmpDir);

    const after = await loadPendingDeliveries(tmpDir);
    expect(after).toHaveLength(0);
  });

  it("stores all payload fields", async () => {
    const id = await enqueueDelivery(
      {
        channel: "telegram",
        to: "chat123",
        accountId: "acc1",
        payloads: [{ text: "hi" }, { mediaUrl: "http://x.com/img.png" }],
        threadId: "t1",
        replyToId: "r1",
        bestEffort: true,
        gifPlayback: true,
        silent: true,
        mirror: { sessionKey: "agent:main:main", text: "hi" },
      },
      tmpDir,
    );

    const [entry] = await loadPendingDeliveries(tmpDir);
    expect(entry.id).toBe(id);
    expect(entry.accountId).toBe("acc1");
    expect(entry.threadId).toBe("t1");
    expect(entry.replyToId).toBe("r1");
    expect(entry.bestEffort).toBe(true);
    expect(entry.gifPlayback).toBe(true);
    expect(entry.silent).toBe(true);
    expect(entry.mirror).toEqual({ sessionKey: "agent:main:main", text: "hi" });
  });

  it("ackDelivery is idempotent (no-op on already-delivered)", async () => {
    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "x" }] },
      tmpDir,
    );
    await ackDelivery(id, tmpDir);
    await expect(ackDelivery(id, tmpDir)).resolves.toBeUndefined();
    const pending = await loadPendingDeliveries(tmpDir);
    expect(pending).toHaveLength(0);
  });
});

describe("failDelivery", () => {
  it("increments retry_count on transient error", async () => {
    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "x" }] },
      tmpDir,
    );
    await failDelivery(id, "network timeout", tmpDir);

    const [entry] = await loadPendingDeliveries(tmpDir);
    expect(entry.retryCount).toBe(1);
    expect(entry.lastError).toBe("network timeout");
  });

  it("marks permanent errors as failed immediately", async () => {
    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "x" }] },
      tmpDir,
    );
    await failDelivery(id, "chat not found", tmpDir);

    const pending = await loadPendingDeliveries(tmpDir);
    expect(pending).toHaveLength(0); // moved to failed status
  });

  it("marks entry as terminal after MAX_RETRIES transient failures", async () => {
    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "x" }] },
      tmpDir,
    );
    for (let i = 0; i < MAX_RETRIES; i++) {
      await failDelivery(id, `transient error #${i}`, tmpDir);
    }

    const pending = await loadPendingDeliveries(tmpDir);
    expect(pending).toHaveLength(0); // terminal — removed from queued
  });
});

describe("moveToFailed", () => {
  it("removes entry from pending list", async () => {
    const id = await enqueueDelivery(
      { channel: "telegram", to: "chat1", payloads: [{ text: "x" }] },
      tmpDir,
    );
    await moveToFailed(id, tmpDir);
    const pending = await loadPendingDeliveries(tmpDir);
    expect(pending).toHaveLength(0);
  });
});

describe("computeBackoffMs", () => {
  it("returns 0 for retry 0", () => {
    expect(computeBackoffMs(0)).toBe(0);
  });
  it("returns 5000 for retry 1", () => {
    expect(computeBackoffMs(1)).toBe(5_000);
  });
  it("returns 25000 for retry 2", () => {
    expect(computeBackoffMs(2)).toBe(25_000);
  });
  it("caps at last backoff value for very high retry count", () => {
    expect(computeBackoffMs(100)).toBe(computeBackoffMs(4));
  });
});

describe("isEntryEligibleForRecoveryRetry", () => {
  const base: Parameters<typeof isEntryEligibleForRecoveryRetry>[0] = {
    id: "x",
    channel: "telegram",
    to: "c1",
    payloads: [],
    enqueuedAt: 1000,
    retryCount: 0,
  };
  const now = 100_000;

  it("eligible when retryCount=0 and no lastAttemptAt (first replay after crash)", () => {
    expect(isEntryEligibleForRecoveryRetry({ ...base, retryCount: 0 }, now)).toEqual({
      eligible: true,
    });
  });

  it("eligible when backoff elapsed based on lastAttemptAt", () => {
    // retry 1 → computeBackoffMs(2) = 25_000ms; lastAttemptAt 30s ago → eligible
    const entry = { ...base, retryCount: 1, lastAttemptAt: now - 30_000 };
    expect(isEntryEligibleForRecoveryRetry(entry, now)).toEqual({ eligible: true });
  });

  it("not eligible when backoff not yet elapsed based on lastAttemptAt", () => {
    // retry 1 → backoff 25_000ms; lastAttemptAt only 2s ago → not eligible
    const entry = { ...base, retryCount: 1, lastAttemptAt: now - 2_000 };
    const result = isEntryEligibleForRecoveryRetry(entry, now);
    expect(result.eligible).toBe(false);
    if (!result.eligible) {
      expect(result.remainingBackoffMs).toBeGreaterThan(0);
    }
  });

  it("falls back to enqueuedAt when lastAttemptAt absent on retried entry", () => {
    // retryCount=1 but no lastAttemptAt (migrated entry); enqueuedAt 30s ago → eligible
    const entry = { ...base, retryCount: 1, enqueuedAt: now - 30_000 };
    expect(isEntryEligibleForRecoveryRetry(entry, now)).toEqual({ eligible: true });
  });
});

describe("isPermanentDeliveryError", () => {
  it("returns true for permanent patterns", () => {
    expect(isPermanentDeliveryError("no conversation reference found")).toBe(true);
    expect(isPermanentDeliveryError("chat not found")).toBe(true);
    expect(isPermanentDeliveryError("user not found")).toBe(true);
    expect(isPermanentDeliveryError("bot was blocked by the user")).toBe(true);
    expect(isPermanentDeliveryError("Forbidden: bot was kicked")).toBe(true);
    expect(isPermanentDeliveryError("chat_id is empty")).toBe(true);
    expect(isPermanentDeliveryError("recipient is not a valid phone")).toBe(true);
    expect(isPermanentDeliveryError("outbound not configured for channel")).toBe(true);
  });
  it("returns false for transient errors", () => {
    expect(isPermanentDeliveryError("network timeout")).toBe(false);
    expect(isPermanentDeliveryError("connection reset")).toBe(false);
    expect(isPermanentDeliveryError("")).toBe(false);
  });
});

describe("recoverPendingDeliveries", () => {
  const cfg: OpenClawConfig = {};

  it("returns empty counts when no pending entries", async () => {
    const deliver = vi.fn();
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await recoverPendingDeliveries({
      deliver,
      log,
      cfg,
      stateDir: tmpDir,
    });
    expect(result).toEqual({ recovered: 0, failed: 0, skipped: 0, deferredBackoff: 0 });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("delivers pending entries and marks them delivered", async () => {
    const id1 = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "a" }] },
      tmpDir,
    );
    const id2 = await enqueueDelivery(
      { channel: "telegram", to: "chat1", payloads: [{ text: "b" }] },
      tmpDir,
    );

    const deliver = vi.fn(async () => {});
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await recoverPendingDeliveries({
      deliver,
      log,
      cfg,
      stateDir: tmpDir,
    });

    expect(result.recovered).toBe(2);
    expect(result.failed).toBe(0);
    expect(deliver).toHaveBeenCalledTimes(2);

    // Both entries should be delivered now.
    const pending = await loadPendingDeliveries(tmpDir);
    expect(pending).toHaveLength(0);
    void id1;
    void id2;
  });

  it("skips entries that exceed MAX_RETRIES", async () => {
    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "x" }] },
      tmpDir,
    );
    // Directly force retry_count to MAX_RETRIES while keeping status='queued'.
    // This simulates entries migrated from the old file queue with high retry counts,
    // or other edge cases where the count is already at the limit.
    const db = getJournalDb(tmpDir);
    db.prepare("UPDATE outbound_messages SET retry_count=? WHERE id=?").run(MAX_RETRIES, id);

    const preCheck = await loadPendingDeliveries(tmpDir);
    expect(preCheck).toHaveLength(1);
    expect(preCheck[0].retryCount).toBe(MAX_RETRIES);

    const deliver = vi.fn(async () => {});
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await recoverPendingDeliveries({
      deliver,
      log,
      cfg,
      stateDir: tmpDir,
    });

    expect(result.skipped).toBe(1);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("defers entries whose backoff has not elapsed (deferredBackoff)", async () => {
    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "x" }] },
      tmpDir,
    );
    // Simulate a prior failed attempt just now (backoff = 5000ms, not yet elapsed).
    const db = getJournalDb(tmpDir);
    db.prepare("UPDATE outbound_messages SET retry_count=1, last_attempt_at=? WHERE id=?").run(
      Date.now(),
      id,
    );

    const deliver = vi.fn(async () => {});
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await recoverPendingDeliveries({ deliver, log, cfg, stateDir: tmpDir });

    expect(result.deferredBackoff).toBe(1);
    expect(result.recovered).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    // Entry remains queued for next restart.
    const pending = await loadPendingDeliveries(tmpDir);
    expect(pending).toHaveLength(1);
  });

  it("retries immediately when lastAttemptAt is old enough", async () => {
    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "x" }] },
      tmpDir,
    );
    // retry_count=1 → computeBackoffMs(2)=25_000ms; lastAttemptAt 30s ago → eligible.
    const db = getJournalDb(tmpDir);
    db.prepare("UPDATE outbound_messages SET retry_count=1, last_attempt_at=? WHERE id=?").run(
      Date.now() - 30_000,
      id,
    );

    const deliver = vi.fn(async () => {});
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await recoverPendingDeliveries({ deliver, log, cfg, stateDir: tmpDir });

    expect(result.recovered).toBe(1);
    expect(result.deferredBackoff).toBe(0);
    expect(deliver).toHaveBeenCalledTimes(1);
    void id;
  });

  it("failDelivery sets last_attempt_at", async () => {
    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "x" }] },
      tmpDir,
    );
    const before = Date.now();
    await failDelivery(id, "transient error", tmpDir);
    const after = Date.now();

    const [entry] = await loadPendingDeliveries(tmpDir);
    expect(entry.lastAttemptAt).toBeGreaterThanOrEqual(before);
    expect(entry.lastAttemptAt).toBeLessThanOrEqual(after);
  });

  it("marks failed entries as permanent on permanent errors", async () => {
    await enqueueDelivery({ channel: "whatsapp", to: "+1555", payloads: [{ text: "x" }] }, tmpDir);

    const deliver = vi.fn(async () => {
      throw new Error("chat not found");
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await recoverPendingDeliveries({
      deliver,
      log,
      cfg,
      stateDir: tmpDir,
    });

    expect(result.failed).toBe(1);
    const pending = await loadPendingDeliveries(tmpDir);
    expect(pending).toHaveLength(0);
  });

  it("respects maxRecoveryMs budget — stops when deadline exceeded", async () => {
    // Enqueue 3 entries; first deliver call will exhaust budget.
    for (let i = 0; i < 3; i++) {
      await enqueueDelivery(
        { channel: "whatsapp", to: `+${i}`, payloads: [{ text: "x" }] },
        tmpDir,
      );
    }

    let calls = 0;
    const deliver = vi.fn(async () => {
      calls += 1;
      // Simulate time advancing past budget by using a very small budget.
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    // Set maxRecoveryMs=0 so the budget is immediately exceeded after the first check.
    const result = await recoverPendingDeliveries({
      deliver,
      log,
      cfg,
      stateDir: tmpDir,

      maxRecoveryMs: 0,
    });

    // With budget=0, no entries should be recovered (deadline already passed on first check).
    expect(result.recovered).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("expires stale (TTL) entries before recovery", async () => {
    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "x" }] },
      tmpDir,
    );
    // Manually set queued_at to be very old (before TTL).
    const { getJournalDb } = await import("./db.js");
    const db = getJournalDb(tmpDir);
    db.prepare("UPDATE outbound_messages SET queued_at=1 WHERE id=?").run(id);

    const deliver = vi.fn(async () => {});
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const result = await recoverPendingDeliveries({
      deliver,
      log,
      cfg,
      stateDir: tmpDir,
    });

    expect(result.recovered).toBe(0);
    expect(deliver).not.toHaveBeenCalled();
    const pending = await loadPendingDeliveries(tmpDir);
    expect(pending).toHaveLength(0); // expired to 'failed'
  });

  it("AbortError is treated as failDelivery (not ackDelivery)", async () => {
    const id = await enqueueDelivery(
      { channel: "whatsapp", to: "+1555", payloads: [{ text: "x" }] },
      tmpDir,
    );

    const abortError = new DOMException("aborted", "AbortError");
    const deliver = vi.fn(async () => {
      throw abortError;
    });
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const result = await recoverPendingDeliveries({
      deliver,
      log,
      cfg,
      stateDir: tmpDir,
    });

    // Abort is transient, so retryCount increments and entry stays/becomes failed.
    expect(result.failed).toBe(1);
    // Entry should NOT be in pending anymore (either still queued with +1 retry or moved to failed).
    void id;
  });
});

describe("migrateFileQueueToJournal", () => {
  it("is a no-op when delivery-queue directory is missing", async () => {
    await expect(migrateFileQueueToJournal(tmpDir)).resolves.toBeUndefined();
    const pending = await loadPendingDeliveries(tmpDir);
    expect(pending).toHaveLength(0);
  });

  it("migrates JSON files from delivery-queue dir and removes them", async () => {
    const queueDir = path.join(tmpDir, "delivery-queue");
    fs.mkdirSync(queueDir, { recursive: true });

    const oldEntry = {
      id: "old-entry-1",
      channel: "whatsapp",
      to: "+1999",
      payloads: [{ text: "migrated" }],
      enqueuedAt: Date.now() - 1000,
      retryCount: 0,
    };
    fs.writeFileSync(path.join(queueDir, "old-entry-1.json"), JSON.stringify(oldEntry));

    await migrateFileQueueToJournal(tmpDir);

    // File should be removed after migration.
    expect(fs.existsSync(path.join(queueDir, "old-entry-1.json"))).toBe(false);

    // Entry should be in the journal.
    const pending = await loadPendingDeliveries(tmpDir);
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe("old-entry-1");
    expect(pending[0].to).toBe("+1999");
  });

  it("skips non-JSON files", async () => {
    const queueDir = path.join(tmpDir, "delivery-queue");
    fs.mkdirSync(queueDir, { recursive: true });
    fs.writeFileSync(path.join(queueDir, "README.txt"), "not json");

    await migrateFileQueueToJournal(tmpDir);

    const pending = await loadPendingDeliveries(tmpDir);
    expect(pending).toHaveLength(0);
  });

  it("uses INSERT OR IGNORE so duplicate ids are skipped", async () => {
    // Pre-insert a matching entry.
    const existingId = await enqueueDelivery(
      { channel: "telegram", to: "chat99", payloads: [{ text: "existing" }] },
      tmpDir,
    );

    const queueDir = path.join(tmpDir, "delivery-queue");
    fs.mkdirSync(queueDir, { recursive: true });
    const oldEntry = {
      id: existingId,
      channel: "telegram",
      to: "chat99",
      payloads: [{ text: "duplicate" }],
      enqueuedAt: Date.now(),
      retryCount: 1,
    };
    fs.writeFileSync(path.join(queueDir, `${existingId}.json`), JSON.stringify(oldEntry));

    await migrateFileQueueToJournal(tmpDir);

    // Should still only have the one entry (the existing one wins).
    const pending = await loadPendingDeliveries(tmpDir);
    expect(pending).toHaveLength(1);
    expect(pending[0].retryCount).toBe(0); // original entry unchanged
  });
});
