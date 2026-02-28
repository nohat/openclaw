import { chunkText } from "../../../auto-reply/chunk.js";
import { shouldLogVerbose } from "../../../globals.js";
import { sendPollWhatsApp } from "../../../web/outbound.js";
import { resolveWhatsAppOutboundTarget } from "../../../whatsapp/resolve-outbound-target.js";
import type { ChannelOutboundAdapter } from "../types.js";

export const whatsappOutbound: ChannelOutboundAdapter = {
  deliveryMode: "gateway",
  chunker: chunkText,
  chunkerMode: "text",
  textChunkLimit: 4000,
  pollMaxOptions: 12,
  resolveTarget: ({ to, allowFrom, mode }) =>
    resolveWhatsAppOutboundTarget({ to, allowFrom, mode }),
  sendPayload: async ({ to, payload, mediaLocalRoots, accountId, deps, gifPlayback }) => {
    const send =
      deps?.sendWhatsApp ?? (await import("../../../web/outbound.js")).sendMessageWhatsApp;
    const urls = payload.mediaUrls?.length
      ? payload.mediaUrls
      : payload.mediaUrl
        ? [payload.mediaUrl]
        : [];
    if (urls.length > 0) {
      let lastResult;
      for (let i = 0; i < urls.length; i++) {
        const result = await send(to, i === 0 ? (payload.text ?? "") : "", {
          verbose: false,
          mediaUrl: urls[i],
          mediaLocalRoots,
          accountId: accountId ?? undefined,
          gifPlayback,
        });
        lastResult = { channel: "whatsapp" as const, ...result };
      }
      return lastResult;
    }
    const result = await send(to, payload.text ?? "", {
      verbose: false,
      accountId: accountId ?? undefined,
      gifPlayback,
    });
    return { channel: "whatsapp", ...result };
  },
  sendText: async ({ to, text, accountId, deps, gifPlayback }) => {
    const send =
      deps?.sendWhatsApp ?? (await import("../../../web/outbound.js")).sendMessageWhatsApp;
    const result = await send(to, text, {
      verbose: false,
      accountId: accountId ?? undefined,
      gifPlayback,
    });
    return { channel: "whatsapp", ...result };
  },
  sendMedia: async ({ to, text, mediaUrl, mediaLocalRoots, accountId, deps, gifPlayback }) => {
    const send =
      deps?.sendWhatsApp ?? (await import("../../../web/outbound.js")).sendMessageWhatsApp;
    const result = await send(to, text, {
      verbose: false,
      mediaUrl,
      mediaLocalRoots,
      accountId: accountId ?? undefined,
      gifPlayback,
    });
    return { channel: "whatsapp", ...result };
  },
  sendPoll: async ({ to, poll, accountId }) =>
    await sendPollWhatsApp(to, poll, {
      verbose: shouldLogVerbose(),
      accountId: accountId ?? undefined,
    }),
};
