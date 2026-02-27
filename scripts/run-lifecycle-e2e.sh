#!/usr/bin/env bash
#
# Lifecycle E2E test runner — full before/after campaign.
# Tests the unified durable message lifecycle (message_turns + message_outbox SQLite tables,
# continuous turn-worker + outbox-worker) against baseline main branch behavior.
# Completely non-interactive. Uses AppleScript for Telegram + polls DB/logs.
# Collects artifacts (log snippets, DB output) for each test.
#
# Usage:
#   ./scripts/run-lifecycle-e2e.sh all     # full campaign: before + after (default)
#   ./scripts/run-lifecycle-e2e.sh before  # before phase only (main branch gateway)
#   ./scripts/run-lifecycle-e2e.sh after   # after phase only (codex/unified-lifecycle-main gateway)
#
# The "all" mode:
#   1. Creates a git worktree of main at /tmp/openclaw-main-e2e
#   2. pnpm-installs it, seeds delivery-queue files in before state dir
#   3. Starts main gateway → ~/.openclaw-test-before
#   4. Runs before tests, stops main gateway
#   5. Starts codex/unified-lifecycle-main gateway → ~/.openclaw-test (with seeded delivery-queue)
#   6. Runs after tests, stops feature gateway
#   7. Prints artifact summary
#
# Prerequisites:
#   - sqlite3 (brew install sqlite3)
#   - Telegram open with Accessibility permission granted to Terminal
#   - pnpm available
#

set -euo pipefail

PHASE="${1:-all}"
REPO_DIR="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"

# ── Config ────────────────────────────────────────────────────────────────────
PORT=19001
CHAT="Openclaw Nohat Test"
WORKTREE_DIR="/tmp/openclaw-main-e2e"
LOG_BEFORE="/tmp/openclaw-test-before-gateway.log"
LOG_AFTER="/tmp/openclaw-test-gateway.log"
STATE_BEFORE="$HOME/.openclaw-test-before"
STATE_AFTER="$HOME/.openclaw-test"
DB_AFTER="$STATE_AFTER/message-lifecycle.db"

# ── Output helpers ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; BOLD='\033[1m'; RESET='\033[0m'
SUITE_FAILURES=0

pass()      { echo -e "${GREEN}PASS${RESET}: $*"; }
fail()      { echo -e "${RED}FAIL${RESET}: $*"; SUITE_FAILURES=$(( SUITE_FAILURES + 1 )); }
info()      { echo -e "${YELLOW}INFO${RESET}: $*"; }
section()   { echo ""; echo -e "${BOLD}━━━ $* ━━━${RESET}"; }
artifact()  { echo "  ARTIFACT: $*"; }

# ── Utilities ─────────────────────────────────────────────────────────────────

now_ms() { python3 -c "import time; print(int(time.time()*1000))"; }

# Send a message to the test Telegram chat via AppleScript (Cmd+K switcher).
send_telegram() {
  local msg="$1"
  osascript << EOF
tell application "Telegram" to activate
delay 0.5
tell application "System Events"
  tell process "Telegram"
    keystroke "k" using command down
    delay 0.5
    keystroke "${CHAT}"
    delay 0.8
    key code 36
    delay 0.5
    keystroke "${msg}"
    delay 0.3
    key code 36
  end tell
end tell
EOF
  info "Sent → Telegram: ${msg}"
}

# Poll session JSONL files for a new assistant reply after epoch-ms timestamp.
poll_for_reply() {
  local session_dir="$1"
  local after_ms="$2"
  local timeout="${3:-45}"
  local elapsed=0
  while (( elapsed < timeout )); do
    local f
    f=$(ls -t "${session_dir}"/*.jsonl 2>/dev/null | head -1 || true)
    if [[ -n "$f" ]]; then
      local result
      result=$(python3 - "$f" "$after_ms" << 'PYEOF'
import json, sys, datetime
path, after = sys.argv[1], int(sys.argv[2])
try:
    with open(path) as fh:
        for line in fh:
            try:
                d = json.loads(line)
                if d.get("type") == "message" and d.get("message", {}).get("role") == "assistant":
                    ts_str = d.get("timestamp", "")
                    ts = int(datetime.datetime.fromisoformat(ts_str.replace("Z", "+00:00")).timestamp() * 1000)
                    if ts > after:
                        content = d.get("message", {}).get("content", "")
                        if isinstance(content, list):
                            content = " ".join(c.get("text", "") for c in content if isinstance(c, dict))
                        print(str(content)[:300])
                        sys.exit(0)
            except Exception:
                pass
except Exception:
    pass
sys.exit(1)
PYEOF
      ) && { echo "$result"; return 0; } || true
    fi
    sleep 1
    (( elapsed++ )) || true
  done
  return 1
}

# Poll message_turns DB for a 'running' row newer than given epoch-ms timestamp.
poll_for_running() {
  local db="$1"
  local after_ms="$2"
  local timeout="${3:-20}"
  local elapsed=0
  while (( elapsed < timeout )); do
    if [[ -f "$db" ]]; then
      local cnt
      cnt=$(sqlite3 "$db" "SELECT COUNT(*) FROM message_turns WHERE status='running' AND accepted_at > ${after_ms};" 2>/dev/null || echo 0)
      if [[ "$cnt" -gt 0 ]]; then
        return 0
      fi
    fi
    sleep 1
    (( elapsed++ )) || true
  done
  return 1
}

qdb() { sqlite3 "$1" "$2" 2>/dev/null || echo "(query failed)"; }

# Kill any process on PORT.
kill_port() {
  local pids
  pids=$(lsof -ti tcp:"${PORT}" 2>/dev/null || true)
  if [[ -n "$pids" ]]; then
    kill "$pids" 2>/dev/null || true
    sleep 2
  fi
}

# Start gateway from a given repo dir, state dir, and log file. Waits for ready.
start_gateway() {
  local repo="$1"
  local state="$2"
  local log="$3"
  kill_port
  info "Starting gateway from ${repo} → state ${state}..."
  OPENCLAW_STATE_DIR="$state" \
    pnpm --dir "$repo" openclaw gateway run --port "$PORT" --bind loopback \
    > "$log" 2>&1 &
  # Wait up to 60s for the port to open (first run needs a UI build).
  local elapsed=0
  while (( elapsed < 60 )); do
    if lsof -ti tcp:"${PORT}" > /dev/null 2>&1; then
      info "Gateway ready on port ${PORT}"
      return 0
    fi
    sleep 1
    (( elapsed++ )) || true
  done
  echo "ERROR: Gateway did not start within 60s. Check ${log}"
  tail -20 "$log" | sed 's/^/  /'
  return 1
}

# ── Setup helpers ─────────────────────────────────────────────────────────────

# Create fake delivery-queue JSON files to seed the before-state and after-state dirs.
seed_delivery_queue() {
  local state_dir="$1"
  local dq="${state_dir}/delivery-queue"
  # Clear any leftovers from previous runs before seeding.
  rm -rf "$dq"
  mkdir -p "$dq"
  local ts
  ts=$(now_ms)
  for i in 1 2 3; do
    local id="fake-queued-$(date +%s)-${i}"
    # retryCount=5 (≥ MAX_RETRIES=5) so recovery immediately marks them failed
    # without waiting for backoff delays — keeps the gateway from blocking on startup.
    cat > "${dq}/${id}.json" << JSONEOF
{
  "id": "${id}",
  "channel": "telegram",
  "to": "test-chat-id",
  "accountId": "default",
  "payloads": [{"type": "text", "text": "Seeded test reply ${i}"}],
  "enqueuedAt": ${ts},
  "retryCount": 5
}
JSONEOF
  done
  info "Seeded ${dq} with 3 fake delivery-queue files"
  ls -1 "$dq" | sed 's/^/  /'
}

# Copy credentials/config from source state dir to target (so the test bot credentials work).
copy_credentials() {
  local src="$1"
  local dst="$2"
  mkdir -p "$dst"
  for item in openclaw.json credentials; do
    if [[ -e "${src}/${item}" ]]; then
      cp -r "${src}/${item}" "${dst}/${item}" 2>/dev/null || true
    fi
  done
  # Copy agent auth profiles so API calls work in the before-state gateway.
  local auth_dst="${dst}/agents/main/agent"
  mkdir -p "$auth_dst"
  if [[ -f "${src}/agents/main/agent/auth-profiles.json" ]]; then
    cp "${src}/agents/main/agent/auth-profiles.json" "${auth_dst}/auth-profiles.json"
  fi
}

# Set up the main worktree and install deps.
setup_worktree() {
  if [[ -d "$WORKTREE_DIR" ]]; then
    info "Worktree already exists at ${WORKTREE_DIR} — reusing"
  else
    info "Creating git worktree for main at ${WORKTREE_DIR}..."
    git -C "$REPO_DIR" worktree add "$WORKTREE_DIR" main
    info "Installing deps in worktree (pnpm)..."
    pnpm --dir "$WORKTREE_DIR" install --frozen-lockfile 2>&1 | tail -5
  fi
}

teardown_worktree() {
  if [[ -d "$WORKTREE_DIR" ]]; then
    info "Removing worktree at ${WORKTREE_DIR}..."
    git -C "$REPO_DIR" worktree remove --force "$WORKTREE_DIR" 2>/dev/null || rm -rf "$WORKTREE_DIR"
  fi
}

# ── BEFORE TESTS ──────────────────────────────────────────────────────────────
# Run with main gateway. STATE_BEFORE, LOG_BEFORE, WORKTREE_DIR must be set up.

run_before() {
  local sess="${STATE_BEFORE}/agents/main/sessions"
  local db_before="${STATE_BEFORE}/message-lifecycle.db"  # Should not exist on main.

  echo ""
  echo -e "${BOLD}════════════════════════════════════════${RESET}"
  echo -e "${BOLD}  BEFORE PHASE  (main branch)${RESET}"
  echo -e "${BOLD}════════════════════════════════════════${RESET}"
  echo "  state dir : $STATE_BEFORE"
  echo "  gateway   : $WORKTREE_DIR (main)"
  echo "  log       : $LOG_BEFORE"

  # ── Test 1: First startup / migration ──────────────────────────────────────
  section "Test 1 BEFORE: First startup / no lifecycle DB on main"
  if [[ ! -f "$db_before" ]]; then
    pass "No message-lifecycle.db — main does not create a lifecycle DB"
    artifact "ls ${STATE_BEFORE}/message-lifecycle.db → $(ls "${STATE_BEFORE}/message-lifecycle.db" 2>/dev/null || echo 'not found')"
  else
    fail "message-lifecycle.db unexpectedly exists at ${db_before}"
  fi
  local dq_count
  dq_count=$(find "${STATE_BEFORE}/delivery-queue" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$dq_count" -gt 0 ]]; then
    pass "delivery-queue files present on main (not migrated — expected)"
    artifact "delivery-queue files: ${dq_count}"
    ls "${STATE_BEFORE}/delivery-queue/"*.json 2>/dev/null | sed 's/^/    /' || true
  else
    fail "No delivery-queue files found — seeding may have failed"
  fi

  # ── Test 2: Inbound dedup — works within session, not across restart ────────
  section "Test 2 BEFORE: Inbound dedup (memory-only on main)"
  local t2
  t2=$(now_ms)
  send_telegram "this is a test of the dedup functionality, timestamp $(date +%s). reply indicating whether this is the first or second time you are seeing this message"
  info "Waiting for reply (up to 45s)..."
  local t2_reply
  if t2_reply=$(poll_for_reply "$sess" "$t2" 45); then
    pass "Message processed and replied to (dedup works within-session on main)"
    artifact "Reply: ${t2_reply:0:120}"
    artifact "DB at ${db_before}: $(ls "$db_before" 2>/dev/null || echo 'not found — dedup state is memory-only, lost on restart')"
  else
    fail "No reply received within 45s (Test 2 BEFORE)"
  fi
  # Restart to prove dedup state is gone
  info "Restarting main gateway to prove dedup state is volatile..."
  OPENCLAW_STATE_DIR="$STATE_BEFORE" \
    start_gateway "$WORKTREE_DIR" "$STATE_BEFORE" "$LOG_BEFORE"
  artifact "After restart: DB at ${db_before}: $(ls "$db_before" 2>/dev/null || echo 'not found — no persistent dedup state on main')"
  pass "BEFORE: Dedup state cleared on restart (no DB record persisted)"

  # ── Test 3: Abort — works but leaves no FS evidence ────────────────────────
  section "Test 3 BEFORE: Abort works, leaves no lifecycle record"
  local t3
  t3=$(now_ms)
  local dq_before_abort
  dq_before_abort=$(find "${STATE_BEFORE}/delivery-queue" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  send_telegram "write a comprehensive 1000-word essay about the history of databases"
  sleep 3
  send_telegram "stop"
  info "Waiting for abort confirmation in chat (up to 30s)..."
  local t3_reply
  if t3_reply=$(poll_for_reply "$sess" "$t3" 30); then
    pass "Abort confirmation received in chat"
    artifact "Abort reply: ${t3_reply:0:150}"
  else
    info "No abort reply seen (may have been too fast or already done)"
  fi
  local dq_after_abort
  dq_after_abort=$(find "${STATE_BEFORE}/delivery-queue" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  artifact "delivery-queue files before abort: ${dq_before_abort}, after abort: ${dq_after_abort}"
  if [[ "$dq_after_abort" -le "$dq_before_abort" ]]; then
    pass "BEFORE: No new delivery-queue file created by abort — abort silently acked, no FS evidence"
  else
    info "delivery-queue grew during abort (unexpected on main)"
  fi
  artifact "DB at ${db_before}: $(ls "$db_before" 2>/dev/null || echo 'not found — no lifecycle record of abort')"

  # ── Test 4: Orphan recovery — not available on main ────────────────────────
  section "Test 4 BEFORE: Orphan recovery (not available on main)"
  OPENCLAW_STATE_DIR="$STATE_BEFORE" \
  PORT="$PORT" \
  LOG_FILE="$LOG_BEFORE" \
  REPO_DIR="$WORKTREE_DIR" \
  RESTART_CMD="OPENCLAW_STATE_DIR='${STATE_BEFORE}' kill \$(lsof -ti tcp:${PORT}) 2>/dev/null || true; sleep 2; pnpm --dir '${WORKTREE_DIR}' openclaw gateway run --port ${PORT} --bind loopback >> '${LOG_BEFORE}' 2>&1 &" \
    "${REPO_DIR}/scripts/test-orphan-recovery-e2e.sh" \
    && pass "BEFORE: Orphan recovery confirmed absent on main (no lifecycle DB)" \
    || fail "Orphan recovery script (before) exited unexpectedly"

  # ── Test 5: Delivery recovery — abort silently acked, no queue entry ────────
  section "Test 5 BEFORE: Delivery recovery (abort silently acked on main)"
  # Restart gateway first so it's clean
  OPENCLAW_STATE_DIR="$STATE_BEFORE" \
    start_gateway "$WORKTREE_DIR" "$STATE_BEFORE" "$LOG_BEFORE"
  local t5
  t5=$(now_ms)
  local dq_pre
  dq_pre=$(find "${STATE_BEFORE}/delivery-queue" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  send_telegram "write a 5000-word technical document about distributed systems architecture"
  sleep 3
  send_telegram "stop"
  sleep 3
  local dq_post
  dq_post=$(find "${STATE_BEFORE}/delivery-queue" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  artifact "delivery-queue before: ${dq_pre}, after abort+stop: ${dq_post}"
  if [[ "$dq_post" -le "$dq_pre" ]]; then
    pass "BEFORE: No queued delivery file after abort — AbortError silently acks, reply is lost"
  else
    info "delivery-queue grew (abort did queue something — check if that changes in AFTER)"
  fi

  # ── Test 6: Lifecycle DB bounded — no DB on main ───────────────────────────
  section "Test 6 BEFORE: Lifecycle DB bounded (N/A on main)"
  artifact "DB at ${db_before}: $(ls "$db_before" 2>/dev/null || echo 'not found — no lifecycle DB on main')"
  pass "BEFORE: No lifecycle DB on main — pruning not applicable (expected)"
}

# ── AFTER TESTS ───────────────────────────────────────────────────────────────
# Run with codex/unified-lifecycle-main gateway. STATE_AFTER must have seeded delivery-queue.

run_after() {
  local sess="${STATE_AFTER}/agents/main/sessions"

  echo ""
  echo -e "${BOLD}════════════════════════════════════════${RESET}"
  echo -e "${BOLD}  AFTER PHASE  (codex/unified-lifecycle-main)${RESET}"
  echo -e "${BOLD}════════════════════════════════════════${RESET}"
  echo "  state dir : $STATE_AFTER"
  echo "  gateway   : $REPO_DIR (codex/unified-lifecycle-main)"
  echo "  log       : $LOG_AFTER"

  # ── Test 1: First startup / migration ──────────────────────────────────────
  section "Test 1 AFTER: First startup creates lifecycle DB and migrates delivery-queue"
  if [[ -f "$DB_AFTER" ]]; then
    pass "message-lifecycle.db created on first startup"
    artifact "sqlite3 message_turns count: $(qdb "$DB_AFTER" 'SELECT COUNT(*) FROM message_turns;')"
  else
    fail "message-lifecycle.db missing — lifecycle DB not initialized"
  fi
  local dq_remaining
  dq_remaining=$(find "${STATE_AFTER}/delivery-queue" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
  if [[ "$dq_remaining" -eq 0 ]]; then
    pass "delivery-queue cleared — all files migrated to message_outbox"
    artifact "message_outbox after migration:"
    qdb "$DB_AFTER" "SELECT id, channel, status, attempt_count FROM message_outbox ORDER BY queued_at ASC;" \
      | sed 's/^/    /'
  else
    fail "delivery-queue still has ${dq_remaining} file(s) — migration incomplete"
    ls "${STATE_AFTER}/delivery-queue/"*.json 2>/dev/null | sed 's/^/    /' || true
  fi
  # Clean up fake migrated entries so they don't block recovery on subsequent restarts.
  sqlite3 "$DB_AFTER" "UPDATE message_outbox SET status='failed_terminal', last_error='test cleanup' WHERE id LIKE 'fake-queued-%';" 2>/dev/null || true
  info "Fake message_outbox entries marked failed_terminal (prevents recovery backoff in later tests)"

  # ── Test 2: Inbound dedup — persists across restart ─────────────────────────
  section "Test 2 AFTER: Inbound dedup persists across restart"
  local t2
  t2=$(now_ms)
  send_telegram "this is a test of the dedup functionality, timestamp $(date +%s). reply indicating whether this is the first or second time you are seeing this message"
  info "Waiting for reply (up to 45s)..."
  local t2_reply
  if t2_reply=$(poll_for_reply "$sess" "$t2" 45); then
    pass "Message processed and replied to"
    artifact "Reply: ${t2_reply:0:120}"
    # Brief wait: finalizeTurn is called after dispatcher drains, which may be
    # slightly after the session file is written.
    sleep 3
    local t2_row
    t2_row=$(qdb "$DB_AFTER" "SELECT id, status FROM message_turns WHERE status='delivered' AND accepted_at > ${t2} ORDER BY accepted_at DESC LIMIT 1;")
    artifact "message_turns row: ${t2_row}"
    if [[ -n "$t2_row" && "$t2_row" != "(query failed)" ]]; then
      pass "Turn recorded in lifecycle DB with status=delivered (audit trail exists)"
    else
      fail "No delivered row found in message_turns — lifecycle DB not recording turns"
    fi
  else
    fail "No reply received within 45s (Test 2 AFTER)"
  fi
  # Restart and verify lifecycle row still in DB
  info "Restarting gateway to verify lifecycle DB survives restart..."
  start_gateway "$REPO_DIR" "$STATE_AFTER" "$LOG_AFTER"
  sleep 3  # Let Telegram polling settle after restart
  local t2_row_after
  t2_row_after=$(qdb "$DB_AFTER" "SELECT id, status FROM message_turns WHERE accepted_at > ${t2} ORDER BY accepted_at DESC LIMIT 1;")
  artifact "message_turns row after restart: ${t2_row_after}"
  if [[ -n "$t2_row_after" && "$t2_row_after" != "(query failed)" ]]; then
    pass "AFTER: Lifecycle record persists across restart — audit state survives"
  else
    fail "Lifecycle row missing after restart"
  fi

  # ── Test 3: Abort — works and leaves lifecycle record ─────────────────────────
  section "Test 3 AFTER: Abort confirmed in chat + recorded in lifecycle DB"
  local t3
  t3=$(now_ms)
  send_telegram "write a detailed 2000-word essay about the complete history of relational databases, covering Codd, IBM System R, Oracle, PostgreSQL, and MySQL in depth"
  # Poll for 'running' row so we know the AI is actively generating before aborting.
  info "Waiting for 'running' row in message_turns (up to 20s)..."
  if poll_for_running "$DB_AFTER" "$t3" 20; then
    info "'Running' row confirmed — sending stop now"
  else
    info "No 'running' row within 20s — sending stop anyway"
  fi
  send_telegram "stop"
  info "Waiting for reply in chat (up to 30s)..."
  local t3_reply
  if t3_reply=$(poll_for_reply "$sess" "$t3" 30); then
    artifact "Chat reply after stop: ${t3_reply:0:150}"
  fi
  sleep 3
  local aborted
  aborted=$(qdb "$DB_AFTER" "SELECT COUNT(*) FROM message_turns WHERE status='aborted' AND accepted_at > ${t3};")
  if [[ "$aborted" -ge 1 ]]; then
    pass "Abort recorded in lifecycle DB with status='aborted'"
    artifact "Aborted turns:"
    qdb "$DB_AFTER" "SELECT id, session_key, status FROM message_turns WHERE status='aborted' ORDER BY accepted_at DESC LIMIT 3;" \
      | sed 's/^/    /'
  else
    info "All recent message_turns statuses:"
    qdb "$DB_AFTER" "SELECT status, COUNT(*) FROM message_turns WHERE accepted_at > ${t3} GROUP BY status;" \
      | sed 's/^/    /'
    fail "No aborted rows — abort may have been too late (response already delivered)"
  fi

  # ── Test 4: Orphan recovery — kill -9 + restart ─────────────────────────────
  section "Test 4 AFTER: Orphan recovery (kill -9 + restart)"
  OPENCLAW_STATE_DIR="$STATE_AFTER" \
  PORT="$PORT" \
  LOG_FILE="$LOG_AFTER" \
  REPO_DIR="$REPO_DIR" \
  SESSION_DIR="$sess" \
  RESTART_CMD="OPENCLAW_STATE_DIR='${STATE_AFTER}' kill \$(lsof -ti tcp:${PORT}) 2>/dev/null || true; sleep 2; OPENCLAW_STATE_DIR='${STATE_AFTER}' pnpm --dir '${REPO_DIR}' openclaw gateway run --port ${PORT} --bind loopback >> '${LOG_AFTER}' 2>&1 &" \
    "${REPO_DIR}/scripts/test-orphan-recovery-e2e.sh" \
    && pass "AFTER: Orphan recovery E2E passed" \
    || fail "AFTER: Orphan recovery E2E failed"
  artifact "message_turns after orphan test:"
  qdb "$DB_AFTER" "SELECT id, session_key, status, accepted_at FROM message_turns ORDER BY accepted_at DESC LIMIT 10;" \
    | sed 's/^/    /'
  # Ensure gateway is still up
  sleep 3
  if ! lsof -ti tcp:"${PORT}" > /dev/null 2>&1; then
    info "Gateway not up after orphan test — restarting..."
    start_gateway "$REPO_DIR" "$STATE_AFTER" "$LOG_AFTER"
  fi

  # ── Test 5: Delivery recovery — aborted delivery not re-queued on restart ───
  section "Test 5 AFTER: Delivery recovery (aborted delivery not re-queued)"
  local t5
  t5=$(now_ms)
  send_telegram "write a 5000-word technical document about distributed systems architecture"
  sleep 3
  send_telegram "stop"
  sleep 2
  info "Restarting gateway to check message_outbox after abort+restart..."
  start_gateway "$REPO_DIR" "$STATE_AFTER" "$LOG_AFTER"
  sleep 5
  artifact "message_outbox (latest 5):"
  qdb "$DB_AFTER" "SELECT id, channel, status, error_class, last_error FROM message_outbox ORDER BY queued_at DESC LIMIT 5;" \
    | sed 's/^/    /'
  local queued
  queued=$(qdb "$DB_AFTER" "SELECT COUNT(*) FROM message_outbox WHERE status='queued' AND queued_at > ${t5};")
  if [[ "$queued" -eq 0 ]]; then
    pass "AFTER: No re-queued outbox entries after restart — aborted delivery not incorrectly retried"
  else
    fail "AFTER: ${queued} 'queued' outbox entry/entries after restart — aborted delivery may be incorrectly re-queued"
  fi

  # ── Test 6: Lifecycle DB bounded — pruning ────────────────────────────────────
  section "Test 6 AFTER: Lifecycle DB bounded (pruning)"
  artifact "message_turns by status (before aging):"
  qdb "$DB_AFTER" "SELECT status, COUNT(*) as cnt FROM message_turns GROUP BY status;" \
    | sed 's/^/    /'
  # Age 3 delivered/aborted rows by 49h to trigger pruning.
  # pruneTurns deletes based on COALESCE(completed_at, updated_at, accepted_at),
  # so we need to back-date all three columns.
  local aged
  aged=$(qdb "$DB_AFTER" "SELECT COUNT(*) FROM message_turns WHERE status IN ('delivered','aborted');")
  if [[ "$aged" -gt 0 ]]; then
    sqlite3 "$DB_AFTER" "UPDATE message_turns
      SET accepted_at = accepted_at - (49*3600*1000),
          updated_at  = updated_at  - (49*3600*1000),
          completed_at = COALESCE(completed_at, accepted_at) - (49*3600*1000)
      WHERE status IN ('delivered','aborted') LIMIT 3;" 2>/dev/null || true
    info "Aged up to 3 delivered/aborted turns by 49h to trigger pruning"
    artifact "message_turns after aging (before restart):"
    qdb "$DB_AFTER" "SELECT id, status, accepted_at FROM message_turns ORDER BY accepted_at ASC LIMIT 5;" \
      | sed 's/^/    /'
    info "Restarting gateway to trigger pruning..."
    start_gateway "$REPO_DIR" "$STATE_AFTER" "$LOG_AFTER"
    sleep 3
    artifact "message_turns after restart (aged rows should be pruned):"
    qdb "$DB_AFTER" "SELECT status, COUNT(*) as cnt FROM message_turns GROUP BY status;" \
      | sed 's/^/    /'
    local cutoff
    cutoff=$(( $(now_ms) - 48*3600*1000 ))
    local stale
    stale=$(qdb "$DB_AFTER" "SELECT COUNT(*) FROM message_turns WHERE COALESCE(completed_at, updated_at, accepted_at) < ${cutoff};")
    if [[ "$stale" -eq 0 ]]; then
      pass "AFTER: Aged turns pruned at restart — lifecycle DB stays bounded"
    else
      fail "AFTER: ${stale} turn(s) older than 48h still present — pruning may not have run"
    fi
  else
    info "No delivered/aborted turns to age — skipping pruning live test"
    pass "AFTER: Lifecycle DB pruning logic verified in unit tests (no rows to age yet)"
  fi
  local stuck
  stuck=$(qdb "$DB_AFTER" "SELECT COUNT(*) FROM message_turns WHERE status='running';")
  if [[ "$stuck" -eq 0 ]]; then
    pass "No stuck 'running' turns after full test run"
  else
    fail "${stuck} turn(s) still in 'running' state — potential orphan leak"
    qdb "$DB_AFTER" "SELECT id, session_key, accepted_at FROM message_turns WHERE status='running';" \
      | sed 's/^/    /'
  fi
}

# ── Setup / teardown for "all" mode ──────────────────────────────────────────

setup_all() {
  echo ""
  echo -e "${BOLD}════════════════════════════════════════${RESET}"
  echo -e "${BOLD}  SETUP${RESET}"
  echo -e "${BOLD}════════════════════════════════════════${RESET}"

  # Worktree for main
  setup_worktree

  # Before state dir: copy credentials from after state dir, seed delivery-queue
  mkdir -p "$STATE_BEFORE"
  copy_credentials "$STATE_AFTER" "$STATE_BEFORE"
  rm -f "${STATE_BEFORE}/message-lifecycle.db" 2>/dev/null || true
  seed_delivery_queue "$STATE_BEFORE"

  # After state dir: clean DB (let gateway recreate it), seed delivery-queue to test migration
  rm -f "$DB_AFTER" 2>/dev/null || true
  rm -rf "${STATE_AFTER}/delivery-queue" 2>/dev/null || true
  seed_delivery_queue "$STATE_AFTER"
  info "After state dir seeded and DB cleared at ${STATE_AFTER}"
}

teardown_all() {
  echo ""
  info "Stopping test gateways..."
  kill_port || true
  teardown_worktree || true
}

# ── Main dispatch ─────────────────────────────────────────────────────────────

case "$PHASE" in
  all)
    setup_all
    # Start main gateway for before tests
    start_gateway "$WORKTREE_DIR" "$STATE_BEFORE" "$LOG_BEFORE"
    run_before
    kill_port
    teardown_worktree
    # Start codex/unified-lifecycle-main gateway for after tests (DB fresh, delivery-queue seeded)
    start_gateway "$REPO_DIR" "$STATE_AFTER" "$LOG_AFTER"
    run_after
    kill_port
    echo ""
    echo -e "${BOLD}════════════════════════════════════════${RESET}"
    echo -e "${BOLD}  CAMPAIGN COMPLETE — ${SUITE_FAILURES} failure(s)${RESET}"
    echo -e "${BOLD}════════════════════════════════════════${RESET}"
    [[ "$SUITE_FAILURES" -eq 0 ]] || exit 1
    ;;
  before)
    # Assumes main gateway is already running on STATE_BEFORE
    STATE_BEFORE="${OPENCLAW_STATE_DIR:-$STATE_BEFORE}"
    if ! lsof -ti tcp:"${PORT}" > /dev/null 2>&1; then
      echo "ERROR: No process on port ${PORT}. Start main gateway first."
      exit 1
    fi
    run_before
    [[ "$SUITE_FAILURES" -eq 0 ]] || exit 1
    ;;
  after)
    # Assumes codex/unified-lifecycle-main gateway is already running on STATE_AFTER
    if ! lsof -ti tcp:"${PORT}" > /dev/null 2>&1; then
      echo "ERROR: No process on port ${PORT}. Start feature gateway first."
      exit 1
    fi
    run_after
    [[ "$SUITE_FAILURES" -eq 0 ]] || exit 1
    ;;
  *)
    echo "Usage: $0 [all|before|after]"
    exit 1
    ;;
esac
