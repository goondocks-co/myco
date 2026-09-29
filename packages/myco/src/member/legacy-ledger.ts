/**
 * What a 1.4 vault import has done, per Deployment and Project, kept on this
 * machine.
 *
 * One append-only file per Project under
 * `<MYCO_HOME>/member/legacy/<deployment key>/<projectId>.jsonl`. Each line
 * records one fact the moment it becomes true: where a session's content was
 * decided to come from, a session finished, a spore or a history event
 * recorded, a session 1.4 deleted. Two readers:
 *
 *   - the vault import, which resumes from it and never decides a session's
 *     content source twice, so a transcript that appears mid-run cannot give a
 *     session a second source;
 *   - the transcript import, which leaves out every session whose content came
 *     from the vault and every session 1.4 deleted, on every later run.
 *
 * A line that does not parse is skipped: the ledger only ever saves work, and
 * a lost line costs one repeated request the Deployment answers as held.
 */
import fs from 'node:fs';
import path from 'node:path';
import { deploymentKeyFor } from './registry.js';
import { ensureMemberDir, ensurePrivateFile, memberRoot } from './store.js';

const LEGACY_DIRNAME = 'legacy';
const LEDGER_EXTENSION = '.jsonl';

/** Where a session's content comes from: its transcript, the vault's prompts, or nowhere because it is deleted. */
export type ContentSource = 'transcript' | 'vault' | 'deleted';

export type LedgerLine =
  | { k: 'source'; session: string; from: ContentSource }
  | { k: 'session'; session: string }
  | { k: 'spore'; id: string }
  | { k: 'lineage'; id: string };

export interface LedgerState {
  sources: Map<string, ContentSource>;
  sessions: Set<string>;
  spores: Set<string>;
  lineage: Set<string>;
}

const ledgerDir = (mycoHome: string, serverUrl: string): string => path.join(memberRoot(mycoHome), LEGACY_DIRNAME, deploymentKeyFor(serverUrl));

const parseLine = (raw: string): LedgerLine | null => {
  try {
    const value = JSON.parse(raw) as Partial<LedgerLine> & Record<string, unknown>;
    if (value.k === 'source' && typeof value.session === 'string' && ['transcript', 'vault', 'deleted'].includes(value.from as string)) return value as LedgerLine;
    if (value.k === 'session' && typeof value.session === 'string') return value as LedgerLine;
    if ((value.k === 'spore' || value.k === 'lineage') && typeof value.id === 'string') return value as LedgerLine;
    return null;
  } catch {
    return null;
  }
};

/** One Project's ledger on one Deployment. */
export class LegacyLedger {
  readonly file: string;

  constructor(private readonly mycoHome: string, serverUrl: string, readonly projectId: string) {
    this.file = path.join(ledgerDir(mycoHome, serverUrl), `${projectId}${LEDGER_EXTENSION}`);
  }

  /** What the ledger holds; empty when there is none. */
  read(): LedgerState {
    const state: LedgerState = { sources: new Map(), sessions: new Set(), spores: new Set(), lineage: new Set() };
    let text: string;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return state; }
    for (const raw of text.split('\n')) {
      const line = raw.trim() === '' ? null : parseLine(raw);
      if (line === null) continue;
      if (line.k === 'source') state.sources.set(line.session, line.from);
      else if (line.k === 'session') state.sessions.add(line.session);
      else if (line.k === 'spore') state.spores.add(line.id);
      else state.lineage.add(line.id);
    }
    return state;
  }

  /** Record facts, in order, before the caller moves on. */
  append(...lines: LedgerLine[]): void {
    if (lines.length === 0) return;
    ensureMemberDir(path.dirname(this.file), this.mycoHome);
    ensurePrivateFile(this.file);
    fs.appendFileSync(this.file, lines.map((l) => `${JSON.stringify(l)}\n`).join(''));
  }
}

/**
 * Every session a transcript import on this Deployment leaves out: its content
 * came from a 1.4 vault, or 1.4 deleted it. Read from every Project's ledger,
 * since a transcript is placed after the vault decided.
 */
export function legacySessionsToLeaveOut(mycoHome: string, serverUrl: string): Set<string> {
  const out = new Set<string>();
  const dir = ledgerDir(mycoHome, serverUrl);
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith(LEDGER_EXTENSION)) continue;
    const state = new LegacyLedger(mycoHome, serverUrl, name.slice(0, -LEDGER_EXTENSION.length)).read();
    for (const [session, from] of state.sources) if (from !== 'transcript') out.add(session);
  }
  return out;
}
