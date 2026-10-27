import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { operatorViewProjectExists, operatorViewProjects } from '@myco-server-worker/read/view-store.js';
import { readViewStatus } from '@myco-server-worker/read/view-status.js';
import {
  readViewPreflightPage,
  decodeViewPreflightCursor,
  encodeViewPreflightCursor,
} from '@myco-server-worker/core/view-preflight.js';

/** Operator diagnostics use the same bounded inventory and lifecycle reader as the dashboard. */
export async function viewPreflight(db: RelationalStore, project: string, token: string | null) {
  const exists = await operatorViewProjectExists(db).bind(project).first();
  if (exists === null) throw new Error('Project not found');
  const page = await readViewPreflightPage(db, project, decodeViewPreflightCursor(project, token));
  return { ...page, nextCursor: page.nextCursor ? encodeViewPreflightCursor(project, page.nextCursor) : null };
}

export async function viewStatusLine(
  read: <T>(run: (db: RelationalStore) => Promise<T>) => Promise<T>,
): Promise<string> {
  try {
    return await read(async (db) => {
      const projects = (
        await operatorViewProjects(db).all<{ project_id: string }>()
      ).results;
      const status = await readViewStatus(
        db,
        projects.map((row) => row.project_id),
        Date.now(),
      );
      const counts = Object.entries(status.counts)
        .filter(([, count]) => count > 0)
        .map(([state, count]) => `${count} ${state}`);
      const measured = status.states.flatMap((row) =>
        row.work.state === 'measured' ? [row.work.netBytesPerSecond] : [],
      );
      const speed = measured.length
        ? 'slowest sampled session ' +
          Math.floor(Math.min(...measured)) +
          ' B/s net across ' +
          measured.length +
          ' samples'
        : 'rebuild speed unavailable';
      return (
        '  Session views: ' +
        (counts.join(', ') || 'no sessions') +
        '; ' +
        speed +
        '; ' +
        status.cleanup.retired +
        ' retired (' +
        status.cleanup.eligibleRetired +
        ' beyond hold); ' +
        status.findings.reduce((sum, row) => sum + row.count, 0) +
        ' findings' +
        '; unplaced unavailable; coverage not carried unavailable' +
        (status.details.complete ? '' : '; showing ' + status.states.length + '/' + status.details.total + ' sessions')
      );
    });
  } catch (error) {
    return '  Session views: unavailable — ' + (error instanceof Error ? error.message : String(error));
  }
}
