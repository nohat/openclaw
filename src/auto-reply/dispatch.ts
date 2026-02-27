import type { OpenClawConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { acceptInboundOrSkip, completeInboundTurn } from "../infra/message-journal/inbound.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import type { DispatchFromConfigResult } from "./reply/dispatch-from-config.js";
import { dispatchReplyFromConfig } from "./reply/dispatch-from-config.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import {
  createReplyDispatcher,
  createReplyDispatcherWithTyping,
  type ReplyDispatcher,
  type ReplyDispatcherOptions,
  type ReplyDispatcherWithTypingOptions,
} from "./reply/reply-dispatcher.js";
import type { FinalizedMsgContext, MsgContext } from "./templating.js";
import type { GetReplyOptions } from "./types.js";

export type DispatchInboundResult = DispatchFromConfigResult;

export async function withReplyDispatcher<T>(params: {
  dispatcher: ReplyDispatcher;
  run: () => Promise<T>;
  onSettled?: () => void | Promise<void>;
}): Promise<T> {
  try {
    return await params.run();
  } finally {
    // Ensure dispatcher reservations are always released on every exit path.
    params.dispatcher.markComplete();
    try {
      await params.dispatcher.waitForIdle();
    } finally {
      await params.onSettled?.();
    }
  }
}

type DispatchInboundMessageInternalParams = {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
  /** True when re-dispatching a recovered orphan turn — skips dedup + journal insert. */
  isOrphanReplyRecovery?: boolean;
};

async function dispatchInboundMessageInternal({
  ctx,
  cfg,
  dispatcher,
  replyOptions,
  replyResolver,
  isOrphanReplyRecovery = false,
}: DispatchInboundMessageInternalParams): Promise<DispatchInboundResult> {
  const finalized = finalizeInboundContext(ctx);

  // Journal-based dedup + orphan-recovery tracking.
  // Only runs for real inbound turns (not heartbeats, not recovery replays).
  const shouldTrackTurn = !isOrphanReplyRecovery && replyOptions?.isHeartbeat !== true;

  let pendingReplyId: string | undefined;
  let deliveryObserved = false;
  if (shouldTrackTurn) {
    // Generate a stable turn ID if the caller didn't provide one.
    if (!finalized.PendingReplyId?.trim()) {
      finalized.PendingReplyId = generateSecureUuid();
    }
    pendingReplyId = finalized.PendingReplyId;
    // acceptInboundOrSkip returns false when this external_id was already processed
    // (duplicate delivery from the channel). Skip immediately if so.
    try {
      const accepted = acceptInboundOrSkip(finalized);
      if (!accepted) {
        const channel =
          finalized.OriginatingChannel ?? finalized.Surface ?? finalized.Provider ?? "unknown";
        const externalId = finalized.MessageSid ?? "(no message id)";
        logVerbose(
          `dispatch: deduped inbound turn — channel=${channel} external_id=${externalId} account=${finalized.AccountId ?? ""} turn=${pendingReplyId}`,
        );
        // Release dispatcher reservation so deduped turns don't leak registry entries.
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
        return { queuedFinal: false, counts: dispatcher.getQueuedCounts() };
      }
    } catch (err) {
      // Journal errors must not block message processing.
      logVerbose(`dispatch: journal accept failed (continuing): ${String(err)}`);
    }

    // Persist post-send evidence as soon as any provider send succeeds.
    // This prevents duplicate orphan replay for channels that bypass outbound journaling.
    if (pendingReplyId && dispatcher.setDeliveryObserver) {
      const pendingId = pendingReplyId;
      dispatcher.setDeliveryObserver(() => {
        if (deliveryObserved) {
          return;
        }
        deliveryObserved = true;
        try {
          completeInboundTurn(pendingId, "delivered");
        } catch (err) {
          logVerbose(`dispatch: journal early-complete failed: ${String(err)}`);
        }
      });
    }
  }

  const result = await withReplyDispatcher({
    dispatcher,
    run: () =>
      dispatchReplyFromConfig({
        ctx: finalized,
        cfg,
        dispatcher,
        replyOptions,
        replyResolver,
      }),
  });

  // Mark turn delivered after dispatcher fully drains (including queued replies).
  if (pendingReplyId && !deliveryObserved) {
    try {
      completeInboundTurn(pendingReplyId, "delivered");
    } catch (err) {
      logVerbose(`dispatch: journal complete failed: ${String(err)}`);
    }
  }

  return result;
}

export async function dispatchInboundMessage(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  return dispatchInboundMessageInternal(params);
}

/** Re-dispatch a recovered orphan turn — skips dedup check and journal insert. */
export async function dispatchRecoveredPendingReply(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcher: ReplyDispatcher;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  return dispatchInboundMessageInternal({ ...params, isOrphanReplyRecovery: true });
}

export async function dispatchInboundMessageWithBufferedDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherWithTypingOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping(
    params.dispatcherOptions,
  );
  try {
    return await dispatchInboundMessageInternal({
      ctx: params.ctx,
      cfg: params.cfg,
      dispatcher,
      replyResolver: params.replyResolver,
      replyOptions: {
        ...params.replyOptions,
        ...replyOptions,
      },
    });
  } finally {
    markDispatchIdle();
  }
}

export async function dispatchInboundMessageWithDispatcher(params: {
  ctx: MsgContext | FinalizedMsgContext;
  cfg: OpenClawConfig;
  dispatcherOptions: ReplyDispatcherOptions;
  replyOptions?: Omit<GetReplyOptions, "onToolResult" | "onBlockReply">;
  replyResolver?: typeof import("./reply.js").getReplyFromConfig;
}): Promise<DispatchInboundResult> {
  const dispatcher = createReplyDispatcher(params.dispatcherOptions);
  return await dispatchInboundMessageInternal({
    ctx: params.ctx,
    cfg: params.cfg,
    dispatcher,
    replyResolver: params.replyResolver,
    replyOptions: params.replyOptions,
  });
}
