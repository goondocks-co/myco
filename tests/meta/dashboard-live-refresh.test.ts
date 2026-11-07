/**
 * Meta gate: the dashboard keeps itself current through one mechanism (`ui/src/lib/live.ts`).
 *
 * Only the heartbeat — Myco's work now, a bounded read with tested rows-read ceilings — is read by the clock. Every
 * other read declares its freshness through `live(...)`: it follows the heartbeat's marks, polls one small read of one
 * thing in motion, or is a heavy measure read only when asked. A page that sets its own interval brings back what
 * this replaced: many pages polling windows of history in parallel, which spent the database's per-request budget on
 * the owner's Deployment. Static source scan, no build.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UI_SRC = path.join(REPO_ROOT, 'packages', 'myco-server', 'ui', 'src');
const MECHANISM = 'lib/live.ts';
const POLLING = /\brefetchInterval(?:InBackground)?\b/;

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

const relative = (file: string) => path.relative(UI_SRC, file).split(path.sep).join('/');

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

  it('reads the measures as a heavy read, never by the clock or a mark', () => {
    const kpis = fs.readFileSync(path.join(UI_SRC, 'hooks', 'use-kpis.ts'), 'utf8');
    expect(kpis).toContain("live<KpiReport>('heavy')");
    expect(kpis).not.toMatch(/follows|whileMoving/);
  });

  it('mounts the heartbeat once, in the shell', () => {
    const mounts = sources(UI_SRC).filter((file) => /<LiveRefresh\b/.test(fs.readFileSync(file, 'utf8'))).map(relative);
    expect(mounts).toEqual(['routes/Shell.tsx']);
  });
});
