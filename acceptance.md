# Acceptance: auto-loop-start

## What this task is about

When a user types `/start` in Claude Code, the game loop runs continuously and autonomously — screenshot, vote, act, reschedule — without any user interaction, until they type `/end`.

## User flows

### Starting the game
1. User types `/start` in Claude Code.
2. Agent checks if agent server is running, starts it if not.
3. Agent reads character.md and controls.md.
4. Agent enters the loop: screenshot → check votes → act in world.
5. At the END of each iteration, the agent calls `Skill({skill: "loop", args: "/start"})` to reschedule itself via the harness ScheduleWakeup mechanism.
6. User does nothing. Loop continues autonomously across turns.

### Stopping the game
1. User types `/end` in Claude Code.
2. `/end` command does NOT reschedule the loop (no loop skill call).
3. `/end` calls `curl -s -X POST http://localhost:7979/quit` to shut down the agent server.
4. Agent says a closing in-character line.
5. Loop stops. No further screenshots or actions happen.

## Edge cases

- If agent server is already running when `/start` is called, it skips setup and goes straight to loop.
- If agent server is already stopped when `/end` is called, the quit call may fail gracefully — that's fine.
- Claude must never pause mid-loop to ask the user a question. If stuck (two identical screenshots), pick a random different direction and continue.
- Vote decisions are made in character without hesitation.

## Definition of done

1. `~/.claude/commands/start.md` ends each loop iteration by calling `Skill({skill: "loop", args: "/start"})`.
2. `~/.claude/commands/start.md` has NO old "Stopping" section with `curl -X POST http://localhost:7979/quit` — replaced with a note: "To stop, type `/end` in Claude Code."
3. `~/.claude/commands/start.md` contains NO question-asking language mid-loop (no "ask", "wait for user", "check with user", etc.).
4. `~/.claude/commands/end.md` exists with: (a) no loop skill call, (b) `curl -s -X POST http://localhost:7979/quit`, (c) an in-character closing line.
5. `agent/README.md` exists and documents `/start` and `/end`.
6. `npm run build` passes.
