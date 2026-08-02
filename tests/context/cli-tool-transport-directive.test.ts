/**
 * CLI tool-transport directive: the only tool path `toolTransport: cli`
 * symbionts are given, so the invocation it names must be resolvable on the
 * host it is injected into, and the agent-generated body must never carry an
 * invocation of its own.
 */

import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
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
  // A bare `myco` does not resolve in a non-interactive shell.
  expect(directive).not.toContain('`myco tool call');
});

test('a whitespace path degrades to the bare name (direct-argv hosts cannot quote)', () => {
  const directive = cliToolTransportDirective('/Applications/My Tools/myco');
  expect(directive).toContain('`myco tool call <tool>');
  expect(directive).not.toContain('My Tools');
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

// ---------------------------------------------------------------------------
// Generated-content gates: body-authoring surfaces teach tools by NAME and
// carry no shell invocation — the code-owned directive is the only place an
// invocation string exists.
// ---------------------------------------------------------------------------

test('the generated agent definitions contain no shell invocation form', () => {
  const generated = fs.readFileSync(
    path.resolve('packages/myco/src/agent/definitions.generated.ts'),
    'utf8',
  );
  expect(generated).not.toContain('myco tool call');
});

test('the cortex-brief authoring prompt contains no shell invocation form', () => {
  const brief = fs.readFileSync(
    path.resolve('packages/myco/src/context/cortex-brief.ts'),
    'utf8',
  );
  expect(brief).not.toContain('myco tool call');
  expect(brief).not.toContain('`myco tool ...`');
});

test('prompt revisions participate in the regeneration hash via promptContract', () => {
  const brief = fs.readFileSync(
    path.resolve('packages/myco/src/context/cortex-brief.ts'),
    'utf8',
  );
  expect(brief).toMatch(/promptContract:\s*\d+/);
});
