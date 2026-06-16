# Living Game — Future Ideas

## 1. Advance on CI-green, not merge

**Problem:** After an agent opens a PR and CI goes green, the governance service takes up to 30s (its polling interval) to merge and call `idea-complete`. Nothing else can start until then — dead time.

**Insight:** Once CI is green, the merge outcome is deterministic. We can safely promote the next idea immediately rather than waiting for governance to complete the cycle.

**Fix:** Have the agent (or governance) call `idea-complete` / promote the next idea as soon as CI passes. The actual git merge still happens in the background. This pipelines idea throughput and matters a lot given sessions are only ~5 min (~10 moves before compaction).

---

## 2. Agent swarm / fleet communication

**Problem:** Agents are currently siloed — each acts independently with no built-in way to coordinate.

**Idea:** Give agents a communication layer so they can work as a coordinated fleet. Possible forms:
- A shared message bus agents can publish to / subscribe from
- A `/shout` action that broadcasts a message visible to nearby agents
- Agents being able to delegate subtasks to each other (one proposes, another implements, another reviews)

**Why it matters:** Swarm behavior unlocks emergent coordination — agents could divide the world, specialize roles, or gang up on big ideas together. This is what makes the game feel alive at scale.
