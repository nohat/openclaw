---
summary: "Implementation prompt: ensure all pending user messages receive a response after gateway restart, without scanning every session"
read_when:
  - Implementing restart-safe handling of in-flight or queued user turns
  - Defining acceptance criteria for orphan message recovery
owner: "openclaw"
status: "draft"
last_updated: "2026-02-25"
title: "Orphan response recovery on restart"
---

# Orphan response recovery on restart

Implementation prompt for ensuring that every user message that was awaiting a reply before a restart receives a response after the gateway restarts. The solution approach is left to the implementer.

## Problem

When the gateway process restarts (or crashes) while the agent is processing a user message—or was about to—that message can be left without a reply. In-memory state (active run handle, queue state) is lost on restart, so after startup there is no built-in way to know which sessions had a user turn that never got a response. The user sees silence with no retry or recovery unless something else triggers a run for that session. This affects **all channels** that deliver user messages to the agent (Telegram, Discord, web chat, iMessage, Signal, Slack, etc.), not only one surface.

## Goal

After any gateway restart, the system must ensure that **every user message that was pending a response** (i.e. the user had sent a message and no reply had been delivered yet) receives a response. Recovery must run at **gateway startup** so the user gets replies without having to send another message or otherwise touch the session.

## Acceptance criteria

1. **Delivery guarantee**  
   At gateway startup, the system delivers a response for every user message that was still awaiting a reply at the time of the previous process exit. Recovery is part of startup; it must not be deferred to "first access" or the next user message.

2. **No full-session scan**  
   Identifying which sessions need recovery must **not** require opening or scanning every session’s transcript (or equivalent full history) to detect “user message with no assistant reply.” The implementation must provide a way to discover pending responses that is efficient with respect to the number of sessions (e.g. O(pending) or O(sessions with pending work), not O(all sessions) with full transcript inspection per session).

3. **Consistency**  
   Recovery behavior must align with existing reply and session semantics (e.g. delivery context, channel routing, abort/reset behavior). No new user-facing contract is required beyond “pending responses get replies after restart.”

4. **All channels**  
   Recovery must apply to **every channel** (and other entry points) that can create a pending user message: Telegram, Discord, web chat (e.g. `chat.send`), iMessage, Signal, Slack, and any other path that results in a run for that session. A solution that only handles one entry point (e.g. web chat only) does **not** satisfy this criterion.

5. **Test that validates current behavior is broken**  
   The implementation must include a test that asserts the desired post-fix behavior (after restart, pending user messages receive a response). That test must **fail** on the current codebase (i.e. without the fix), demonstrating the bug, and **pass** once the solution is in place. The test must cover at least one channel other than web chat (e.g. Telegram) or otherwise demonstrate that recovery is channel-agnostic.

## Out of scope (for this prompt)

- How to represent or persist “pending response” (e.g. session metadata, separate index, restart sentinel, or other) is **not** specified; the implementer chooses.
- Delivery confirmation (did the channel deliver the reply to the user) is out of scope.
- Persisting or recovering in-memory queue state (e.g. multiple enqueued messages) is out of scope unless needed to satisfy the AC above.

## Reference

Background on the problem and existing code touchpoints (for implementer context only; not a required design): `docs/research/turn-lifecycle-affordances.md`.
