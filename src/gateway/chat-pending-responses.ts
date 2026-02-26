import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";

const PENDING_DIRNAME = "chat-pending-responses";

export type PendingChatAttachment = {
  type?: string;
  mimeType?: string;
  fileName?: string;
  content?: string;
};

export type PendingChatResponseEntry = {
  idempotencyKey: string;
  sessionKey: string;
  message: string;
  thinking?: string;
  timeoutMs?: number;
  attachments?: PendingChatAttachment[];
  enqueuedAt: number;
};

export interface PendingChatRecoveryLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

function resolvePendingDir(stateDir?: string): string {
  return path.join(stateDir ?? resolveStateDir(), PENDING_DIRNAME);
}

function resolveEntryFilePath(idempotencyKey: string, stateDir?: string): string {
  const digest = crypto.createHash("sha256").update(idempotencyKey).digest("hex");
  return path.join(resolvePendingDir(stateDir), `${digest}.json`);
}

export async function enqueuePendingChatResponse(
  entry: Omit<PendingChatResponseEntry, "enqueuedAt"> & { enqueuedAt?: number },
  stateDir?: string,
): Promise<void> {
  const filePath = resolveEntryFilePath(entry.idempotencyKey, stateDir);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const payload: PendingChatResponseEntry = {
    ...entry,
    enqueuedAt: entry.enqueuedAt ?? Date.now(),
  };
  const tmp = `${filePath}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(payload, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fs.promises.rename(tmp, filePath);
}

export async function ackPendingChatResponse(
  idempotencyKey: string,
  stateDir?: string,
): Promise<void> {
  const filePath = resolveEntryFilePath(idempotencyKey, stateDir);
  try {
    await fs.promises.unlink(filePath);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    if (code !== "ENOENT") {
      throw err;
    }
  }
}

export async function loadPendingChatResponses(
  stateDir?: string,
): Promise<PendingChatResponseEntry[]> {
  const dir = resolvePendingDir(stateDir);
  let files: string[];
  try {
    files = await fs.promises.readdir(dir);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code?: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const out: PendingChatResponseEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) {
      continue;
    }
    const filePath = path.join(dir, file);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        continue;
      }
      const raw = await fs.promises.readFile(filePath, "utf-8");
      const parsed = JSON.parse(raw) as Partial<PendingChatResponseEntry>;
      if (
        typeof parsed?.idempotencyKey !== "string" ||
        typeof parsed?.sessionKey !== "string" ||
        typeof parsed?.message !== "string"
      ) {
        continue;
      }
      out.push({
        idempotencyKey: parsed.idempotencyKey,
        sessionKey: parsed.sessionKey,
        message: parsed.message,
        thinking: typeof parsed.thinking === "string" ? parsed.thinking : undefined,
        timeoutMs:
          typeof parsed.timeoutMs === "number" && Number.isFinite(parsed.timeoutMs)
            ? parsed.timeoutMs
            : undefined,
        attachments: Array.isArray(parsed.attachments)
          ? parsed.attachments
              .filter((item) => item && typeof item === "object")
              .map((item) => {
                const value = item;
                return {
                  type: typeof value.type === "string" ? value.type : undefined,
                  mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined,
                  fileName: typeof value.fileName === "string" ? value.fileName : undefined,
                  content: typeof value.content === "string" ? value.content : undefined,
                };
              })
          : undefined,
        enqueuedAt:
          typeof parsed.enqueuedAt === "number" && Number.isFinite(parsed.enqueuedAt)
            ? parsed.enqueuedAt
            : 0,
      });
    } catch {
      // Skip malformed entries; leave file in place for inspection.
    }
  }
  out.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
  return out;
}

export async function recoverPendingChatResponses(opts: {
  replay: (entry: PendingChatResponseEntry) => Promise<void>;
  log: PendingChatRecoveryLogger;
  stateDir?: string;
  cutoffEnqueuedAt?: number;
}): Promise<{ recovered: number; failed: number; skipped: number }> {
  const pending = await loadPendingChatResponses(opts.stateDir);
  if (pending.length === 0) {
    return { recovered: 0, failed: 0, skipped: 0 };
  }
  const cutoff = opts.cutoffEnqueuedAt;
  const eligible =
    typeof cutoff === "number" && Number.isFinite(cutoff)
      ? pending.filter((entry) => entry.enqueuedAt <= cutoff)
      : pending;
  const skipped = pending.length - eligible.length;
  if (eligible.length === 0) {
    return { recovered: 0, failed: 0, skipped };
  }

  opts.log.info(`Found ${eligible.length} pending chat response(s) to recover`);
  let recovered = 0;
  let failed = 0;
  for (const entry of eligible) {
    try {
      await opts.replay(entry);
      await ackPendingChatResponse(entry.idempotencyKey, opts.stateDir);
      recovered += 1;
    } catch (err) {
      failed += 1;
      opts.log.warn(
        `Pending chat response recovery failed for ${entry.idempotencyKey}: ${String(err)}`,
      );
    }
  }
  if (skipped > 0) {
    opts.log.info(`Skipped ${skipped} newly-enqueued chat response(s) during startup recovery`);
  }
  opts.log.info(
    `Chat response recovery complete: ${recovered} recovered, ${failed} failed, ${skipped} skipped`,
  );
  return { recovered, failed, skipped };
}
