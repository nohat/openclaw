import path from "node:path";
import { resolveSessionAgentId } from "../agents/agent-scope.js";
import { resolveAgentSessionDirs } from "../agents/session-dirs.js";
import { dispatchRecoveredPendingReply } from "../auto-reply/dispatch.js";
import { createReplyDispatcher } from "../auto-reply/reply/reply-dispatcher.js";
import { routeReply, type RouteReplyResult } from "../auto-reply/reply/route-reply.js";
import type { MsgContext } from "../auto-reply/templating.js";
import type { GetReplyOptions } from "../auto-reply/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import {
  loadSessionStore,
  resolveStorePath,
  updateSessionStoreEntry,
  type PendingReplyState,
  type SessionEntry,
} from "../config/sessions.js";
import { extractTextFromChatContent } from "../shared/chat-content.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../utils/message-channel.js";
import { appendAssistantTranscriptMessage } from "./chat-transcript-append.js";
import { readSessionMessages } from "./session-utils.fs.js";

type PendingReplyItem = {
  id: string;
  state: PendingReplyState;
};

type PendingSessionRecoveryEntry = {
  storePath: string;
  sessionKey: string;
  entry: SessionEntry;
  pendingItems: PendingReplyItem[];
};

type TranscriptPendingTurn = {
  text: string;
  images?: GetReplyOptions["images"];
  timestamp?: number;
  messageIdHints: string[];
};

type PendingMatch = {
  item: PendingReplyItem;
  turn?: TranscriptPendingTurn;
};

const MESSAGE_ID_LINE_RE = /^\s*\[message_id:\s*([^\]]+)\]\s*$/i;

export interface PendingReplyRecoveryLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export type PendingReplyRecoveryWebChatHooks = {
  onFinal?: (params: {
    runId: string;
    sessionKey: string;
    message?: Record<string, unknown>;
  }) => void;
  onError?: (params: { runId: string; sessionKey: string; errorMessage?: string }) => void;
};

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function collectTextBlocks(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const out: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const entry = block as Record<string, unknown>;
    if (entry.type !== "text" || typeof entry.text !== "string") {
      continue;
    }
    out.push(entry.text);
  }
  return out;
}

function extractMessageIdHintsFromContent(content: unknown): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const text of collectTextBlocks(content)) {
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(MESSAGE_ID_LINE_RE);
      const id = match?.[1]?.trim();
      if (!id) {
        continue;
      }
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

function collectTranscriptImages(content: unknown): GetReplyOptions["images"] | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const images: NonNullable<GetReplyOptions["images"]> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const entry = block as Record<string, unknown>;
    if (entry.type !== "image") {
      continue;
    }
    const data = normalizeString(entry.data);
    const mimeType = normalizeString(entry.mimeType);
    if (!data || !mimeType) {
      continue;
    }
    images.push({ type: "image", data, mimeType });
  }
  return images.length > 0 ? images : undefined;
}

function parseTranscriptUserTurn(message: unknown): TranscriptPendingTurn | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  const entry = message as Record<string, unknown>;
  const role = normalizeString(entry.role)?.toLowerCase();
  if (role !== "user") {
    return null;
  }
  const text =
    extractTextFromChatContent(entry.content, {
      normalizeText: (raw) => raw,
      joinWith: "\n\n",
    }) ?? (typeof entry.content === "string" ? entry.content : "");
  const images = collectTranscriptImages(entry.content);
  if (!text.trim() && !images?.length) {
    return null;
  }
  const timestamp =
    typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)
      ? entry.timestamp
      : undefined;
  return {
    text,
    images,
    timestamp,
    messageIdHints: extractMessageIdHintsFromContent(entry.content),
  };
}

function extractTrailingOrphanUserTurns(messages: unknown[]): TranscriptPendingTurn[] {
  const turns: TranscriptPendingTurn[] = [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || typeof message !== "object") {
      continue;
    }
    const role = normalizeString((message as Record<string, unknown>).role)?.toLowerCase();
    if (!role || role === "system") {
      continue;
    }
    if (role !== "user") {
      break;
    }
    const turn = parseTranscriptUserTurn(message);
    if (!turn) {
      break;
    }
    turns.push(turn);
  }
  return turns.toReversed();
}

function pendingItemsSorted(items: PendingReplyItem[]): PendingReplyItem[] {
  return [...items].toSorted((a, b) => {
    const delta = a.state.startedAt - b.state.startedAt;
    if (delta !== 0) {
      return delta;
    }
    return a.id.localeCompare(b.id);
  });
}

function matchPendingItemsToTranscriptTurns(params: {
  items: PendingReplyItem[];
  turns: TranscriptPendingTurn[];
}): PendingMatch[] {
  const items = pendingItemsSorted(params.items);
  const turns = params.turns;
  const matches = new Map<string, TranscriptPendingTurn>();
  const matchedTurnIndexes = new Set<number>();

  const claimTurnByHint = (hint: string | undefined): TranscriptPendingTurn | undefined => {
    if (!hint) {
      return undefined;
    }
    for (let i = 0; i < turns.length; i += 1) {
      if (matchedTurnIndexes.has(i)) {
        continue;
      }
      if (!turns[i]?.messageIdHints.includes(hint)) {
        continue;
      }
      matchedTurnIndexes.add(i);
      return turns[i];
    }
    return undefined;
  };

  for (const item of items) {
    const matched =
      claimTurnByHint(normalizeString(item.state.messageIdFull)) ??
      claimTurnByHint(normalizeString(item.state.messageId));
    if (matched) {
      matches.set(item.id, matched);
    }
  }

  let nextUnmatchedTurn = 0;
  for (const item of items) {
    if (matches.has(item.id)) {
      continue;
    }
    while (nextUnmatchedTurn < turns.length && matchedTurnIndexes.has(nextUnmatchedTurn)) {
      nextUnmatchedTurn += 1;
    }
    if (nextUnmatchedTurn >= turns.length) {
      break;
    }
    matchedTurnIndexes.add(nextUnmatchedTurn);
    matches.set(item.id, turns[nextUnmatchedTurn]);
    nextUnmatchedTurn += 1;
  }

  return items.map((item) => ({ item, turn: matches.get(item.id) }));
}

function resolveRecoveryChannel(
  pending: PendingReplyState,
  entry: SessionEntry,
): string | undefined {
  return normalizeMessageChannel(
    pending.originatingChannel ??
      pending.surface ??
      pending.provider ??
      entry.lastChannel ??
      entry.channel,
  );
}

function resolveRecoveryTarget(
  pending: PendingReplyState,
  entry: SessionEntry,
): string | undefined {
  return pending.originatingTo ?? pending.to ?? entry.lastTo ?? entry.origin?.to;
}

function buildReplayContext(params: {
  sessionKey: string;
  entry: SessionEntry;
  pending: PendingReplyState;
  turn: TranscriptPendingTurn;
}): MsgContext {
  const { sessionKey, entry, pending, turn } = params;
  const body = turn.text;
  const provider = pending.provider ?? entry.origin?.provider ?? entry.lastChannel;
  const surface = pending.surface ?? entry.origin?.surface ?? entry.lastChannel;
  return {
    Body: body,
    BodyForAgent: body,
    RawBody: body,
    CommandBody: body,
    BodyForCommands: body,
    SessionKey: sessionKey,
    From: pending.from ?? entry.origin?.from,
    To: pending.to ?? entry.origin?.to ?? entry.lastTo,
    AccountId: pending.accountId ?? entry.lastAccountId ?? entry.origin?.accountId,
    MessageSid: pending.messageId,
    MessageSidFull: pending.messageIdFull,
    MessageThreadId: pending.threadId ?? entry.lastThreadId ?? entry.origin?.threadId,
    ChatType: pending.chatType ?? entry.chatType ?? "direct",
    Provider: provider,
    Surface: surface,
    CommandAuthorized: pending.commandAuthorized === true,
    CommandSource: pending.commandSource,
    CommandTargetSessionKey: pending.commandTargetSessionKey,
    OriginatingChannel:
      typeof pending.originatingChannel === "string"
        ? (pending.originatingChannel as MsgContext["OriginatingChannel"])
        : undefined,
    OriginatingTo: pending.originatingTo,
    SenderId: pending.senderId,
    SenderName: pending.senderName,
    SenderUsername: pending.senderUsername,
    SenderE164: pending.senderE164,
    WasMentioned: pending.wasMentioned,
    IsForum: pending.isForum,
    Timestamp: turn.timestamp,
  };
}

async function clearPendingReplyMarker(params: {
  storePath: string;
  sessionKey: string;
  pendingId: string;
}) {
  await updateSessionStoreEntry({
    storePath: params.storePath,
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

async function resolveStorePathsForRecovery(
  cfg: OpenClawConfig,
  stateDir: string,
): Promise<string[]> {
  const paths = new Set<string>();
  const sessionDirs = await resolveAgentSessionDirs(stateDir);
  for (const dir of sessionDirs) {
    paths.add(path.join(dir, "sessions.json"));
  }
  paths.add(resolveStorePath(cfg.session?.store));
  if (typeof cfg.session?.store === "string" && cfg.session.store.includes("{agentId}")) {
    const agentIds = new Set<string>(["main"]);
    for (const dir of sessionDirs) {
      const agentId = path.basename(path.dirname(dir));
      if (agentId) {
        agentIds.add(agentId);
      }
    }
    for (const agentId of agentIds) {
      paths.add(resolveStorePath(cfg.session.store, { agentId }));
    }
  }
  return [...paths].toSorted((a, b) => a.localeCompare(b));
}

async function loadPendingSessionEntries(opts: {
  cfg: OpenClawConfig;
  stateDir?: string;
}): Promise<PendingSessionRecoveryEntry[]> {
  const stateDir = opts.stateDir ?? resolveStateDir();
  const storePaths = await resolveStorePathsForRecovery(opts.cfg, stateDir);
  const pendingSessions: PendingSessionRecoveryEntry[] = [];
  for (const storePath of storePaths) {
    let store: Record<string, SessionEntry>;
    try {
      store = loadSessionStore(storePath, { skipCache: true });
    } catch {
      continue;
    }
    for (const [sessionKey, entry] of Object.entries(store)) {
      const pendingReplies = entry?.pendingReplies;
      if (!pendingReplies || typeof pendingReplies !== "object") {
        continue;
      }
      const pendingItems: PendingReplyItem[] = [];
      for (const [id, state] of Object.entries(pendingReplies)) {
        if (!state || typeof state !== "object") {
          continue;
        }
        if (typeof state.startedAt !== "number" || !Number.isFinite(state.startedAt)) {
          continue;
        }
        pendingItems.push({ id, state });
      }
      if (pendingItems.length === 0) {
        continue;
      }
      pendingSessions.push({ storePath, sessionKey, entry, pendingItems });
    }
  }
  pendingSessions.sort((a, b) => {
    const aMin = Math.min(...a.pendingItems.map((item) => item.state.startedAt));
    const bMin = Math.min(...b.pendingItems.map((item) => item.state.startedAt));
    if (aMin !== bMin) {
      return aMin - bMin;
    }
    return a.sessionKey.localeCompare(b.sessionKey);
  });
  return pendingSessions;
}

export async function recoverPendingRepliesOnStartup(opts: {
  cfg: OpenClawConfig;
  log: PendingReplyRecoveryLogger;
  stateDir?: string;
  replyResolver?: typeof import("../auto-reply/reply.js").getReplyFromConfig;
  routeReplyFn?: (params: Parameters<typeof routeReply>[0]) => Promise<RouteReplyResult>;
  webchat?: PendingReplyRecoveryWebChatHooks;
}): Promise<{ recovered: number; failed: number; clearedStale?: number }> {
  const pendingSessions = await loadPendingSessionEntries({
    cfg: opts.cfg,
    stateDir: opts.stateDir,
  });
  if (pendingSessions.length === 0) {
    return { recovered: 0, failed: 0, clearedStale: 0 };
  }

  const routeReplyFn = opts.routeReplyFn ?? routeReply;
  let recovered = 0;
  let failed = 0;
  let clearedStale = 0;
  const pendingCount = pendingSessions.reduce(
    (sum, session) => sum + session.pendingItems.length,
    0,
  );
  opts.log.info(
    `Found ${pendingCount} pending repl${pendingCount === 1 ? "y" : "ies"} across ${pendingSessions.length} session${pendingSessions.length === 1 ? "" : "s"}`,
  );

  for (const sessionPending of pendingSessions) {
    const { storePath, sessionKey, entry, pendingItems } = sessionPending;
    const transcriptMessages = readSessionMessages(entry.sessionId, storePath, entry.sessionFile);
    const orphanTurns = extractTrailingOrphanUserTurns(transcriptMessages);
    const pendingMatches = matchPendingItemsToTranscriptTurns({
      items: pendingItems,
      turns: orphanTurns,
    });

    for (const match of pendingMatches) {
      const { item, turn } = match;
      if (!turn) {
        try {
          await clearPendingReplyMarker({
            storePath,
            sessionKey,
            pendingId: item.id,
          });
          clearedStale += 1;
          opts.log.info(`Cleared stale pending reply marker for ${sessionKey} (${item.id})`);
        } catch (err) {
          failed += 1;
          opts.log.warn(
            `Failed to clear stale pending marker for ${sessionKey} (${item.id}): ${String(err)}`,
          );
        }
        continue;
      }

      const pending = item.state;
      const runId = `recovery-${item.id}`;
      const ctx = buildReplayContext({ sessionKey, entry, pending, turn });
      const channel = resolveRecoveryChannel(pending, entry);
      const target = resolveRecoveryTarget(pending, entry);
      const isWebChat = channel === INTERNAL_MESSAGE_CHANNEL;
      let agentRunStarted = false;
      const finalReplyParts: string[] = [];
      let deliveryError: string | undefined;

      try {
        const dispatcher = createReplyDispatcher({
          onError: (err, info) => {
            deliveryError = `${info.kind}: ${err instanceof Error ? err.message : String(err)}`;
            opts.log.warn(
              `pending reply ${sessionKey} (${item.id}): delivery error (${info.kind}): ${err instanceof Error ? err.message : String(err)}`,
            );
          },
          deliver: async (payload, info) => {
            if (isWebChat) {
              if (info.kind === "final") {
                const text = payload.text?.trim();
                if (text) {
                  finalReplyParts.push(text);
                }
              }
              return;
            }
            if (!channel || !target) {
              throw new Error("missing channel or reply target");
            }
            const result = await routeReplyFn({
              payload,
              channel,
              to: target,
              sessionKey,
              accountId: ctx.AccountId,
              threadId: ctx.MessageThreadId,
              cfg: opts.cfg,
              mirror: false,
            });
            if (!result.ok) {
              throw new Error(result.error ?? "routeReply failed");
            }
          },
        });

        await dispatchRecoveredPendingReply({
          ctx,
          cfg: opts.cfg,
          dispatcher,
          replyResolver: opts.replyResolver,
          replyOptions: {
            runId,
            images: turn.images,
            onAgentRunStart: () => {
              agentRunStarted = true;
            },
          },
        });

        if (deliveryError) {
          throw new Error(deliveryError);
        }

        if (isWebChat && !agentRunStarted) {
          const combinedReply = finalReplyParts.join("\n\n").trim();
          let message: Record<string, unknown> | undefined;
          if (combinedReply) {
            const latestStore = loadSessionStore(storePath, { skipCache: true });
            const latestEntry =
              latestStore[sessionKey] ?? latestStore[sessionKey.toLowerCase()] ?? entry;
            const sessionId = latestEntry?.sessionId ?? entry.sessionId ?? runId;
            const originalRunId = pending.messageId?.trim() || runId;
            const appended = appendAssistantTranscriptMessage({
              message: combinedReply,
              sessionId,
              storePath,
              sessionFile: latestEntry?.sessionFile,
              agentId: resolveSessionAgentId({ sessionKey, config: opts.cfg }),
              createIfMissing: true,
              idempotencyKey: `${originalRunId}:assistant`,
            });
            if (!appended.ok) {
              throw new Error(
                `webchat transcript append failed: ${appended.error ?? "unknown error"}`,
              );
            }
            message = appended.message;
          }
          opts.webchat?.onFinal?.({ runId, sessionKey, message });
        }

        await clearPendingReplyMarker({ storePath, sessionKey, pendingId: item.id });
        recovered += 1;
        opts.log.info(
          `Recovered pending reply for ${sessionKey} (${item.id})${channel ? ` via ${channel}` : ""}`,
        );
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        if (isWebChat) {
          opts.webchat?.onError?.({ runId, sessionKey, errorMessage: message });
        }
        opts.log.warn(`Pending reply recovery failed for ${sessionKey} (${item.id}): ${message}`);
      }
    }
  }

  opts.log.info(
    `Pending reply recovery complete: ${recovered} recovered, ${failed} failed, ${clearedStale} stale markers cleared`,
  );
  return { recovered, failed, clearedStale };
}
