/**
 * The healthcheck's Host header against the allowlist that decides it.
 *
 * Condition 3 refuses a request whose Host is not an allowlisted loopback
 * authority, and a healthcheck carrying a Host the server refuses reports a
 * serving container unhealthy — which Compose acts on by restarting it. The
 * bundle is written in one package and the allowlist lives in the other, so
 * nothing but this reads them together.
 */
import { describe, expect, it } from 'bun:test';
import { COMPOSE_TEMPLATE } from '@myco/server/compose-template.js';
import { isAllowedLoopbackHost } from '@myco-server-worker/platform/bun/loopback.js';

/** The template with its shell defaults taken and its comments dropped, as Compose renders it for an operator who set nothing. */
const rendered = (): string => COMPOSE_TEMPLATE
  .split('\n').filter((line) => !/^\s*#/.test(line)).join('\n')
  .replace(/\$\{[A-Z_]+:-([^}]*)\}/g, '$1');

/** Every `Host:` value a healthcheck in the bundle carries. */
const hostHeaders = (): string[] =>
  [...rendered().matchAll(/Host: ([^'"\\,]+)/g)].map((match) => match[1]!.trim());

/** The port the healthchecks actually address, read from the URLs they request. */
const probedPorts = (): number[] =>
  [...rendered().matchAll(/http:\/\/127\.0\.0\.1:(\d+)\/health/g)].map((match) => Number(match[1]));

/** The one port every server-health request in the bundle addresses. */
function servedPort(): number {
  const ports = [...new Set(probedPorts())];
  expect(ports).toHaveLength(1);
  return ports[0]!;
}

describe('the healthchecks address the server the way the allowlist admits', () => {
  it('finds the headers it is meant to police', () => {
    // A reader that silently found nothing would pass every assertion below.
    expect(hostHeaders().length).toBeGreaterThanOrEqual(2);
  });

  it('carries a Host every healthcheck request is admitted under, at the port it is requesting', () => {
    // The Host and the URL are written separately; a drift between them is a
    // healthcheck the server refuses on a container that is serving.
    for (const host of hostHeaders()) {
      expect({ host, admitted: isAllowedLoopbackHost(host, servedPort()) }).toEqual({ host, admitted: true });
    }
  });

  it('renders the published port into it, never a name', () => {
    for (const host of hostHeaders()) expect(host).toBe(`127.0.0.1:${servedPort()}`);
    // `localhost` is the one loopback spelling the allowlist refuses.
    expect(isAllowedLoopbackHost(`localhost:${servedPort()}`, servedPort())).toBe(false);
  });

  it('CONTROL: the allowlist refuses a Host naming another port', () => {
    expect(isAllowedLoopbackHost(`127.0.0.1:${servedPort()}`, servedPort() + 1)).toBe(false);
  });
});
