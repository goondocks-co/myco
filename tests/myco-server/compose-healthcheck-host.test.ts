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

/** The port the bundle publishes when the operator names none. */
const DEFAULT_PORT = 8787;

/** The template with its shell defaults taken, as Compose renders it for an operator who set nothing. */
const rendered = (): string => COMPOSE_TEMPLATE.replace(/\$\{[A-Z_]+:-([^}]*)\}/g, '$1');

/** Every `Host:` value a healthcheck in the bundle carries. */
const hostHeaders = (): string[] =>
  [...rendered().matchAll(/Host: ([^'"\\,]+)/g)].map((match) => match[1]!.trim());

describe('the healthchecks address the server the way the allowlist admits', () => {
  it('finds the headers it is meant to police', () => {
    // A reader that silently found nothing would pass every assertion below.
    expect(hostHeaders().length).toBeGreaterThanOrEqual(2);
  });

  it('carries a Host every healthcheck request is admitted under', () => {
    for (const host of hostHeaders()) {
      expect({ host, admitted: isAllowedLoopbackHost(host, DEFAULT_PORT) }).toEqual({ host, admitted: true });
    }
  });

  it('renders the published port into it, never a name', () => {
    for (const host of hostHeaders()) expect(host).toBe(`127.0.0.1:${DEFAULT_PORT}`);
    // `localhost` is the one loopback spelling the allowlist refuses.
    expect(isAllowedLoopbackHost(`localhost:${DEFAULT_PORT}`, DEFAULT_PORT)).toBe(false);
  });

  it('CONTROL: the allowlist refuses a Host naming another port', () => {
    expect(isAllowedLoopbackHost(`127.0.0.1:${DEFAULT_PORT}`, 9001)).toBe(false);
  });
});
