#!/usr/bin/env tsx
/**
 * Capture fidelity audit — developer entry point.
 *
 * Read-only. Answers "is what we captured correct and complete?", which is a
 * different question from `debug-capture`'s "why did capture stop?". Drive it
 * through the `audit-capture-fidelity` skill, which explains how to read the
 * findings and which fixes apply.
 *
 *   tsx scripts/capture-audit.ts --grove <path-to-myco.db> [--project proj_…]
 *                               [--symbiont codex] [--since 2026-07-01] [--json]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { repair, runAudit } from '../packages/myco/src/capture/audit/index.js';
import { resolveRuntimeHome } from '../packages/myco/src/daemon/update-checker.js';
import type { AuditReport, Finding } from '../packages/myco/src/capture/audit/index.js';

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

/**
 * Apply the project's runtime home pin before anything reads MYCO_HOME.
 *
 * Launchers (`myco`, `myco-run`, the `myco-dev` wrapper) resolve
 * `.myco/runtime.home` and export MYCO_HOME before exec, so everything
 * downstream sees the right install. A script invoked directly skips that
 * layer, so without this it reads the default `~/.myco` while auditing a
 * Grove that belongs to a pinned dev home — reporting on one installation
 * while analysing another.
 *
 * `resolveRuntimeHome` is the same layered, trust-checked reader the daemon
 * uses; an explicit MYCO_HOME still wins, exactly as it does for a launcher.
 */
function applyRuntimeHomePin(): void {
  if (process.env.MYCO_HOME?.trim()) return;
  const pinned = resolveRuntimeHome(path.join(process.cwd(), '.myco'));
  if (pinned) process.env.MYCO_HOME = pinned;
}

/** Groves live under <MYCO_HOME>/groves/<groveId>/myco.db. */
function discoverGroves(): string[] {
  const homes = [process.env.MYCO_HOME, path.join(os.homedir(), '.myco'), path.join(os.homedir(), '.myco-dev')]
    .filter((h): h is string => Boolean(h));
  const found: string[] = [];
  for (const home of homes) {
    const grovesDir = path.join(home, 'groves');
    let entries: string[];
    try {
      entries = fs.readdirSync(grovesDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const db = path.join(grovesDir, entry, 'myco.db');
      if (fs.existsSync(db) && !found.includes(db)) found.push(db);
    }
  }
  return found;
}

const SEVERITY_MARK = { high: '!!', medium: ' !', low: '  ' } as const;

function renderFinding(f: Finding): string {
  const scope = f.symbiont ? ` [${f.symbiont}]` : '';
  const when =
    f.lastSeen !== undefined
      ? `  last seen ${new Date(f.lastSeen * 1000).toISOString().slice(0, 10)}`
      : '';
  return [
    `${SEVERITY_MARK[f.severity]} ${f.title}${scope}`,
    `     ${f.count} row(s) · ${f.layer} · ${f.recency.toUpperCase()}${when}`,
    `     ${f.detail}`,
    f.samples.length ? `     e.g. ${f.samples.slice(0, 3).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function render(report: AuditReport): string {
  const lines: string[] = [];
  lines.push(`Capture fidelity audit — ${new Date(report.generatedAt * 1000).toISOString()}`);
  lines.push(`vault: ${report.dbPath}`);
  if (report.projectId) lines.push(`project: ${report.projectId}`);

  const mining = report.symbionts.filter((s) => s.model === 'hook-and-mining').map((s) => s.name);
  const plugin = report.symbionts.filter((s) => s.model === 'plugin-reported').map((s) => s.name);
  lines.push(`capture models — mining: ${mining.join(', ')} | plugin-reported: ${plugin.join(', ')}`);
  lines.push('');

  // Lead with the active/legacy split: it changes what a human is being asked
  // to approve. A legacy backlog is bounded cleanup; an active one means the
  // code fix comes first and repairing rows would mask it.
  const active = report.findings.filter((f) => f.recency === 'active');
  const legacy = report.findings.filter((f) => f.recency === 'legacy');
  const unknown = report.findings.filter((f) => f.recency === 'unknown');

  const section = (title: string, findings: Finding[], note: string) => {
    if (findings.length === 0) return;
    lines.push(`── ${title} (${findings.length}) ──`);
    lines.push(note);
    lines.push('');
    for (const f of findings) {
      lines.push(renderFinding(f));
      lines.push('');
    }
  };

  section('ACTIVE', active, '   Still occurring. Fix the code path before repairing rows.');
  section('LEGACY', legacy, '   No longer occurring. Bounded cleanup — safe to repair.');
  section('UNCLASSIFIED', unknown, '   No timestamps available to date these.');

  if (report.findings.length === 0) lines.push('No findings.');

  if (report.coverage.length > 0) {
    lines.push(`── NOT COVERED (${report.coverage.length}) ──`);
    lines.push('   Read this before treating the above as a clean bill of health.');
    lines.push('');
    for (const gap of report.coverage) {
      lines.push(`   ${gap.symbiont ? `[${gap.symbiont}] ` : ''}${gap.scope}: ${gap.reason}`);
    }
  }
  return lines.join('\n');
}

applyRuntimeHomePin();

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  console.log(
    'usage: bun scripts/capture-audit.ts [--grove <myco.db>] [--project <id>] [--symbiont <name>] [--since YYYY-MM-DD] [--stale-threshold-ms N] [--json]\n' +
    '       bun scripts/capture-audit.ts --grove <myco.db> --repair <finding-id> [--apply]\n\n' +
    'Repair is dry-run unless --apply is passed, and takes a .bak of the vault before writing.',
  );
  process.exit(0);
}

const groves = typeof args.grove === 'string' ? [args.grove] : discoverGroves();
if (groves.length === 0) {
  console.error('No grove database found. Pass --grove <path-to-myco.db>.');
  process.exit(1);
}

if (typeof args.repair === 'string') {
  if (groves.length !== 1) {
    console.error('Repair needs exactly one --grove; refusing to write across groves.');
    process.exit(1);
  }
  const plan = repair({
    dbPath: groves[0]!,
    findingId: args.repair,
    ...(typeof args.project === 'string' ? { projectId: args.project } : {}),
    apply: args.apply === true,
  });

  if (!plan.supported) {
    console.error(`Refusing to repair ${plan.findingId}:\n\n  ${plan.refusal}`);
    process.exit(1);
  }
  console.log(`${plan.findingId}: ${plan.rowCount} row(s) would change`);
  for (const change of plan.changes.slice(0, 50)) console.log(`  ${change}`);
  if (plan.changes.length > 50) console.log(`  … and ${plan.changes.length - 50} more`);
  if (plan.requiresConfirmation && !plan.applied) {
    console.log('\nOver the confirmation threshold — review the list above before re-running with --apply.');
  }
  console.log(plan.applied ? `\nApplied. Backup: ${plan.backupPath}` : '\nDry run — nothing written. Re-run with --apply to write.');
  process.exit(0);
}

for (const dbPath of groves) {
  const report = runAudit({
    dbPath,
    ...(typeof args.project === 'string' ? { projectId: args.project } : {}),
    ...(typeof args.symbiont === 'string' ? { symbiont: args.symbiont } : {}),
    ...(typeof args.since === 'string'
      ? { since: Math.floor(new Date(args.since).getTime() / 1000) }
      : {}),
  }, typeof args['stale-threshold-ms'] === 'string'
    ? { staleThresholdMs: Number(args['stale-threshold-ms']) }
    : undefined);
  console.log(args.json ? JSON.stringify(report, null, 2) : render(report));
  if (groves.length > 1) console.log('\n' + '='.repeat(72) + '\n');
}
