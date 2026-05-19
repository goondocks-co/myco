#!/usr/bin/env node
// Drives `bun test` in two passes: non-tsx tests (pure Node environment) and
// tsx tests (jsdom via a dedicated bunfig). Honors MYCO_TEST_PROFILE=fast |
// integration to match the former vitest-side configuration.

import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FAST_EXCLUDES = [
  'tests/integration/',
  'tests/smoke/',
  'tests/daemon/integration.test.ts',
  'tests/daemon/server.test.ts',
  'tests/hooks/client.test.ts',
];
const INTEGRATION_INCLUDES = [
  'tests/integration/',
  'tests/smoke/',
  'tests/daemon/integration.test.ts',
  'tests/daemon/server.test.ts',
  'tests/hooks/client.test.ts',
];

const profile = process.env.MYCO_TEST_PROFILE ?? '';
const forwardedArgs = process.argv.slice(2);

const VALUE_FLAGS = new Set([
  '-t',
  '--test-name-pattern',
  '--timeout',
  '--rerun-each',
  '--retry',
  '--bail',
  '--coverage-reporter',
  '--coverage-dir',
  '--reporter',
  '--reporter-outfile',
  '--max-concurrency',
  '--parallel',
  '--parallel-delay',
  '--shard',
]);

function parseForwardedArgs(args) {
  const options = [];
  const targets = [];

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--') continue;
    if (arg.startsWith('-')) {
      options.push(arg);
      const flag = arg.split('=')[0];
      if (!arg.includes('=') && VALUE_FLAGS.has(flag) && i + 1 < args.length) {
        options.push(args[i + 1]);
        i += 1;
      }
    } else {
      targets.push(arg);
    }
  }

  return { options, targets };
}

function isTestFile(file) {
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

function findTests(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findTests(full, out);
    else if (entry.isFile() && isTestFile(entry.name)) out.push(full);
  }
  return out;
}

function findTsxTests(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) findTsxTests(full, out);
    else if (entry.isFile() && entry.name.endsWith('.test.tsx')) out.push(full);
  }
  return out;
}

function relativeUnique(files) {
  return [...new Set(files.map((f) => path.relative(REPO, f)))].sort();
}

function expandTargets(targets) {
  const nonDom = [];
  const dom = [];
  const passthrough = [];

  for (const target of targets) {
    const full = path.resolve(REPO, target);
    if (!fs.existsSync(full)) {
      passthrough.push(target);
      continue;
    }

    const stat = fs.statSync(full);
    const files = stat.isDirectory() ? findTests(full) : [full];
    for (const file of files) {
      if (file.endsWith('.test.tsx')) dom.push(file);
      else nonDom.push(file);
    }
  }

  return {
    nonDom: relativeUnique(nonDom),
    dom: relativeUnique(dom),
    passthrough,
  };
}

/**
 * Returns two arrays: [nonDomArgs, domArgs]. Each is an argv suffix passed to
 * `bun test`. `nonDomArgs` always ignores tsx files; `domArgs` always ignores
 * non-tsx files.
 */
function buildArgs() {
  const { options, targets } = parseForwardedArgs(forwardedArgs);
  const tsxFiles = relativeUnique(findTsxTests(path.join(REPO, 'tests')));

  if (targets.length > 0) {
    const expanded = expandTargets(targets);
    if (expanded.passthrough.length > 0) {
      console.warn(
        `[run-bun-tests] treating unmatched target(s) as Bun patterns: ${expanded.passthrough.join(', ')}`,
      );
    }

    const nonDomTargets = [...expanded.nonDom, ...expanded.passthrough];
    return {
      nonDom: nonDomTargets.length > 0
        ? [...options, ...nonDomTargets, "--path-ignore-patterns=**/*.test.tsx"]
        : null,
      dom: expanded.dom.length > 0 ? [...options, ...expanded.dom] : null,
    };
  }

  if (profile === 'integration') {
    return {
      // Integration profile: tests/integration + tests/smoke plus a few
      // named files. None are tsx at time of writing.
      nonDom: [...options, ...INTEGRATION_INCLUDES, "--path-ignore-patterns=**/*.test.tsx"],
      dom: null,
    };
  }

  if (profile === 'fast') {
    // Fast profile: everything except the integration/smoke buckets.
    const ignores = [
      "--path-ignore-patterns=**/*.test.tsx",
      ...FAST_EXCLUDES.map((p) => `--path-ignore-patterns=${p}**`),
    ];
    return {
      nonDom: [...options, 'tests/', ...ignores],
      // Also run the UI tests in fast mode (they're quick).
      dom: tsxFiles.length > 0 ? [...options, ...tsxFiles] : null,
    };
  }

  return {
    nonDom: [...options, 'tests/', "--path-ignore-patterns=**/*.test.tsx"],
    dom: tsxFiles.length > 0 ? [...options, ...tsxFiles] : null,
  };
}

// Where per-phase test artifacts land. Always written so that a non-zero exit
// can be followed up by reading a deterministic file — instead of grepping
// through the human-readable stream (which loses ANSI markers when piped and
// drowns failure lines under 4,900+ pass lines).
//
// Two artifacts per phase:
//   - <phase>.junit.xml — Bun's JUnit XML (captures assertion failures)
//   - <phase>.log       — verbatim tee of Bun's stdout+stderr (captures the
//                         "1 error" class that the JUnit reporter silently
//                         drops, plus context lines around `(fail)` markers)
const REPORT_DIR = path.join(REPO, 'target', 'test-reports');
function reportPath(label) {
  return path.join(REPORT_DIR, `${label.replace(/\s+/g, '-')}.junit.xml`);
}
function logPath(label) {
  return path.join(REPORT_DIR, `${label.replace(/\s+/g, '-')}.log`);
}

function runPhase(label, extraArgs, bunfig) {
  if (extraArgs === null || extraArgs.length === 0) return 0;
  // `BUN_CONFIG_FILE` is not observed by `bun test` for the bunfig; the only
  // reliable way to swap configs is to move the file on disk for the
  // duration of the run.
  const canonical = path.join(REPO, 'bunfig.toml');
  const backup = path.join(REPO, '.bunfig.toml.runner-backup');
  let restored = false;
  if (bunfig && bunfig !== canonical) {
    if (fs.existsSync(canonical)) fs.renameSync(canonical, backup);
    fs.copyFileSync(bunfig, canonical);
    restored = true;
  }
  try {
    console.log(`\n=== bun test (${label}) ===`);
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const reportFile = reportPath(label);
    const teeFile = logPath(label);
    fs.writeFileSync(teeFile, ''); // start empty so re-runs don't append stale data
    // Always emit a JUnit XML report alongside the human-readable stream.
    // We tee stdout+stderr to both the terminal AND a local log file so a
    // post-run scan can recover the "1 error" class that Bun's JUnit
    // reporter drops (file-load errors, unhandled rejections, etc.).
    const args = [
      'test', '--isolate',
      '--reporter=junit',
      `--reporter-outfile=${reportFile}`,
      ...extraArgs,
    ];
    const status = runWithTee('bun', args, teeFile);
    return status;
  } finally {
    if (restored) {
      fs.rmSync(canonical, { force: true });
      if (fs.existsSync(backup)) fs.renameSync(backup, canonical);
    }
  }
}

/**
 * Parse a Bun-emitted JUnit XML and return a flat list of failures.
 *
 * Bun emits two `<testcase>` shapes:
 *   - self-closing: `<testcase name="…" classname="…" … />`        (pass)
 *   - paired:      `<testcase name="…" …><failure …/></testcase>`  (fail/skip)
 *
 * We must NOT match the self-closing form with a paired-tag regex — that
 * would greedily span from a passing testcase through to the next paired
 * `</testcase>` and report the wrong test as the failure. The lookbehind
 * `(?<!\/)` on the open-tag `>` excludes self-closers.
 *
 * `name` is the test (it block) name; `classname` is the describe-suite
 * path. `file` (a separate attribute Bun emits) is the source path —
 * useful for jumping to the failing file.
 */
function parseFailuresFromJunit(file) {
  if (!fs.existsSync(file)) return [];
  let xml;
  try {
    xml = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const failures = [];
  const pairedTestcasePattern =
    /<testcase\b([^>]*?)(?<!\/)\s*>([\s\S]*?)<\/testcase>/g;
  for (const match of xml.matchAll(pairedTestcasePattern)) {
    const attrs = match[1];
    const body = match[2];
    if (!/<failure\b/.test(body)) continue;
    const name = attrs.match(/\bname="([^"]*)"/)?.[1] ?? '(unnamed)';
    const classname = attrs.match(/\bclassname="([^"]*)"/)?.[1] ?? '';
    const sourceFile = attrs.match(/\bfile="([^"]*)"/)?.[1] ?? '';
    const lineNo = attrs.match(/\bline="([^"]*)"/)?.[1] ?? '';
    // Bun's `<failure>` is usually `<failure type="AssertionError" />` with
    // no message attribute; the human-readable message is on stdout. We
    // still try to surface `message` and `type` when present.
    const failureMessage = body.match(/<failure[^>]*\bmessage="([^"]*)"/)?.[1] ?? '';
    const failureType = body.match(/<failure[^>]*\btype="([^"]*)"/)?.[1] ?? '';
    failures.push({
      name: decodeXmlEntities(name),
      classname: decodeXmlEntities(classname),
      file: sourceFile,
      line: lineNo,
      message: decodeXmlEntities(failureMessage || failureType),
    });
  }
  return failures;
}

/**
 * Run a subprocess synchronously while teeing stdout+stderr to both the
 * terminal (so live progress is preserved) and a log file (so a
 * post-run scanner can find failure context that the JUnit reporter
 * silently drops).
 *
 * Implemented with synchronous spawnSync + a child that writes to a pipe
 * to `tee` via shell — simplest cross-platform path that preserves exit
 * code without requiring Node's async event loop in this script.
 */
function runWithTee(command, args, teeFile) {
  // Use /bin/sh to set pipefail so the parent's exit code reflects the
  // child's status (not tee's). `tee -a` is fine because we pre-truncated
  // the file in runPhase. Quote args defensively — they're internal so
  // we control them, but defense in depth never hurts.
  const escaped = args.map((a) => `'${String(a).replace(/'/g, `'\\''`)}'`).join(' ');
  const teePath = teeFile.replace(/'/g, `'\\''`);
  const shellCmd = `set -o pipefail; ${command} ${escaped} 2>&1 | tee -a '${teePath}'`;
  const result = spawnSync('/bin/sh', ['-c', shellCmd], {
    cwd: REPO,
    stdio: 'inherit',
    env: process.env,
  });
  return result.status ?? 1;
}

function decodeXmlEntities(input) {
  return input
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, '\n')
    .replace(/&amp;/g, '&');
}

/**
 * Scan a phase's tee'd log for failure context that Bun's JUnit reporter
 * doesn't capture. Two patterns:
 *   1. `(fail) <test path>` — assertion failures (also in JUnit, but kept
 *      here as a cross-check).
 *   2. `error: <message>` followed by an `at <file>:<line>:<col>` stack
 *      frame — uncaught errors / unhandled rejections / file-load failures
 *      that Bun summarizes as `N error` but never emits as a `<failure>`
 *      node in the JUnit XML.
 */
function parseFailuresFromLog(file) {
  if (!fs.existsSync(file)) return [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const failures = [];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // (fail) markers — Bun's stdout per-test failure announcement.
    const failMatch = line.match(/^\(fail\)\s+(.+?)(?:\s+\[[^\]]*\])?$/);
    if (failMatch) {
      failures.push({ kind: 'fail', name: failMatch[1].trim(), location: '' });
      continue;
    }
    // error: lines — typically followed by a stack frame within ~10 lines.
    const errMatch = line.match(/^error:\s+(.+)$/);
    if (errMatch) {
      let location = '';
      for (let j = i + 1; j < Math.min(i + 12, lines.length); j++) {
        const stackMatch = lines[j].match(/at\s+(?:<anonymous>\s+)?\((.+?:\d+(?::\d+)?)\)/)
          ?? lines[j].match(/at\s+(.+?:\d+(?::\d+)?)/);
        if (stackMatch) {
          location = stackMatch[1];
          break;
        }
      }
      failures.push({ kind: 'error', name: errMatch[1].trim(), location });
    }
  }
  return failures;
}

/**
 * Print a structured FAILURES summary so a non-zero exit always tells the
 * caller exactly what failed, in a stream-position they can find without
 * scrolling past tens of thousands of pass lines. The JUnit XMLs and the
 * per-phase logs remain on disk for deeper inspection.
 *
 * Two-source fusion:
 *   - JUnit XML for asserted-and-named failures with file:line metadata.
 *   - Tee'd log for file-load / uncaught / rejection errors that JUnit
 *     drops. Deduped by visible identity so the same test isn't listed twice.
 */
function printFailureSummary(phaseStatuses) {
  const allEntries = [];
  for (const { label, file: junitFile, log: logFile } of phaseStatuses) {
    // 1. JUnit-sourced asserted failures with file:line metadata. Collect the
    //    set of (file, line) pairs they already cover so log-sourced errors
    //    at the same location aren't duplicated.
    const junitFailures = parseFailuresFromJunit(junitFile);
    const junitFailureLocations = new Set();
    const junitFailureFiles = new Set();
    for (const f of junitFailures) {
      if (f.file && f.line) junitFailureLocations.add(`${f.file}:${f.line}`);
      if (f.file) junitFailureFiles.add(f.file);
      allEntries.push({
        phase: label,
        kind: 'fail',
        line: formatJunitEntry(label, f),
      });
    }
    // 2. Log-sourced entries — keep only what JUnit missed. An `error:` line
    //    whose stack frame points at a file:line already in the JUnit set is
    //    the same failure (just with the assertion message); skip it. A
    //    `(fail)` line that mentions a test already in JUnit is also a dupe.
    //    What's left is the "1 error" class JUnit silently drops: file-load
    //    errors, unhandled rejections, setup-time throws.
    //
    // Path normalization: Bun's log stack frames are absolute (under REPO);
    // JUnit `file=` attrs are repo-relative. Strip the repo prefix from log
    // locations before comparing.
    const repoPrefix = REPO.endsWith('/') ? REPO : REPO + '/';
    for (const f of parseFailuresFromLog(logFile)) {
      if (f.kind === 'error') {
        const normalized = f.location.startsWith(repoPrefix)
          ? f.location.slice(repoPrefix.length)
          : f.location;
        const fileColon = normalized.match(/^(.+?:\d+)/)?.[1] ?? '';
        const fileOnly = normalized.replace(/:\d+(?::\d+)?$/, '');
        if (fileColon && junitFailureLocations.has(fileColon)) continue;
        if (fileOnly && junitFailureFiles.has(fileOnly)) continue;
      }
      // Dedupe `(fail)` markers against JUnit by test-path tail.
      if (f.kind === 'fail') {
        const tail = f.name.split(' > ').pop()?.trim() ?? '';
        const alreadyInJunit = junitFailures.some((jf) => jf.name === tail);
        if (alreadyInJunit) continue;
      }
      allEntries.push({
        phase: label,
        kind: f.kind,
        line: `[${label}] ${f.kind === 'error' ? 'ERROR ' : ''}${f.name}${f.location ? ` (${f.location})` : ''}`,
      });
    }
  }
  if (allEntries.length === 0) return;
  console.log('\n=== FAILURES ===');
  for (const e of allEntries) {
    console.log(e.line);
  }
  console.log(`\n${allEntries.length} failure${allEntries.length === 1 ? '' : 's'}. Artifacts:`);
  for (const { label, file, log } of phaseStatuses) {
    if (fs.existsSync(file)) console.log(`  ${label} JUnit: ${file}`);
    if (fs.existsSync(log))  console.log(`  ${label} log:   ${log}`);
  }
}

function formatJunitEntry(label, f) {
  const suite = f.classname ? `${f.classname} > ` : '';
  const loc = f.file ? ` (${f.file}${f.line ? `:${f.line}` : ''})` : '';
  const msg = f.message ? `\n  ${f.message.split('\n')[0].trim()}` : '';
  return `[${label}] ${suite}${f.name}${loc}${msg}`;
}

/**
 * npm installs a second copy of react + react-dom under
 * packages/myco/ui/node_modules whenever the ui workspace's peer versions
 * differ in any way from the root. When a tsx test then imports a component
 * via `packages/myco/ui/src/...`, that component resolves to the UI-local
 * React while `@testing-library/react` (from root) resolves to root's React.
 * Two React instances == broken hooks. Strip the duplicates before the tsx
 * pass; Bun.plugin `onResolve` hooks don't fire in time to re-route static
 * imports.
 */
function stripDuplicateReact() {
  const candidates = [
    path.join(REPO, 'packages/myco/ui/node_modules'),
    path.join(REPO, 'packages/myco-collective/ui/node_modules'),
    path.join(REPO, 'packages/myco-team/ui/node_modules'),
  ];
  for (const base of candidates) {
    for (const pkg of [
      'react',
      'react-dom',
      'react-router-dom',
      'react-router',
      '@tanstack/react-query',
      '@tanstack/query-core',
    ]) {
      const dupe = path.join(base, pkg);
      if (fs.existsSync(dupe)) {
        fs.rmSync(dupe, { recursive: true, force: true });
        console.log(`[run-bun-tests] removed duplicate ${pkg} at ${dupe}`);
      }
    }
  }
}

const { nonDom, dom } = buildArgs();
const phaseReports = [];

const nonDomStatus = runPhase('node env', nonDom, path.join(REPO, 'bunfig.toml'));
if (nonDom !== null && nonDom.length > 0) {
  phaseReports.push({
    label: 'node env',
    file: reportPath('node env'),
    log: logPath('node env'),
  });
}

let domStatus = 0;
if (dom !== null) {
  stripDuplicateReact();
  domStatus = runPhase(
    'jsdom',
    dom,
    path.join(REPO, 'bunfig.dom.toml'),
  );
  phaseReports.push({
    label: 'jsdom',
    file: reportPath('jsdom'),
    log: logPath('jsdom'),
  });
}

const exitCode = nonDomStatus || domStatus;
if (exitCode !== 0) {
  printFailureSummary(phaseReports);
}
process.exit(exitCode);
