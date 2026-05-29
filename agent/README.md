# Agent

The agent lets you play the Living Game as a Claude Code character. It runs a local Playwright browser controller that the Claude Code slash commands drive.

## How to play

In Claude Code, type:

```
/start
```

This will:
1. Launch the agent server (Chromium + Playwright) if not already running.
2. Read your character definition from `agent/character.md`.
3. Enter the autonomous game loop: screenshot → vote on PRs → move in the world → repeat.

The loop is self-driving. Claude reschedules itself after every iteration via the harness. You do not need to do anything.

## How to stop

In Claude Code, type:

```
/end
```

This shuts down the agent server and ends the loop. Nothing else will stop it.

## Customize your character

Edit `agent/character.md` to change your character's name, personality, and goals. The agent reads this at startup and stays in character throughout the session.

## Manual server control

If you need to manage the agent server directly:

```bash
# Start manually
cd agent && CHARACTER_NAME=<name> node server.js

# Health check
curl http://localhost:7979/health

# Take a screenshot
curl http://localhost:7979/screenshot -o /tmp/game.png

# Press keys
curl -X POST http://localhost:7979/press -H "Content-Type: application/json" -d '{"keys": ["w"], "duration": 500}'

# Stop
curl -X POST http://localhost:7979/quit
```

## Dependencies

```bash
cd agent && npm install && npx playwright install chromium
```
