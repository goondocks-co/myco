/**
 * The feature-preservation ledger (`docs/architecture/myco-2.0.md` §7), as the gates read it: its closed vocabularies
 * and its rows, each with the §7 section it sits in.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const LEDGER_PATH = path.join(REPO_ROOT, 'docs', 'architecture', 'myco-2.0.md');

/** Dispositions the ledger may assign: a 1.4 capability is kept, replaced or dropped; one 2.0 adds is NEW. */
export const DISPOSITIONS: ReadonlySet<string> = new Set(['KEEP', 'REPLACE', 'DROP', 'NEW']);

/** The closed set of owning surfaces (§4). `—` is legal only alongside DROP. */
export const SURFACES: ReadonlySet<string> = new Set(['M', 'MS', 'Core', 'W', 'C', 'UI', 'MCP']);

export interface LedgerRow {
  /** The §7 section the row sits in: `7.1` … `7.8`. */
  section: string;
  token: string;
  disposition: string;
  surfaces: string[];
  raw: string;
}

/**
 * Every §7 table row. A row's identity is the FIRST backticked token in its first cell, so trailing qualifiers
 * ("`settings` (project-scoped)") are cosmetic. The disposition is cell 2; the surface cell is the first following
 * cell whose content is `—` or a comma-separated list drawn entirely from SURFACES, which tolerates a section that
 * carries an extra column (§7.6's Migration, §7.8's scope) without a second parser.
 */
export function parseLedger(): LedgerRow[] {
  const rows: LedgerRow[] = [];
  let section: string | null = null;
  for (const line of fs.readFileSync(LEDGER_PATH, 'utf8').split('\n')) {
    const heading = /^### (7\.\d+)\b/.exec(line);
    if (heading) { section = heading[1]!; continue; }
    if (/^## /.test(line)) { section = null; continue; }
    if (section === null || !line.startsWith('| `')) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 3) continue;

    const token = cells[0]!.match(/`([^`]+)`/)?.[1];
    if (!token) continue;

    const disposition = cells[1]!;
    if (!DISPOSITIONS.has(disposition)) continue;

    let surfaces: string[] | null = null;
    for (const cell of cells.slice(2)) {
      if (cell === '—') { surfaces = []; break; }
      const parts = cell.split(',').map((s) => s.trim());
      if (parts.length > 0 && parts.every((s) => SURFACES.has(s))) { surfaces = parts; break; }
    }
    if (surfaces === null) continue;

    rows.push({ section, token, disposition, surfaces, raw: line });
  }
  return rows;
}
