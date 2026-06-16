import { createServer } from "http";
import { readdir, stat, readFile, open } from "fs/promises";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = join(__dirname, "agents");
const CLAUDE_PROJECTS_DIR = join(homedir(), ".claude", "projects");
const PORT = process.env.INSPECT_PORT || 7970;

function agentToProjectDir(agentCwd) {
  const encoded = agentCwd.replace(/\//g, "-");
  return join(CLAUDE_PROJECTS_DIR, encoded);
}

async function listAgents() {
  const names = new Set();

  try {
    const entries = await readdir(AGENTS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) names.add(e.name);
    }
  } catch {}

  const prefix = join(__dirname, "agents").replace(/\//g, "-");
  try {
    const entries = await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(prefix)) {
        const name = e.name.slice(prefix.length + 1);
        if (name) names.add(name);
      }
    }
  } catch {}

  return [...names].sort();
}

async function peekSessionStart(file) {
  try {
    const fd = await open(file, "r");
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await fd.read(buf, 0, 4096, 0);
    await fd.close();
    const text = buf.slice(0, bytesRead).toString("utf8");
    const firstLine = text.split("\n")[0];
    const obj = JSON.parse(firstLine);
    return obj.timestamp || null;
  } catch {
    return null;
  }
}

async function countAssistantTurns(file) {
  try {
    const text = await readFile(file, "utf8");
    let count = 0;
    let idx = 0;
    while ((idx = text.indexOf('"type":"assistant"', idx)) !== -1) {
      count++;
      idx += 19;
    }
    return count;
  } catch {
    return 0;
  }
}

async function getAgentSessions(agentName) {
  const projectDir = agentToProjectDir(join(__dirname, "agents", agentName));
  let files = [];
  try {
    const entries = await readdir(projectDir);
    files = entries.filter((f) => f.endsWith(".jsonl")).map((f) => join(projectDir, f));
  } catch {
    return [];
  }
  const sessions = [];
  await Promise.all(
    files.map(async (f) => {
      try {
        const s = await stat(f);
        if (s.size < 8192) return; // skip tiny files — always rate-limit hits
        const turnCount = await countAssistantTurns(f);
        if (turnCount === 0) return; // skip empty/rate-limited sessions
        const sessionStart = await peekSessionStart(f);
        sessions.push({ file: f, mtime: s.mtime, size: s.size, sessionStart, turnCount });
      } catch {}
    })
  );
  // most recent first
  sessions.sort((a, b) => new Date(b.sessionStart || b.mtime) - new Date(a.sessionStart || a.mtime));
  return sessions;
}

function classifyStep(content) {
  let stepType = "thinking";
  const tools = [];

  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "tool_use") {
      const input = block.input || {};
      if (block.name === "Bash") {
        const rawCmd = input.command || "";
        const c = rawCmd.toLowerCase();
        let label = rawCmd.slice(0, 100);
        if (c.includes("submit-idea")) {
          const m = rawCmd.match(/"description"\s*:\s*"([^"]{1,120})/);
          label = m ? `submit-idea: "${m[1]}"` : "submit-idea";
          stepType = "propose";
        } else if (c.includes("vote-idea")) {
          const m = rawCmd.match(/"ideaId"\s*:\s*"([^"]+)"/);
          label = m ? `vote: ${m[1].slice(0, 8)}…` : "vote-idea";
          if (stepType === "thinking") stepType = "vote";
        } else if (c.includes("/screenshot")) stepType = "screenshot";
        else if (c.includes("/press")) stepType = "press";
        else if (c.includes("/state")) stepType = "state";
        else if (c.includes("/compact")) stepType = "compact";
        else if (c.includes("gh pr")) stepType = "pr";
        else if (stepType === "thinking") stepType = "bash";
        tools.push({ name: "Bash", cmd: label });
      } else if (block.name === "Agent" || block.name === "TaskCreate") {
        const prompt = input.prompt || "";
        const ideaMatch = prompt.match(/idea\/([a-f0-9-]{8,})/);
        const descMatch = prompt.match(/Implement:\s*([^\n]{1,120})/);
        const label = ideaMatch
          ? `spawn PR: idea/${ideaMatch[1].slice(0, 8)}… ${descMatch ? "— " + descMatch[1].slice(0, 80) : ""}`
          : (input.description || "spawn agent").slice(0, 100);
        tools.push({ name: "Agent", cmd: label });
        stepType = "spawn";
      } else {
        const cmd = input.file_path || JSON.stringify(input).slice(0, 80);
        tools.push({ name: block.name, cmd });
      }
    } else if (block.type === "text" && block.text) {
      tools.push({ name: "text", cmd: block.text.slice(0, 80) });
    }
  }

  return { stepType, tools };
}

async function parseSession(file) {
  const text = await readFile(file, "utf8");
  const lines = text.split("\n").filter((l) => l.trim());
  const turns = [];

  for (const line of lines) {
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }

    if (obj.type !== "assistant") continue;
    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;

    const { stepType, tools } = classifyStep(content);
    const usage = obj.message?.usage || {};

    turns.push({
      timestamp: obj.timestamp,
      stepType,
      tools,
      input_tokens: usage.input_tokens || 0,
      output_tokens: usage.output_tokens || 0,
      cache_read_input_tokens: usage.cache_read_input_tokens || 0,
      cache_creation_input_tokens: usage.cache_creation_input_tokens || 0,
    });
  }

  return turns;
}

function validateStepOrder(turns) {
  const violations = [];
  let lastWasState = false;
  let sawStateThisCycle = false;

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.stepType === "state") {
      sawStateThisCycle = true;
    } else if (t.stepType === "screenshot" || t.stepType === "press") {
      if (!sawStateThisCycle) {
        violations.push({ index: i, reason: `${t.stepType} without a preceding /state check` });
      }
    }
    if (t.stepType === "compact") sawStateThisCycle = false;
  }

  return violations;
}

function enrichTurns(turns) {
  let cumulative = 0;
  return turns.map((t) => {
    const costProxy = t.input_tokens + t.output_tokens + t.cache_read_input_tokens / 10;
    cumulative += costProxy;
    return { ...t, costProxy, cumulative };
  });
}

const STEP_COLORS = {
  state: "#5b8def",
  screenshot: "#e0a843",
  press: "#6fcf97",
  propose: "#bb6bd9",
  vote: "#9b59b6",
  spawn: "#eb5757",
  pr: "#eb5757",
  compact: "#f2994a",
  bash: "#888",
  thinking: "#555",
};

const HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Living Game — Agent Inspector</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, system-ui, sans-serif; background: #111; color: #eee; display: flex; height: 100vh; }
  #sidebar { width: 280px; background: #1a1a1a; overflow-y: auto; border-right: 1px solid #333; flex-shrink: 0; }
  #sidebar h2 { font-size: 13px; text-transform: uppercase; color: #888; padding: 12px 14px 4px; margin: 0; }
  .agent { padding: 8px 14px; cursor: pointer; border-bottom: 1px solid #222; }
  .agent:hover { background: #222; }
  .agent.active { background: #2a2a3a; }
  .session { padding: 6px 14px 6px 26px; cursor: pointer; font-size: 12px; color: #aaa; border-bottom: 1px solid #1e1e1e; }
  .session:hover { background: #222; }
  .session.active { background: #2a2a3a; color: #fff; }
  #main { flex: 1; overflow-y: auto; padding: 16px 24px; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid #2a2a2a; vertical-align: top; }
  th { color: #888; font-weight: 500; position: sticky; top: 0; background: #111; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 11px; color: #111; font-weight: 600; }
  .violation { background: #3a1f1f !important; }
  #stats { display: flex; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
  .stat { background: #1a1a1a; padding: 10px 16px; border-radius: 8px; }
  .stat .label { font-size: 11px; color: #888; text-transform: uppercase; }
  .stat .value { font-size: 20px; font-weight: 600; }
  .tools { font-size: 11px; color: #999; font-family: monospace; white-space: pre-wrap; max-width: 480px; }
  #placeholder { color: #666; padding: 40px; text-align: center; }
  a { color: #5b8def; text-decoration: none; }
</style>
</head>
<body>
<div id="sidebar"><h2>Agents</h2><div id="agentList">Loading…</div></div>
<div id="main"><div id="placeholder">Select an agent session to inspect.</div></div>
<script>
let currentAgent = null;
let currentSessions = [];

async function loadAgents() {
  const res = await fetch("/api/agents");
  const agents = await res.json();
  const list = document.getElementById("agentList");
  list.innerHTML = "";
  for (const a of agents) {
    const div = document.createElement("div");
    div.className = "agent";
    div.textContent = a.name;
    div.onclick = () => selectAgent(a.name, div);
    list.appendChild(div);

    const sessWrap = document.createElement("div");
    sessWrap.style.display = "none";
    sessWrap.id = "sessions-" + a.name;
    list.appendChild(sessWrap);
  }
}

async function selectAgent(name, el) {
  document.querySelectorAll(".agent").forEach((e) => e.classList.remove("active"));
  el.classList.add("active");
  currentAgent = name;
  const res = await fetch("/api/agents");
  const agents = await res.json();
  const agent = agents.find((a) => a.name === name);
  currentSessions = agent.sessions || [];

  document.querySelectorAll(".session").forEach((e) => e.remove());
  let after = el;
  for (const s of currentSessions) {
    const div = document.createElement("div");
    div.className = "session";
    const date = s.sessionStart ? new Date(s.sessionStart).toLocaleString() : new Date(s.mtime).toLocaleString();
    div.textContent = date + " — " + s.turnCount + " turns";
    div.onclick = (e) => {
      e.stopPropagation();
      document.querySelectorAll(".session").forEach((x) => x.classList.remove("active"));
      div.classList.add("active");
      loadSession(name, s.file);
    };
    after.after(div);
    after = div;
  }
}

async function loadSession(agentName, file) {
  const main = document.getElementById("main");
  main.innerHTML = "<div id='placeholder'>Loading…</div>";
  const res = await fetch("/api/session?agent=" + encodeURIComponent(agentName) + "&file=" + encodeURIComponent(file));
  const data = await res.json();
  renderSession(data);
}

function renderSession(data) {
  const main = document.getElementById("main");
  const turns = data.turns || [];
  const violations = new Set((data.violations || []).map((v) => v.index));

  const totalIn = turns.reduce((s, t) => s + t.input_tokens, 0);
  const totalOut = turns.reduce((s, t) => s + t.output_tokens, 0);
  const totalCacheRead = turns.reduce((s, t) => s + t.cache_read_input_tokens, 0);
  const byType = {};
  for (const t of turns) {
    byType[t.stepType] = (byType[t.stepType] || 0) + t.output_tokens;
  }

  let html = '<div id="stats">';
  html += statCard("Turns", turns.length);
  html += statCard("Input tokens", totalIn.toLocaleString());
  html += statCard("Output tokens", totalOut.toLocaleString());
  html += statCard("Cache read tokens", totalCacheRead.toLocaleString());
  html += statCard("Step-order violations", violations.size);
  html += "</div>";

  html += "<table><thead><tr><th>#</th><th>Time</th><th>Step</th><th>Tools</th><th>In</th><th>Out</th><th>Cache R</th><th>Cache W</th></tr></thead><tbody>";
  turns.forEach((t, i) => {
    const color = ${JSON.stringify(STEP_COLORS)}[t.stepType] || "#555";
    const cls = violations.has(i) ? "violation" : "";
    const toolsStr = (t.tools || []).map((x) => x.name + ": " + x.cmd).join("\\n");
    html += "<tr class='" + cls + "'><td>" + i + "</td><td>" + (t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : "") + "</td>";
    html += "<td><span class='badge' style='background:" + color + "'>" + t.stepType + "</span></td>";
    html += "<td class='tools'>" + escapeHtml(toolsStr) + "</td>";
    html += "<td>" + t.input_tokens + "</td><td>" + t.output_tokens + "</td><td>" + t.cache_read_input_tokens + "</td><td>" + t.cache_creation_input_tokens + "</td></tr>";
  });
  html += "</tbody></table>";

  main.innerHTML = html;
}

function statCard(label, value) {
  return "<div class='stat'><div class='label'>" + label + "</div><div class='value'>" + value + "</div></div>";
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

loadAgents();
</script>
</body>
</html>`;

async function handleRequest(req, res) {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML);
    return;
  }

  if (url.pathname === "/api/agents") {
    const names = await listAgents();
    const agents = await Promise.all(
      names.map(async (name) => {
        const sessions = await getAgentSessions(name);
        const latest = sessions[0]; // getAgentSessions already sorts most-recent-first
        return {
          name,
          latestActivity: latest ? new Date(latest.sessionStart || latest.mtime).getTime() : 0,
          sessions: sessions.map((s) => ({ file: s.file, mtime: s.mtime, size: s.size, sessionStart: s.sessionStart, turnCount: s.turnCount })),
        };
      })
    );
    agents.sort((a, b) => b.latestActivity - a.latestActivity);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(agents));
    return;
  }

  if (url.pathname === "/api/session") {
    const file = url.searchParams.get("file");
    if (!file) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "missing file param" }));
      return;
    }
    try {
      const rawTurns = await parseSession(file);
      const violations = validateStepOrder(rawTurns);
      const turns = enrichTurns(rawTurns);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ turns, violations }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end("not found");
}

createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    res.writeHead(500);
    res.end(String(err));
  });
}).listen(PORT, () => {
  console.log(`Inspector running at http://localhost:${PORT}`);
});
