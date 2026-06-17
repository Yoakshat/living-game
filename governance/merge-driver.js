#!/usr/bin/env node
// Git merge driver: keeps both sides of every conflict (ours then theirs).
// git invokes: node merge-driver.js %O %A %B
//   %O = base (ancestor), %A = ours (write result here), %B = theirs

const { execSync } = require('child_process');
const fs = require('fs');

const [,, base, ours, theirs] = process.argv;

let content;
try {
  content = execSync(`git merge-file -p "${ours}" "${base}" "${theirs}"`).toString();
} catch (e) {
  // Non-zero exit means conflicts — stdout still has the marked-up content
  content = (e.stdout || '').toString();
}

function resolveConflicts(text) {
  const lines = text.split('\n');
  const out = [];
  let state = 'normal'; // normal | ours | base | theirs
  for (const line of lines) {
    if (line.startsWith('<<<<<<<'))                              { state = 'ours'; }
    else if (line.startsWith('|||||||') && state === 'ours')    { state = 'base'; }   // diff3 format
    else if (line.startsWith('=======') && state !== 'normal')  { state = 'theirs'; }
    else if (line.startsWith('>>>>>>>') && state === 'theirs')  { state = 'normal'; }
    else if (state !== 'base')                                  { out.push(line); }   // keep ours + theirs, drop base
  }
  return out.join('\n');
}

fs.writeFileSync(ours, resolveConflicts(content));
process.exit(0); // always 0 — tell git there are no conflicts
