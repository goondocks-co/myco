import fs from 'node:fs';

/** True when a breached timing limit should report and pass: pull requests set MYCO_TIMING_GATES=report. */
export function timingGateReports(env = process.env) {
  return env.MYCO_TIMING_GATES === 'report';
}

/** Warn about one breached timing limit on the run and in its step summary. */
export function reportTimingBreach(message, env = process.env) {
  const text = message.replace(/\r?\n/g, ' ');
  process.stdout.write(`::warning title=Timing limit exceeded (reported, not enforced on this run)::${text}\n`);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `- Timing limit exceeded: ${text}\n`);
}
