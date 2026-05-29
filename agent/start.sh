#!/bin/bash
while true; do
  claude --continue --dangerously-skip-permissions --print "/start"
  sleep 3
done
