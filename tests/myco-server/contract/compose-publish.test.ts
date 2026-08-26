/**
 * Condition 4 of #909's C-local contract, verified where it is decidable.
 *
 * The other three conditions are properties the server observes about its own
 * socket and its request headers. This one is not: a container published on
 * every interface receives the same bytes as one published on loopback, so no
 * runtime check inside it can tell the difference. The shipped Compose file is
 * the artifact that decides it, and this gate reads that file.
 *
 * `${MYCO_PORT}:${MYCO_PORT}` publishes on 0.0.0.0. `127.0.0.1:${MYCO_PORT}:${MYCO_PORT}`
 * does not. One prefix separates a loopback deployment from a networked one,
 * and nothing else in the suite reads it.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const COMPOSE = fileURLToPath(new URL('../../../packages/myco-server/compose.yaml', import.meta.url));

/** Every entry under a `ports:` block, in source order. */
function publishedPorts(yaml: string): string[] {
  const lines = yaml.split('\n');
  const found: string[] = [];
  let inPorts = false;
  let portsIndent = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;

    const indent = line.length - line.trimStart().length;
    if (inPorts && indent <= portsIndent && !trimmed.startsWith('-')) inPorts = false;

    if (/^ports:\s*$/.test(trimmed)) {
      inPorts = true;
      portsIndent = indent;
      continue;
    }
    if (inPorts && trimmed.startsWith('-')) {
      found.push(trimmed.replace(/^-\s*/, '').replace(/^["']|["']$/g, ''));
    }
  }
  return found;
}

describe('Compose publishes only on loopback (C-local condition 4)', () => {
  const yaml = readFileSync(COMPOSE, 'utf8');
  const ports = publishedPorts(yaml);

  it('finds the ports it is meant to police', () => {
    // A parser that silently finds nothing would pass every assertion below.
    expect(ports.length).toBeGreaterThan(0);
  });

  it('qualifies every published port with the loopback literal', () => {
    const unqualified = ports.filter((p) => !p.startsWith('127.0.0.1:') && !p.startsWith('[::1]:'));
    expect(unqualified, `published on every interface: ${unqualified.join(', ')}`).toEqual([]);
  });

  it('never publishes by the NAME, matching condition 1', () => {
    expect(ports.filter((p) => p.startsWith('localhost:'))).toEqual([]);
  });

  it('CONTROL: the parser catches an unqualified port', () => {
    // A gate that cannot fail is not a gate.
    const bad = ['services:', '  server:', '    ports:', '      - "8787:8787"'].join('\n');
    expect(publishedPorts(bad)).toEqual(['8787:8787']);
    expect(publishedPorts(bad).filter((p) => !p.startsWith('127.0.0.1:'))).toHaveLength(1);
  });

  it('CONTROL: the parser reads a qualified port as qualified', () => {
    const good = ['services:', '  server:', '    ports:', '      - "127.0.0.1:8787:8787"'].join('\n');
    expect(publishedPorts(good)).toEqual(['127.0.0.1:8787:8787']);
  });

  it('CONTROL: the parser ignores a commented-out port', () => {
    const commented = ['services:', '  server:', '    ports:', '      # - "8787:8787"', '      - "127.0.0.1:8787:8787"'].join('\n');
    expect(publishedPorts(commented)).toEqual(['127.0.0.1:8787:8787']);
  });
});
