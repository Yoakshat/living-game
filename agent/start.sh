#!/bin/bash
PORT=$(cat ./port 2>/dev/null || echo 7979)
NAME=$(grep -m1 "^# Character:" ./character.md 2>/dev/null | sed 's/# Character: //')
AGENT_DIR="$HOME/projects/living-game/main/agent"

# Boot the browser server if it's not already running on our port
if ! curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
  AGENT_PORT="$PORT" CHARACTER_NAME="$NAME" node "$AGENT_DIR/server.js" &
  # Wait for it to be ready (up to 20s)
  for i in $(seq 1 20); do
    sleep 1
    curl -s "http://localhost:$PORT/health" > /dev/null 2>&1 && break
  done
fi

# Trim Claude session to last 50 lines before each run to prevent context bloat.
# memory.md is the real persistence layer — conversation history isn't needed.
PROJECT_SLUG=$(echo "$PWD" | tr '/' '-' | sed 's/^-//')
SESSION_DIR="$HOME/.claude/projects/$PROJECT_SLUG"

trim_session() {
  local latest
  latest=$(ls -t "$SESSION_DIR"/*.jsonl 2>/dev/null | head -1)
  if [ -n "$latest" ] && [ "$(wc -l < "$latest")" -gt 150 ]; then
    tail -n 150 "$latest" > "$latest.tmp" && mv "$latest.tmp" "$latest"
  fi
}

while true; do
  trim_session
  claude --continue --dangerously-skip-permissions --print "/start"
  sleep 3
done
