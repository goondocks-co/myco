// The rules check-test-additions applies to each statement a change adds under tests/: patterns no behavioural test
// needs. Each finding carries the rule and the refusal text, which says what to write instead. The rules read the
// statement's own text, so an alias, a helper or a value held in a variable is left to review.
import { readFileSync } from 'node:fs';
import { posix } from 'node:path';

/** The owner-ratified gates may read product source and name product files; nothing else under tests/ may. */
export const EXEMPT_DIRECTORY = 'tests/meta/boundaries/';
/** The database-layer gate: its test and the allowances only it reads. */
const EXEMPT_FILES = new Set(['tests/myco-server/db-layer.test.ts', 'tests/myco-server/helpers/db-boundary.ts']);
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/;
/** Black-box suites reach the server only through its HTTP surface and this fixed set of worker modules. */
const PARITY_SCENARIOS = 'tests/parity/scenarios/';
const UI_SCREENS = /^tests\/ui-screens\/.*\.(?:screens|browser)\.ts$/;
const BLACK_BOX_WORKER_MODULES = new Set(['constants', 'hash', 'auth/owner/cookie']);
const WORKER_SOURCE = 'packages/myco-server/src/';
export const PRODUCT_ROOT = /^packages\/[\w.-]+\/(?:ui\/)?src\//;
const PRODUCT_ALIAS = /^@(?:myco|myco-server-worker|goondocks\/[\w.-]+)\//;

const SQL_KEYWORD = /(?:SELECT\s|INSERT\s+(?:OR\s+\w+\s+)?INTO|DELETE\s+FROM|UPDATE\s+\w+\s+SET|CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)|\bJOIN\s|\bWHERE\s|ORDER\s+BY|GROUP\s+BY|RETURNING\b|ON\s+CONFLICT)/;
const MATCHER = String.raw`(?:toContain|toMatch|toEqual|toBe|toStrictEqual|toStartWith|toEndWith|toInclude|toMatchObject|toHaveBeenCalledWith|toHaveBeenLastCalledWith|toHaveBeenNthCalledWith)`;
const SQL_EXPECTED = [
  new RegExp(String.raw`\)\s*\.(?:not\.)?${MATCHER}\(\s*[[{]?\s*[\`'"/][^;]*?` + SQL_KEYWORD.source),
  new RegExp(String.raw`\)\s*\.(?:not\.)?${MATCHER}\([^;]*?\bsql:\s*[\`'"][^\`'"]*?` + SQL_KEYWORD.source),
];
const SQL_SUBJECT = [
  new RegExp(String.raw`expect\([^;]*?[\w\])!?]\.sql\b(?![\w'"(])[^;(]*\)\s*\.(?:not\.)?${MATCHER}\(`),
  /expect\([^;]*?(?:statements|prepared|issued|written|sqls?)\b[^;]*?\.(?:some|every|find|filter|map)\([^;]*?\.sql\b(?!\s*\()/,
  new RegExp(String.raw`expect\(\s*(?:sql|sqls|sqlText|statementSql)\s*\)\s*\.(?:not\.)?${MATCHER}\(`),
];
const PLAN_TEXT = [/EXPLAIN\s+QUERY\s+PLAN|USING\s+(?:COVERING\s+)?INDEX|\b(?:SCAN|SEARCH)\b(?=[\s'"`/])/, /using\s+(?:covering\s+)?index/i];
const CREATE_TABLE = /CREATE\s+(?:TEMP(?:ORARY)?\s+|VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[`"'[]?\w+[`"'\]]?\.)?[`"'[]?(\w+)/gi;
/** A counter that measures database cost: a measured store's `reads()`/`writes()`, or a row or statement count. */
const COST_COUNTER = String.raw`(?:reads\(\)|writes\(\)|rowsRead|rowsWritten|rows_read|rows_written|statements|queries)`;
const EXACT_COST = new RegExp(String.raw`expect\(\s*(?:[^;]*?[.\s(])?${COST_COUNTER}(?:\.length)?\s*,?\s*\)\s*\.(?:toBe|toEqual|toStrictEqual|toHaveLength)\(\s*([1-9]\d*)\s*\)`);
const EXPECTED_OBJECT = /\.(?:toEqual|toStrictEqual|toMatchObject)\(\s*\{([^;]*)/;
const COST_FIELD = /\b(?:rowsRead|rowsWritten|rows_read|rows_written|statements|queries):\s*[1-9]\d*\b/;
const COST_PAIR = [/\breads:\s*[1-9]\d*\b/, /\bwrites:\s*\d+\b/];
/**
 * A per-mechanism cost term. A product limit (`MAX_…`, `MIN_…`) is imported, not summed, and passes; so does a schema
 * step's statement list (`V731_STATEMENTS`, `NEXT_…_STATEMENTS`).
 */
const NAMED_COST = /\b(?!MAX_|MIN_|V\d|VNEXT_|NEXT_|LAST_)[A-Z][A-Z0-9_]*_(?:READS|WRITES|STATEMENTS)\b/;
const TERM = String.raw`\b(?!MAX_|MIN_|V\d|VNEXT_|NEXT_|LAST_)[A-Z][A-Z0-9_]*_(?:READS|WRITES|STATEMENTS)\b`;
/** A named cost term used as a number: declared with one, summed or compared. */
const NAMED_COST_USE = new RegExp(String.raw`[-+*<>]=?\s*${TERM}|${TERM}\s*(?:[-+*<>]|[=:]\s*\d)`);
/** A read or write term asserted or imported counts too; a statement list is asserted as data and does not. */
const ASSERTED_OR_IMPORTED = /\b(?:expect|import|toBe\w*)\b/;
/** A product path handed to a resolver names a module to run, not a file to key a test on, unless the statement reads it as text. */
const MODULE_LOCATION = /(?:\bresolve|\bjoin|new URL|fileURLToPath)\(\s*(?:[^,()]*,\s*)*$/;
const SOURCE_READ = /\b(?:readFileSync|readFile|Bun\.file|createSourceFile)\(/;
const MOCK_CALL = /\b(?:mock\.module|vi\.mock|jest\.mock)\(\s*(['"`])([^'"`]+)\1/g;
const MODULE_SPECIFIER = /\b(?:from|import|require|mock\.module|vi\.mock|jest\.mock)\s*\(?\s*(['"`])([^'"`]+)\1/g;
const STRING_LITERAL = /(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g;
const PRODUCT_PATH_LITERAL = /^(?:\.{1,2}\/)*(packages\/[\w.-]+\/(?:ui\/)?src\/[\w@./-]+\.(?:[cm]?[jt]sx?))(?:#[\w$.]+)?$/;
const SOURCE_PATH = /^(?:\.{1,2}\/)*([\w@./-]+\.(?:[cm]?[jt]sx?))(?:#[\w$.]+)?$/;
const STORE_CALL = /\.(?:exec|run|prepare|query|sql|batch)\(/g;
const SCENARIO_WRITE_CALL = /\.sql\(/g;
const SCREEN_WRITE_CALL = /\.(?:sql|run|query|exec|prepare)\(/g;
const WRITE_KEYWORD = /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b|\bUPDATE\s+\w+\s+SET\b|\bDELETE\s+FROM\b|\bREPLACE\s+INTO\b/i;

const RULES = {
  productTable: (name) => ({
    rule: 'product-table',
    message: `creates the product table \`${name}\`. A test's own copy of a product table keeps passing after the real `
      + 'table changes. Build the real schema through the migrated schema template (seededSqlite() or getD1Database() in '
      + 'tests/myco-server/helpers/d1.ts) and put rows in through the product\'s own writes or routes.',
  }),
  sqlText: () => ({
    rule: 'sql-text',
    message: 'asserts SQL text (an expected value holding SQL, or the .sql of a captured statement). Statement text '
      + 'changes with every behaviour-preserving rewrite. Assert what a caller observes instead: the response, the '
      + 'refusal, or the rows read back after the call.',
  }),
  planText: () => ({
    rule: 'plan-text',
    message: 'names query-plan text (EXPLAIN QUERY PLAN, USING INDEX, SCAN, SEARCH). Plans change with planner '
      + 'statistics and indexes without changing behaviour. State cost as a two-scale test: the same request at a small '
      + 'and a large size reads the same, or at most a bounded k more.',
  }),
  exactCost: (value) => ({
    rule: 'exact-cost',
    message: `pins an exact read, write or statement count (${value}). Every new index or trigger moves it. Measure the `
      + 'same request at two sizes and assert `expect(large.reads()).toBe(small.reads())` or '
      + '`expect(large.reads()).toBeLessThanOrEqual(small.reads() + k)`; a count of 0 for "writes nothing" is allowed.',
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
      + 'real client calls, or read the value from a response. If the scenario is about a limit, move that constant to '
      + 'packages/myco-server/src/constants.ts and import it from there.',
  }),
  blackBoxWrite: () => ({
    rule: 'black-box-write',
    message: 'writes rows (INSERT, UPDATE, DELETE or REPLACE) from a black-box suite. A row written behind the '
      + 'server\'s back can hold a state no client can reach. Create the state through the routes a real client calls; '
      + 'for a row that must be older than a time-to-live, call ageRows(target, { table, column, byMs, match }) from '
      + 'tests/parity/harness.ts; read rows with .sql(\'SELECT ...\') only to check what a call stored.',
  }),
  testKnobName: (name) => ({
    rule: 'test-knob-name',
    message: `exports the test-only knob \`${name}\`. Product code must not expose hooks, reset functions, or fakes `
      + 'for tests. Drive the test through a production entry with an injected dependency the product already accepts, '
      + 'a test-owned worker entry, or a fresh process.',
  }),
  testKnobComment: (phrase) => ({
    rule: 'test-knob-comment',
    message: `marks an export as test-only (${phrase}). Product exports must serve production paths. Drive tests `
      + 'through production entries, existing dependency injection seams, test-owned entries, or delete the test if '
      + 'the behaviour is covered elsewhere.',
  }),
};

const TEST_KNOB_IDENTIFIER = /^(?:_?reset|__\w*ForTests?|install\w*ForTests?|\w+ForTests?)$/;
const TEST_COMMENT_PHRASE = /\b(?:test[- ]only|for\s+testing|exposed\s+for\s+tests?|test\s+seam)\b/i;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

function* exportedKnobNames(code) {
  for (const m of code.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z0-9_$]+)/g)) {
    if (TEST_KNOB_IDENTIFIER.test(m[1])) yield m[1];
  }
  for (const m of code.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) {
    if (TEST_KNOB_IDENTIFIER.test(m[1])) yield m[1];
  }
  for (const block of code.matchAll(/\bexport\s*\{([^}]+)\}/g)) {
    for (const spec of block[1].split(',')) {
      const parts = spec.trim().split(/\s+as\s+/);
      const exportedName = (parts[1] || parts[0]).trim();
      if (TEST_KNOB_IDENTIFIER.test(exportedName)) yield exportedName;
    }
  }
  for (const m of code.matchAll(/(?:^|\s)(?:public\s+|static\s+|async\s+)*([A-Za-z0-9_$]+)\s*\(/g)) {
    if (TEST_KNOB_IDENTIFIER.test(m[1])) yield m[1];
  }
}

function exportCommentPhrase(file, line, text) {
  if (!TEST_COMMENT_PHRASE.test(text)) return null;
  const match = TEST_COMMENT_PHRASE.exec(text)[0];
  if (/\bexport\b/.test(text)) return match;
  if (!file || typeof line !== 'number') return null;
  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = line; i < Math.min(lines.length, line + 5); i++) {
      const trimmed = lines[i]?.trim() ?? '';
      if (!trimmed || COMMENT_LINE.test(trimmed)) continue;
      if (/\bexport\b/.test(trimmed)) return match;
      break;
    }
  } catch {}
  return null;
}

/** Whether `file` is a test file to check. */
export function isTestFile(file) {
  return file.startsWith('tests/') && CODE_FILE.test(file) && !file.startsWith(EXEMPT_DIRECTORY) && !EXEMPT_FILES.has(file);
}

/** Whether `file` is a product code file to check for test knobs. */
export function isProductFile(file) {
  return PRODUCT_ROOT.test(file) && CODE_FILE.test(file) && !file.includes('.generated.');
}

/** Whether the rules apply to `file` at all. */
export function checkedFile(file) {
  return isTestFile(file) || isProductFile(file);
}

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

/** The product file a whole string literal names, or null: a repository path under a package's src or ui/src, or a path relative to one. */
function productPathLiteral(literal, productFiles) {
  const repositoryPath = PRODUCT_PATH_LITERAL.exec(literal);
  if (repositoryPath) return literal;
  const match = SOURCE_PATH.exec(literal);
  if (!match || !match[1].includes('/')) return null;
  return productFiles.has(match[1]) ? literal : null;
}

/** Every string literal inside the parentheses of each call `pattern` matches in `text`, call by call. */
function* stringArguments(text, pattern) {
  for (const call of text.matchAll(pattern)) {
    let depth = 0;
    for (let index = call.index + call[0].length; index < text.length; index += 1) {
      const char = text[index];
      if (char === '(' || char === '[' || char === '{') depth += 1;
      else if (char === ')' || char === ']' || char === '}') { if (depth === 0) break; depth -= 1; }
      else if (char === '"' || char === "'" || char === '`') {
        let end = index + 1;
        while (end < text.length && text[end] !== char) end += text[end] === '\\' ? 2 : 1;
        yield text.slice(index + 1, end);
        index = end;
      }
    }
  }
}

/**
 * The rules a statement breaks, one finding each.
 * @param {{ file: string, code: string, text: string }} statement `code` is the statement without its comment lines;
 *   `text` keeps them.
 * @param {{ productTables: () => ReadonlySet<string>, productFiles: ReadonlySet<string> }} facts
 * @returns {{ rule: string, message: string }[]}
 */
export function statementFindings({ file, line, code, text }, facts) {
  if (isProductFile(file)) {
    const findings = [];
    for (const name of new Set(exportedKnobNames(code))) {
      findings.push(RULES.testKnobName(name));
    }
    const phrase = exportCommentPhrase(file, line, text);
    if (phrase !== null) {
      findings.push(RULES.testKnobComment(phrase));
    }
    return findings;
  }
  const findings = [];
  const blanked = code.replace(STRING_LITERAL, '""');
  for (const argument of stringArguments(code, STORE_CALL)) {
    for (const match of argument.matchAll(CREATE_TABLE)) {
      if (facts.productTables().has(match[1].toLowerCase())) findings.push(RULES.productTable(match[1]));
    }
  }
  if (SQL_EXPECTED.some((pattern) => pattern.test(code)) || SQL_SUBJECT.some((pattern) => pattern.test(blanked))) findings.push(RULES.sqlText());
  if (PLAN_TEXT.some((pattern) => pattern.test(text))) findings.push(RULES.planText());
  const exact = EXACT_COST.exec(code);
  const expected = EXPECTED_OBJECT.exec(code)?.[1] ?? '';
  const field = COST_FIELD.exec(expected) ?? (COST_PAIR.every((pattern) => pattern.test(expected)) ? COST_PAIR[0].exec(expected) : null);
  if (exact ?? field) findings.push(RULES.exactCost((exact ?? field)[0]));
  const named = NAMED_COST.exec(blanked);
  const asNumber = NAMED_COST_USE.test(blanked) || (/_(?:READS|WRITES)$/.test(named?.[0] ?? '') && ASSERTED_OR_IMPORTED.test(blanked));
  if (named && asNumber) findings.push(RULES.namedCost(named[0]));
  for (const match of code.matchAll(MOCK_CALL)) {
    if (productModule(file, match[2])) findings.push(RULES.productMock(match[2]));
  }
  const withoutSpecifiers = code.replace(MODULE_SPECIFIER, '');
  for (const match of withoutSpecifiers.matchAll(STRING_LITERAL)) {
    const path = productPathLiteral(match[2], facts.productFiles);
    if (path === null) continue;
    if (MODULE_LOCATION.test(withoutSpecifiers.slice(0, match.index)) && !SOURCE_READ.test(code)) continue;
    findings.push(RULES.productPath(path));
    break;
  }
  const scenario = file.startsWith(PARITY_SCENARIOS);
  if (scenario || UI_SCREENS.test(file)) {
    for (const match of code.matchAll(MODULE_SPECIFIER)) {
      if (/mock/.test(match[0])) continue;
      const module = workerModule(file, match[2]);
      if (module !== null && !BLACK_BOX_WORKER_MODULES.has(module)) findings.push(RULES.blackBoxImport(match[2]));
    }
    for (const argument of stringArguments(code, scenario ? SCENARIO_WRITE_CALL : SCREEN_WRITE_CALL)) {
      if (WRITE_KEYWORD.test(argument)) { findings.push(RULES.blackBoxWrite()); break; }
    }
  }
  return findings;
}
