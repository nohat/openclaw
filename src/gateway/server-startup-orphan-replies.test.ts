import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../test/helpers/temp-home.ts";
import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, saveSessionStore } from "../config/sessions.js";
import { recoverPendingRepliesOnStartup } from "./server-startup-orphan-replies.js";

async function writeTranscript(params: {
  homeStateDir: string;
  agentId?: string;
  sessionId: string;
  messages: unknown[];
}) {
  const transcriptPath = path.join(
    params.homeStateDir,
    "agents",
    params.agentId ?? "main",
    "sessions",
    `${params.sessionId}.jsonl`,
  );
  await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", version: 1, id: params.sessionId }),
    ...params.messages.map((message) => JSON.stringify({ message })),
  ];
  await fs.writeFile(transcriptPath, lines.join("\n"), "utf-8");
}

function defaultStorePath(stateDir: string, agentId = "main") {
  return path.join(stateDir, "agents", agentId, "sessions", "sessions.json");
}

describe("recoverPendingRepliesOnStartup", () => {
  it("replays queued pending replies on startup for non-web channels (telegram)", async () => {
    await withTempHome(async () => {
      const stateDir = process.env.OPENCLAW_STATE_DIR!;
      const sessionKey = "agent:main:telegram:dm:telegram-chat-1";
      const storePath = defaultStorePath(stateDir);
      await writeTranscript({
        homeStateDir: stateDir,
        sessionId: "sess-1",
        messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      });
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "sess-1",
          updatedAt: Date.now(),
          chatType: "direct",
          lastChannel: "telegram",
          lastTo: "telegram-chat-1",
          pendingReplies: {
            "msg:msg-1": {
              startedAt: Date.now(),
              messageId: "msg-1",
              from: "telegram-user-1",
              to: "telegram-chat-1",
              provider: "telegram",
              surface: "telegram",
              originatingChannel: "telegram",
              originatingTo: "telegram-chat-1",
              chatType: "direct",
              commandAuthorized: true,
            },
          },
        },
      });

      const routeReplyFn = vi.fn(async () => ({ ok: true as const }));
      const replyResolver = vi.fn(async () => ({ text: "Recovered reply" }));
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const result = await recoverPendingRepliesOnStartup({
        cfg: {} as OpenClawConfig,
        log: logger,
        routeReplyFn,
        replyResolver,
      });

      expect(result).toMatchObject({ recovered: 1, failed: 0, clearedStale: 0 });
      expect(replyResolver).toHaveBeenCalledTimes(1);
      expect(routeReplyFn).toHaveBeenCalledTimes(1);
      expect(routeReplyFn).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: "telegram",
          to: "telegram-chat-1",
          sessionKey: "agent:main:telegram:dm:telegram-chat-1",
          payload: expect.objectContaining({
            text: "Recovered reply",
          }),
        }),
      );
      const saved = loadSessionStore(storePath, { skipCache: true });
      expect(saved[sessionKey]?.pendingReplies).toBeUndefined();
    });
  });

  it("keeps the pending entry when replay delivery fails", async () => {
    await withTempHome(async () => {
      const stateDir = process.env.OPENCLAW_STATE_DIR!;
      const sessionKey = "agent:main:telegram:dm:telegram-chat-2";
      const storePath = defaultStorePath(stateDir);
      await writeTranscript({
        homeStateDir: stateDir,
        sessionId: "sess-2",
        messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
      });
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId: "sess-2",
          updatedAt: Date.now(),
          chatType: "direct",
          lastChannel: "telegram",
          lastTo: "telegram-chat-2",
          pendingReplies: {
            "msg:msg-2": {
              startedAt: Date.now(),
              messageId: "msg-2",
              from: "telegram-user-2",
              to: "telegram-chat-2",
              provider: "telegram",
              surface: "telegram",
              chatType: "direct",
              commandAuthorized: true,
            },
          },
        },
      });

      const routeReplyFn = vi.fn(async () => ({ ok: false as const, error: "send failed" }));
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      };

      const result = await recoverPendingRepliesOnStartup({
        cfg: {} as OpenClawConfig,
        log: logger,
        routeReplyFn,
        replyResolver: async () => ({ text: "Recovered reply" }),
      });

      expect(result).toMatchObject({ recovered: 0, failed: 1 });
      const saved = loadSessionStore(storePath, { skipCache: true });
      expect(saved[sessionKey]?.pendingReplies).toMatchObject({
        "msg:msg-2": expect.objectContaining({ messageId: "msg-2" }),
      });
    });
  });
});
