import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.ts";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, saveSessionStore } from "../config/sessions.js";
import { dispatchInboundMessage, withReplyDispatcher } from "./dispatch.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.js";
import { buildTestCtx } from "./reply/test-ctx.js";

function createDispatcher(record: string[]): ReplyDispatcher {
  return {
    sendToolResult: () => true,
    sendBlockReply: () => true,
    sendFinalReply: () => true,
    getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
    markComplete: () => {
      record.push("markComplete");
    },
    waitForIdle: async () => {
      record.push("waitForIdle");
    },
  };
}

describe("withReplyDispatcher", () => {
  it("always marks complete and waits for idle after success", async () => {
    const order: string[] = [];
    const dispatcher = createDispatcher(order);

    const result = await withReplyDispatcher({
      dispatcher,
      run: async () => {
        order.push("run");
        return "ok";
      },
      onSettled: () => {
        order.push("onSettled");
      },
    });

    expect(result).toBe("ok");
    expect(order).toEqual(["run", "markComplete", "waitForIdle", "onSettled"]);
  });

  it("still drains dispatcher after run throws", async () => {
    const order: string[] = [];
    const dispatcher = createDispatcher(order);
    const onSettled = vi.fn(() => {
      order.push("onSettled");
    });

    await expect(
      withReplyDispatcher({
        dispatcher,
        run: async () => {
          order.push("run");
          throw new Error("boom");
        },
        onSettled,
      }),
    ).rejects.toThrow("boom");

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["run", "markComplete", "waitForIdle", "onSettled"]);
  });

  it("dispatchInboundMessage owns dispatcher lifecycle", async () => {
    const order: string[] = [];
    const dispatcher = {
      sendToolResult: () => true,
      sendBlockReply: () => true,
      sendFinalReply: () => {
        order.push("sendFinalReply");
        return true;
      },
      getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
      markComplete: () => {
        order.push("markComplete");
      },
      waitForIdle: async () => {
        order.push("waitForIdle");
      },
    } satisfies ReplyDispatcher;

    await dispatchInboundMessage({
      ctx: buildTestCtx(),
      cfg: {} as OpenClawConfig,
      dispatcher,
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(order).toEqual(["sendFinalReply", "markComplete", "waitForIdle"]);
  });

  it("persists a pending reply entry when dispatch fails before completion", async () => {
    await withTempHome(async () => {
      const storePath = path.join(
        process.env.OPENCLAW_STATE_DIR!,
        "agents",
        "main",
        "sessions",
        "sessions.json",
      );
      const sessionKey = "agent:main:telegram:dm:test";
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "sess-1",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "chat-1",
        },
      });
      const dispatcher = {
        sendToolResult: () => true,
        sendBlockReply: () => true,
        sendFinalReply: () => true,
        getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
        markComplete: () => {},
        waitForIdle: async () => {},
      } satisfies ReplyDispatcher;

      await expect(
        dispatchInboundMessage({
          ctx: buildTestCtx({
            SessionKey: sessionKey,
            Provider: "telegram",
            Surface: "telegram",
            To: "chat-1",
            From: "user-1",
            MessageSid: "msg-1",
            CommandAuthorized: true,
          }),
          cfg: {} as OpenClawConfig,
          dispatcher,
          replyResolver: async () => {
            throw new Error("boom");
          },
        }),
      ).rejects.toThrow("boom");

      const store = loadSessionStore(storePath, { skipCache: true });
      const pendingReplies = store[sessionKey]?.pendingReplies;
      expect(pendingReplies).toBeTruthy();
      const pendingValues = Object.values(pendingReplies ?? {});
      expect(pendingValues).toHaveLength(1);
      expect(pendingValues[0]).toMatchObject({
        messageId: "msg-1",
        to: "chat-1",
        provider: "telegram",
        commandAuthorized: true,
      });
    });
  });

  it("clears only the completed pending key and preserves other pending turns", async () => {
    await withTempHome(async () => {
      const storePath = path.join(
        process.env.OPENCLAW_STATE_DIR!,
        "agents",
        "main",
        "sessions",
        "sessions.json",
      );
      const sessionKey = "agent:main:telegram:dm:test";
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "sess-1",
          updatedAt: Date.now(),
          lastChannel: "telegram",
          lastTo: "chat-1",
          pendingReplies: {
            "synthetic:older:1": {
              startedAt: Date.now() - 1_000,
              to: "chat-1",
              provider: "telegram",
            },
          },
        },
      });

      const dispatcher = {
        sendToolResult: () => true,
        sendBlockReply: () => true,
        sendFinalReply: () => true,
        getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
        markComplete: () => {},
        waitForIdle: async () => {},
      } satisfies ReplyDispatcher;

      await dispatchInboundMessage({
        ctx: buildTestCtx({
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
          To: "chat-1",
          From: "user-1",
          MessageSid: "msg-1",
          CommandAuthorized: true,
        }),
        cfg: {} as OpenClawConfig,
        dispatcher,
        replyResolver: async () => ({ text: "ok" }),
      });

      const store = loadSessionStore(storePath, { skipCache: true });
      expect(store[sessionKey]?.pendingReplies).toMatchObject({
        "synthetic:older:1": expect.objectContaining({ provider: "telegram" }),
      });
      expect(store[sessionKey]?.pendingReplies?.["msg:msg-1"]).toBeUndefined();
    });
  });
});
