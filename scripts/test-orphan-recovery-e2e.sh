#!/usr/bin/env bash
#
# E2E test for post-restart orphan reply recovery.
#
# 1. Tails the Telegram session transcript (or gateway log) until a new user
#    message is seen.
# 2. Restarts the OpenClaw gateway so the in-flight reply becomes "orphaned".
# 3. After restart, watches the log for recovery messages and reports success.
#
# Usage:
#   OPENCLAW_STATE_DIR=~/.openclaw ./scripts/test-orphan-recovery-e2e.sh
#
# Prerequisites:
#   - OpenClaw gateway is already running (e.g. openclaw start or pnpm dev).
#   - You have a Telegram session; send a test message from Telegram when prompted.
#
# Optional env:
#   OPENCLAW_STATE_DIR   State directory (default: ~/.openclaw)
#   RESTART_CMD          Command to restart the gateway (default: pkill + openclaw start)
#   OPENCLAW_START_CMD   Command to start the gateway after kill (default: openclaw start)
#
# If you run the gateway with `pnpm dev` from the repo, set RESTART_CMD so it kills
# that process and starts it again, e.g.:
#   RESTART_CMD='pkill -f "run-node.mjs|openclaw" || true; sleep 2; cd /path/to/openclaw && pnpm dev'
#

set -e

STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"
SESSIONS_JSON="$STATE_DIR/agents/main/sessions/sessions.json"
LOG_FILE="$STATE_DIR/logs/gateway.log"
TRANSCRIPT_DIR="$STATE_DIR/agents/main/sessions"

# Default: kill node process that looks like the gateway, then start openclaw
# Override RESTART_CMD to do something else (e.g. systemctl restart openclaw).
if [[ -z "$RESTART_CMD" ]]; then
  OPENCLAW_START_CMD="${OPENCLAW_START_CMD:-openclaw start}"
  RESTART_CMD="pkill -f 'node.*openclaw|openclaw.*start' || true; sleep 2; $OPENCLAW_START_CMD"
fi

echo "=== Orphan reply recovery E2E test ==="
echo "State dir: $STATE_DIR"
echo ""

# Resolve Telegram session transcript path
get_telegram_transcript_path() {
  if [[ ! -f "$SESSIONS_JSON" ]]; then
    echo "Error: $SESSIONS_JSON not found" >&2
    return 1
  fi
  local session_id
  session_id=$(node -e "
    const fs = require('fs');
    const data = JSON.parse(fs.readFileSync('$SESSIONS_JSON', 'utf8'));
    for (const [key, entry] of Object.entries(data)) {
      if (key.toLowerCase().includes('telegram') && entry && entry.sessionId) {
        console.log(entry.sessionId);
        process.exit(0);
      }
    }
    process.exit(1);
  " 2>/dev/null) || return 1
  echo "$TRANSCRIPT_DIR/$session_id.jsonl"
}

TRANSCRIPT_PATH=$(get_telegram_transcript_path 2>/dev/null || true)

if [[ -z "$TRANSCRIPT_PATH" ]]; then
  echo "No Telegram session found in $SESSIONS_JSON."
  echo "Falling back to: watch gateway log for [telegram] activity, then poll sessions.json for pendingReplies."
  echo ""
  USE_LOG_AND_POLL=1
else
  if [[ ! -f "$TRANSCRIPT_PATH" ]]; then
    echo "Telegram transcript not created yet: $TRANSCRIPT_PATH"
    echo "Send a message from Telegram; script will poll sessions.json for pendingReplies then restart."
    USE_LOG_AND_POLL=1
  else
    echo "Watching Telegram transcript: $TRANSCRIPT_PATH"
    echo "Send a test message from Telegram now; the script will restart the server as soon as it sees your message."
    echo ""
    USE_LOG_AND_POLL=
  fi
fi

# Wait for a new user message in the transcript (tail -f, parse each new line)
# Only considers lines added after we start (tail -n 0 -f = follow from current end).
wait_for_user_message() {
  local transcript_path=$1
  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    if echo "$line" | grep -qE '"role"[[:space:]]*:[[:space:]]*"user"'; then
      echo "[$(date -u +%H:%M:%S)] Saw new user message in transcript."
      return 0
    fi
  done < <(tail -n 0 -f "$transcript_path" 2>/dev/null)
  return 1
}

# Poll sessions.json for pendingReplies on any session
poll_pending_replies() {
  local max_attempts=60
  local attempt=0
  while (( attempt < max_attempts )); do
    if node -e "
      const fs = require('fs');
      const data = JSON.parse(fs.readFileSync('$SESSIONS_JSON', 'utf8'));
      for (const [key, entry] of Object.entries(data)) {
        if (entry && entry.pendingReplies && Object.keys(entry.pendingReplies).length > 0) {
          console.log('pending');
          process.exit(0);
        }
      }
      process.exit(1);
    " 2>/dev/null; then
      return 0
    fi
    sleep 0.5
    (( attempt++ )) || true
  done
  return 1
}

# Wait for gateway log to show recovery messages
wait_for_recovery_log() {
  local log_file=$1
  local timeout=60
  local start=$(date +%s)
  local found_pending=0
  local found_complete=0
  echo "Watching $log_file for recovery messages (up to ${timeout}s)..."
  while IFS= read -r line; do
    if echo "$line" | grep -q "Found.*pending repl"; then
      found_pending=1
      echo "  [RECOVERY] $line"
    fi
    if echo "$line" | grep -q "Recovered pending reply for"; then
      echo "  [RECOVERY] $line"
    fi
    if echo "$line" | grep -q "Pending reply recovery complete"; then
      found_complete=1
      echo "  [RECOVERY] $line"
      break
    fi
    if (( $(date +%s) - start > timeout )); then
      break
    fi
  done < <(tail -n 0 -f "$log_file" 2>/dev/null)
  if (( found_complete )); then
    echo ""
    echo "*** Recovery completed. Check Telegram for the reply. ***"
    return 0
  fi
  if (( found_pending )); then
    echo ""
    echo "*** Recovery started but 'recovery complete' not seen within ${timeout}s. Check logs. ***"
    return 0
  fi
  echo ""
  echo "*** No recovery log messages seen. If the server restarted, check $log_file and Telegram. ***"
  return 1
}

do_restart() {
  echo ""
  echo "[$(date -u +%H:%M:%S)] Restarting gateway: $RESTART_CMD"
  eval "$RESTART_CMD" &
  sleep 3
  echo "[$(date -u +%H:%M:%S)] Gateway restarted (background)."
}

if [[ -n "$USE_LOG_AND_POLL" ]]; then
  echo "Send a test message from Telegram now..."
  if ! poll_pending_replies; then
    echo "Timeout waiting for pendingReplies to appear. Did you send a message? Aborting."
    exit 1
  fi
  echo "[$(date -u +%H:%M:%S)] pendingReplies detected in session store."
  do_restart
else
  # Tail transcript; on first new user line, restart
  wait_for_user_message "$TRANSCRIPT_PATH" || exit 1
  do_restart
fi

# After restart, tail log for recovery
if [[ -f "$LOG_FILE" ]]; then
  wait_for_recovery_log "$LOG_FILE" || true
else
  echo "Log file not found: $LOG_FILE"
  echo "After restart, grep for 'Pending reply recovery' or 'Recovered pending reply' in your gateway logs."
fi
