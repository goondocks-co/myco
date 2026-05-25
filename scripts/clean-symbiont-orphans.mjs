#!/usr/bin/env node
/**
 * Remove orphan Myco hook entries from every JSON-merge symbiont's
 * global settings file.
 *
 * Two on-disk shapes:
 *   - Nested (claude-code, codex, copilot):
 *       hooks.<Event> = [{matcher?, hooks: [{type:"command", command:"..."}]}, ...]
 *   - Flat (cursor, windsurf):
 *       hooks.<event> = [{command:"...", type?, timeout?}, ...]
 *
 * Rule:
 *   1. A hook entry is Myco-owned when its command string contains
 *      'launcher.cjs' AND ('--symbiont' OR 'myco-hook' OR 'myco-run').
 *   2. Of Myco-owned entries, only those whose command contains the
 *      canonical path (/Users/chris/.myco/launcher.cjs) are kept;
 *      at most ONE per event (the first encountered).
 *   3. Non-Myco entries (GitKraken, Superset, etc.) are untouched.
 */
import fs from 'node:fs';

const TARGETS = [
  { path: '/Users/chris/.cursor/hooks.json',                shape: 'flat'   },
  { path: '/Users/chris/.codex/hooks.json',                 shape: 'nested' },
  { path: '/Users/chris/.copilot/hooks/myco-hooks.json',    shape: 'nested' },
  { path: '/Users/chris/.codeium/windsurf/hooks.json',      shape: 'flat'   },
];

const CANONICAL = '/Users/chris/.myco/launcher.cjs';
const APPLY = process.argv.includes('--apply');

function isMycoCmd(cmd) {
  if (typeof cmd !== 'string') return false;
  return cmd.includes('launcher.cjs') && (cmd.includes('--symbiont') || cmd.includes('myco-hook') || cmd.includes('myco-run'));
}
function isCanonical(cmd) {
  return typeof cmd === 'string' && cmd.includes(CANONICAL);
}

function cleanNestedEvent(groups) {
  if (!Array.isArray(groups)) return { kept: groups, dropped: 0 };
  const out = [];
  let canonicalSeen = false;
  let dropped = 0;
  for (const group of groups) {
    const inner = Array.isArray(group?.hooks) ? group.hooks : [];
    const isMyco = inner.some((h) => isMycoCmd(h?.command));
    if (!isMyco) {
      out.push(group);
      continue;
    }
    const allCanonical = inner.every((h) => !isMycoCmd(h?.command) || isCanonical(h?.command));
    if (allCanonical && !canonicalSeen) {
      out.push(group);
      canonicalSeen = true;
    } else {
      dropped++;
    }
  }
  return { kept: out, dropped };
}

function cleanFlatEvent(entries) {
  if (!Array.isArray(entries)) return { kept: entries, dropped: 0 };
  const out = [];
  let canonicalSeen = false;
  let dropped = 0;
  for (const entry of entries) {
    const cmd = entry?.command;
    if (!isMycoCmd(cmd)) {
      out.push(entry);
      continue;
    }
    if (isCanonical(cmd) && !canonicalSeen) {
      out.push(entry);
      canonicalSeen = true;
    } else {
      dropped++;
    }
  }
  return { kept: out, dropped };
}

for (const target of TARGETS) {
  if (!fs.existsSync(target.path)) {
    console.log(`SKIP (missing): ${target.path}`);
    continue;
  }
  const settings = JSON.parse(fs.readFileSync(target.path, 'utf8'));
  const hooks = settings.hooks ?? {};
  const summary = { events: {}, totalDropped: 0 };
  for (const [event, value] of Object.entries(hooks)) {
    const { kept, dropped } = target.shape === 'nested'
      ? cleanNestedEvent(value)
      : cleanFlatEvent(value);
    if (dropped > 0) {
      summary.events[event] = { before: value.length, after: kept.length, dropped };
      summary.totalDropped += dropped;
    }
    hooks[event] = kept;
  }
  settings.hooks = hooks;
  console.log(`--- ${target.path} (${target.shape})`);
  if (summary.totalDropped === 0) {
    console.log('  no changes');
  } else {
    console.log(`  dropped ${summary.totalDropped} orphan entries across ${Object.keys(summary.events).length} events`);
    for (const [evt, s] of Object.entries(summary.events)) {
      console.log(`    ${evt}: ${s.before} -> ${s.after} (-${s.dropped})`);
    }
  }
  if (APPLY && summary.totalDropped > 0) {
    fs.writeFileSync(target.path, JSON.stringify(settings, null, 2) + '\n', 'utf8');
    console.log(`  WROTE ${target.path}`);
  }
}

if (!APPLY) console.log('\n(dry run; pass --apply to write)');
