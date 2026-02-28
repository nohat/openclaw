import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk";
import { sendMessageMatrix, sendPollMatrix } from "./matrix/send.js";
import { getMatrixRuntime } from "./runtime.js";

export const matrixOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getMatrixRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sendPayload: async (ctx) => {
    const urls = ctx.payload.mediaUrls?.length
      ? ctx.payload.mediaUrls
      : ctx.payload.mediaUrl
        ? [ctx.payload.mediaUrl]
        : [];
    const send = ctx.deps?.sendMatrix ?? sendMessageMatrix;
    const resolvedThreadId =
      ctx.threadId !== undefined && ctx.threadId !== null ? String(ctx.threadId) : undefined;
    if (urls.length > 0) {
      let lastResult;
      for (let i = 0; i < urls.length; i++) {
        lastResult = await send(ctx.to, i === 0 ? (ctx.payload.text ?? "") : "", {
          mediaUrl: urls[i],
          replyToId: ctx.replyToId ?? undefined,
          threadId: resolvedThreadId,
          accountId: ctx.accountId ?? undefined,
        });
      }
      return {
        channel: "matrix",
        messageId: lastResult!.messageId,
        roomId: lastResult!.roomId,
      };
    }
    const result = await send(ctx.to, ctx.payload.text ?? "", {
      replyToId: ctx.replyToId ?? undefined,
      threadId: resolvedThreadId,
      accountId: ctx.accountId ?? undefined,
    });
    return {
      channel: "matrix",
      messageId: result.messageId,
      roomId: result.roomId,
    };
  },
  sendText: async ({ to, text, deps, replyToId, threadId, accountId }) => {
    const send = deps?.sendMatrix ?? sendMessageMatrix;
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await send(to, text, {
      replyToId: replyToId ?? undefined,
      threadId: resolvedThreadId,
      accountId: accountId ?? undefined,
    });
    return {
      channel: "matrix",
      messageId: result.messageId,
      roomId: result.roomId,
    };
  },
  sendMedia: async ({ to, text, mediaUrl, deps, replyToId, threadId, accountId }) => {
    const send = deps?.sendMatrix ?? sendMessageMatrix;
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await send(to, text, {
      mediaUrl,
      replyToId: replyToId ?? undefined,
      threadId: resolvedThreadId,
      accountId: accountId ?? undefined,
    });
    return {
      channel: "matrix",
      messageId: result.messageId,
      roomId: result.roomId,
    };
  },
  sendPoll: async ({ to, poll, threadId, accountId }) => {
    const resolvedThreadId =
      threadId !== undefined && threadId !== null ? String(threadId) : undefined;
    const result = await sendPollMatrix(to, poll, {
      threadId: resolvedThreadId,
      accountId: accountId ?? undefined,
    });
    return {
      channel: "matrix",
      messageId: result.eventId,
      roomId: result.roomId,
      pollId: result.eventId,
    };
  },
};
