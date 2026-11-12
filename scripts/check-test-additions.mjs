// Tests assert behaviour, not code. Each statement a change adds under tests/ is checked against the rules in
// test-addition-rules.mjs, patterns no behavioural test needs. Coupling already on the base is not refused again: a
// line moved, split out or re-indented (its text matches a removed line) counts as old, and within a file a rule is
// reported only for findings beyond those the change removed from that file.
// Usage: npm run check:test-additions, or node scripts/check-test-additions.mjs [base-ref]   (base: $BASE_SHA, else
// origin/main; in CI, BASE_SHA as a full commit id)
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkedFile, isProductFile, isTestFile, PRODUCT_ROOT, statementFindings } from './test-addition-rules.mjs';

const MIGRATIONS_DIR = 'packages/myco-server/migrations';
/** A statement longer than this is checked in pieces, so one unbalanced line cannot swallow a file. */
const MAX_STATEMENT_LINES = 40;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/**
 * The lines a `git diff -U0` adds and removes, by file: added lines by their number in the new file, removed lines by
 * their number in the old one. A deleted file keeps its old path.
 * @typedef {{ line: number, text: string, old?: boolean }} DiffLine
 * @returns {Map<string, { added: DiffLine[], removed: DiffLine[] }>}
 */
function diffLines(diff) {
  const files = new Map();
  let entry = null;
  let oldPath = null;
  let nextAdded = 0;
  let nextRemoved = 0;
  let inHunk = false;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) { entry = null; oldPath = null; inHunk = false; continue; }
    if (!inHunk && raw.startsWith('--- ')) { oldPath = raw === '--- /dev/null' ? null : raw.slice('--- a/'.length); continue; }
    if (!inHunk && raw.startsWith('+++ ')) {
      const file = raw === '+++ /dev/null' ? oldPath : raw.slice('+++ b/'.length);
      if (!files.has(file)) files.set(file, { added: [], removed: [] });
      entry = files.get(file);
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { nextRemoved = Number(hunk[1]); nextAdded = Number(hunk[2]); inHunk = true; continue; }
    if (!inHunk || entry === null) continue;
    if (raw.startsWith('+')) entry.added.push({ line: nextAdded++, text: raw.slice(1) });
    else if (raw.startsWith('-')) entry.removed.push({ line: nextRemoved++, text: raw.slice(1) });
  }
  return files;
}

/** Marks as old every added line whose trimmed text matches a removed line anywhere in the change (each removed line matched once), and that removed line. */
function markMoves(files) {
  const removed = new Map();
  for (const { removed: lines } of files.values()) {
    for (const line of lines) {
      const key = line.text.trim();
      if (key === '') { line.old = true; continue; }
      if (!removed.has(key)) removed.set(key, []);
      removed.get(key).push(line);
    }
  }
  for (const { added } of files.values()) {
    for (const line of added) {
      const key = line.text.trim();
      const match = key === '' ? undefined : removed.get(key)?.pop();
      if (key === '' || match) line.old = true;
      if (match) match.old = true;
    }
  }
}

/** One line outside strings and comments: its bracket balance, whether it ends inside a template literal, and its code. */
function scanLine(text, inTemplate) {
  let depth = 0;
  let quote = inTemplate ? '`' : null;
  let code = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      code += char;
      if (char === '\\') { code += text[index + 1] ?? ''; index += 1; } else if (char === quote) quote = null;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') break;
    code += char;
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
  }
  return { depth, inTemplate: quote === '`', code: code.trimEnd() };
}

/**
 * Consecutive lines grouped into statements: a statement runs until its brackets close and the next line does not
 * continue it with `.`, or until it opens a block (`) {`, `=> {`, `else {`).
 * @param {DiffLine[]} lines lines in file order
 * @returns {{ line: number, code: string, text: string, fresh: boolean }[]}
 */
function statements(lines) {
  const out = [];
  let current = [];
  let depth = 0;
  let inTemplate = false;
  const flush = () => {
    if (current.length === 0) return;
    out.push({
      line: current[0].line,
      code: current.map((part) => part.code.trim()).filter(Boolean).join(' '),
      text: current.map((part) => part.text.trim()).join('\n'),
      fresh: current.some((part) => !part.old),
    });
    current = [];
    depth = 0;
    inTemplate = false;
  };
  lines.forEach((line, index) => {
    if (current.length > 0 && current.at(-1).line !== line.line - 1) flush();
    const comment = !inTemplate && COMMENT_LINE.test(line.text);
    const scanned = comment ? { depth: 0, inTemplate: false, code: '' } : scanLine(line.text, inTemplate);
    current.push({ ...line, code: scanned.code });
    inTemplate = scanned.inTemplate;
    depth += scanned.depth;
    if (inTemplate && current.length < MAX_STATEMENT_LINES) return;
    const next = lines[index + 1];
    const continues = next !== undefined && next.line === line.line + 1 && /^\s*\??\./.test(next.text);
    const opensBlock = /(?:\)|=>|\belse|\btry|\bfinally|\bdo)\s*\{$/.test(scanned.code);
    const onlyCommentsSoFar = current.every((part) => !part.code);
    const nextConsecutive = next !== undefined && next.line === line.line + 1;
    if (opensBlock || (depth <= 0 && !continues && !(onlyCommentsSoFar && nextConsecutive)) || current.length >= MAX_STATEMENT_LINES) flush();
  });
  flush();
  return out;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Every file under a package's src or ui/src in the working tree or at the merge base (so a removed line naming a file
 * the change deletes still counts), as repository paths and as paths relative to that root, by source and emitted extension.
 */
function productFiles(mergeBase) {
  const files = new Set();
  const paths = [
    ...git(['ls-files', '-z', '--', ':(glob)packages/*/src/**', ':(glob)packages/*/ui/src/**']).split('\0'),
    ...git(['ls-tree', '-r', '-z', '--name-only', mergeBase, '--', 'packages']).split('\0').filter((path) => PRODUCT_ROOT.test(path)),
  ];
  for (const path of paths.filter(Boolean)) {
    for (const form of [path, path.replace(PRODUCT_ROOT, '')]) {
      files.add(form);
      files.add(form.replace(/\.ts(x?)$/, '.js$1'));
    }
  }
  return files;
}

/** The product's table and view names, read from the schema its migrations build in an empty in-memory database. */
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

/** Untracked files under tests/ and packages/, every line added. */
function untrackedFiles(files) {
  for (const file of git(['ls-files', '-z', '--others', '--exclude-standard', '--', 'tests/', 'packages/']).split('\0').filter(Boolean)) {
    if (!existsSync(file)) continue;
    files.set(file, { added: readFileSync(file, 'utf8').split('\n').map((text, index) => ({ line: index + 1, text })), removed: [] });
  }
}

/** Each refusal, as `file:line [rule] message` and the statement's first line, and how many added statements were checked. */
async function refusals(files, mergeBase) {
  const checked = [...files].filter(([file]) => checkedFile(file));
  const createsTables = checked.some(([file, { added, removed }]) => isTestFile(file) && [...added, ...removed].some((line) => /CREATE\s+(?:\w+\s+)?TABLE/i.test(line.text)));
  const tables = createsTables ? await migratedTables() : new Set();
  const facts = { productTables: () => tables, productFiles: productFiles(mergeBase) };
  const problems = [];
  let count = 0;
  for (const [file, { added, removed }] of checked) {
    const already = new Map();
    for (const statement of statements(removed).filter((each) => each.fresh)) {
      for (const { rule } of statementFindings({ file, ...statement }, facts)) already.set(rule, (already.get(rule) ?? 0) + 1);
    }
    const addedStatements = statements(added).filter((each) => each.fresh);
    count += addedStatements.length;
    for (const statement of addedStatements) {
      for (const finding of statementFindings({ file, ...statement }, facts)) {
        const left = already.get(finding.rule) ?? 0;
        if (left > 0) { already.set(finding.rule, left - 1); continue; }
        const first = added.find((line) => line.line === statement.line)?.text.trim() ?? '';
        problems.push(`${file}:${statement.line} [${finding.rule}] ${finding.message}\n    ${first.slice(0, 200)}`);
      }
    }
  }
  return { problems, count };
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
    console.error(`Cannot find the merge base of ${base} and HEAD. Fetch it first (\`git fetch origin main\`, and \`git fetch --unshallow\` in a shallow clone), or pass the base ref: node scripts/check-test-additions.mjs <base-ref>`);
    process.exit(2);
  }
  const files = diffLines(git(['diff', '--no-color', '--no-ext-diff', '--find-renames', '-U0', mergeBase, '--', 'tests/', 'packages/']));
  untrackedFiles(files);
  markMoves(files);
  const { problems, count } = await refusals(files, mergeBase);
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    console.error(`\n${problems.length} added statement${problems.length === 1 ? '' : 's'} since the merge base with ${base} (${mergeBase.slice(0, 12)}) `
      + 'couple a test to code instead of behaviour, or expose a product knob for tests. Rewrite each as the message says; the rules are in AGENTS.md (Test behavior, not code).');
    process.exit(1);
  }
  console.log(`${count} added statements since the merge base with ${base} (${mergeBase.slice(0, 12)}) pass the checks for code coupling and test knobs.`);
}
