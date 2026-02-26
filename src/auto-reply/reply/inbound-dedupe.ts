import type { DedupeCache } from "../../infra/dedupe.js";
export { createDedupeCache } from "../../infra/dedupe.js";
import type { MsgContext } from "../templating.js";

const normalizeProvider = (value?: string | null) => value?.trim().toLowerCase() || "";

const resolveInboundPeerId = (ctx: MsgContext) =>
  ctx.OriginatingTo ?? ctx.To ?? ctx.From ?? ctx.SessionKey;

export function buildInboundDedupeKey(ctx: MsgContext): string | null {
  const provider = normalizeProvider(ctx.OriginatingChannel ?? ctx.Provider ?? ctx.Surface);
  const messageId = ctx.MessageSid?.trim();
  if (!provider || !messageId) {
    return null;
  }
  const peerId = resolveInboundPeerId(ctx);
  if (!peerId) {
    return null;
  }
  const sessionKey = ctx.SessionKey?.trim() ?? "";
  const accountId = ctx.AccountId?.trim() ?? "";
  const threadId =
    ctx.MessageThreadId !== undefined && ctx.MessageThreadId !== null
      ? String(ctx.MessageThreadId)
      : "";
  return [provider, accountId, sessionKey, peerId, threadId, messageId].filter(Boolean).join("|");
}

/**
 * @deprecated Dedup is now handled upstream via acceptInboundOrSkip (SQLite-backed).
 * This stub always returns false so existing call sites are no-ops until removed.
 */
export function shouldSkipDuplicateInbound(
  _ctx: MsgContext,
  _opts?: { cache?: DedupeCache; now?: number },
): boolean {
  return false;
}

/** @deprecated No-op — global cache was removed; dedup is SQLite-backed. */
export function resetInboundDedupe(): void {}
