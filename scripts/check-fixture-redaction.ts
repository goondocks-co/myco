import { execFileSync } from 'node:child_process';
import { scanFixture } from './fixture-redaction.ts';

const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: MAX_GIT_OUTPUT_BYTES, stdio: ['pipe', 'pipe', 'pipe'] });
}

try {
  const entries = git(['ls-files', '--stage', '-z', '--', ':(top)tests/fixtures/']).split('\0').filter(Boolean);
  const findings: string[] = [];
  for (const entry of entries) {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
    if (!match) throw new Error('Invalid Git index entry');
    const [, mode, objectId, stage, file] = match;
    const label = JSON.stringify(file);
    if (stage !== '0' || (mode !== '100644' && mode !== '100755')) {
      findings.push(`${label}: fixtures must be resolved regular files`);
      continue;
    }
    for (const finding of scanFixture(git(['cat-file', 'blob', objectId!]))) {
      findings.push(`${label}:${finding.line}: carries ${finding.rule}`);
    }
  }
  if (findings.length > 0) {
    console.error(`Fixture redaction rejected the staged snapshot:\n${findings.join('\n')}\nRedact the fixture and stage it again.`);
    process.exitCode = 1;
  }
} catch {
  console.error('Fixture redaction could not read the Git index or a fixture blob. Commit blocked.');
  process.exitCode = 1;
}
