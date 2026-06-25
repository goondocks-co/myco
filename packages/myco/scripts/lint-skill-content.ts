/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanForContamination, type SkillContaminationSpan } from '@myco/agent/tools/skill-contamination.js';

interface CliOptions {
  strict: boolean;
  showWarnings: boolean;
  json: boolean;
  paths: string[];
}

interface FileReport {
  file: string;
  hard: SkillContaminationSpan[];
  warn: SkillContaminationSpan[];
}

interface ResolvedFiles {
  files: string[];
  missing: string[];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const FALLBACK_REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..');
const DEFAULT_SKILL_PATHS = ['.agents/skills', 'packages/myco/skills'];

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    strict: false,
    showWarnings: false,
    json: false,
    paths: [],
  };

  for (const arg of argv) {
    if (arg === '--strict') {
      options.strict = true;
    } else if (arg === '--show-warnings') {
      options.showWarnings = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      options.paths.push(arg);
    }
  }

  return options;
}

function printHelp(): void {
  process.stdout.write(`Usage: tsx packages/myco/scripts/lint-skill-content.ts [--strict] [--show-warnings] [--json] [path...]

Scans Myco SKILL.md files for point-in-time release, PR, date, and history contamination.

Default paths: ${DEFAULT_SKILL_PATHS.join(', ')}
Default mode fails on hard contamination only. --strict also fails on warnings.
`);
}

function repoRoot(): string {
  try {
    return execFileSync('git', ['-C', FALLBACK_REPO_ROOT, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return FALLBACK_REPO_ROOT;
  }
}

function defaultSkillFiles(root: string): string[] {
  const files = new Set<string>();
  try {
    const output = execFileSync('git', [
      '-C',
      root,
      'ls-files',
      '--',
      '.agents/skills/**/SKILL.md',
      'packages/myco/skills/**/SKILL.md',
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (output) {
      for (const file of output.split(/\r?\n/)) {
        files.add(path.join(root, file));
      }
    }
  } catch {
    // Fall back to filesystem traversal when the checkout metadata is absent.
  }

  for (const entry of DEFAULT_SKILL_PATHS) {
    for (const file of collectSkillFiles(path.join(root, entry))) {
      files.add(file);
    }
  }
  return [...files];
}

function collectSkillFiles(entry: string): string[] {
  if (!fs.existsSync(entry)) return [];
  const stat = fs.statSync(entry);
  if (stat.isFile()) return path.basename(entry) === 'SKILL.md' ? [entry] : [];
  if (!stat.isDirectory()) return [];

  const files: string[] = [];
  for (const dirent of fs.readdirSync(entry, { withFileTypes: true })) {
    if (dirent.name === 'node_modules' || dirent.name === 'dist') continue;
    const child = path.join(entry, dirent.name);
    if (dirent.isDirectory()) {
      files.push(...collectSkillFiles(child));
    } else if (dirent.isFile() && dirent.name === 'SKILL.md') {
      files.push(child);
    }
  }
  return files;
}

function filesFromArgs(root: string, entries: string[]): ResolvedFiles {
  if (entries.length === 0) return { files: defaultSkillFiles(root), missing: [] };

  const files: string[] = [];
  const missing: string[] = [];
  for (const entry of entries) {
    const resolved = path.resolve(process.cwd(), entry);
    if (!fs.existsSync(resolved)) {
      missing.push(entry);
      continue;
    }
    const matches = collectSkillFiles(resolved);
    if (matches.length === 0) {
      missing.push(entry);
      continue;
    }
    files.push(...matches);
  }
  return { files, missing };
}

function lineColumn(content: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset; index++) {
    if (content[index] === '\n') {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

function scanFile(root: string, file: string): FileReport {
  const content = fs.readFileSync(file, 'utf8');
  const result = scanForContamination(content);
  return {
    file: path.relative(root, file),
    hard: withLocations(content, result.hard),
    warn: withLocations(content, result.warn),
  };
}

function withLocations(content: string, spans: SkillContaminationSpan[]): SkillContaminationSpan[] {
  return spans.map(span => {
    const location = lineColumn(content, span.start);
    return {
      ...span,
      message: `${span.message} (${location.line}:${location.column})`,
    };
  });
}

function printHumanReport(reports: FileReport[], options: CliOptions): void {
  const hardCount = reports.reduce((sum, report) => sum + report.hard.length, 0);
  const warnCount = reports.reduce((sum, report) => sum + report.warn.length, 0);
  const showWarnDetails = options.strict || options.showWarnings;

  for (const report of reports) {
    const hasPrintableWarning = showWarnDetails && report.warn.length > 0;
    if (report.hard.length === 0 && !hasPrintableWarning) continue;
    process.stdout.write(`\n${report.file}\n`);
    for (const span of report.hard) {
      process.stdout.write(`  HARD ${span.kind}: ${JSON.stringify(span.text)} ${span.message}\n`);
    }
    if (showWarnDetails) {
      for (const span of report.warn) {
        process.stdout.write(`  WARN ${span.kind}: ${JSON.stringify(span.text)} ${span.message}\n`);
      }
    }
  }

  process.stdout.write(
    `\nSkill content lint: ${reports.length} files, ${hardCount} hard, ${warnCount} warnings` +
    `${options.strict ? ' (strict)' : ''}.\n`,
  );
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const root = repoRoot();
  const resolved = filesFromArgs(root, options.paths);
  const files = [...new Set(resolved.files)]
    .sort((a, b) => a.localeCompare(b));
  const reports = files.map(file => scanFile(root, file));
  const hardCount = reports.reduce((sum, report) => sum + report.hard.length, 0);
  const warnCount = reports.reduce((sum, report) => sum + report.warn.length, 0);

  if (options.json) {
    process.stdout.write(`${JSON.stringify({
      ok: hardCount === 0 && (!options.strict || warnCount === 0),
      strict: options.strict,
      files: reports.length,
      hard_count: hardCount,
      warn_count: warnCount,
      missing_paths: resolved.missing,
      reports,
    }, null, 2)}\n`);
  } else {
    printHumanReport(reports, options);
    for (const entry of resolved.missing) {
      process.stderr.write(`Skill content lint target did not match any SKILL.md file: ${entry}\n`);
    }
  }

  if (resolved.missing.length > 0 || hardCount > 0 || (options.strict && warnCount > 0)) {
    process.exitCode = 1;
  }
}

main();
