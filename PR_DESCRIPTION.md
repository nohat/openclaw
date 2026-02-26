# fix(gateway): recover pending replies on startup (post-restart orphan replay)

## Summary

- **Problem:** After a gateway restart, user turns that were already accepted for reply (dispatch started) but not yet completed are lost: the agent never sends a reply, and the user sees no response. Session transcript has the user message; the in-memory reply state is gone.
- **Why it matters:** Restarts (deploys, crashes, config reloads) leave in-flight conversations in a broken state. Users have to re-send or assume the bot failed silently.
- **What changed:** (1) When shared dispatch accepts an inbound turn, we write a `pendingReplies` marker to the session store (keyed by message id or synthetic id). (2) When the reply is finalized (or aborted / subagent killed), we clear that marker. (3) On gateway startup, we load all sessions with pending markers, match them to the transcript’s trailing user turns (by message-id hint or order), and re-dispatch each; for webchat we append the assistant message to the transcript and broadcast to the UI. Unmatched markers are treated as stale and cleared.
- **What did NOT change:** No change to normal request path except writing/clearing the marker. No new config. Recovery runs once at startup (fire-and-forget) and does not block server readiness.

## Change Type (select all)

- [x] Bug fix
- [ ] Feature
- [ ] Refactor
- [ ] Docs
- [ ] Security hardening
- [ ] Chore/infra

## Scope (select all touched areas)

- [x] Gateway / orchestration
- [ ] Skills / tool execution
- [ ] Auth / tokens
- [ ] Memory / storage
- [x] Integrations
- [ ] API / contracts
- [ ] UI / DX
- [ ] CI/CD / infra

## Linked Issue/PR

- (None — can open an issue and link if maintainers prefer.)

## User-visible / Behavior Changes

- **After restart:** Pending replies (user sent a message, gateway restarted before reply was sent) are now replayed automatically: the agent runs again for that turn and the reply is delivered (or appended to webchat transcript and broadcast). Stale markers (no matching transcript turn) are cleared and logged.
- **Session store:** New optional `pendingReplies` on `SessionEntry`; existing sessions without it are unchanged.

## Security Impact (required)

- New permissions/capabilities? **No**
- Secrets/tokens handling changed? **No**
- New/changed network calls? **No** (recovery uses existing `routeReply` / reply path)
- Command/tool execution surface changed? **No**
- Data access scope changed? **No** (session store and transcript paths already used by gateway)
- If any Yes, explain risk + mitigation: N/A

## Repro + Verification

### Environment

- OS: macOS (developed); behavior is runtime-agnostic
- Runtime/container: Node 22+
- Model/provider: Any
- Integration/channel: Any (telegram, webchat, etc.)
- Relevant config: Default session store; no new config

### Steps

1. Start gateway, open a session (e.g. webchat or Telegram).
2. Send a user message so the agent starts replying.
3. Restart the gateway (or kill and start again) before the reply is finalized.
4. After startup, check logs and session UI.

### Expected

- Logs show “Pending reply recovery complete: 1 recovered, 0 failed” (or similar).
- The reply is delivered to the channel (e.g. Telegram) or appears in webchat transcript and in the UI.

### Actual (before fix)

- No recovery; user message remains without a reply unless the user sends again.

## Evidence

- [x] Failing test/log before + passing after: New unit tests in `server-startup-orphan-replies.test.ts` (replay for telegram, delivery failure keeps marker). New tests in `dispatch.test.ts` for pending-reply mark/clear; `abort.test.ts` for clear on abort.
- [x] Trace/log snippets: Recovery logs “Found N pending replies across M sessions” and “Pending reply recovery complete: recovered, failed, clearedStale”.
- [x] Manual E2E (Telegram, prod state): Using `scripts/test-orphan-recovery-e2e.sh` against `~/.openclaw`, sent a Telegram DM (“this is another test message, please reply with \"this is a response to your test message\"”), killed `openclaw-gateway` mid-flight, observed on restart:
  - `Found 1 pending reply across 1 session` and `Recovered pending reply for agent:main:main (msg:1776) via telegram` in `gateway.log`, followed by `Pending reply recovery complete: 1 recovered, 0 failed, 0 stale markers cleared`.
  - Transcript for `agent:main:main` includes the user turn and a recovered assistant `text` reply `this is a response to your test message`, which was delivered to Telegram (user-confirmed in UX).
  - Artifacts (script + redacted logs + transcript snippet): https://gist.github.com/nohat/8886c7135a034189ca8ae4a2b9283386

## Human Verification (required)

- **Verified scenarios:** (1) Unit tests for recovery (telegram replay, routeReply failure keeps marker, webchat not exercised in test but path mirrors chat delivery). (2) Dispatch marks on accept and clears on finalize/abort/kill; tests added. (3) `pnpm build && pnpm check` and relevant unit tests (dispatch, abort, server-startup-orphan-replies) pass.
- **Edge cases checked:** Stale markers (no matching transcript turn) cleared; delivery failure leaves marker so retry on next startup; matching by message-id hint then by order; recovered turn that produced only an internal `thinking` block (no text) resulted in no visible channel reply, which is tracked as a separate behavior bug (not a failure of the replay machinery).
- **What you did not verify:** Behavior under load with many concurrent pending sessions and non-Telegram channels (Slack, webchat, etc.); multi-channel E2E across restarts.

## Compatibility / Migration

- Backward compatible? **Yes**
- Config/env changes? **No**
- Migration needed? **No**
- If yes, exact upgrade steps: N/A

## Failure Recovery (if this breaks)

- **How to disable/revert:** Revert the commit; pending markers in session store are optional and ignored by older code (no migration). New code only reads/writes `pendingReplies`; if reverted, existing markers are harmless.
- **Files/config to restore:** This commit only; no config.
- **Known bad symptoms reviewers should watch for:** Recovery running too late or blocking startup (it’s fire-and-forget); duplicate replies if matching logic ever pairs one pending item to the wrong turn (we use message-id hints and then order to reduce that).

## Risks and Mitigations

- **Risk:** Matching pending item to wrong transcript turn could send a reply to the wrong conversation or duplicate.
  - **Mitigation:** Match by `messageId` / `messageIdFull` when present in transcript (`[message_id: ...]` in content); otherwise match by chronological order of pending items to trailing user turns. Stale markers (no matching turn) are cleared, not replayed.
- **Risk:** Recovery runs async at startup; high volume of pending sessions could delay other work.
  - **Mitigation:** Recovery is one-shot, sequential per session; no new ongoing background work. If needed, we could add a cap or backoff in a follow-up.

---

**AI-assisted:** This PR was prepared with AI assistance (Cursor/Claude). I (David Friedland, @nohat) reviewed the code and ran build, check, and unit tests locally.
