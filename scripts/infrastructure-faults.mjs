// A failed test file is rerun once when its failure is only one of these infrastructure faults.
import { stripVTControlCharacters } from 'node:util';

const MINIFLARE_PROXY = /miniflare|proxy\.worker|workerd/i;
const DEVALUE = /(?:^|[/\\])devalue(?:[/\\]|\b)|node_modules[/\\]devalue|\bdevalue\b/i;
const INTERNAL_ASSERTION = /AssertionError|internal assertion/i;

/** The signature a retry reports, or null when the text is not only an infrastructure fault. */
export function infrastructureFaultSignature(text) {
  const log = stripVTControlCharacters(text);
  const signatures = [];
  if (MINIFLARE_PROXY.test(log) && INTERNAL_ASSERTION.test(log)) signatures.push('miniflare proxy assertion');
  if (DEVALUE.test(log) && INTERNAL_ASSERTION.test(log)) signatures.push('devalue internal assertion');
  if (log.includes('TypeError: Unable to connect')) signatures.push('TypeError: Unable to connect');
  if (log.includes('Network connection lost')) signatures.push('D1 Network connection lost');
  if (signatures.length === 0 || hasUnrelatedFailure(log)) return null;
  return signatures[0];
}

function hasUnrelatedFailure(log) {
  return /(?:^|\n)[^\n]*\bExpected:/.test(log)
    || /(?:^|\n)[^\n]*\bReceived:/.test(log)
    || /(?:^|\n)error:\s+expect\(/.test(log);
}

/**
 * Files in one phase whose own failure text is only an infrastructure fault.
 * `failures` are `{ file, message }`. A phase of one file uses the whole log.
 * A failure that names no file is not retried.
 */
export function retryableInfrastructureFaults({ log, failures, files }) {
  const grouped = new Map();
  for (const failure of failures) {
    const file = failure.file || (files.length === 1 ? files[0] : '');
    if (!file) continue;
    const messages = grouped.get(file) ?? [];
    messages.push(failure.message ?? '');
    grouped.set(file, messages);
  }
  if (grouped.size === 0 && files.length === 1 && infrastructureFaultSignature(log)) {
    grouped.set(files[0], ['']);
  }
  const retry = [];
  for (const [file, messages] of grouped) {
    const text = files.length === 1 ? `${messages.join('\n')}\n${log}` : excerptForFile(log, file, messages.join('\n'));
    const signature = infrastructureFaultSignature(text);
    if (signature) retry.push({ file, signature });
  }
  return retry;
}

function excerptForFile(log, file, message) {
  const lines = log.split('\n');
  const name = file.split('/').pop();
  const chunks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index].includes(file) || (name && lines[index].includes(name))) {
      chunks.push(lines.slice(Math.max(0, index - 8), Math.min(lines.length, index + 20)).join('\n'));
    }
  }
  return [message, chunks.join('\n')].filter(Boolean).join('\n');
}

/** One step-summary line for a file rerun. */
export function infrastructureRetrySummary(file, signature) {
  return `- Infrastructure retry: ${file} (${signature})`;
}

/** Join passing rerun reports into one JUnit document the runner can score. */
export function combineJunitReports(xmls) {
  const suites = [];
  for (const xml of xmls) {
    const found = xml.match(/<testsuite\b[^>]*>[\s\S]*?<\/testsuite>/g);
    if (!found?.length) throw new Error('retry report has no testsuite');
    suites.push(...found);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites>\n${suites.join('\n')}\n</testsuites>\n`;
}
