# ADR: Unified Durable Message Lifecycle (Single-Node) with Plugin Outbound Compatibility

## Context

OpenClaw reliability behavior is currently split across subsystem-specific mechanisms:

- Inbound dedupe caches and channel-specific replay/catch-up logic.
- Outbound durable queue/retry/TTL behavior.
- Startup-specific orphan-reply recovery in recent work.
- Channel/plugin-specific direct send paths.

This fragmentation causes repeated edge-case fixes at boundaries rather than one durable model.

## Problem

OpenClaw currently implements reliability guarantees as a collection of subsystem-specific mechanisms (inbound dedupe caches, outbound delivery queue, channel-specific update offsets/watermarks, restart catch-up logic, idempotency keys in selected flows, and local retry/permanent-error classification rules). The test suite demonstrates that these guarantees are important and intentionally maintained in isolation, but issue/PR history shows repeated failures at subsystem boundaries, especially during restart/crash/reconnect windows.

Recurring user-visible failures are:

- accepted user messages that never receive a reply after restart/crash/network interruption,
- duplicate message processing or duplicate replies caused by retries/replays/reconnects,
- stale queued deliveries replayed long after relevance,
- inconsistent abort/supersession behavior where canceled work is later retried or delivered,
- channel-specific catch-up gaps that lose messages sent during downtime.

Root architectural gap: there is no single durable lifecycle model for a turn spanning:

1. inbound acceptance/idempotency,
2. run execution state (including retry/abort/supersession),
3. reply materialization,
4. outbound delivery and delivery confirmation.

Without a unified durable state machine, reliability semantics are repeatedly encoded as local rules (`dedupe`, `skipQueue`, retry classifiers, startup heuristics, pending markers, watermarks). This increases code volume, causes semantic drift, and makes restart correctness depend on special-case recovery code instead of structural guarantees.

## Non-goals

1. Multi-node distributed exactly-once guarantees.
2. Durable guarantees for non-final streaming/tool/thinking updates.
3. Transcript/session heuristic inference for pending work.
4. Breaking external plugin APIs in this rollout.

## Guarantees

1. Every accepted inbound turn is durably recorded and deduped.
2. Restart behavior is continuation of non-terminal work, not startup-only orphan replay.
3. Turn terminal states are explicit and final: `delivered | aborted | failed_terminal`.
4. Outbound retry/permanent/expiry classification is centralized.
5. Abort/supersession transitions suppress replay.
6. For providers without hard idempotency, duplicate risk is bounded best-effort (not strict exactly-once).

## Proposed Model

1. Durable `message_turns` state:

- `accepted | running | delivery_pending | failed_retryable | delivered | aborted | failed_terminal`.
- attempt counters, schedule timestamps, terminal reason, completion timestamps.

2. Durable `message_outbox` state:

- `queued | failed_retryable | delivered | failed_terminal | expired`.
- per-attempt metadata and terminal reason.

3. Workers:

- `turn-worker` continuously claims/resumes recoverable turns.
- `outbox-worker` continuously claims/sends/retries pending outbox rows.
- Startup starts workers only (no orphan replay loop).

4. Route target is persisted at turn acceptance and reused for resume/delivery.

## Backward-Compatible Plugin Outbound Adapter

1. Keep existing plugin outbound API valid (`sendText/sendMedia/sendPayload`).
2. Add optional v2 outbound contract (`sendFinal`, metadata + contract flags).
3. Host compatibility normalizer wraps v1/v2 adapters into one runtime send interface.
4. SDK helper (`createCompatOutboundAdapter`) reduces migration effort for plugin authors.
5. Runtime behavior:

- v2: full durable final-delivery semantics.
- v1: bounded best-effort duplicate suppression via compatibility wrapper.

6. Diagnostics:

- one-time runtime warning for v1 compatibility mode.
- contract mode exposed in channel account snapshots.

## Technical Integration Execution Plan

1. Add lifecycle storage and transitions (`message_turns`, `message_outbox`).
2. Integrate inbound acceptance/dedupe into lifecycle service.
3. Integrate outbox enqueue/send/finalize into lifecycle service.
4. Run continuous lifecycle workers in gateway runtime.
5. Add plugin outbound compat layer and SDK helper.
6. Migrate built-in channel outbound adapters to v2 declarations.
7. Remove startup-only split recovery path.

## Migration/Cleanup Plan

1. Deterministic importer for legacy file-queue artifacts into outbox.
2. No transcript-based inference for pending work.
3. Legacy non-importable artifacts become terminal diagnostics, not replay guesses.
4. Importer remains idempotent across restarts.
5. After stability window, remove legacy orphan/queue-specialized paths.
