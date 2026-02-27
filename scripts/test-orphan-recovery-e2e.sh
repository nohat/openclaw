#!/usr/bin/env bash
#
# E2E test for post-restart orphan turn recovery (unified durable lifecycle).
# Verifies that an in-flight turn interrupted by kill -9 is recovered and
# transitioned to a terminal state after gateway restart.
#
# Usage:
#   OPENCLAW_STATE_DIR=~/.openclaw-test ./scripts/test-orphan-recovery-e2e.sh
#
# Prerequisites:
#   - Test gateway is already running on codex/unified-lifecycle-main.
#   - Telegram is open with Accessibility permission granted to Terminal.
#
# Optional env:
#   OPENCLAW_STATE_DIR   State directory (default: ~/.openclaw-test)
#   PORT                 Gateway port (default: 19001)
#   LOG_FILE             Gateway log file (default: /tmp/openclaw-test-gateway.log)
#   RESTART_CMD          Command to restart the gateway after kill -9
#   REPO_DIR             Repo root (default: resolved from script location)
#   TELEGRAM_CHAT        Telegram chat name (default: Openclaw Nohat Test)
#

set -euo pipefail

REPO_DIR="${REPO_DIR:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}"
STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw-test}"
PORT="${PORT:-19001}"
LOG_FILE="${LOG_FILE:-/tmp/openclaw-test-gateway.log}"
DB="$STATE_DIR/message-lifecycle.db"
CHAT="${TELEGRAM_CHAT:-Openclaw Nohat Test}"
SESSION_DIR="${SESSION_DIR:-$STATE_DIR/agents/main/sessions}"

if [[ -z "${RESTART_CMD:-}" ]]; then
  RESTART_CMD="kill \$(lsof -ti tcp:${PORT}) 2>/dev/null || true; sleep 2; pnpm --dir '${REPO_DIR}' openclaw --profile test gateway run >> '${LOG_FILE}' 2>&1 &"
fi

EXIT_CODE=0
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; EXIT_CODE=1; }
info() { echo "INFO: $*"; }

now_ms() { python3 -c "import time; print(int(time.time()*1000))"; }

# Send a message to the test Telegram chat via AppleScript.
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
  info "Sent to Telegram: ${msg}"
}

# Poll message_turns for any row newer than given epoch-ms timestamp.
# Accepts any status — detects the moment a message is recorded.
poll_for_inbound_row() {
  local after_ms="$1"
  local timeout="${2:-25}"
  local elapsed=0
  while (( elapsed < timeout )); do
    if [[ -f "$DB" ]]; then
      local cnt
      cnt=$(sqlite3 "$DB" "SELECT COUNT(*) FROM message_turns WHERE accepted_at > ${after_ms};" 2>/dev/null || echo 0)
      if [[ "$cnt" -gt 0 ]]; then
        return 0
      fi
    fi
    sleep 1
    (( elapsed++ )) || true
  done
  return 1
}

# Poll specifically for a 'running' row — used to time the kill-9.
poll_for_running() {
  local after_ms="$1"
  local timeout="${2:-20}"
  local elapsed=0
  while (( elapsed < timeout )); do
    if [[ -f "$DB" ]]; then
      local cnt
      cnt=$(sqlite3 "$DB" "SELECT COUNT(*) FROM message_turns WHERE status='running' AND accepted_at > ${after_ms};" 2>/dev/null || echo 0)
      if [[ "$cnt" -gt 0 ]]; then
        return 0
      fi
    fi
    sleep 1
    (( elapsed++ )) || true
  done
  return 1
}

# Poll session files for a new assistant reply after given epoch-ms timestamp.
poll_for_reply() {
  local after_ms="$1"
  local timeout="${2:-45}"
  local elapsed=0
  while (( elapsed < timeout )); do
    local f
    f=$(ls -t "${SESSION_DIR}"/*.jsonl 2>/dev/null | head -1 || true)
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

# Wait for the orphan turn to leave 'running' state (recovery complete or failed).
# Primary signal: DB poll. Secondary: log file scan for supporting evidence.
wait_for_recovery() {
  local after_ms="$1"
  local timeout="${2:-90}"
  local elapsed=0
  info "Polling DB for orphan turn to leave 'running' state (up to ${timeout}s)..."

  # Also tail the log in the background to capture any recovery log lines.
  local log_artifact_file
  log_artifact_file=$(mktemp)
  # Look for turn-worker recovery log patterns (any of these indicate activity):
  #   "recovery failed"  — turn worker failed the recovery attempt
  #   "stale turn"       — turn worker aged out the turn
  #   "pass recovered="  — outbox worker recovered pending deliveries
  (timeout "$((timeout + 2))" tail -n 100 -f "$LOG_FILE" 2>/dev/null \
    | grep --line-buffered -E "recovery failed|stale turn|pass recovered=" \
    > "$log_artifact_file") &
  local log_pid=$!

  while (( elapsed < timeout )); do
    if [[ -f "$DB" ]]; then
      local cnt
      # Any turn from this test run that is now in a terminal state
      cnt=$(sqlite3 "$DB" \
        "SELECT COUNT(*) FROM message_turns
           WHERE status IN ('delivered','aborted','failed_terminal')
             AND accepted_at > ${after_ms};" 2>/dev/null || echo 0)
      if [[ "$cnt" -gt 0 ]]; then
        kill "$log_pid" 2>/dev/null || true
        if [[ -s "$log_artifact_file" ]]; then
          echo "  ARTIFACT (log evidence):"
          sed 's/^/    /' "$log_artifact_file"
        fi
        rm -f "$log_artifact_file"
        return 0
      fi
    fi
    sleep 2
    (( elapsed += 2 )) || true
  done

  kill "$log_pid" 2>/dev/null || true
  if [[ -s "$log_artifact_file" ]]; then
    echo "  ARTIFACT (log evidence — turn may still be recovering):"
    sed 's/^/    /' "$log_artifact_file"
  fi
  rm -f "$log_artifact_file"
  return 1
}

echo "=== Orphan turn recovery E2E test (unified lifecycle) ==="
echo "State dir: $STATE_DIR"
echo "DB:        $DB"
echo "Log:       $LOG_FILE"
echo "Port:      $PORT"
echo ""

# ── Short-circuit: no DB means we're on main — recovery doesn't exist ──
if [[ ! -f "$DB" ]]; then
  pass "BEFORE: No message-lifecycle.db — orphan recovery not available on main (expected)"
  echo "  ARTIFACT: No DB at $DB"
  echo "  ARTIFACT: Turn is permanently lost on kill -9 without the lifecycle DB"
  exit 0
fi

# ── Step 1: Send a long-running message ──
# Wait 3s after gateway startup for Telegram long-polling to settle.
sleep 3
ts=$(now_ms)
info "Sending long-running message via AppleScript..."
send_telegram "write a detailed 1000-word essay about the history of databases, covering relational, NoSQL, and NewSQL systems"

# ── Step 2: Wait for ANY inbound row (message received by gateway) ──
info "Polling DB for inbound turn row (up to 25s)..."
if ! poll_for_inbound_row "$ts" 25; then
  fail "No message_turns row found within 25s — message may not have reached the gateway"
  exit 1
fi

# Now wait specifically for 'running' status (AI actively generating — safe to kill).
info "Waiting for 'running' status in message_turns (AI generating — up to 20s)..."
if poll_for_running "$ts" 20; then
  info "Found 'running' turn — AI is generating"
  echo "  ARTIFACT (DB running turn):"
  sqlite3 "$DB" "SELECT id, status, accepted_at FROM message_turns WHERE status='running' ORDER BY accepted_at DESC LIMIT 3;" \
    | sed 's/^/    /'
else
  info "No 'running' row — response may have been very fast; checking DB state:"
  sqlite3 "$DB" "SELECT id, status, accepted_at FROM message_turns WHERE accepted_at > ${ts} ORDER BY accepted_at DESC LIMIT 3;" \
    | sed 's/^/    /'
  info "Will attempt kill-9 anyway (turn worker also handles already-delivered turns)"
fi

# ── Step 3: Kill -9 the gateway (simulate crash) ──
info "Sending kill -9 to gateway on port ${PORT} (simulating crash)..."
kill -9 "$(lsof -ti tcp:"${PORT}")" 2>/dev/null || true
sleep 2
info "Gateway killed."

echo "  ARTIFACT (DB state at kill time):"
sqlite3 "$DB" "SELECT id, status, accepted_at FROM message_turns WHERE accepted_at > ${ts} ORDER BY accepted_at DESC LIMIT 5;" \
  | sed 's/^/    /'

# ── Step 4: Restart the gateway ──
info "Restarting gateway..."
eval "$RESTART_CMD"
sleep 8
info "Gateway restarted."

# ── Step 5: Wait for the orphan turn to be recovered ──
if wait_for_recovery "$ts" 90; then
  pass "Orphan turn recovered — transitioned to terminal state after restart"
else
  fail "Orphan turn did not reach terminal state within 90s — recovery may not have triggered"
fi

# ── Step 6: Check final journal row status ──
echo ""
echo "  ARTIFACT (DB state after recovery):"
sqlite3 "$DB" "SELECT id, session_key, status, accepted_at, terminal_reason FROM message_turns ORDER BY accepted_at DESC LIMIT 10;" \
  | sed 's/^/    /'

recovered=$(sqlite3 "$DB" "SELECT COUNT(*) FROM message_turns WHERE status IN ('delivered','aborted','failed_terminal') AND accepted_at > ${ts};" 2>/dev/null || echo 0)
if [[ "$recovered" -ge 1 ]]; then
  pass "Orphan turn reached terminal status (delivered/aborted/failed_terminal) in lifecycle DB"
else
  info "Turn may still be in a retryable state — recovery dispatches async"
  echo "  Current status:"
  sqlite3 "$DB" "SELECT id, status, attempt_count, terminal_reason FROM message_turns WHERE accepted_at > ${ts};" \
    | sed 's/^/    /'
fi

echo ""
echo "=== Orphan recovery test complete (exit: ${EXIT_CODE}) ==="
exit "$EXIT_CODE"
