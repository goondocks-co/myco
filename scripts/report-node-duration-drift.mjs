// Write files over 1.5× their weight, and groups over the packing budget, to the step summary.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactGroups, durationDrift, driftSummary, nodePackingBudget } from './node-report-workload.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportDirectory = process.argv[2];
if (!reportDirectory) throw new Error('usage: node scripts/report-node-duration-drift.mjs <test-reports-dir>');
if (!fs.existsSync(reportDirectory)) {
  console.log('Node duration drift: no test reports');
  process.exit(0);
}
const groups = artifactGroups(reportDirectory);
const weights = JSON.parse(fs.readFileSync(path.join(repo, 'scripts/test-durations.json'), 'utf8')).files;
const budget = nodePackingBudget(fs.readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8'));
const summary = driftSummary(durationDrift(groups, weights, budget));
console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
