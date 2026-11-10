// The pull request gate stays inside one runner-time budget, and the test suite does not grow while it is
// already larger than the product. Usage: npm run check:test-budget, or
// node scripts/check-test-budget.mjs [base-ref]   (base: $BASE_SHA, else origin/main)
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIVE_MINUTES_MS = 5 * 60 * 1000;

/** Pull request node runner time the build job allows. The planned time after demotion, rounded up to 5 minutes. */
export const PR_NODE_RUNNER_BUDGET_MS = 7_200_000;

export function roundUpFiveMinutes(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) throw new Error(`Planned runner time must be a nonnegative number, got ${milliseconds}`);
  return Math.ceil(milliseconds / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
}

/** Sum of planned node phase time in a shard-planner matrix. DOM phases are not included. */
export function plannedNodeRunnerMs(matrix) {
  const shards = (matrix?.ordinary ?? []).filter((entry) => entry.kind === 'node');
  return shards.reduce((sum, shard) => sum + shard.phases.reduce((phaseSum, phase) => phaseSum + phase.estimatedMs, 0), 0);
}

export function formatRunnerTime(milliseconds) {
  const seconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${seconds}s (${minutes}m ${rest}s)`;
}

export function runnerBudgetRefusal(actualMs, budgetMs = PR_NODE_RUNNER_BUDGET_MS) {
  return `Pull request node runner time is ${formatRunnerTime(actualMs)}, over the ${formatRunnerTime(budgetMs)} budget. `
    + 'Make room by deleting or demoting tests, never by raising the budget.';
}

/** Throws the runner-time refusal when the plan is over the budget. */
export function assertRunnerBudget(actualMs, budgetMs = PR_NODE_RUNNER_BUDGET_MS) {
  if (actualMs <= budgetMs) return;
  throw new Error(runnerBudgetRefusal(actualMs, budgetMs));
}

export function isTestLineFile(file) {
  return /^tests\/.*\.(?:ts|tsx|mjs)$/.test(file);
}

export function isProductLineFile(file) {
  if (file.includes('.generated.')) return false;
  return /^packages\/[^/]+\/src\//.test(file) || /^packages\/[^/]+\/ui\/src\//.test(file);
}

/** Physical lines in a file body. An empty file is zero. A missing trailing newline still counts the last line. */
export function countLines(text) {
  if (text.length === 0) return 0;
  let lines = 0;
  for (let index = 0; index < text.length; index += 1) if (text.charCodeAt(index) === 10) lines += 1;
  if (text.charCodeAt(text.length - 1) !== 10) lines += 1;
  return lines;
}

export function formatRatio(counts) {
  if (!(counts.product > 0)) return `undefined (${counts.test} test lines / ${counts.product} product lines)`;
  return `${(counts.test / counts.product).toFixed(3)} (${counts.test} test lines / ${counts.product} product lines)`;
}

/** True when the head ratio is above 1 and higher than the base ratio. */
export function ratioRoseAboveOne(before, after) {
  if (!(before.product > 0) || !(after.product > 0)) return true;
  const aboveOne = after.test > after.product;
  const rose = after.test * before.product > before.test * after.product;
  return aboveOne && rose;
}

export function ratioRefusal(before, after) {
  const added = after.test - before.test;
  return `Test-to-product line ratio rose from ${formatRatio(before)} to ${formatRatio(after)} while above 1.0 `
    + `(${added} test lines added). Make room by deleting or demoting tests.`;
}

function git(repo, args, options = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], ...options });
}

/** Bytes of a git command. Bun's execFileSync rejects the `buffer` encoding Node accepts. */
function gitBytes(repo, args, input) {
  const result = spawnSync('git', ['-C', repo, ...args], { input, maxBuffer: 256 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : String(result.stderr ?? result.error?.message ?? '');
    throw new Error(`git ${args[0] ?? ''} failed: ${detail.trim()}`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? '');
}

/** Test and product line counts at one git revision. Generated product files are excluded. */
export function lineCountsAt(repo, revision) {
  const names = git(repo, ['ls-tree', '-r', '--name-only', revision]).split('\n').filter(Boolean);
  const wanted = names.filter((file) => isTestLineFile(file) || isProductLineFile(file));
  const counts = { test: 0, product: 0 };
  if (wanted.length === 0) return counts;
  const output = gitBytes(repo, ['cat-file', '--batch'], `${wanted.map((file) => `${revision}:${file}`).join('\n')}\n`);
  let offset = 0;
  for (const file of wanted) {
    const headerEnd = output.indexOf(0x0a, offset);
    if (headerEnd < 0) throw new Error(`git cat-file returned no header for ${file}`);
    const header = output.toString('utf8', offset, headerEnd);
    const size = Number(header.split(' ')[2]);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`git cat-file could not read ${revision}:${file} (${header})`);
    const start = headerEnd + 1;
    const text = output.toString('utf8', start, start + size);
    const lines = countLines(text);
    if (isTestLineFile(file)) counts.test += lines;
    else counts.product += lines;
    offset = start + size + 1;
  }
  return counts;
}

function pullRequestPlan(repo) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-test-budget-'));
  const planFile = path.join(directory, 'plan.json');
  try {
    const result = spawnSync(process.execPath, ['scripts/run-bun-tests.mjs'], {
      cwd: repo,
      env: {
        ...process.env,
        MYCO_TEST_SCOPE: 'pr',
        MYCO_RUNNER_DRY_RUN: '1',
        MYCO_RUNNER_MATRIX_PLAN_FILE: planFile,
        MYCO_RUNNER_REPORT_DIR: directory,
      },
      encoding: 'utf8',
      timeout: 120_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
      throw new Error(`The pull request test plan failed to build (exit ${result.status ?? 'signal'}).\n${result.stderr ?? ''}${result.stdout ?? ''}`);
    }
    return JSON.parse(fs.readFileSync(planFile, 'utf8'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function mergeBase(repo, base) {
  try {
    return git(repo, ['merge-base', base, 'HEAD']).trim();
  } catch (error) {
    throw new Error(`Cannot find the merge base of ${base} and HEAD. Fetch it first (\`git fetch origin main\`), or pass the base ref. ${error.stderr ?? error.message}`);
  }
}

/**
 * Check one repository. `plan` skips the shard planner. Returns refusal strings; an empty list is a pass.
 * @param {{ repo?: string, base?: string, plan?: object, budgetMs?: number, skipRatio?: boolean, skipPlan?: boolean }} options
 */
export function checkTestBudget(options = {}) {
  const repo = options.repo ?? repoRoot;
  const refusals = [];
  if (!options.skipPlan) {
    const matrix = options.plan ?? pullRequestPlan(repo);
    const actual = plannedNodeRunnerMs(matrix);
    const budget = options.budgetMs ?? PR_NODE_RUNNER_BUDGET_MS;
    if (actual > budget) refusals.push(runnerBudgetRefusal(actual, budget));
    else console.log(`Pull request node runner time ${formatRunnerTime(actual)} is within ${formatRunnerTime(budget)}.`);
  }
  if (!options.skipRatio) {
    const base = mergeBase(repo, options.base ?? 'origin/main');
    const before = lineCountsAt(repo, base);
    const after = lineCountsAt(repo, 'HEAD');
    if (ratioRoseAboveOne(before, after)) refusals.push(ratioRefusal(before, after));
    else console.log(`Test-to-product line ratio ${formatRatio(after)} did not rise above 1.0 from ${formatRatio(before)}.`);
  }
  return refusals;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.argv[2] || process.env.BASE_SHA || 'origin/main';
  if (process.env.GITHUB_ACTIONS && (!/^[a-f0-9]{40}$/.test(base) || /^0{40}$/.test(base))) {
    console.error(`In CI the base must be the commit the change is checked against, as 40 hex characters; got ${JSON.stringify(base)}. `
      + 'Set BASE_SHA to the pull request base (github.event.pull_request.base.sha) or the commit before the push (github.event.before).');
    process.exit(2);
  }
  let refusals;
  try {
    refusals = checkTestBudget({ repo: repoRoot, base });
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }
  if (refusals.length > 0) {
    for (const refusal of refusals) console.error(refusal);
    process.exit(1);
  }
}
