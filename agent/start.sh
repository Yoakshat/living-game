#!/bin/bash
PORT=$(cat ./port 2>/dev/null || echo 7979)
NAME=$(grep -m1 "^# Character:" ./character.md 2>/dev/null | sed 's/# Character: //')
AGENT_DIR="$HOME/projects/living-game/main/agent"

# Initialize memory.md if it doesn't exist
[ -f ./memory.md ] || touch ./memory.md

# Boot the browser server if it's not already running on our port
if ! curl -s "http://localhost:$PORT/health" > /dev/null 2>&1; then
  AGENT_PORT="$PORT" CHARACTER_NAME="$NAME" node "$AGENT_DIR/server.js" &
  # Wait for it to be ready (up to 20s)
  for i in $(seq 1 20); do
    sleep 1
    curl -s "http://localhost:$PORT/health" > /dev/null 2>&1 && break
  done
fi

while true; do
  claude --dangerously-skip-permissions --print "/start"
  sleep 3
done
