# Acceptance: agent-memory

## What a memory entry looks like

Each entry is a single sentence prefixed with the date in `YYYY-MM-DD` format, written under the relevant section header. Examples:

```
## Encounters
- 2026-05-28: Met Zara the Explorer near the cave; she favors world-expansion PRs.

## PRs
- 2026-05-28: Voted yes on PR #12 (campfire mechanic) — aligned with my builder goals.

## Places
- 2026-05-28: Discovered the river in the northeast corner; want to revisit.

## Goals in Progress
- 2026-05-28: Working toward establishing a trade route between the campfire and the cave.
```

## When notes are written

Notes are appended during the active session loop after meaningful events:
- **Encounters**: when the agent sees another named player on screen or reads their name in a vote context.
- **PRs**: after casting every vote — one line capturing the PR number and the reasoning.
- **Places**: when the agent discovers something it considers notable (a new landmark, an area it wants to revisit).
- **Goals in Progress**: when the agent decides on a new objective or makes meaningful progress on one.

Notes are appended via a `Bash` tool call. The agent does not rewrite the whole file; it appends a line under the correct section.

## How memory affects the next session

At session start (before the loop), the agent reads `~/projects/living-game/main/agent/memory.md` if it exists and uses the contents to:
- Recall players it has met and their tendencies when encountering them again.
- Avoid re-voting on PRs it has already voted on (cross-reference the PRs section).
- Return to places it noted as interesting.
- Resume working toward goals listed under Goals in Progress.

If the file does not exist, the agent starts fresh with no prior context.

## Definition of done

1. `~/projects/living-game/main/agent/memory.md` exists as a template file with all four sections and placeholder text.
2. `agent/memory.md` is listed in `.gitignore` so it is never committed.
3. `~/.claude/commands/start.md` reads `memory.md` at session start (before the loop) and uses it to orient the character.
4. `~/.claude/commands/start.md` instructs the agent to append a note after each meaningful event during the loop.
5. Notes written in one session are visible when the agent reads the file at the start of the next session.
6. `npm run build` passes.
