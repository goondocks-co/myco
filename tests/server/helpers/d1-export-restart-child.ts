import fs from 'node:fs';
import path from 'node:path';
import { D1ExportStartBudget, exportD1, exportRecordPath } from '@myco/server/cloudflare-d1-export.js';

const [root, phase] = process.argv.slice(2);
if (!root || !phase) throw new Error('root and phase required');
const stateFile = path.join(root, 'provider.json');
const state: { starts: number } = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : { starts: 0 };
const context = {
  accountId: 'fixture', databaseId: 'fixture', tables: ['t'], schema: 'fixture',
  output: path.join(root, 'export.sql'), recordDir: root, holdToken: 'same-recovery-hold',
  login: { current: async () => new Headers(), headers: async () => new Headers(), refused: () => {} }, sleep: async () => {},
};
const budget = new D1ExportStartBudget(phase === 'restart-1' ? context : undefined);
const errors: string[] = [];
for (let attempt = 0; attempt < (phase === 'restart-1' ? 3 : 1); attempt++) {
  try {
    await exportD1({ ...context, startBudget: budget, fetch: async (url, init) => {
      if (url.startsWith('https://api.cloudflare.com')) {
        const bookmark = JSON.parse(String(init.body)).current_bookmark;
        if (bookmark === 'bm-1' || (phase === 'restart-2' && bookmark === 'bm-2')) {
          return Response.json({ success: true, result: { success: true, status: 'error', error: 'provider reset' } });
        }
        if (!bookmark) { state.starts++; fs.writeFileSync(stateFile, JSON.stringify(state)); }
        return Response.json({ success: true, result: { success: true, status: 'complete', at_bookmark: bookmark ?? `bm-${state.starts}`,
          result: { signed_url: 'https://signed.fixture/export' } } });
      }
      return new Response(null, { status: state.starts === 1 ? 404 : 500 });
    } });
  } catch (error) { errors.push((error as Error).message); }
}
console.log(JSON.stringify({ starts: state.starts, errors, recordExists: fs.existsSync(exportRecordPath(root, 'fixture')) }));
