import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearLifecycleDbCacheForTest, getLifecycleDb } from "./db.js";
import {
  MAX_TURN_RECOVERY_ATTEMPTS,
  acceptTurn,
  failStaleTurns,
  finalizeTurn,
  hydrateTurnContext,
  listRecoverableTurns,
  markTurnDeliveryPending,
  markTurnRunning,
  recordTurnRecoveryFailure,
  type TurnRow,
} from "./turns.js";

// ──────────────────────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "lifecycle-turns-test-"));
}

function buildMsgContext(
  overrides: Record<string, unknown> = {},
): import("../../auto-reply/templating.js").MsgContext {
  return {
    Body: "hello",
    BodyForAgent: "hello",
    BodyForCommands: "hello",
    From: "user-1",
    To: "chat-1",
    OriginatingChannel: "telegram",
    OriginatingTo: "chat-1",
    SessionKey: "sk-1",
    AccountId: "primary",
    MessageSid: "msg-1",
    ...overrides,
  } as import("../../auto-reply/templating.js").MsgContext;
}

function getTurnStatus(stateDir: string, id: string): string | null {
  const db = getLifecycleDb(stateDir);
  const row = db.prepare("SELECT status FROM message_turns WHERE id=?").get(id) as
    | { status: string }
    | undefined;
  return row?.status ?? null;
}

function getTurnAttempts(stateDir: string, id: string): number {
  const db = getLifecycleDb(stateDir);
  const row = db.prepare("SELECT attempt_count FROM message_turns WHERE id=?").get(id) as
    | { attempt_count: number }
    | undefined;
  return row?.attempt_count ?? 0;
}

// ──────────────────────────────────────────────────────────────
// hydrateTurnContext (existing tests preserved)
// ──────────────────────────────────────────────────────────────

function buildTurn(overrides: Partial<TurnRow>): TurnRow {
  return {
    id: "turn-1",
    channel: "telegram",
    account_id: "primary",
    external_id: "msg-1",
    session_key: "main",
    payload: JSON.stringify({
      Body: "hello",
      BodyForAgent: "hello",
      BodyForCommands: "hello",
      From: "user-1",
      To: "chat-1",
      OriginatingChannel: "telegram",
      OriginatingTo: "chat-1",
      CommandAuthorized: true,
      MessageThreadId: "42",
    }),
    accepted_at: 1,
    status: "running",
    attempt_count: 0,
    updated_at: 1,
    terminal_reason: null,
    ...overrides,
  };
}

describe("hydrateTurnContext", () => {
  it("hydrates modern payload format", () => {
    const turn = buildTurn({});
    const ctx = hydrateTurnContext(turn);
    expect(ctx).toBeTruthy();
    expect(ctx?.OriginatingChannel).toBe("telegram");
    expect(ctx?.OriginatingTo).toBe("chat-1");
    expect(ctx?.MessageTurnId).toBe("turn-1");
    expect(ctx?.MessageThreadId).toBe(42);
    expect(ctx?.CommandAuthorized).toBe(true);
  });

  it("hydrates legacy payload keys", () => {
    const turn = buildTurn({
      payload: JSON.stringify({
        body: "legacy",
        from: "legacy-user",
        to: "legacy-chat",
        originatingChannel: "slack",
        originatingTo: "C123",
        commandAuthorized: false,
      }),
      channel: "slack",
      account_id: "",
      external_id: null,
    });
    const ctx = hydrateTurnContext(turn);
    expect(ctx).toBeTruthy();
    expect(ctx?.Body).toBe("legacy");
    expect(ctx?.OriginatingChannel).toBe("slack");
    expect(ctx?.OriginatingTo).toBe("C123");
    expect(ctx?.MessageSid).toBeUndefined();
  });

  it("returns null when route target is unavailable", () => {
    const turn = buildTurn({
      payload: JSON.stringify({ Body: "hi" }),
      channel: "",
    });
    expect(hydrateTurnContext(turn)).toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────
// acceptTurn
// ──────────────────────────────────────────────────────────────

describe("acceptTurn", () => {
  let tmpDir: string;

  afterEach(() => {
    clearLifecycleDbCacheForTest();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("creates a turn row and returns accepted=true", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const result = acceptTurn(ctx, { stateDir: tmpDir });
    expect(result.accepted).toBe(true);
    expect(typeof result.id).toBe("string");
    expect(result.id.length).toBeGreaterThan(0);
    const status = getTurnStatus(tmpDir, result.id);
    expect(status).toBe("running");
  });

  it("uses provided turnId when given", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const result = acceptTurn(ctx, { stateDir: tmpDir, turnId: "custom-id" });
    expect(result.accepted).toBe(true);
    expect(result.id).toBe("custom-id");
    expect(getTurnStatus(tmpDir, "custom-id")).toBe("running");
  });

  it("stores the session key and channel on the row", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext({ SessionKey: "session-abc", OriginatingChannel: "discord" });
    const result = acceptTurn(ctx, { stateDir: tmpDir });
    const db = getLifecycleDb(tmpDir);
    const row = db
      .prepare("SELECT session_key, channel FROM message_turns WHERE id=?")
      .get(result.id) as { session_key: string; channel: string } | undefined;
    expect(row?.session_key).toBe("session-abc");
    expect(row?.channel).toBe("discord");
  });
});

// ──────────────────────────────────────────────────────────────
// markTurnRunning / markTurnDeliveryPending
// ──────────────────────────────────────────────────────────────

describe("markTurnRunning", () => {
  let tmpDir: string;

  afterEach(() => {
    clearLifecycleDbCacheForTest();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("transitions failed_retryable → running", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const { id } = acceptTurn(ctx, { stateDir: tmpDir });
    // Manually set to failed_retryable to test the transition
    const db = getLifecycleDb(tmpDir);
    db.prepare("UPDATE message_turns SET status='failed_retryable' WHERE id=?").run(id);
    markTurnRunning(id, { stateDir: tmpDir });
    expect(getTurnStatus(tmpDir, id)).toBe("running");
  });

  it("does not transition a terminal turn", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const { id } = acceptTurn(ctx, { stateDir: tmpDir });
    finalizeTurn(id, "delivered", { stateDir: tmpDir });
    markTurnRunning(id, { stateDir: tmpDir });
    // Should remain delivered
    expect(getTurnStatus(tmpDir, id)).toBe("delivered");
  });
});

describe("markTurnDeliveryPending", () => {
  let tmpDir: string;

  afterEach(() => {
    clearLifecycleDbCacheForTest();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("transitions running → delivery_pending", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const { id } = acceptTurn(ctx, { stateDir: tmpDir });
    markTurnDeliveryPending(id, { stateDir: tmpDir });
    expect(getTurnStatus(tmpDir, id)).toBe("delivery_pending");
  });
});

// ──────────────────────────────────────────────────────────────
// finalizeTurn
// ──────────────────────────────────────────────────────────────

describe("finalizeTurn", () => {
  let tmpDir: string;

  afterEach(() => {
    clearLifecycleDbCacheForTest();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("transitions running → delivered", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const { id } = acceptTurn(ctx, { stateDir: tmpDir });
    finalizeTurn(id, "delivered", { stateDir: tmpDir });
    expect(getTurnStatus(tmpDir, id)).toBe("delivered");
  });

  it("transitions running → aborted", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const { id } = acceptTurn(ctx, { stateDir: tmpDir });
    finalizeTurn(id, "aborted", { stateDir: tmpDir });
    expect(getTurnStatus(tmpDir, id)).toBe("aborted");
  });

  it("transitions running → failed_terminal", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const { id } = acceptTurn(ctx, { stateDir: tmpDir });
    finalizeTurn(id, "failed", { stateDir: tmpDir });
    expect(getTurnStatus(tmpDir, id)).toBe("failed_terminal");
  });

  it("does not re-finalize an already terminal turn", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const { id } = acceptTurn(ctx, { stateDir: tmpDir });
    finalizeTurn(id, "delivered", { stateDir: tmpDir });
    finalizeTurn(id, "aborted", { stateDir: tmpDir });
    // First terminal state wins
    expect(getTurnStatus(tmpDir, id)).toBe("delivered");
  });

  it("transitions delivery_pending → delivered", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const { id } = acceptTurn(ctx, { stateDir: tmpDir });
    markTurnDeliveryPending(id, { stateDir: tmpDir });
    finalizeTurn(id, "delivered", { stateDir: tmpDir });
    expect(getTurnStatus(tmpDir, id)).toBe("delivered");
  });
});

// ──────────────────────────────────────────────────────────────
// recordTurnRecoveryFailure
// ──────────────────────────────────────────────────────────────

describe("recordTurnRecoveryFailure", () => {
  let tmpDir: string;

  afterEach(() => {
    clearLifecycleDbCacheForTest();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("increments attempt_count and sets failed_retryable", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const { id } = acceptTurn(ctx, { stateDir: tmpDir });
    const result = recordTurnRecoveryFailure(id, "network error", { stateDir: tmpDir });
    expect(result.attempts).toBe(1);
    expect(result.markedFailed).toBe(false);
    expect(getTurnStatus(tmpDir, id)).toBe("failed_retryable");
    expect(getTurnAttempts(tmpDir, id)).toBe(1);
  });

  it(`marks failed_terminal at attempt ${MAX_TURN_RECOVERY_ATTEMPTS}`, () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const { id } = acceptTurn(ctx, { stateDir: tmpDir });
    let result = { attempts: 0, markedFailed: false };
    for (let i = 0; i < MAX_TURN_RECOVERY_ATTEMPTS; i++) {
      result = recordTurnRecoveryFailure(id, "repeated error", { stateDir: tmpDir });
    }
    expect(result.markedFailed).toBe(true);
    expect(getTurnStatus(tmpDir, id)).toBe("failed_terminal");
  });

  it("returns {attempts:0, markedFailed:false} for already-terminal turns", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const { id } = acceptTurn(ctx, { stateDir: tmpDir });
    finalizeTurn(id, "delivered", { stateDir: tmpDir });
    const result = recordTurnRecoveryFailure(id, "late error", { stateDir: tmpDir });
    expect(result.attempts).toBe(0);
    expect(result.markedFailed).toBe(false);
    // Status unchanged
    expect(getTurnStatus(tmpDir, id)).toBe("delivered");
  });
});

// ──────────────────────────────────────────────────────────────
// listRecoverableTurns
// ──────────────────────────────────────────────────────────────

describe("listRecoverableTurns", () => {
  let tmpDir: string;

  afterEach(() => {
    clearLifecycleDbCacheForTest();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("returns non-terminal turns", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const { id } = acceptTurn(ctx, { stateDir: tmpDir });
    const rows = listRecoverableTurns({ stateDir: tmpDir });
    expect(rows.some((r) => r.id === id)).toBe(true);
  });

  it("excludes terminal turns", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const { id } = acceptTurn(ctx, { stateDir: tmpDir });
    finalizeTurn(id, "delivered", { stateDir: tmpDir });
    const rows = listRecoverableTurns({ stateDir: tmpDir });
    expect(rows.some((r) => r.id === id)).toBe(false);
  });

  it("respects minAgeMs — excludes turns younger than the cutoff", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const { id } = acceptTurn(ctx, { stateDir: tmpDir });
    // Turn was just accepted; it should be excluded when minAgeMs > 0
    const rows = listRecoverableTurns({ minAgeMs: 60_000, stateDir: tmpDir });
    expect(rows.some((r) => r.id === id)).toBe(false);
  });

  it("includes failed_retryable turns whose next_attempt_at has passed", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const { id } = acceptTurn(ctx, { stateDir: tmpDir });
    // Force next_attempt_at to the past
    const db = getLifecycleDb(tmpDir);
    db.prepare(
      "UPDATE message_turns SET status='failed_retryable', next_attempt_at=1 WHERE id=?",
    ).run(id);
    const rows = listRecoverableTurns({ stateDir: tmpDir });
    expect(rows.some((r) => r.id === id)).toBe(true);
  });

  it("excludes failed_retryable turns whose next_attempt_at is in the future", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const { id } = acceptTurn(ctx, { stateDir: tmpDir });
    const db = getLifecycleDb(tmpDir);
    db.prepare(
      "UPDATE message_turns SET status='failed_retryable', next_attempt_at=? WHERE id=?",
    ).run(Date.now() + 60_000, id);
    const rows = listRecoverableTurns({ stateDir: tmpDir });
    expect(rows.some((r) => r.id === id)).toBe(false);
  });
});

// ──────────────────────────────────────────────────────────────
// failStaleTurns
// ──────────────────────────────────────────────────────────────

describe("failStaleTurns", () => {
  let tmpDir: string;

  afterEach(() => {
    clearLifecycleDbCacheForTest();
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it("marks old non-terminal turns as failed_terminal", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const { id } = acceptTurn(ctx, { stateDir: tmpDir });
    // Backdate accepted_at to simulate a stale turn
    const db = getLifecycleDb(tmpDir);
    db.prepare("UPDATE message_turns SET accepted_at=1 WHERE id=?").run(id);
    const count = failStaleTurns(1, { stateDir: tmpDir }); // 1ms max age
    expect(count).toBeGreaterThanOrEqual(1);
    expect(getTurnStatus(tmpDir, id)).toBe("failed_terminal");
  });

  it("does not affect recently accepted turns", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const { id } = acceptTurn(ctx, { stateDir: tmpDir });
    const count = failStaleTurns(60 * 60_000, { stateDir: tmpDir }); // 60 min age
    expect(count).toBe(0);
    expect(getTurnStatus(tmpDir, id)).toBe("running");
  });

  it("does not affect already-terminal turns", () => {
    tmpDir = makeTmpDir();
    const ctx = buildMsgContext();
    const { id } = acceptTurn(ctx, { stateDir: tmpDir });
    const db = getLifecycleDb(tmpDir);
    db.prepare("UPDATE message_turns SET accepted_at=1, status='delivered' WHERE id=?").run(id);
    failStaleTurns(1, { stateDir: tmpDir });
    expect(getTurnStatus(tmpDir, id)).toBe("delivered");
  });
});
