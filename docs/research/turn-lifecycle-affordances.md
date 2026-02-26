# Turn lifecycle state: data structures and persistence

Research on where to add turn lifecycle (pending-turn) state so we can detect and recover from "user sent message, agent never responded" (orphans) after restart, and provide a single story for "open turn" / missed response.

## 1. In-memory structures (relevant to user message → run → response)

| Location                                | Structure                                                            | Purpose                                                                       | Survives restart? |
| --------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------- |
| `src/agents/pi-embedded-runner/runs.ts` | `ACTIVE_EMBEDDED_RUNS` (Map sessionId → handle)                      | "Is run active?", abort, queue message. Set at run start, cleared at run end. | No                |
| `src/auto-reply/reply/queue/state.ts`   | `FOLLOWUP_QUEUES` (Map key → FollowupQueueState)                     | Per-session followup queue (items, draining, lastRun).                        | No                |
| `src/auto-reply/reply/queue/enqueue.ts` | Updates `queue.lastRun`, `queue.items`                               | Tracks last enqueued run and queue contents.                                  | No                |
| `src/process/command-queue.ts`          | Per-lane queue + active task ids                                     | Command queue for embedded runs.                                              | No                |
| `src/config/sessions/store.ts`          | `SESSION_STORE_CACHE` (Map storePath → { store, loadedAt, mtimeMs }) | TTL cache for sessions.json; invalidated on write.                            | No (cache only)   |

None of these persist. After a restart, we cannot tell from in-memory state that a session had a run in progress or a user message with no response.

## 2. Persistence touchpoints

| What              | Where                                                                     | Format                                                                                                                              | Who updates                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Session store** | `~/.openclaw/agents/<agentId>/sessions/sessions.json` (or per-agent path) | JSON object: `{ [sessionKey]: SessionEntry }`                                                                                       | `updateSessionStore`, `updateSessionStoreEntry`, `recordSessionMetaFromInbound`, `updateLastRoute`, plus many callers in gateway, reply, cron, etc. |
| **Session entry** | One `SessionEntry` per session key in the store                           | Fields: sessionId, updatedAt, sessionFile, abortedLastRun, deliveryContext, model, tokens, etc.                                     | Same; single-entry updates via `updateSessionStoreEntry(storePath, sessionKey, update)`.                                                            |
| **Transcript**    | Per-session JSONL (`SessionEntry.sessionFile`)                            | Append-only tree of nodes (session header, messages, custom entries). User/assistant messages and parent/child structure live here. | SessionManager (pi-coding-agent); we append via agent run (e.g. tool-result-truncation, attempt.ts).                                                |

Orphan detection today is done by **scanning the transcript**: `listRecoverableOrphanUserLeafIds(sessionManager)` in `attempt.ts` finds user-message leaves with no assistant child. That works inside a live run but does not tell us "this session has an open turn" without loading and scanning every transcript after restart.

## 3. Best affordance for turn lifecycle state

**Recommendation: add turn lifecycle state to `SessionEntry` in the session store.**

Reasons:

- **Session store is already the session-level metadata layer** – same place as `abortedLastRun`, `updatedAt`, `sessionFile`, delivery context, etc. It is the natural place for "this session has an open turn."
- **Survives restart** – we can list sessions with a pending turn by reading `sessions.json` only, without opening transcripts.
- **Atomic updates** – `updateSessionStoreEntry(storePath, sessionKey, update)` gives a single place to set/clear; no new persistence mechanism.
- **Set/clear aligns with existing flow** – we already have `storePath` and `sessionKey` in `agent-runner.ts` where we start the embedded run and where we handle run outcome, abort, and reset.

Alternatives considered:

- **Transcript only** – Orphan detection already lives there (append-only tree). Adding a "pending" marker would require an append-only sentinel (e.g. custom entry) and a "cleared" follow-up entry, which is clumsier than a single flag on the session.
- **New file or table** – Would duplicate session keying and update ordering; session store already has the right granularity and locking.

## 4. Minimal schema (on `SessionEntry`)

Add to `src/config/sessions/types.ts`:

```ts
// Turn lifecycle: set when we start processing a user turn, clear when the turn completes (response written or run aborted/failed).
/** Transcript node id of the user message we are currently answering (if any). Enables precise orphan recovery. */
pendingUserMessageId?: string;
/** Timestamp (ms) when the current turn started. Enables "open turn" detection after restart without opening transcript. */
pendingTurnSince?: number;
```

- **`pendingTurnSince`** – Set at run start, clear at run end. Sufficient for "this session has an open turn" after restart; no transcript read needed.
- **`pendingUserMessageId`** – Optional; set when we have the transcript node id (e.g. after the pi SessionManager appends the user message). Enables recovery that targets that specific node. Can be added later if we expose the node id from the embedded run.

For a minimal first step, **`pendingTurnSince` alone** is enough: set when we're about to run, clear when the run completes or aborts.

## 5. Where to set and clear (code locations)

All in **reply layer** (`src/auto-reply/reply/`); no need to pass `storePath` into the embedded runner for this.

**Set** (run start):

- **`agent-runner.ts`** – Immediately before calling the code that invokes the embedded run (e.g. before `runReplyAgent` / the subscription/attempt invocation). We have `storePath`, `sessionKey`, and `activeSessionEntry` there. Call `updateSessionStoreEntry({ storePath, sessionKey, update: () => ({ pendingTurnSince: Date.now() }) })`. Do **not** set when we only enqueue (e.g. `enqueueFollowupRun`); set only when we are about to execute the run, so "pending" means "run in progress," not "message queued."

**Clear** (run end):

- **`agent-runner.ts`** – When the run completes (success or failure):
  - In the success path after we've persisted usage and built reply payloads (e.g. before or after `finalizeWithFollowup`), and in the early-exit paths (e.g. `runOutcome.kind === "final"`, or when `payloadArray.length === 0`).
  - In the failure/abort/reset paths: wherever we currently call `updateSessionStore` / `updateSessionStoreEntry` for this session (e.g. reset session, abort handling).
- **`abort.ts`** – When we set `abortedLastRun` and update the store (around the existing `updateSessionStore(storePath, ...)`), also clear `pendingTurnSince` (and `pendingUserMessageId` if present) so an aborted run does not look like an open turn after restart.

**Consistency**: Any path that clears "active run" (e.g. `clearActiveEmbeddedRun`, session reset, abort) should also clear the pending-turn fields so the session store and in-memory run state stay aligned.

## 6. Summary

- **In-memory**: Run and queue state (ACTIVE_EMBEDDED_RUNS, FOLLOWUP_QUEUES, command-queue) are lost on restart; they are not the right place for durable "open turn" state.
- **Persistence**: Session store (sessions.json) and transcript (JSONL) are the two durable surfaces. Session store is keyed by session and already updated at run boundaries; transcript is append-only and already used for orphan detection by scanning.
- **Best place**: **SessionEntry** in the session store, with optional `pendingTurnSince` (and later `pendingUserMessageId`). Set at run start in agent-runner, clear on run completion and on abort/reset. This gives a single, restart-safe affordance for "open turn" and a clear place to add recovery (e.g. on startup or when loading a session, if `pendingTurnSince` is set, treat as orphan and run recovery or show in UI).

---

## 7. Historical precedent: persisting more state for reliability

OpenClaw has already evolved by persisting additional state so that behavior survives restart or reconnects. That gives clear precedent for adding turn-lifecycle state to the session store.

| Precedent                          | What is persisted                                                                             | Why (reliability)                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Restart sentinel**               | `restart-sentinel.json`: `sessionKey`, `deliveryContext` (channel, to, accountId), `threadId` | Comment in code: _"Delivery context captured at restart time to ensure channel routing survives restart"_ (`src/infra/restart-sentinel.ts`). Written on config apply/update/restart so that after a gateway restart we still know where to route the next reply (`src/gateway/server-methods/config.ts`: "Extract deliveryContext + threadId for routing after restart"). |
| **Session store**                  | `sessions.json`: session records keyed by sessionKey                                          | Schema help: _"used to persist session records across restarts"_ (`session.store`). Explicit design intent: survive restart.                                                                                                                                                                                                                                              |
| **Cron store**                     | Cron job store file                                                                           | Schema help: _"used to persist scheduled jobs across restarts"_ (`cron.store`). Same pattern.                                                                                                                                                                                                                                                                             |
| **Telegram update offset**         | `telegram/update-offset-<account>.json`: `lastUpdateId`, `botId`                              | So we don’t reprocess or skip updates after restart; watermark persists across process restarts and reconnects.                                                                                                                                                                                                                                                           |
| **Subagent registry**              | `subagents/runs.json`: active runs + requesterOrigin etc.                                     | Test: _"persists runs to disk and resumes after restart"_; ensures we can report back to the right session after a restart.                                                                                                                                                                                                                                               |
| **Session store schema evolution** | New optional fields on `SessionEntry`; in-place migration on load                             | Store supports evolution: `provider` → `channel`, `room` → `groupChannel` (best-effort migration in `loadSessionStore`). `SessionEntryLike` in state-migrations is `sessionId + updatedAt + Record<string, unknown>`, so new optional fields don’t break old stores.                                                                                                      |
| **Feishu extension (dedup)**       | Persistent TTL store                                                                          | Comment: _"Persistent TTL: 24 hours — survives restarts & WebSocket reconnects."_                                                                                                                                                                                                                                                                                         |

So the pattern is established: **when correctness or reliability after restart (or reconnect) depends on state, that state is persisted.** Turn lifecycle fits the same pattern: we need "open turn" to survive restart so we can recover orphans and show accurate status.

---

## 8. OpenClaw persistence at a higher level

### Is there a coherent framework?

OpenClaw does not document a single named "persistence framework," but the pattern is consistent:

- **Gateway is the source of truth.** Session and conversation state live on the gateway host. UIs and remote clients query the gateway; they do not read local session files directly (see [Session management](/concepts/session), [Session management deep dive](/reference/session-management-compaction)).
- **Two session layers** (both under the gateway):
  1. **Session store** (`sessions.json`) – small, mutable, keyed by `sessionKey`. Holds session **metadata**: sessionId, updatedAt, toggles, token counters, delivery context, etc. Safe to edit or delete entries; recreated on demand.
  2. **Transcript** (`<sessionId>.jsonl`) – append-only conversation tree. Holds the actual messages and tool results; used to rebuild model context.
- **Other persisted state** lives outside the session layers but follows the same idea – "must survive restart or be visible to other processes":
  - Config: `openclaw.json` (and env overrides).
  - Connector/operational: Telegram update offset, pairing/device store, auth tokens, cron run logs, target writeback (e.g. Telegram defaultTo).
  - Workspace: memory Markdown files, agent workspace (see [Memory](/concepts/memory), [Agent workspace](/concepts/agent-workspace)).
- **What is not persisted** – ephemeral runtime state: active run handles (`ACTIVE_EMBEDDED_RUNS`), followup queues, command queue, typing/streaming flags, in-memory caches (e.g. session store TTL cache). These exist only in the gateway process and are lost on restart.

So the implicit rule is: **persist what must survive restart or be shared across processes/UIs; keep short-lived runtime state in memory.**

### Where turn lifecycle fits

Turn lifecycle state is **session-scoped metadata** about the current turn – like `abortedLastRun` and token counters. It belongs in the **session store** (`SessionEntry`), not in the transcript or a new store:

- Same layer as other "last run" and activity metadata.
- Same update path: `updateSessionStoreEntry(storePath, sessionKey, update)`.
- Same consistency story: written at run boundaries, so it survives restart and is visible to any consumer of `sessions.json` (gateway, CLI, future dashboards).

It does **not** belong in the transcript (append-only; no single "current" flag) or in a new file (redundant keying and locking).

---

## 9. Greater purpose than the orphan bug

### Best argument

**One source of truth for "is there an open turn?"** that serves multiple concerns:

1. **Orphan recovery** – After restart, we know which sessions had a run in progress and can run recovery (e.g. continue the turn or mark for retry) without scanning every transcript.
2. **Status and UX** – UIs (TUI, web, macOS) can show "waiting for response" or "Agent is thinking" for a session by reading the session store (or gateway API that exposes it), including in remote setups where the UI is not the process that started the run.
3. **Operational visibility** – Dashboards or `openclaw sessions` can list "sessions with open turn" and how long they have been pending, for debugging and support.
4. **Future features** – "Nudge to retry" or "Resume orphaned turn" can key off the same flag; delivery/retry logic can correlate "we cleared pending but user never got a reply" with channel delivery failures.

The strongest single pitch: **restart-safe, session-level "open turn" is the minimal durable contract that both fixes the orphan bug and unlocks status, recovery, and future improvements without a second persistence model.**

### Other tangible improvements

| Improvement                 | How turn lifecycle helps                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Startup orphan recovery** | Gateway can, on boot, filter to sessions where `pendingTurnSince` is set and run recovery only for those (no need to open every transcript).                            |
| **CLI / dashboard**         | `openclaw sessions --open-turn` or a "Sessions with open turn" view without touching JSONL.                                                                             |
| **Remote / multi-UI**       | Any client that can read session list can show "thinking" or "pending" for a session even if it didn’t start the run (today "run in progress" is in-memory only).       |
| **Abort and reset**         | Clearing `pendingTurnSince` (and `pendingUserMessageId`) in the same place we set `abortedLastRun` keeps "no open turn" consistent with "run was aborted."              |
| **Delivery debugging**      | If we later add "last reply sent at" or delivery confirmation, we can detect "pending was cleared but no delivery ack" and treat that as a delivery bug, not an orphan. |

---

## 10. Related issues: more states vs sync management

### Could we add more states?

A richer lifecycle could distinguish, for example:

- `pending` → `running` → `streaming` → `responded` | `failed` | `aborted`

That would allow:

- Finer UX: "Agent is thinking" vs "Agent is typing."
- Finer recovery: "we died while streaming" could trigger different handling than "we never started."

Trade-offs:

- **More sync points** – each transition must be written to the store; more risk of stuck or inconsistent state if a write fails or a path is missed.
- **Clear-on-restart semantics** – after restart we only know "there was an open turn"; we don’t know if it was running or streaming unless we persist that too. So "more states" help mainly for in-process UX and for post-mortem logs, not necessarily for restart recovery, unless we also persist the substate and define recovery per state.

**Recommendation:** Start with the minimal binary (pending vs not). Add substates only if we have a concrete use (e.g. streaming indicator in UI) and a clear transition and clear policy (who clears what and when).

### Sync and consistency

- **Set once, clear in all exit paths** – We must clear `pendingTurnSince` (and `pendingUserMessageId`) on **every** exit: success, early exit (e.g. empty payloads), failure, abort, and session reset. Missing one path leaves a stale "open turn" after restart.
- **Use a single clear helper** – Centralize "clear pending turn for this session" and call it from agent-runner (all success/failure/early-exit paths), abort.ts, and any reset flow. That reduces the risk of forgetting a path.
- **Optional: clear in finally** – If the run is wrapped in a try/finally, clearing in `finally` guarantees we clear even on unexpected throws, as long as we don’t rely on the run result to decide _whether_ to clear (we always clear when the run is done from our point of view).

### Other lifecycles (delivery, queue)

- **Delivery** – "We sent a reply; did the channel deliver it?" is a different lifecycle (delivery/ack). It could be a separate field (e.g. `lastReplySentAt` or channel-specific delivery state) and would help with "user never got the message" bugs (e.g. GitHub #20273, #18784). Turn lifecycle answers "did we finish the turn?"; delivery answers "did the user see it?"
- **Queue** – "Message queued but not yet running" is today in-memory only. Persisting "pending message enqueued at" would allow after-restart queue recovery (re-drain), but that would require persisting enough queue shape to rebuild it, which is a larger change. Our proposal does not persist queue state; we only persist "a run is in progress" when we actually start the run.

---

## 11. Prior PRs to reference (for the turn-lifecycle PR)

When writing the PR that adds `pendingTurnSince` / `pendingUserMessageId`, you can cite these as precedent for persisting more state to improve reliability. They show the project has repeatedly added or extended persisted state for restart/reliability; review feedback focused on schema consistency and correctness, not on avoiding "more persistence."

### Restart sentinel / deliveryContext (persist for routing after restart)

| PR                                        | Title                                                                          | What it did                                                                                                                                                                                      | Review / pushback                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **#12445** (closed, superseded by #12970) | fix: include deliveryContext in restart sentinel for config.patch/apply/update | Added `deliveryContext` and `threadId` to restart sentinel so post-restart wake can route to the correct channel.                                                                                | No pushback on persisting more state. Review asked for: (1) protocol schemas to allow new params (AJV would reject otherwise) — author added optional fields; (2) tool schema + sentinel kind — author clarified deliveryContext/threadId are server-resolved from session store, not LLM params; reviewer agreed. **Takeaway:** Add persisted state; keep protocol/schema and types in sync. |
| **#9139** (closed)                        | fix: ensure wake message delivery after gateway restart                        | Extract/preserve `deliveryContext` in config restart handlers, pass `accountId` through wake flow, skip SIGTERM sentinel overwrite when useful sentinel exists, support `:topic:` in sessionKey. | Only comment: remove accidental `.pyc` from PR. No objection to persistence.                                                                                                                                                                                                                                                                                                                  |
| **#18267** (merged)                       | fix(gateway): stop update.run restart leaking to wrong channel (#18239)        | `update.run` now includes `deliveryContext` and `threadId` in restart sentinel (same pattern as config handlers).                                                                                | Minimal; merged.                                                                                                                                                                                                                                                                                                                                                                              |
| **#11640** (merged)                       | fix(gateway): ensure restart ping routes through the correct accountId         | Session store `lastAccountId` fallback in wake path; gateway-tool captures fuller delivery context from session store.                                                                           | One review; merged.                                                                                                                                                                                                                                                                                                                                                                           |

### Session store: new fields or persist more

| PR                       | Title                                                                | What it did                                                                                                              | Review / pushback                                                                                     |
| ------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| **#14879** (open)        | fix: persist session metadata to sessions.json after context pruning | After context pruning, persist updated `contextTokens` to session store via `updateSessionStoreEntry` (fire-and-forget). | Greptile noted correctness in multi-agent setups (storePath resolution). No "don't persist" pushback. |
| **#17538** (open)        | feat(sessions): add resolvedModel field                              | Add `resolvedModel` to `SessionEntry`, thread through write path to sessions.json.                                       | Review noted stale-data edge case in fallback; no objection to new field.                             |
| **#6653** (open)         | fix: persist archived session entry on /new or /reset                | Archive previous session entry under a derived key when resetting, so UI shows history.                                  | Review noted archive-key collision edge case; no objection to persisting more.                        |
| **#9561** (in CHANGELOG) | Sessions/Store: canonicalize inbound mixed-case session keys         | Session store key normalization + migration; prevents duplicate sessions.                                                | Merged; session store evolution accepted.                                                             |
| **#5638** (open)         | fix: rewrite sessionFile paths during state dir migration            | During state-dir migration, rewrite `sessionFile` paths in session entries so they point at new location.                | Low risk; path rewriting in migration.                                                                |
| **#15882** (open)        | fix: move session entry computation inside store lock                | Race fix: compute session entry inside `updateSessionStore` mutator so writes merge against latest state.                | No new persistence; shows project cares about store consistency.                                      |

### Telegram update offset (persist for at-least-once / no skip)

| PR                       | Title                                                             | What it did                                                                                                 | Review / pushback                                |
| ------------------------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **#23284** (merged)      | fix(telegram): prevent update offset skipping queued updates      | Persist a safe watermark `min(highestCompleted, minPending - 1)` so restart doesn’t skip in-flight updates. | Merged; reliability fix via smarter persistence. |
| **#22363** (merged)      | fix(telegram): isolate update offset state by bot token           | Scope offset store by token fingerprint (v2 format); legacy v1 files ignored when token provided.           | Migration behavior (V1 rejected) noted; merged.  |
| CHANGELOG #10850, #11347 | Telegram/Polling: scope persisted polling offsets to bot identity | Persist offset per bot; single awaited runner-stop path.                                                    | Merged.                                          |

### Pushback summary

- **No** examples were found of reviewers arguing that "we shouldn’t add more persistence" or "this complexifies the persistence system too much."
- **Yes** examples of what _did_ get feedback: (1) **Schema/contract consistency** — e.g. protocol schemas and TypeBox must allow new fields so validation doesn’t reject them (#12445). (2) **Correctness** — e.g. storePath/agent scope (#14879), sentinel kind vs stats (#12445), archive key collisions (#6653). (3) **Clean PRs** — e.g. remove accidental artifacts (#9139).
- **What was persuasive:** Following the existing pattern (session store = metadata; optional new fields; update at the right lifecycle points), keeping protocol/schema in sync, and clarifying that new fields are server-side/resolved (not new LLM surface) where relevant.

For the turn-lifecycle PR, the same playbook applies: add optional `pendingTurnSince` (and optionally `pendingUserMessageId`) to `SessionEntry`; ensure any gateway/API that exposes session list knows about the new fields if needed; document set/clear semantics and that the field is server-managed. Referencing the PRs above in the PR description (e.g. "Same pattern as #18267 / #12445: persist minimal state so behavior survives restart") gives reviewers a clear precedent.

---

## 12. Implementation prompt (outcome-only, for Codex or other implementers)

A separate **implementation prompt** states the problem and acceptance criteria **without** prescribing persistence or schema. It is intended for use by Codex (or similar) so the implementer can derive a solution—e.g. session-store fields, a separate index, or another approach—from the required behavior.

- **Location:** [Orphan response recovery on restart](/experiments/plans/orphan-response-recovery-on-restart)
- **AC:** (1) Deliver responses for all pending user messages after restart; (2) discover pending responses without scanning every session’s transcript; (3) align with existing reply/session semantics.
- **Out of scope in the prompt:** How to represent or persist “pending response”; delivery confirmation; queue recovery.

This document (§1–§11) remains the design and research reference; the implementation prompt is solution-agnostic.
