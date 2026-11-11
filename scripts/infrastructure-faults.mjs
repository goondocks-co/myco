// A failed test file is rerun once when its own JUnit failure is only an infrastructure fault.
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

/** A stack frame in `file`, as Bun writes it inside a `<failure>` body. */
export function failureStackInFile(text, file) {
  const base = file.split(/[/\\]/).pop();
  if (!base) return false;
  const quoted = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\n)\\s*at [^\\n]*(?:${quoted(file)}|${quoted(base)}):\\d+`);
  return pattern.test(stripVTControlCharacters(text));
}

/**
 * Files whose every JUnit failure body is only an infrastructure fault and names a stack frame in that file.
 * `failures` are `{ file, body }`. A log is never read here.
 */
export function retryableInfrastructureFaults({ failures }) {
  const grouped = new Map();
  for (const failure of failures) {
    if (!failure.file) continue;
    const bodies = grouped.get(failure.file) ?? [];
    bodies.push(failure.body ?? '');
    grouped.set(failure.file, bodies);
  }
  const retry = [];
  for (const [file, bodies] of grouped) {
    const signatures = bodies.map((body) => infrastructureFaultSignature(body));
    if (signatures.some((signature) => !signature)) continue;
    if (bodies.some((body) => !failureStackInFile(body, file))) continue;
    retry.push({ file, signature: signatures[0] });
  }
  return retry;
}

/** Bun reported an error the JUnit file does not carry: `N error` with N > 0, or a load error between tests. */
export function logHasUncarriedError(log) {
  const text = stripVTControlCharacters(log);
  return /^\s*[1-9]\d*\s+error\b/m.test(text) || text.includes('# Unhandled error between tests');
}

/** One step-summary line for a file rerun. */
export function infrastructureRetrySummary(file, signature) {
  return `- Infrastructure retry: ${file} (${signature})`;
}

/** Replace one file's `<testsuite>` entries with the suites from its rerun. Other suites stay. */
export function replaceFileSuites(xml, file, rerunXml) {
  const replacement = rerunXml.match(/<testsuite\b[^>]*>[\s\S]*?<\/testsuite>/g);
  if (!replacement?.length) throw new Error('retry report has no testsuite');
  const base = file.split(/[/\\]/).pop();
  let replaced = 0;
  const next = xml.replace(/<testsuite\b[^>]*>[\s\S]*?<\/testsuite>/g, (suite) => {
    const attr = suite.match(/\bfile="([^"]*)"/)?.[1] ?? '';
    const matches = attr === file || attr === base || (base && (attr.endsWith(`/${base}`) || attr.endsWith(`\\${base}`)));
    if (!matches) return suite;
    replaced += 1;
    return replaced === 1 ? replacement.join('\n') : '';
  });
  if (replaced === 0) throw new Error(`retry report has no suite for ${file}`);
  return next;
}
