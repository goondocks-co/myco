/**
 * Meta gate: the dashboard keeps itself current through one mechanism (`ui/src/lib/live.ts`).
 *
 * Only the heartbeat — Myco's work now, a bounded read with tested rows-read ceilings — is read by the clock. Every
 * other read declares its freshness through `live(...)`: it follows the heartbeat's marks, polls one small read of one
 * thing in motion, is a heavy measure read only when asked, or holds still. A query that declares nothing is refused
 * by name, so a new page cannot opt out of live data by omission, and a page that sets its own interval brings back
 * many pages polling windows of history in parallel, which spent the database's per-request budget on the owner's
 * Deployment. Static source scan over the parsed source, no build.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'rolldown/parseAst';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI_SRC = path.join(REPO_ROOT, 'packages', 'myco-server', 'ui', 'src');
const MECHANISM = 'lib/live.ts';
const POLLING = /\brefetchInterval(?:InBackground)?\b/;
/** A spread that carries a declared freshness: `live(...)`, the heartbeat, or a variable a hook built from `live(...)`. */
const DECLARES = /\.\.\.\s*(?:live\s*(?:<[^>]*>)?\s*\(|heartbeat\s*(?:<[^>]*>)?\s*\(|fresh\b)/;

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

const relative = (file: string) => path.relative(UI_SRC, file).split(path.sep).join('/');

type Node = { type?: string; start: number; end: number; [key: string]: unknown };

function each(node: unknown, visit: (node: Node) => void): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const child of node) each(child, visit); return; }
  if (typeof (node as Node).type === 'string') visit(node as Node);
  for (const value of Object.values(node)) each(value, visit);
}

/** Every query a dashboard file makes, with the text of its options and where it starts. */
function queries(file: string): Array<{ hook: string; options: string; line: number }> {
  const text = fs.readFileSync(file, 'utf8');
  const found: Array<{ hook: string; options: string; line: number }> = [];
  each(parseAst(text, { lang: file.endsWith('x') ? 'tsx' : 'ts' }), (node) => {
    const callee = node.callee as Node & { name?: string } | undefined;
    if (node.type !== 'CallExpression' || callee?.type !== 'Identifier') return;
    if (!['useQuery', 'useInfiniteQuery', 'useQueries'].includes(callee.name!)) return;
    const options = (node.arguments as Node[])[0];
    if (options === undefined) return;
    found.push({ hook: callee.name!, options: text.slice(options.start, options.end), line: text.slice(0, node.start).split('\n').length });
  });
  return found;
}

describe('dashboard live refresh', () => {
  it('sets a refresh interval only inside the live mechanism', () => {
    const offenders = sources(UI_SRC)
      .filter((file) => relative(file) !== MECHANISM)
      .flatMap((file) => fs.readFileSync(file, 'utf8').split('\n')
        .map((line, i) => ({ line, at: `${relative(file)}:${i + 1}` }))
        .filter(({ line }) => POLLING.test(line))
        .map(({ at, line }) => `${at}: ${line.trim()}`));
    expect(offenders).toEqual([]);
  });

  it('has every query declare its freshness, so none is left out of live data by omission', () => {
    const all = sources(UI_SRC).flatMap((file) => queries(file).map((query) => ({ ...query, at: `${relative(file)}:${query.line}` })));
    expect(all.length).toBeGreaterThan(50);
    expect(all.filter((query) => !DECLARES.test(query.options)).map((query) => `${query.at} ${query.hook}`)).toEqual([]);
    const paged = fs.readFileSync(path.join(UI_SRC, 'hooks', 'use-paged.ts'), 'utf8');
    expect(paged).toMatch(/opts: \{ freshness: PagedFreshness;/);
    expect(paged).toContain('...live(opts.freshness)');
  });

  it('keeps the pages that show stored knowledge, session lists and backups following their marks', () => {
    const follows = (file: string, key: string, marks: string) => {
      const query = queries(path.join(UI_SRC, file)).find((q) => q.options.includes(key));
      expect({ file, key, options: query?.options.includes(marks) }).toEqual({ file, key, options: true });
    };
    follows('hooks/use-knowledge.ts', "'spore-stream'", "follows: ['knowledge', 'runs']");
    follows('hooks/use-knowledge.ts', "'plans'", "follows: ['knowledge', 'runs']");
    follows('hooks/use-sessions.ts', "'live'", 'until: liveUntil');
    follows('hooks/use-recovery.ts', "'recovery'", "follows: ['recovery']");
    follows('hooks/use-backups.ts', "'backups'", "follows: ['recovery']");
    expect(fs.readFileSync(path.join(UI_SRC, 'hooks', 'use-sessions.ts'), 'utf8')).toMatch(/freshness: \{ follows: \['sessions', 'runs'\] \},\n\s+rowKey/);
  });

  it('refreshes measures while historical measurement is building', () => {
    const kpis = fs.readFileSync(path.join(UI_SRC, 'hooks', 'use-kpis.ts'), 'utf8');
    expect(kpis).toContain("live<KpiAnswer>({ whileMoving: data => data?.state === 'building' })");
    expect(kpis).not.toMatch(/follows/);
  });

  it('mounts the heartbeat once, in the shell', () => {
    const mounts = sources(UI_SRC).filter((file) => /<LiveRefresh\b/.test(fs.readFileSync(file, 'utf8'))).map(relative);
    expect(mounts).toEqual(['routes/Shell.tsx']);
  });
});
