import crypto from "node:crypto";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { normalizeChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStorePath, updateSessionStoreEntry } from "../config/sessions.js";
import { logVerbose } from "../globals.js";
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

function trimNonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function buildPendingReplyToken(params: {
  startedAt: number;
  messageId?: string;
  messageIdFull?: string;
}): string {
  if (params.messageIdFull) {
    return `msgfull:${params.messageIdFull}`;
  }
  if (params.messageId) {
    return `msg:${params.messageId}`;
  }
  return `synthetic:${params.startedAt}:${crypto.randomUUID()}`;
}

async function markSessionPendingReply(params: {
  cfg: OpenClawConfig;
  ctx: FinalizedMsgContext;
}): Promise<string | undefined> {
  const sessionKey = params.ctx.SessionKey?.trim();
  if (!sessionKey) {
    return undefined;
  }
  const startedAt = Date.now();
  const messageId = trimNonEmpty(params.ctx.MessageSid);
  const messageIdFull = trimNonEmpty(params.ctx.MessageSidFull);
  const pendingId = buildPendingReplyToken({
    startedAt,
    messageId,
    messageIdFull,
  });
  const agentId = resolveSessionAgentId({ sessionKey, config: params.cfg });
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  await updateSessionStoreEntry({
    storePath,
    sessionKey,
    update: async (entry) => ({
      pendingReplies: {
        ...entry.pendingReplies,
        [pendingId]: {
          startedAt,
          messageId,
          messageIdFull,
          from: params.ctx.From,
          to: params.ctx.To,
          accountId: params.ctx.AccountId,
          threadId: params.ctx.MessageThreadId,
          provider: params.ctx.Provider,
          surface: params.ctx.Surface,
          originatingChannel:
            typeof params.ctx.OriginatingChannel === "string"
              ? params.ctx.OriginatingChannel
              : undefined,
          originatingTo: params.ctx.OriginatingTo,
          chatType: normalizeChatType(params.ctx.ChatType),
          commandAuthorized: params.ctx.CommandAuthorized,
          commandSource: params.ctx.CommandSource,
          commandTargetSessionKey: params.ctx.CommandTargetSessionKey,
          senderId: params.ctx.SenderId,
          senderName: params.ctx.SenderName,
          senderUsername: params.ctx.SenderUsername,
          senderE164: params.ctx.SenderE164,
          wasMentioned: params.ctx.WasMentioned,
          isForum: params.ctx.IsForum,
        },
      },
    }),
  });
  return pendingId;
}

async function clearSessionPendingReply(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  pendingId: string;
}): Promise<void> {
  const agentId = resolveSessionAgentId({ sessionKey: params.sessionKey, config: params.cfg });
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId });
  await updateSessionStoreEntry({
    storePath,
    sessionKey: params.sessionKey,
    update: async (entry) => {
      const current = entry.pendingReplies ?? {};
      if (!Object.prototype.hasOwnProperty.call(current, params.pendingId)) {
        return null;
      }
      const next = { ...current };
      delete next[params.pendingId];
      return {
        pendingReplies: Object.keys(next).length > 0 ? next : undefined,
      };
    },
  });
}

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
  const shouldTrackPendingReply =
    !isOrphanReplyRecovery &&
    replyOptions?.isHeartbeat !== true &&
    typeof finalized.SessionKey === "string" &&
    finalized.SessionKey.trim().length > 0;

  let pendingReplyId: string | undefined;
  let pendingReplySessionKey: string | undefined;
  if (shouldTrackPendingReply && finalized.SessionKey) {
    try {
      pendingReplySessionKey = finalized.SessionKey;
      pendingReplyId = await markSessionPendingReply({
        cfg,
        ctx: finalized,
      });
    } catch (err) {
      logVerbose(`pending-reply: mark failed: ${String(err)}`);
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

  if (pendingReplyId && pendingReplySessionKey) {
    // Ack only after the shared dispatch path fully returns (including dispatcher drain).
    // If reply generation or delivery throws, we intentionally leave the entry on disk so
    // startup recovery can retry it after a restart/crash.
    try {
      await clearSessionPendingReply({
        cfg,
        sessionKey: pendingReplySessionKey,
        pendingId: pendingReplyId,
      });
    } catch (err) {
      logVerbose(
        `pending-reply: clear failed (${pendingReplySessionKey}/${pendingReplyId}): ${String(err)}`,
      );
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
