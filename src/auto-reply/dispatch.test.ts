import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  dispatchInboundMessage,
  dispatchRecoveredPendingReply,
  withReplyDispatcher,
} from "./dispatch.js";
import type { ReplyDispatcher } from "./reply/reply-dispatcher.js";
import { buildTestCtx } from "./reply/test-ctx.js";

vi.mock("../infra/message-journal/inbound.js", () => ({
  acceptInboundOrSkip: vi.fn(() => true),
  completeInboundTurn: vi.fn(),
}));

// Import after mock registration so we get the spy instances.
const { acceptInboundOrSkip, completeInboundTurn } =
  await import("../infra/message-journal/inbound.js");

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
});

describe("dispatchInboundMessage — journal integration", () => {
  function makeDispatcher(): ReplyDispatcher {
    return {
      sendToolResult: () => true,
      sendBlockReply: () => true,
      sendFinalReply: () => true,
      getQueuedCounts: () => ({ tool: 0, block: 0, final: 0 }),
      markComplete: vi.fn(),
      waitForIdle: vi.fn(async () => {}),
    };
  }

  beforeEach(() => {
    vi.mocked(acceptInboundOrSkip).mockClear().mockReturnValue(true);
    vi.mocked(completeInboundTurn).mockClear();
  });

  it("calls acceptInboundOrSkip and assigns PendingReplyId when absent", async () => {
    const ctx = buildTestCtx(); // no PendingReplyId set
    expect(ctx.PendingReplyId).toBeUndefined();

    await dispatchInboundMessage({
      ctx,
      cfg: {} as OpenClawConfig,
      dispatcher: makeDispatcher(),
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(acceptInboundOrSkip).toHaveBeenCalledTimes(1);
    // dispatch should have generated a UUID and set it on ctx
    const calledCtx = vi.mocked(acceptInboundOrSkip).mock.calls[0][0];
    expect(typeof calledCtx.PendingReplyId).toBe("string");
    expect(calledCtx.PendingReplyId!.length).toBeGreaterThan(0);
  });

  it("calls completeInboundTurn('delivered') after successful dispatch", async () => {
    await dispatchInboundMessage({
      ctx: buildTestCtx(),
      cfg: {} as OpenClawConfig,
      dispatcher: makeDispatcher(),
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(completeInboundTurn).toHaveBeenCalledTimes(1);
    expect(vi.mocked(completeInboundTurn).mock.calls[0][1]).toBe("delivered");
  });

  it("skips journal tracking for heartbeats", async () => {
    await dispatchInboundMessage({
      ctx: buildTestCtx(),
      cfg: {} as OpenClawConfig,
      dispatcher: makeDispatcher(),
      replyOptions: { isHeartbeat: true },
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(acceptInboundOrSkip).not.toHaveBeenCalled();
    expect(completeInboundTurn).not.toHaveBeenCalled();
  });

  it("returns early without dispatching when acceptInboundOrSkip returns false (duplicate)", async () => {
    vi.mocked(acceptInboundOrSkip).mockReturnValue(false);
    const dispatcher = makeDispatcher();
    const sendFinalReply = vi.spyOn(dispatcher, "sendFinalReply");

    await dispatchInboundMessage({
      ctx: buildTestCtx({ MessageSid: "dup-msg-001" }),
      cfg: {} as OpenClawConfig,
      dispatcher,
      replyResolver: async () => ({ text: "ok" }),
    });

    expect(sendFinalReply).not.toHaveBeenCalled();
    expect(completeInboundTurn).not.toHaveBeenCalled();
  });

  it("skips journal insert for orphan recovery re-dispatches", async () => {
    await dispatchRecoveredPendingReply({
      ctx: buildTestCtx({ PendingReplyId: "orphan-turn-001" }),
      cfg: {} as OpenClawConfig,
      dispatcher: makeDispatcher(),
      replyResolver: async () => ({ text: "ok" }),
    });

    // acceptInboundOrSkip must NOT be called — orphan recovery re-uses the existing row
    expect(acceptInboundOrSkip).not.toHaveBeenCalled();
  });
});
