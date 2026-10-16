import fs from 'node:fs';
import path from 'node:path';
import { installGitBudgetProbe } from './git-budget-probe.js';

installGitBudgetProbe(process.env.MYCO_TEST_GIT_BUDGET_PROBE!, () => {
  const spoolDir = process.env.MYCO_TEST_GIT_SPOOL_DIR;
  const stateFile = process.env.MYCO_TEST_GIT_STATE_FILE;
  if (spoolDir === undefined || stateFile === undefined) return {};
  const journal = fs.existsSync(spoolDir) ? fs.readdirSync(spoolDir).filter(file => file.endsWith('.jsonl'))
    .map(file => fs.readFileSync(path.join(spoolDir, file), 'utf8')).join('') : '';
  return { committed: journal.includes('session.end'), receipt: fs.existsSync(stateFile) };
});
if (process.argv[2] === 'facts') {
  const [root, result, nearDeadline] = process.argv.slice(3);
  process.env.GIT_DIR = path.join(root!, 'steered.git');
  const { sessionEndGitFacts } = await import('@myco/member/git-facts.js');
  const { resolveHookBudget, canStartRequest } = await import('@myco/member/budget.js');
  const startedAt = Date.now();
  const budget = resolveHookBudget('claude-code', 'session-end', { startedAt });
  if (nearDeadline === 'true') budget.deadline = startedAt + budget.connectTimeoutMs + 100;
  const facts = await sessionEndGitFacts(root!, budget);
  fs.writeFileSync(result!, JSON.stringify({ facts, elapsed: Date.now() - startedAt, canDeliver: canStartRequest(budget) }));
} else {
  await import('./hook-process.js');
}
