// Shipped migrations never change. Every migration file that exists at the merge base with the base ref is
// byte-identical in the working tree, and every new file is numbered after the highest one shipped there.
// Usage: npm run check:migrations, or node scripts/check-shipped-migrations.mjs [base-ref]   (base: $BASE_SHA, else origin/main;
// in CI, BASE_SHA as a full commit id)
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIGRATIONS_DIR = 'packages/myco-server/migrations';
const MIGRATION_FILE = /^(\d{4})_v\d+\.sql$/;

/**
 * The problems with a working tree's migration files against the files shipped at the merge base, one sentence each.
 * @param {ReadonlyMap<string, string>} shipped blob id of each migration file at the merge base, by file name
 * @param {ReadonlyMap<string, string>} current blob id of each migration file in the working tree, by file name
 * @param {string} base the ref the merge base was taken with, named in each message
 * @returns {string[]}
 */
function shippedMigrationProblems(shipped, current, base) {
  const problems = [];
  const emit = '`npm run migrations:emit -w @goondocks/myco-server`';
  for (const [name, blob] of shipped) {
    const now = current.get(name);
    if (now === undefined) problems.push(`${MIGRATIONS_DIR}/${name} shipped at the merge base with ${base} and is gone. A deployed database has applied it. Keep its step in SCHEMA_STEPS so ${emit} renders it again; to undo what it did, add a new schema step.`);
    else if (now !== blob) problems.push(`${MIGRATIONS_DIR}/${name} differs from the file shipped at the merge base with ${base}. A deployed database has applied it and never runs it again, so an edit reaches no existing store. Put the step's statements back so ${emit} renders the shipped file again, and make the change a new schema step.`);
  }
  const highest = Math.max(0, ...[...shipped.keys()].map((name) => Number(MIGRATION_FILE.exec(name)?.[1] ?? 0)));
  for (const name of current.keys()) {
    if (shipped.has(name)) continue;
    const number = Number(MIGRATION_FILE.exec(name)?.[1] ?? NaN);
    if (!(number > highest)) problems.push(`${MIGRATIONS_DIR}/${name} is new but not numbered after ${String(highest).padStart(4, '0')}, the highest migration shipped at the merge base with ${base}. A new step appends: give it the next version after the last shipped step.`);
  }
  return problems;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Blob id of every `.sql` file under the migrations directory at `commit`, by file name. */
function shippedBlobs(commit) {
  const listing = git(['ls-tree', '-z', `${commit}:${MIGRATIONS_DIR}`]);
  const blobs = new Map();
  for (const entry of listing.split('\0').filter(Boolean)) {
    const [meta, name] = entry.split('\t');
    if (name.endsWith('.sql')) blobs.set(name, meta.split(' ')[2]);
  }
  return blobs;
}

/** Blob id of every `.sql` file in the working tree's migrations directory, hashed as raw bytes, by file name. */
function workingBlobs() {
  const names = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith('.sql')).sort();
  if (names.length === 0) return new Map();
  const ids = execFileSync('git', ['hash-object', '--no-filters', '--stdin-paths'], {
    input: names.map((name) => join(MIGRATIONS_DIR, name)).join('\n'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  }).trim().split('\n');
  return new Map(names.map((name, index) => [name, ids[index]]));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.argv[2] || process.env.BASE_SHA || 'origin/main';
  if (process.env.GITHUB_ACTIONS && (!/^[a-f0-9]{40}$/.test(base) || /^0{40}$/.test(base))) {
    console.error(`In CI the base must be the commit the change is checked against, as 40 hex characters; got ${process.argv[2] || process.env.BASE_SHA ? JSON.stringify(base) : 'an empty BASE_SHA'}. `
      + 'Set BASE_SHA to the pull request base (github.event.pull_request.base.sha) or the commit before the push (github.event.before).');
    process.exit(2);
  }
  process.chdir(git(['rev-parse', '--show-toplevel']));
  let mergeBase;
  try {
    mergeBase = git(['merge-base', base, 'HEAD']);
  } catch {
    console.error(`Cannot find the merge base of ${base} and HEAD. Fetch it first (\`git fetch origin main\`), or pass the base ref: node scripts/check-shipped-migrations.mjs <base-ref>`);
    process.exit(2);
  }
  const shipped = shippedBlobs(mergeBase);
  const problems = shippedMigrationProblems(shipped, workingBlobs(), base);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(`${shipped.size} shipped migrations unchanged since the merge base with ${base} (${mergeBase.slice(0, 12)}); new files append.`);
}
