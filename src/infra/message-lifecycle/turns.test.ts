import { describe, expect, it } from "vitest";
import { hydrateTurnContext, type TurnRow } from "./turns.js";

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
