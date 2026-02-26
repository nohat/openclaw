# Durable Message Lifecycle Reliability (ADR / Design + Execution Plan)

## Context

OpenClaw already treats reliability as important, but the behavior is spread across multiple subsystems with different persistence and recovery mechanisms:

- Outbound delivery durability/recovery in `src/infra/outbound/*` (enqueue/ack/fail/retry/startup recovery).
- Inbound dedupe/idempotency in channel-specific and feature-specific paths (Telegram, WhatsApp web, auto-reply, gateway).
- Multiple streaming/partial-reply mechanisms with different semantics (gateway/webchat agent-event deltas, channel block streaming, abort partial snapshots, outbound best-effort partial delivery failures).
- Channel-specific progress/watermark persistence (for example Telegram update offsets).
- Restart catch-up logic in services like cron and some channels.
- Durable dedupe and idempotency keys in selected flows (plugin SDK, gateway agent calls, subagent announce).
- Model execution behaviors coupled to runs but not represented in a shared durability model (auto-compaction, memory flush, post-compaction context refresh/audit, prompt-caching wrappers and provider-specific cache behavior).
- New orphan-reply recovery logic that persists pending reply markers and replays on gateway startup.

The existing test suite shows these behaviors are intentional and important. The issue/PR history shows recurring user-visible failures when work crosses subsystem boundaries (restart/crash/reconnect windows, retry classification drift, dedupe scope mismatches).

This document proposes a single-node durable message lifecycle model that unifies these reliability concerns into one persistent state machine backed by SQLite.

## Problem

OpenClaw currently implements reliability guarantees as a collection of subsystem-specific mechanisms (inbound dedupe caches, outbound delivery queue, channel-specific update offsets/watermarks, restart catch-up logic, idempotency keys in selected flows, and local retry/permanent-error classification rules). The test suite demonstrates that these guarantees are important and intentionally maintained in isolation, but issue/PR history shows repeated failures at subsystem boundaries, especially during restart/crash/reconnect windows.

The recurring user-visible failures are:

- accepted user messages that never receive a reply after restart/crash/network interruption,
- duplicate message processing or duplicate replies caused by retries/replays/reconnects,
- stale queued deliveries replayed long after they are relevant,
- inconsistent abort/supersession behavior where canceled work is later retried or delivered,
- channel-specific catch-up gaps that lose messages sent during downtime.

The root architectural gap is the absence of a single durable lifecycle model for a message turn spanning:

1. inbound acceptance/idempotency,
2. run execution state (including retry/abort/supersession),
3. reply materialization,
4. outbound delivery and delivery confirmation.

Because no unified durable state machine exists for this lifecycle, reliability semantics are encoded repeatedly as local rules (`dedupe`, `skipQueue`, retry classifications, restart catch-up heuristics, pending markers, watermarks). This increases code volume, causes drift in failure semantics across channels/features, and makes crash/restart recovery correctness depend on special-case code paths (such as orphan-reply recovery) rather than structural guarantees.

### What the system needs (structural framing)

A single-node durable reliability model (appropriate for OpenClaw’s typical deployment shape) that defines and enforces, by design:

- durable inbound acceptance with idempotency,
- explicit non-terminal/terminal run states (`running`, `delivery_pending`, `delivered`, `aborted`, `failed_retryable`, `failed_terminal`),
- retry and permanent-failure classification at the state-machine boundary,
- restart recovery by resuming/retrying non-terminal records,
- abort/supersession as terminal transitions that suppress replay,
- outbound delivery idempotency so restart recovery does not duplicate sends.

### Why the orphan-reply fix matters in this framing

The orphan-reply recovery implemented in the current branch is a correct and valuable patch for one concrete gap (user turn accepted, reply missing after restart). But the surrounding tests and issue history show it is one instance of a broader reliability class already being solved piecemeal in multiple places.

## Non-goals

- Multi-node distributed coordination, leader election, or cross-host exactly-once guarantees.
- Token-by-token exact replay or resume of streamed assistant deltas after restart/crash (v1 durability remains final-state focused).
- Replacing transcripts or `sessions.json` as user-facing/session UX artifacts in the first phase.
- Rewriting all channel adapters at once.
- Solving provider-side dedupe for channels/APIs that do not expose a usable idempotency primitive (we can only provide best-effort client-side dedupe around retries/recovery).
- Building a generic workflow engine for cron/jobs beyond message-turn lifecycle reliability.
- Replacing or redesigning existing model context management / prompt caching algorithms (auto-compaction, cache retention policy, provider-specific wrappers); the goal is compatibility + explicit lifecycle integration.
- Changing existing routing semantics (session key derivation, channel target normalization, thread/topic scoping) unless required for correctness.

## Guarantees

This proposal targets the following guarantees for a single gateway node:

- `Accepted turn durability`: once an inbound message is accepted into the durable store, its lifecycle is recoverable after restart until it reaches a terminal state.
- `No silent drop after acceptance`: each accepted turn eventually reaches one of: `delivered`, `aborted`, `failed_terminal` (with durable error reason), or remains retryable with scheduled retry metadata.
- `Restart replay safety`: startup recovery resumes/retries only non-terminal records; terminal `aborted`/`superseded` records are not replayed.
- `Durable inbound idempotency`: duplicate inbound events for the same channel message/update map to the same accepted record (or are ignored) across process restarts.
- `Centralized failure classification`: channel/provider send paths return normalized outcomes (`delivered`, `retryable`, `terminal`, `aborted`) and the state machine applies transitions consistently.
- `Bounded stale replay`: outbox items support expiry/TTL and terminal expiration classification to avoid replaying obsolete messages long after they are relevant.
- `Safe watermark advancement`: persisted source watermarks (for channels with offsets/cursors) advance only when the system can safely recover still-pending work.
- `Compatibility-preserving projection`: existing `sessions.json` + transcript writes remain available during migration, but become projections/derivatives rather than the source of truth for recovery.
- `Streaming compatibility`: existing streaming UX paths (gateway/webchat deltas, channel block streaming, abort partial snapshots) remain supported without requiring token-level durable replay in v1.
- `Structured outbound intent durability`: the lifecycle model can represent non-text outbound actions/payloads (media, polls, reactions, edits, stickers, replies, thread actions, channel/plugin action variants), not just text messages.
- `Model execution metadata continuity`: retries/recovery preserve or explicitly recompute run-relevant model execution metadata (selected model/provider, compaction state, cache policy) without breaking existing prompt-cache stability behaviors.

## Proposed model

### Overview

Introduce a local SQLite-backed reliability store that records the end-to-end lifecycle of a message turn:

1. `inbox` acceptance (dedupe/idempotency + source watermark context)
2. `reply_run` execution state (including abort/supersession, model execution metadata, and streaming mode compatibility)
3. `outbox` materialized outbound intents (messages and other action-typed side effects) pending delivery/execution
4. delivery attempts and final delivery result

`sessions.json` and transcript files remain in place initially, but are treated as projections for UX/history rather than the authoritative source for restart recovery.

### Core records

The exact schema can evolve, but the model should support these durable entities.

#### 1. `inbound_events` (durable inbox acceptance)

Purpose:

- Store normalized inbound acceptance records and channel dedupe keys.
- Persist enough metadata to resume processing and reason about replay.

Suggested fields (conceptual):

- `id` (internal primary key)
- `event_kind` (`message`, `edit`, `reaction`, `callback`, `poll_vote`, etc.; channel-specific mapping)
- `channel` (telegram/slack/discord/webchat/etc.)
- `account_id` / provider identity (optional by channel)
- `source_event_id` (channel-native update/message identifier)
- `source_dedupe_key` (canonical dedupe key, unique within scope)
- `session_key` (existing router/session semantics, unchanged)
- `peer_key` / thread/topic identifiers (normalized routing context)
- `received_at`
- `payload_ref` (optional raw payload path/JSON blob ref)
- `watermark_scope` + `watermark_value` (when applicable)
- `lifecycle_state` (`accepted`, `ignored_duplicate`, `superseded`) or link to current turn

Notes:

- Channel adapters remain responsible for canonicalizing dedupe scope, but storage and duplicate outcomes are centralized.
- For channels without stable event IDs, use deterministic hashes over normalized fields already used by local dedupe logic.

#### 2. `reply_runs` (durable run lifecycle)

Purpose:

- Represent execution of a user turn from accepted inbound through reply materialization.
- Provide restart-safe retry/abort/supersession semantics.

Suggested fields:

- `run_id` (stable durable identifier)
- `inbound_event_id`
- `session_key`
- `agent_id`
- `state` (`running`, `delivery_pending`, `delivered`, `aborted`, `failed_retryable`, `failed_terminal`)
- `attempt_count`
- `next_retry_at`
- `lease_owner` / `lease_expires_at` (startup stale-running cleanup + concurrency guard)
- `abort_reason` / `failure_class` / `last_error`
- `reply_artifact_ref` (materialized reply payload(s)/artifact(s) or reference; not limited to text)
- `stream_mode` (for compatibility with current non-stream / gateway-delta / block-stream behavior)
- `stream_summary_ref` (optional summary/projection of streamed output or abort partial snapshot; not token log)
- `selected_provider` / `selected_model` / `thinking_level` (actual model selection after fallback)
- `context_usage_snapshot` (for example post-run `lastCallUsage` / total tokens used)
- `compaction_state` (for example compaction started/completed metadata, counters, retry marker)
- `cache_policy_snapshot` (for example normalized `cacheRetention` / legacy `cacheControlTtl` mapping / provider cache mode)
- `delivery_group_id` (link to outbox rows if split into multiple sends)
- `created_at`, `updated_at`, `terminal_at`

Notes:

- `delivery_pending` means reply materialization succeeded, but one or more outbound deliveries still require confirmation.
- `failed_retryable` is non-terminal only if retry policy remains eligible; once retries/TTL exhausted, transition to `failed_terminal`.
- Streaming deltas/events can remain ephemeral projections; durable storage focuses on run state and any terminal/visible artifacts needed for recovery (for example abort partials or materialized blocks/finals).

#### 3. `outbox_messages` (durable outbound delivery / action execution)

Purpose:

- Replace file-queue-only semantics with a durable outbox integrated into the turn lifecycle.
- Preserve retry/backoff/TTL/permanent-failure handling in one place.

Suggested fields:

- `id`
- `run_id`
- `channel`
- `action_name` (for example `send`, `reply`, `poll`, `react`, `edit`, `sticker`, `thread-reply`, plugin action names)
- `target` (normalized channel target)
- `payload` or `payload_ref` (structured payload; text/media/components/channelData/action args)
- `payload_kind` / `content_kind` (text/media/mixed/poll/reaction/edit/etc. for classification/metrics)
- `reply_to_id` / `thread_id` / `account_id` (normalized execution context when applicable)
- `delivery_idempotency_key` (deterministic per outbound send intent)
- `state` (`pending`, `sending`, `retryable`, `delivered`, `expired`, `failed_terminal`, `canceled`)
- `attempt_count`
- `last_error`
- `last_attempt_at`
- `next_retry_at`
- `expires_at`
- `created_at`, `updated_at`

Notes:

- Existing outbound queue behavior maps naturally here, but state transitions become part of the same lifecycle system as reply runs.
- Despite the table name, this layer must support generic outbound actions and structured payloads already used by OpenClaw channels/plugins, not only `send(text)` replies.
- `canceled` is used when a run becomes `aborted`/`superseded` after materialization but before successful send.

#### 4. `delivery_attempts` (optional but recommended)

Purpose:

- Preserve observability/debugging without bloating hot rows.
- Support root-cause analysis for retry classification errors.

Suggested fields:

- `outbox_message_id`
- `attempt_number`
- `started_at`, `finished_at`
- `outcome` (`delivered`, `retryable`, `terminal`, `aborted`)
- `error_class`, `error_message`
- `provider_response_ref` (optional)

#### 5. `run_execution_events` (optional but recommended)

Purpose:

- Record significant run-internal lifecycle events that matter for debugging and compatibility (for example compaction/fallback phases), without storing every streamed delta token.
- Preserve observability for behaviors currently visible on the agent event bus while keeping durability scope focused.

Suggested fields:

- `reply_run_id`
- `seq`
- `event_stream` (`lifecycle`, `compaction`, `tool`, `assistant`, etc.)
- `event_phase` (optional normalized phase, for example `start`, `end`, `error`)
- `event_class` (`recovery_relevant`, `diagnostic`, `stream_projection`)
- `data_ref` / `data_json` (redacted/size-bounded)
- `created_at`

#### 6. `source_watermarks` (channel progress)

Purpose:

- Persist channel offsets/cursors/checkpoints in the same DB and recovery model.
- Decouple watermark safety from ad hoc local files/caches.

Suggested fields:

- `source` (e.g. `telegram:<botTokenHash>`)
- `scope` (chat/global/topic/etc. if needed)
- `watermark_value`
- `updated_at`
- `advance_policy_version`

Notes:

- Channel-specific logic still decides what a safe watermark means, but the persistence and replay contract is standardized.

### State machine (reply-run centric)

Primary reply-run transitions:

- `accepted -> running`
- `running -> delivery_pending` (reply materialized and outbox created)
- `delivery_pending -> delivered` (all required outbox rows delivered)
- `running -> failed_retryable` (execution failure that should retry)
- `delivery_pending -> failed_retryable` (delivery failure that should retry)
- `failed_retryable -> running` (retry execution) or `failed_retryable -> delivery_pending` (retry delivery only)
- `running|delivery_pending|failed_retryable -> aborted` (user/system cancellation or supersession)
- `running|delivery_pending|failed_retryable -> failed_terminal` (permanent error, retry exhausted, or expired)

Central rule:

- Transition classification is applied by the reliability boundary, not hidden inside channel/feature code. Feature/channel code returns typed outcomes; the state machine persists the decision.

### Inbound acceptance flow

1. Channel adapter receives raw event/update.
2. Adapter derives canonical `source_dedupe_key`, routing context (`session_key`, peer/thread/topic info), and optional watermark context.
3. Within a DB transaction:
   - insert `inbound_events` row if not already present,
   - if duplicate, record duplicate outcome and return existing lifecycle decision,
   - create `reply_runs` row in `running` (or `accepted` then schedule runner),
   - persist any watermark gating metadata needed for later safe advancement.
4. Worker/runner picks up the run and executes reply logic.

This replaces volatile in-memory dedupe caches and ad hoc pending markers as the source of restart recovery truth.

### Reply execution and materialization

Execution writes durable progress at state boundaries, not every token:

- On start: set `running` + lease metadata.
- On successful reply generation: persist `reply_artifact_ref`, create `outbox_messages`, transition to `delivery_pending`.
- On abort/supersession: transition to `aborted` and cancel any pending outbox rows.
- On execution failure: classify as retryable or terminal and persist the result.

Streaming responses remain best-effort UX behavior. The durability guarantee concerns final reply completion/delivery state, not token-level streaming continuity.

### Streaming and partial reply semantics (current compatibility + v1 behavior)

OpenClaw currently has multiple partial/streaming mechanisms with different semantics. The lifecycle model should preserve those distinctions rather than collapsing them into a single "partial" concept:

- `Gateway/webchat agent-event deltas`:
  - assistant text deltas are broadcast live and buffered in memory for UI finalization/abort behavior;
  - they are not currently persisted as token-by-token durable state;
  - aborts can persist a partial assistant snapshot as a terminal transcript artifact.
- `Channel block streaming`:
  - block payloads are coalesced/deduped and delivered incrementally;
  - block-stream timeout aborts the block pipeline and falls back to final payload delivery;
  - pipeline progress is currently in-memory and not restart-resumable at chunk granularity.
- `Outbound bestEffort partial delivery failure`:
  - this is a delivery classification (some payloads failed), not a streamed text partial;
  - it must remain a first-class state-machine outcome for retry/fail decisions.

v1 lifecycle policy:

- Do not attempt token/chunk replay continuation after restart.
- Treat streaming deltas as ephemeral projections from `reply_runs`.
- Persist only what is needed for correctness and user-visible recovery:
  - terminal run state,
  - materialized outbound intents,
  - abort/supersession terminal artifacts when surfaced to users,
  - bounded execution events/metadata (optional `run_execution_events`).

This preserves current UX semantics while moving recovery correctness to durable run/outbox state.

### Outbound intent typing (not text-only)

The durability model must represent the broader outbound action surface already used by OpenClaw channels/plugins, including (non-exhaustive):

- text/media sends (including reply/thread metadata and channel-specific components),
- polls,
- reactions and reaction removals,
- edits/unsend/delete,
- stickers and attachments,
- thread/channel actions and plugin-defined message actions.

Implication:

- `outbox_messages` stores action-typed intents + structured args/payload references, not only a rendered text reply body.
- Reply materialization may create a mixed set of intents (for example text + media + poll, or message + reaction/status side effects), each with its own idempotency and retry classification.

### Model context management and prompt caching compatibility

The message lifecycle proposal must integrate with existing model execution behavior without changing current compaction/caching policy semantics:

- `Auto-compaction` and `memory flush`:
  - compaction phases are part of run execution and may affect retry behavior, user-visible notices, and session token accounting;
  - durability should record enough run metadata to avoid ambiguous restart handling (for example rerunning after compaction-related failures) while preserving current compaction flows.
- `Post-compaction context refresh/audit`:
  - these remain run-adjacent behaviors and should be treated as best-effort side effects unless explicitly promoted to durable obligations.
- `Prompt caching`:
  - preserve provider-specific cache behavior (`cacheRetention`, legacy `cacheControlTtl`, OpenRouter Anthropic `cache_control` injection, Bedrock cache disable rules for non-Anthropic models, provider-specific beta/header wrappers);
  - avoid introducing volatile data into stable prompt prefixes (for example trusted inbound metadata blocks) that would degrade cache reuse.
- `Model selection/fallback metadata`:
  - retries/recovery should preserve a durable record of selected provider/model/thinking level and fallback/compaction phases for diagnostics and consistent transition semantics.

The reliability layer should be cache-policy-aware enough to preserve behavior and diagnostics, but it should not become the new prompt-construction or cache-tuning engine.

### Outbound delivery boundary

Channel senders/providers should return a normalized outcome type:

- `delivered`
- `retryable_failure`
- `terminal_failure`
- `aborted` (intentional cancellation/no-send)

The reliability layer:

- increments attempts/backoff/TTL,
- transitions outbox state,
- derives `reply_runs.state`,
- ensures ack/fail semantics are consistent (for example, abort-before-send should not look like delivery success).

This centralizes semantics currently split across `ackDelivery`, `failDelivery`, local retry loops, and feature-specific abort handling.

### Startup recovery

On gateway startup:

1. Clear stale leases for `running` / `sending` rows older than lease timeout.
2. Enumerate non-terminal `reply_runs` and `outbox_messages`.
3. Requeue eligible retryable work with backoff/TTL checks.
4. Resume `delivery_pending` runs by retrying unsent/unconfirmed outbox rows.
5. Respect terminal `aborted`/`failed_terminal` states (no replay).
6. Apply channel catch-up using persisted `source_watermarks`.

This makes orphan-reply recovery a normal consequence of the lifecycle store, not a special-case path that infers pending work from `sessions.json` + transcripts.

## Technical Integration Execution plan

### Phase 0: Design + contract extraction (no behavior change)

Goals:

- Define shared reliability interfaces and outcome taxonomy.
- Extract a minimal boundary that existing code can call before the full migration.

Work:

- Introduce typed delivery outcome classification interface (retryable/terminal/aborted/delivered), explicitly distinguishing:
  - streamed UX partials,
  - abort partial snapshots,
  - best-effort partial delivery failures.
- Define canonical lifecycle state enums and transition helpers in a new module (no DB writes yet).
- Document mapping from current outbound queue semantics, orphan-reply pending markers, gateway/webchat streaming deltas, and channel block streaming behavior to the new states.
- Define a typed outbound-intent schema (action name + structured args/payload refs) covering existing non-text actions used by core/plugin channels.
- Define `reply_runs` execution metadata shape for model selection/fallback/compaction/cache policy snapshots.
- Add tests for transition classification independent of channel implementations.

Exit criteria:

- Existing outbound and auto-reply code can target the shared outcome types without behavior changes.

### Phase 1: SQLite reliability store (shadow mode / dual-write)

Goals:

- Add a local SQLite store and write durable records alongside current behavior.
- Prove schema/locking/recovery primitives without flipping runtime authority.

Work:

- Implement SQLite schema + migration bootstrap for reliability tables.
- Add transactional APIs for:
  - accept inbound event,
  - create/update reply run state,
  - create/update outbox messages,
  - append bounded run execution events/metadata (optional table),
  - persist source watermarks.
- Dual-write from:
  - inbound auto-reply dispatch acceptance path,
  - outbound queue enqueue/ack/fail path,
  - orphan-reply pending marker path,
  - gateway/webchat abort partial persistence metadata (at least as run terminal metadata),
  - model execution metadata snapshots (selected model/provider, compaction/cache policy summary).
- Add diagnostics command/logging hooks to inspect stuck/non-terminal rows.

Exit criteria:

- Dual-write enabled behind a flag with parity tests passing.
- No change in user-visible routing/send behavior.

### Phase 2: Reply-run authority for orphan recovery (replace pending-marker inference)

Goals:

- Make reply-run records the source of truth for restart replay of accepted-but-undelivered turns.

Work:

- On startup, load non-terminal `reply_runs` from SQLite instead of inferring from `sessions.json`/transcript + pending markers.
- Keep writing existing pending markers during rollout for rollback safety (dual-read/dual-write initially).
- Update abort paths to mark runs terminal (`aborted`) and cancel pending outbox entries in the store.
- Preserve current webchat/gateway abort partial behavior by treating persisted abort partial snapshots as terminal artifacts/projections (not replayable non-terminal work).
- Add tests for:
  - replay success,
  - replay failure retains retryable state,
  - abort suppresses replay,
  - multiple in-flight runs in the same session remain isolated,
  - no attempt to replay token-level deltas / block-stream progress after restart.

Exit criteria:

- Orphan-reply recovery tests pass using SQLite state as authority.
- Pending-marker inference is no longer required for the primary path.

### Phase 3: Outbound queue migration to durable outbox

Goals:

- Fold outbound queue durability/retry semantics into the same lifecycle store.

Work:

- Implement `outbox_messages` worker with lease/backoff/TTL/permanent-failure handling.
- Adapt existing `src/infra/outbound/*` send execution to operate on DB rows (or bridge file queue -> DB during transition).
- Support action-typed outbox rows beyond text sends (for example poll/reaction/edit/sticker/thread-reply/plugin message actions) using structured payload/args storage.
- Centralize ack/fail/abort classification at the reliability boundary.
- Preserve current protections (startup recovery time budget, `skipQueue` recursion avoidance semantics) while simplifying them under the new model.
- Preserve current "partial delivery failure" semantics for best-effort sends as a delivery-classification outcome, not a successful ack.
- Add parity tests mirroring current outbound queue behaviors (enqueue/ack, retry count, permanent fail, startup recovery, time budget).

Exit criteria:

- Durable outbox can run in production behind a flag for at least one channel without regressions.
- File-based outbound queue becomes optional compatibility mode.

### Phase 4: Inbound dedupe + watermark integration (channel-by-channel)

Goals:

- Move channel dedupe and checkpoint persistence into the reliability store incrementally.

Work:

- Start with channels that already have strong dedupe/offset semantics (Telegram, web/WhatsApp inbound).
- Implement adapter-level mapping for channel-specific IDs -> canonical `source_dedupe_key`.
- Move persistent watermark storage (for example Telegram offsets) into `source_watermarks`.
- Preserve channel-specific safe-advance rules while reusing shared persistence and recovery logic.
- Preserve current streaming behavior contracts per surface (for example gateway/webchat deltas, block-stream fallback-to-final behavior) while switching reliability authority underneath.
- Add restart catch-up tests that validate watermark advancement does not skip pending work.

Exit criteria:

- At least one channel’s dedupe + watermark path uses SQLite as the primary store.
- Existing channel behavior remains compatible at the router/session layer.

### Phase 5: Compatibility hardening and broader rollout

Goals:

- Expand to additional channels and webchat semantics while minimizing surface regressions.

Work:

- Integrate channel router entry points without changing session key derivation rules.
- Ensure webchat remains compatible with current chat transcript/session behavior (same ordering expectations, same visible history shape).
- Ensure structured outbound intents map cleanly to existing channel/plugin action surfaces and capability gating.
- Ensure model context-management side effects remain compatible:
  - auto-compaction notices/events,
  - memory flush metadata,
  - post-compaction context refresh/audit,
  - session token/accounting updates.
- Ensure prompt-caching behavior remains compatible across providers/wrappers (cache retention, legacy mapping, OpenRouter Anthropic cache-control injection, Bedrock no-cache rules, context1m/beta header wrappers, Responses `store` behavior).
- Add feature flags / per-channel rollout toggles.
- Add observability:
  - counters by state transition,
  - retry vs terminal classification counts,
  - recovery replay counts,
  - stale/expired outbox counts.
  - streaming fallback counts (block-stream timeout -> final),
  - compaction/fallback phase counts (if `run_execution_events` enabled),
  - cache-policy compatibility warnings/mismatch counts (optional).

Exit criteria:

- Reliability store is primary for selected channels in default configuration.
- Regression dashboards/logging support production triage.

### Phase 6: Cleanup and deprecation

Goals:

- Remove duplicated reliability logic once the new path is stable.

Work:

- Delete legacy pending-marker-only orphan recovery inference paths.
- Decommission file-queue outbound path (or leave as explicit fallback mode if needed).
- Remove redundant channel-local dedupe persistence where replaced by the shared store.
- Simplify restart catch-up code to depend on lifecycle + watermark stores.
- Update docs/tests to reflect the unified model as the canonical reliability boundary.

Exit criteria:

- No user-critical path depends on transcript/session inference for delivery recovery.
- Reliability semantics are expressed primarily through shared lifecycle transitions and SQLite records.

## Migration/cleanup plan

### Migration strategy

Use a staged migration with dual-write, then dual-read, then cutover:

1. `Dual-write`:
   - Continue existing mechanisms (`sessions.json` pending markers, outbound file queue, channel-local dedupe/watermark files/caches).
   - Also write lifecycle events to SQLite.
2. `Shadow-verify`:
   - Compare SQLite-derived outcomes with existing runtime behavior in tests and optional debug logs/telemetry.
   - Flag mismatches (for example duplicate acceptance, retry classification divergence).
3. `Primary-read cutover`:
   - Switch startup recovery and selected delivery workers to read SQLite first.
   - Keep legacy writes for rollback.
4. `Rollback window`:
   - Feature flag to revert to legacy authority if unexpected regressions appear.
5. `Legacy removal`:
   - Remove legacy persistence and inference paths only after channel-by-channel cutover is stable.

### Data migration notes

- No mandatory backfill of historical transcripts is required for correctness.
- Existing `sessions.json` and transcript data remain as UX/history artifacts.
- New reliability state begins tracking accepted turns from rollout forward.
- No mandatory backfill of historical stream deltas or compaction/prompt-cache traces is required.
- If desired, only import bounded terminal artifacts/metadata (for example pending reply markers, abort partial markers, active queue entries), not token-level streaming history.
- For channels with existing persisted offsets/dedupe files, import current checkpoint values into `source_watermarks` during first cutover when feasible; otherwise begin from current runtime watermark and keep legacy reader until confidence is established.

### Compatibility strategy (channel routers + webchat)

Preserve current behavior at integration boundaries:

- Keep existing router/session key derivation and channel target normalization unchanged.
- Keep transcript append/session mirroring behavior for user-visible history.
- Treat SQLite lifecycle records as authoritative for recovery, retries, and duplicate suppression, not for UI rendering shape.
- Preserve current streaming mechanisms as projections:
  - gateway/webchat assistant deltas + in-memory buffering,
  - abort partial snapshots on stop,
  - channel block streaming coalescing/timeout/fallback semantics.
- Preserve support for structured outbound intents and non-text payloads (media, polls, reactions, edits, stickers, thread actions, channel/plugin action variants, `channelData` payloads/components).
- Preserve model context-management and cache-related behavior:
  - auto-compaction / memory flush / post-compaction context refresh & audit,
  - session token/accounting updates tied to compaction and last-call usage,
  - prompt-cache-stability constraints in prompt construction,
  - provider-specific prompt cache wrappers and cache policy mapping.
- Preserve webchat semantics for:
  - visible message order,
  - idempotent send retries,
  - reconnect behavior,
  - transcript continuity.

Migration principle:

- Reliability authority moves first; routing and UI semantics remain stable unless a specific bug fix requires a targeted change.

### Cleanup checklist (post-cutover)

- Remove transcript/session inference paths used only for orphan recovery.
- Remove redundant pending marker keys and cleanup logic.
- Remove duplicate retry classification code in channel/outbound call sites.
- Consolidate dedupe storage implementations where the SQLite lifecycle store replaces them.
- Retire obsolete docs that describe file-queue-only delivery recovery as the canonical model.

## References (evidence and related work)

Issue/PR history and test references are the motivating evidence for this ADR. The problem statement above is based on the consolidated source-test evidence plus the following issues/PRs:

### Issues

- [#22376](https://github.com/openclaw/openclaw/issues/22376)
- [#9208](https://github.com/openclaw/openclaw/issues/9208)
- [#15772](https://github.com/openclaw/openclaw/issues/15772)
- [#14827](https://github.com/openclaw/openclaw/issues/14827)
- [#23777](https://github.com/openclaw/openclaw/issues/23777)
- [#16555](https://github.com/openclaw/openclaw/issues/16555)
- [#22780](https://github.com/openclaw/openclaw/issues/22780)
- [#19426](https://github.com/openclaw/openclaw/issues/19426)
- [#26764](https://github.com/openclaw/openclaw/issues/26764)
- [#14431](https://github.com/openclaw/openclaw/issues/14431)
- [#19226](https://github.com/openclaw/openclaw/issues/19226)
- [#19373](https://github.com/openclaw/openclaw/issues/19373)
- [#26783](https://github.com/openclaw/openclaw/issues/26783)

### Pull requests

- [#15636](https://github.com/openclaw/openclaw/pull/15636)
- [#19284](https://github.com/openclaw/openclaw/pull/19284)
- [#20729](https://github.com/openclaw/openclaw/pull/20729)
- [#23922](https://github.com/openclaw/openclaw/pull/23922)
- [#17150](https://github.com/openclaw/openclaw/pull/17150)
- [#14868](https://github.com/openclaw/openclaw/pull/14868)
- [#22031](https://github.com/openclaw/openclaw/pull/22031)

This document intentionally frames those as one reliability class to reduce future drift and repeated one-off patches.
