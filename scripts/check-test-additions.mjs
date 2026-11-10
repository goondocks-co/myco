// Tests assert behaviour, not code. Every line a change adds under tests/ is checked against the rules below, each a
// pattern no behavioural test needs; lines already on the base are never read, so only new coupling is refused.
// Usage: npm run check:test-additions, or node scripts/check-test-additions.mjs [base-ref]   (base: $BASE_SHA, else
// origin/main; in CI, BASE_SHA as a full commit id)
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIGRATIONS_DIR = 'packages/myco-server/migrations';
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
/** The owner-ratified gates may read product source and name product files; nothing else under tests/ may. */
const EXEMPT_DIRECTORY = 'tests/meta/boundaries/';
/** The database-layer gate: its test and the allowances only it reads. */
const EXEMPT_FILES = new Set(['tests/myco-server/db-layer.test.ts', 'tests/myco-server/helpers/db-boundary.ts']);
/** Black-box suites reach the server only through its HTTP surface and this fixed set of worker modules. */
const BLACK_BOX_DIRECTORIES = ['tests/parity/scenarios/', 'tests/ui-screens/'];
const BLACK_BOX_WORKER_MODULES = new Set(['constants', 'hash', 'auth/owner/cookie']);
const WORKER_SOURCE = 'packages/myco-server/src/';
const PRODUCT_ROOT = /^packages\/[\w.-]+\/(?:ui\/)?src\//;
const PRODUCT_ALIAS = /^@(?:myco|myco-server-worker|goondocks\/[\w.-]+)\//;

const SQL_KEYWORD = /(?:SELECT\s|INSERT\s+(?:OR\s+\w+\s+)?INTO|DELETE\s+FROM|UPDATE\s+\w+\s+SET|CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)|\bJOIN\s|\bWHERE\s|ORDER\s+BY|GROUP\s+BY|RETURNING\b|ON\s+CONFLICT)/;
const SQL_EXPECTED = new RegExp(String.raw`\)\.(?:not\.)?(?:toContain|toMatch|toEqual|toBe|toStrictEqual|toStartWith|toEndWith|toInclude)\(\s*[\`'"/][^\n]*` + SQL_KEYWORD.source);
const SQL_SUBJECT = [
  /expect\([^\n]*[\w\])!?]\.sql\b(?![\w'"(])[^\n(]*\)\.(?:not\.)?(?:toBe|toEqual|toStrictEqual|toMatch|toContain|toStartWith|toEndWith|toInclude)\(/,
  /expect\([^\n]*(?:statements|prepared|issued|written|sqls?)\b[^\n]*\.(?:some|every|find|filter|map)\([^\n]*\.sql\b(?!\s*\()/,
  /expect\(\s*(?:sql|sqls|sqlText|statementSql)\s*\)\.(?:not\.)?(?:toBe|toEqual|toStrictEqual|toMatch|toContain|toStartWith|toEndWith|toInclude)\(/,
];
const PLAN_TEXT = /EXPLAIN\s+QUERY\s+PLAN|USING\s+(?:COVERING\s+)?INDEX|\bSCAN /;
const CREATE_TABLE = /CREATE\s+(?:TEMP(?:ORARY)?\s+|VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"'[]?(\w+)/gi;
const COST_COUNTER = String.raw`(?:reads|writes|rowsRead|rowsWritten|rows_read|rows_written|statements|queries)`;
/** `expect(<…counter>).toBe(<n>)`, where the subject ends on a counter: `reads`, `cost.writes()`, `statements.length`. */
const EXACT_COST = new RegExp(String.raw`expect\((?:[^\n]*?[.\s(])?${COST_COUNTER}(?:\(\))?(?:\.length)?\s*\)\.(?:toBe|toEqual|toStrictEqual|toHaveLength)\(\s*([1-9]\d*)\s*\)`);
const EXACT_COST_FIELD = new RegExp(String.raw`\.(?:toEqual|toStrictEqual|toMatchObject)\([^\n]*\b${COST_COUNTER}:\s*[1-9]\d*\b`);
/** A per-mechanism cost term; a product limit (`MAX_…`, `MIN_…`) is imported, not summed, and passes. */
const NAMED_COST = /\b(?!MAX_|MIN_)[A-Z][A-Z0-9_]*_(?:READS|WRITES)\b/;
/** A named cost term used as a number: declared with one, summed, compared, asserted or imported. */
const NAMED_COST_USE = /\b(?:expect|import|toBe\w*)\b|[-+*<>]=?\s*\b[A-Z][A-Z0-9_]*_(?:READS|WRITES)\b|\b[A-Z][A-Z0-9_]*_(?:READS|WRITES)\b\s*(?:[-+*<>]|[=:]\s*\d)/;
/** A product path handed to a resolver names a module to run, not a file to key a test on, unless the line reads it as text. */
const MODULE_LOCATION = /(?:\bresolve|\bjoin|new URL|fileURLToPath)\(\s*(?:[^,()]*,\s*)*$/;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;
const SOURCE_READ = /\b(?:readFileSync|readFile|Bun\.file|createSourceFile)\(/;
const MOCK_CALL = /\b(?:mock\.module|vi\.mock|jest\.mock)\(\s*(['"`])([^'"`]+)\1/g;
const MODULE_SPECIFIER = /\b(?:from|import|require|mock\.module|vi\.mock|jest\.mock)\s*\(?\s*(['"`])([^'"`]+)\1/g;
const STRING_LITERAL = /(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/g;
const SOURCE_PATH = /^(?:\.{1,2}\/)*([\w@./-]+\.(?:[cm]?[jt]sx?))(?:#[\w$.]+)?$/;
const WRITE_SQL = /\.sql\(\s*[`'"]?\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i;
const OPEN_SQL_CALL = /\.sql\(\s*[`'"]?\s*$/;

/**
 * The rules, each with its refusal text: what was found and what to write instead.
 * @typedef {{ file: string, line: number, text: string, next?: string }} AddedLine
 * @typedef {{ productTables: ReadonlySet<string>, productFiles: ReadonlySet<string> }} Facts
 * @typedef {{ rule: string, message: string }} Finding
 */
const RULES = {
  productTable: (name) => ({
    rule: 'product-table',
    message: `creates the product table \`${name}\`. A test's own copy of a product table keeps passing after the real `
      + 'table changes. Build the real schema through the migrated schema template (seededSqlite() or getD1Database() in '
      + 'tests/myco-server/helpers/d1.ts) and put rows in through the product\'s own writes or routes.',
  }),
  sqlExpected: () => ({
    rule: 'sql-text',
    message: 'asserts SQL text (an expected value holding SQL, or the .sql of a captured statement). Statement text '
      + 'changes with every behaviour-preserving rewrite. Assert what a caller observes instead: the response, the '
      + 'refusal, or the rows read back after the call.',
  }),
  planText: () => ({
    rule: 'plan-text',
    message: 'names query-plan text (EXPLAIN QUERY PLAN, USING INDEX, SCAN). Plans change with planner statistics and '
      + 'indexes without changing behaviour. State cost as a two-scale test: the same request at a small and a large '
      + 'size reads the same, or at most a bounded k more.',
  }),
  exactCost: (value) => ({
    rule: 'exact-cost',
    message: `pins an exact read, write or statement count (${value}). Every new index or trigger moves it. Measure the `
      + 'same request at two sizes and assert `expect(large.reads).toBe(small.reads)` or '
      + '`expect(large.reads).toBeLessThanOrEqual(small.reads + k)`; a count of 0 for "writes nothing" is allowed.',
  }),
  namedCost: (name) => ({
    rule: 'named-cost',
    message: `names a per-mechanism cost term (${name}). A ceiling summed from mechanism terms is edited by every slice `
      + 'that adds a write. Use a two-scale test: the same request at a small and a large size costs the same, or at '
      + 'most a bounded k more.',
  }),
  productPath: (path) => ({
    rule: 'product-path',
    message: `names the product file ${path}. A test keyed to a file or function name breaks when code moves without `
      + 'any behaviour changing. Assert the behaviour through the public entry point; only an owner-ratified gate in '
      + `${EXEMPT_DIRECTORY} may name product files.`,
  }),
  productMock: (path) => ({
    rule: 'product-mock',
    message: `mocks the product module ${path}. A mocked internal module tests the wiring, not the behaviour. Drive the `
      + 'real module and fake only what lies outside the product (network, clock, child processes, the filesystem) '
      + 'through the seams the product already takes.',
  }),
  blackBoxImport: (specifier) => ({
    rule: 'black-box-import',
    message: `imports ${specifier} into a black-box suite. Parity scenarios and UI screens reach the server only through `
      + 'its HTTP surface; of the worker they may import only constants, hash and auth/owner/cookie. Call the route a '
      + 'real client calls, or read the value from a response; a limit the scenario is about belongs in constants.',
  }),
  blackBoxWrite: () => ({
    rule: 'black-box-write',
    message: 'writes rows with .sql(INSERT|UPDATE|DELETE) in a black-box suite. A row written behind the server\'s back '
      + 'can hold a state no client can reach. Create the state through the routes a real client calls; read rows with '
      + '.sql(\'SELECT ...\') only to check what a call stored.',
  }),
};

/** Whether `specifier`, written in `file`, names a product source module. */
function productModule(file, specifier) {
  if (PRODUCT_ALIAS.test(specifier)) return true;
  if (!specifier.startsWith('.')) return false;
  return PRODUCT_ROOT.test(posix.normalize(posix.join(posix.dirname(file), specifier)));
}

/** The worker module path a black-box import names, without extension, or null when it names no worker module. */
function workerModule(file, specifier) {
  let path = null;
  if (specifier.startsWith('@myco-server-worker/')) path = specifier.slice('@myco-server-worker/'.length);
  else if (specifier.startsWith('.')) {
    const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
    if (resolved.startsWith(WORKER_SOURCE)) path = resolved.slice(WORKER_SOURCE.length);
  }
  return path === null ? null : path.replace(/\.(?:[cm]?[jt]sx?)$/, '');
}

/** The product file a string literal names, or null: a repository path under a package's src or ui/src, or a path relative to one. */
function productPathLiteral(literal, productFiles) {
  const embedded = /packages\/[\w.-]+\/(?:ui\/)?src\/[\w@./-]+\.(?:[cm]?[jt]sx?)/.exec(literal);
  if (embedded) return embedded[0];
  const match = SOURCE_PATH.exec(literal);
  if (!match || !match[1].includes('/')) return null;
  return productFiles.has(match[1]) ? literal : null;
}

/**
 * The rules an added test line breaks, one finding each.
 * @param {AddedLine} added
 * @param {Facts} facts
 * @returns {Finding[]}
 */
function lineFindings(added, facts) {
  const { file, text } = added;
  const findings = [];
  for (const match of text.matchAll(CREATE_TABLE)) {
    if (facts.productTables.has(match[1].toLowerCase())) findings.push(RULES.productTable(match[1]));
  }
  const code = text.replace(STRING_LITERAL, '""');
  if (SQL_EXPECTED.test(text) || SQL_SUBJECT.some((pattern) => pattern.test(code))) findings.push(RULES.sqlExpected());
  if (PLAN_TEXT.test(text)) findings.push(RULES.planText());
  const exact = EXACT_COST.exec(text) ?? EXACT_COST_FIELD.exec(text);
  if (exact) findings.push(RULES.exactCost(exact[0]));
  const named = NAMED_COST.exec(code);
  if (named && NAMED_COST_USE.test(code)) findings.push(RULES.namedCost(named[0]));
  for (const match of text.matchAll(MOCK_CALL)) {
    if (productModule(file, match[2])) findings.push(RULES.productMock(match[2]));
  }
  const withoutSpecifiers = COMMENT_LINE.test(text) ? '' : text.replace(MODULE_SPECIFIER, '');
  for (const match of withoutSpecifiers.matchAll(STRING_LITERAL)) {
    const path = productPathLiteral(match[2], facts.productFiles);
    if (path === null) continue;
    if (MODULE_LOCATION.test(withoutSpecifiers.slice(0, match.index)) && !SOURCE_READ.test(text)) continue;
    findings.push(RULES.productPath(path));
    break;
  }
  if (BLACK_BOX_DIRECTORIES.some((directory) => file.startsWith(directory))) {
    for (const match of text.matchAll(MODULE_SPECIFIER)) {
      if (/mock/.test(match[0])) continue;
      const module = workerModule(file, match[2]);
      if (module !== null && !BLACK_BOX_WORKER_MODULES.has(module)) findings.push(RULES.blackBoxImport(match[2]));
    }
    if (WRITE_SQL.test(text) || (OPEN_SQL_CALL.test(text) && /^\s*(?:INSERT|UPDATE|DELETE|REPLACE)\b/i.test(added.next ?? ''))) {
      findings.push(RULES.blackBoxWrite());
    }
  }
  return findings;
}

/** Whether the rules apply to `file` at all. */
function checkedFile(file) {
  return file.startsWith('tests/') && CODE_FILE.test(file) && !file.startsWith(EXEMPT_DIRECTORY) && !EXEMPT_FILES.has(file);
}

/**
 * The lines `git diff -U0` adds, by file and line number in the new file.
 * @param {string} diff
 * @returns {AddedLine[]}
 */
function addedLines(diff) {
  const lines = [];
  let file = null;
  let next = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) { file = null; inHunk = false; continue; }
    if (!inHunk && raw.startsWith('+++ ')) { file = raw === '+++ /dev/null' ? null : raw.slice('+++ b/'.length); continue; }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { next = Number(hunk[1]); inHunk = true; continue; }
    if (!inHunk || file === null) continue;
    if (raw.startsWith('+')) {
      const previous = lines.at(-1);
      const added = { file, line: next, text: raw.slice(1) };
      if (previous && previous.file === file && previous.line === next - 1) previous.next = added.text;
      lines.push(added);
      next += 1;
    }
  }
  return lines;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Every file under a package's src or ui/src, as repository paths and as paths relative to that root. */
function productFiles() {
  const files = new Set();
  for (const path of git(['ls-files', '-z', '--', ':(glob)packages/*/src/**', ':(glob)packages/*/ui/src/**']).split('\0').filter(Boolean)) {
    files.add(path);
    files.add(path.replace(PRODUCT_ROOT, ''));
    files.add(path.replace(/\.ts(x?)$/, '.js$1'));
    files.add(path.replace(PRODUCT_ROOT, '').replace(/\.ts(x?)$/, '.js$1'));
  }
  return files;
}

/** The product's table names, read from the schema its migrations build, applied to an empty in-memory database. */
async function migratedTables() {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch (error) {
    throw new Error(`Reading the product's tables needs node:sqlite (Node 22.13 or later); this is Node ${process.version}. ${error.message}`);
  }
  const db = new DatabaseSync(':memory:');
  for (const name of readdirSync(MIGRATIONS_DIR).filter((entry) => entry.endsWith('.sql')).sort()) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, name), 'utf8'));
  }
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'").all();
  db.close();
  return new Set(rows.map((row) => String(row.name).toLowerCase()));
}

/** Untracked files under tests/, every line added. */
function untrackedAdditions() {
  const lines = [];
  for (const file of git(['ls-files', '-z', '--others', '--exclude-standard', '--', 'tests/']).split('\0').filter(Boolean)) {
    if (!existsSync(file)) continue;
    readFileSync(file, 'utf8').split('\n').forEach((text, index, all) => lines.push({ file, line: index + 1, text, next: all[index + 1] }));
  }
  return lines;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = process.argv[2] || process.env.BASE_SHA || 'origin/main';
  if (process.env.GITHUB_ACTIONS && (!/^[a-f0-9]{40}$/.test(base) || /^0{40}$/.test(base))) {
    console.error(`In CI the base must be the commit the change is checked against, as 40 hex characters; got ${process.argv[2] || process.env.BASE_SHA ? JSON.stringify(base) : 'an empty BASE_SHA'}. `
      + 'Set BASE_SHA to the pull request base (github.event.pull_request.base.sha) or the commit before the push (github.event.before).');
    process.exit(2);
  }
  process.chdir(git(['rev-parse', '--show-toplevel']).trim());
  let mergeBase;
  try {
    mergeBase = git(['merge-base', base, 'HEAD']).trim();
  } catch {
    console.error(`Cannot find the merge base of ${base} and HEAD. Fetch it first (\`git fetch origin main\`), or pass the base ref: node scripts/check-test-additions.mjs <base-ref>`);
    process.exit(2);
  }
  const diff = git(['diff', '--no-color', '--no-ext-diff', '--find-renames', '-U0', mergeBase, '--', 'tests/']);
  const added = [...addedLines(diff), ...untrackedAdditions()].filter((line) => checkedFile(line.file));
  const createsTables = added.some((line) => new RegExp(CREATE_TABLE.source, 'i').test(line.text));
  const facts = { productTables: createsTables ? await migratedTables() : new Set(), productFiles: productFiles() };
  const problems = [];
  for (const line of added) {
    for (const finding of lineFindings(line, facts)) {
      problems.push(`${line.file}:${line.line} [${finding.rule}] ${finding.message}\n    ${line.text.trim().slice(0, 200)}`);
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(`\n${problems.length} added test line${problems.length === 1 ? '' : 's'} since the merge base with ${base} (${mergeBase.slice(0, 12)}) `
      + 'couple a test to code instead of behaviour. Rewrite each as the message says; the rules are in AGENTS.md (Test behavior, not code).');
    process.exit(1);
  }
  console.log(`${added.length} added test lines since the merge base with ${base} (${mergeBase.slice(0, 12)}) assert behaviour, not code.`);
}
