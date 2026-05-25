#!/usr/bin/env bun
// Deduplicate session buffer file. The bug was: 6 stale Claude hook
// entries fired per user prompt, each writing to the same buffer file.
// Keep first occurrence of each event by content; drop the rest.
//
// Dedup key intentionally OMITS timestamp — multiple fires of the same
// hook produce the same event content with slightly different
// timestamps; that's what we want collapsed.
//
// Run with --apply to write; default writes nothing.
import fs from 'node:fs';

const BUFFER = '/Users/chris/.myco/groves/grove_b7e9d7eb502816dafb8ae9eebe5bfa25/projects/proj_ecfd2c27e50729848003a856c1c3747e/buffer/90f7ca3f-9835-47b6-803a-1ec82316dc13.jsonl';
const APPLY = process.argv.includes('--apply');

const raw = fs.readFileSync(BUFFER, 'utf8');
const lines = raw.split('\n').filter((l) => l.trim());
console.log(`lines: ${lines.length}`);

// Key = type + content fingerprint. Excludes timestamp so duplicate
// fires of the same hook collapse to the first.
function keyFor(line) {
  let e;
  try { e = JSON.parse(line); } catch { return line; }
  const parts = [e.type ?? ''];
  if (e.type === 'user_prompt') parts.push((e.prompt ?? '').slice(0, 512));
  else if (e.type === 'tool_use') parts.push(e.tool_name ?? '', JSON.stringify(e.tool_input ?? '').slice(0, 512));
  else if (e.type === 'tool_failure') parts.push(e.tool_name ?? '', JSON.stringify(e.tool_input ?? '').slice(0, 512), e.error ?? '');
  else if (e.type === 'stop') parts.push((e.last_assistant_message ?? '').slice(0, 512));
  else parts.push(JSON.stringify(e).slice(0, 512));
  return parts.join('\0');
}

const seen = new Set();
const kept = [];
const dropped = { byType: {}, total: 0 };

for (const line of lines) {
  const k = keyFor(line);
  if (seen.has(k)) {
    dropped.total++;
    let t;
    try { t = JSON.parse(line).type; } catch { t = '?'; }
    dropped.byType[t] = (dropped.byType[t] ?? 0) + 1;
    continue;
  }
  seen.add(k);
  kept.push(line);
}

console.log(`kept: ${kept.length}`);
console.log(`dropped: ${dropped.total}`);
console.log('dropped by type:', dropped.byType);

if (APPLY) {
  fs.writeFileSync(BUFFER + '.new', kept.join('\n') + '\n', 'utf8');
  fs.renameSync(BUFFER + '.new', BUFFER);
  console.log('WROTE', BUFFER);
} else {
  console.log('(dry run; pass --apply to write)');
}
