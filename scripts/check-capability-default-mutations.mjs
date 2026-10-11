import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const file = 'packages/myco-server/src/core/settings.ts';
const original = readFileSync(file, 'utf8');
const mutants = [
  {
    name: 'absent means off across all readers',
    before: 'AND NOT EXISTS (SELECT 1 FROM project_capabilities pc\n        WHERE pc.project_id = capability_project.project_id AND pc.capability = ${capability} AND pc.enabled = 0)',
    after: 'AND EXISTS (SELECT 1 FROM project_capabilities pc\n        WHERE pc.project_id = capability_project.project_id AND pc.capability = ${capability} AND pc.enabled = 1)',
  },
  {
    name: 'one reader still treats absence as off',
    before: 'const row = await db.prepare(`SELECT ${CAPABILITY_ON_SQL} AS enabled`)',
    after: 'const row = await db.prepare(`SELECT enabled FROM project_capabilities WHERE project_id = ? AND capability = ?`)',
  },
  {
    name: 'archived projects regain default-on admission',
    before: 'capability_project.archived_at IS NULL',
    after: '1 = 1',
  },
];
let survived = false;
try {
  for (const mutant of mutants) {
    if (!original.includes(mutant.before) || original.split(mutant.before).length !== 2) throw new Error(`mutation anchor is not unique: ${mutant.name}`);
    writeFileSync(file, original.replace(mutant.before, mutant.after));
    const result = spawnSync('npm', ['test', '--', 'tests/myco-server/capability-default-on.test.ts', 'tests/myco-server/recall.test.ts'], {
      env: process.env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
    const output = (result.stdout ?? '') + (result.stderr ?? '');
    if (result.error || result.signal || result.status === null) throw result.error ?? new Error(`mutation command did not complete: ${mutant.name}`);
    const killed = result.status !== 0 && /\(fail\) (project capability defaults across readers|POST \/context\/prompt > serves relevant memory for two populated Projects)/.test(output);
    console.log(`${killed ? 'KILLED' : 'SURVIVED'}: ${mutant.name} (exit ${result.status})`);
    if (!killed) {
      console.error(output);
      survived = true;
    }
    writeFileSync(file, original);
  }
} finally {
  writeFileSync(file, original);
}
if (survived) process.exitCode = 1;
