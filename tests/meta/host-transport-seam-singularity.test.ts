/**
 * Meta gate: the member→host transport contract has ONE definition per half.
 *
 * A host round-trip is described by two facts, and both used to be re-derived at
 * every call site:
 *   - WHAT the target is — the `RemoteTarget.host` descriptor projected from a
 *     host record. Six builders (the transcript / plan / event-replay / residency
 *     drains, `remoteTargetFor`, `resolveHostCarrierTarget`) each named the
 *     transport's fields in their own object literal.
 *   - WHERE it claims to be addressed — the `host:` header authority, derived by
 *     parsing the target's address. Eight sites did that parse themselves.
 *
 * Neither set has any compile-time link to the others, so a transport field added
 * in one place and forgotten in the rest fails at runtime, per-drain, on a path
 * that only executes against a real host. This gate makes that drift impossible
 * to introduce silently by pinning the two chokepoints:
 *   - `hostDescriptorFor` (`host/routing.ts`) is the only record→descriptor
 *     projection;
 *   - `parseHostUrl` (`host/host-url.ts`) is consumed for TRANSPORT purposes only
 *     inside `daemon/host-proxy.ts`, whose `hostAuthority` and `defaultDial` are
 *     the authority and dial seams. (The probe and the record writer parse it
 *     too — they validate an address rather than dial one — so the gate names
 *     them explicitly rather than pretending the parser has one caller.)
 *
 * Static source scan (node:fs), no daemon boot — same shape as
 * `tests/meta/route-stamp-completeness.test.ts`.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC_ROOT = path.join(REPO_ROOT, 'packages', 'myco', 'src');

/** The module that owns address parsing; both seams live here. */
const TRANSPORT_SEAM_MODULE = path.join('packages', 'myco', 'src', 'daemon', 'host-proxy.ts');
/** The module that owns the record→descriptor projection. */
const DESCRIPTOR_MODULE = path.join('packages', 'myco', 'src', 'host', 'routing.ts');

function walkTypescript(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walkTypescript(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

const SOURCES = walkTypescript(SRC_ROOT).map((full) => ({
  rel: path.relative(REPO_ROOT, full),
  text: fs.readFileSync(full, 'utf-8'),
}));

describe('host transport seam singularity', () => {
  it('derives the host: header authority only inside the transport seam module', () => {
    // The address parser has FOUR legitimate homes: the seam that DIALS with
    // it, the module that DEFINES it, the registry that refuses to record an
    // address it cannot parse, and the routing module that projects a record
    // into a dial target. A fifth means someone is deriving a dial target
    // outside the seam again — the drift this gate exists to stop — so new
    // entries are a deliberate, reviewed act. Keep this count honest: a
    // rationale that no longer describes the list is how an allowlist rots.
    const ADDRESS_PARSE_ALLOWED = new Set([
      TRANSPORT_SEAM_MODULE,
      'packages/myco/src/host/host-url.ts',
      'packages/myco/src/host/registry.ts',
      'packages/myco/src/host/routing.ts',
    ]);

    const offenders = SOURCES
      .filter((file) => !ADDRESS_PARSE_ALLOWED.has(file.rel))
      .filter((file) => /\b(?:parseHostUrl|isValidHostUrl)\b/.test(file.text))
      .map((file) => file.rel);

    expect(offenders).toEqual([]);
  });

  it('projects a host record into a RemoteTarget descriptor only via hostDescriptorFor', () => {
    // What distinguishes a descriptor from the other shapes carrying these
    // fields is NESTING: a descriptor is the value of a `host:` key, whereas a
    // host record, an enrollment payload, and an API status body all assign
    // `host_url` at their own top level. Keying on the nesting is what keeps
    // this gate specific to the construction it governs — matching the field
    // name alone flags five legitimate non-descriptor shapes.
    const NESTED_DESCRIPTOR_LITERAL = /host:\s*\{(?:[^{}]|\{[^{}]*\})*?host_url:/s;

    const offenders = SOURCES
      .filter((file) => file.rel !== DESCRIPTOR_MODULE)
      .filter((file) => NESTED_DESCRIPTOR_LITERAL.test(file.text))
      .map((file) => file.rel);

    expect(offenders).toEqual([]);
  });

  it('pins both seams to their owning modules', () => {
    const seam = SOURCES.find((file) => file.rel === TRANSPORT_SEAM_MODULE);
    const descriptor = SOURCES.find((file) => file.rel === DESCRIPTOR_MODULE);

    expect(seam?.text).toContain('export function hostAuthority(');
    expect(seam?.text).toContain('export const defaultDial');
    expect(descriptor?.text).toContain('export function hostDescriptorFor(');
  });
});
