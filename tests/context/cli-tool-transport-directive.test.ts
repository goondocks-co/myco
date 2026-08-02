/**
 * CLI tool-transport directive.
 *
 * For `toolTransport: cli` symbionts this directive is not a fallback — it is
 * the ONLY tool path they are given. It used to hardcode a bare `myco`, which
 * resolves only in shells that read the user's interactive rc files; coding
 * agents spawn non-interactive shells and GUI-launched agents inherit a
 * minimal launchd PATH, so the command we handed them did not run. The binary
 * is now resolved per-host by the caller and rendered into the directive.
 */

import { test, expect } from 'bun:test';
import {
  composeCortexInstructionInjection,
  cliToolTransportDirective,
} from '@myco/context/cortex-injection-context.js';
import { composeSessionStartContext } from '@myco/context/session-start-context.js';
import { MycoConfigSchema } from '@myco/config/schema.js';

const BINARY = '/home/u/.myco/bin/myco';

test('the directive names the resolved binary, not a bare `myco`', () => {
  const directive = cliToolTransportDirective(BINARY);
  expect(directive).toContain(`${BINARY} tool call <tool>`);
  expect(directive).toContain(`${BINARY} tool call myco_cortex`);
  // The bare form is what fails in a non-interactive shell — it must not be
  // what we hand a cli-transport agent.
  expect(directive).not.toContain('`myco tool call');
});

test('a binary path containing whitespace is quoted so the command survives paste', () => {
  const directive = cliToolTransportDirective('/Applications/My Tools/myco');
  expect(directive).toContain('"/Applications/My Tools/myco" tool call');
});

test('cli transport prepends the directive at session-start', () => {
  const out = composeCortexInstructionInjection('BODY', 'session-start', {
    cliToolTransport: true,
    mycoBinary: BINARY,
  });
  expect(out).not.toBeNull();
  expect(out!.text.startsWith(cliToolTransportDirective(BINARY))).toBe(true);
  expect(out!.text).toContain('BODY');
});

test('default (mcp) adds no directive', () => {
  const out = composeCortexInstructionInjection('BODY', 'session-start');
  expect(out!.text).toBe('BODY');
});

test('cli transport directive also applies at subagent-start', () => {
  const out = composeCortexInstructionInjection('BODY', 'subagent-start', {
    cliToolTransport: true,
    mycoBinary: BINARY,
  });
  expect(out!.text).toContain(cliToolTransportDirective(BINARY));
  expect(out!.text).toContain('BODY');
});

test('an unsupplied binary degrades to the bare name rather than emitting undefined', () => {
  const out = composeCortexInstructionInjection('BODY', 'session-start', { cliToolTransport: true });
  expect(out!.text).toContain('myco tool call');
  expect(out!.text).not.toContain('undefined');
});

test('composeSessionStartContext forwards the resolved binary to the cortex frame', () => {
  const config = MycoConfigSchema.parse({ version: 3 });
  const composed = composeSessionStartContext(config, 'BODY', { kind: 'global' }, {
    cliToolTransport: true,
    mycoBinary: BINARY,
  });
  const cortexPart = composed.parts.find((p) => p.kind === 'cortex');
  expect(cortexPart?.text).toContain(`${BINARY} tool call`);
  expect(cortexPart?.text).toContain('BODY');
});

test('composeSessionStartContext omits the directive for default (mcp) transport', () => {
  const config = MycoConfigSchema.parse({ version: 3 });
  const composed = composeSessionStartContext(config, 'BODY', { kind: 'global' });
  const cortexPart = composed.parts.find((p) => p.kind === 'cortex');
  expect(cortexPart?.text).toBe('BODY');
});
