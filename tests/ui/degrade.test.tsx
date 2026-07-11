// @vitest-environment jsdom

/**
 * The uniform hosted-capability degradation detector + presentation
 * (consolidation Task D-2 degradation UX): `hostedDegradedInfo` recognizes
 * the ONE refusal shape every `degrade`-stamped Team Host route emits
 * (`host/routing.ts` `hostedCapabilityUnavailable`), and `HostedUnavailable`
 * renders the plain-language "unavailable for hosted projects" state every
 * degraded surface should share instead of a raw error toast.
 */
import { describe, expect, it } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { ApiError } from '../../packages/myco/ui/src/lib/api';
import { hostedDegradedInfo, hostedUnavailableMessage } from '../../packages/myco/ui/src/lib/degrade';
import { HostedUnavailable } from '../../packages/myco/ui/src/components/ui/hosted-unavailable';

function refusal(capability = 'Git provenance') {
  return new ApiError(409, {
    error: 'capability_unavailable_hosted',
    capability,
    message: `${capability} is unavailable for projects served by a host in this version.`,
    retryable: false,
  });
}

describe('hostedDegradedInfo', () => {
  it('recognizes the capability_unavailable_hosted 409 envelope', () => {
    const info = hostedDegradedInfo(refusal('Code intelligence (Canopy)'));
    expect(info).toEqual({
      capability: 'Code intelligence (Canopy)',
      message: 'Code intelligence (Canopy) is unavailable for projects served by a host in this version.',
    });
  });

  it('returns null for a non-ApiError, a non-409 ApiError, or a differently-coded 409', () => {
    expect(hostedDegradedInfo(new Error('boom'))).toBeNull();
    expect(hostedDegradedInfo(undefined)).toBeNull();
    expect(hostedDegradedInfo(new ApiError(404, { error: 'not_found' }))).toBeNull();
    expect(hostedDegradedInfo(new ApiError(409, { error: 'already_claimed' }))).toBeNull();
  });

  it('falls back to a generic capability label when the body omits one', () => {
    const info = hostedDegradedInfo(new ApiError(409, { error: 'capability_unavailable_hosted' }));
    expect(info?.capability).toBe('This feature');
  });
});

describe('hostedUnavailableMessage', () => {
  it('renders outcome vocabulary, not the wire error code', () => {
    const message = hostedUnavailableMessage({ capability: 'Git provenance', message: 'raw' });
    expect(message).toBe("Git provenance isn't available for projects hosted on a Team Host yet.");
    expect(message).not.toContain('capability_unavailable_hosted');
  });
});

describe('HostedUnavailable', () => {
  it('panel variant renders the capability as the title and the uniform message', () => {
    render(<HostedUnavailable info={{ capability: 'Git provenance', message: 'raw' }} />);
    expect(screen.getByText('Git provenance')).toBeDefined();
    expect(screen.getByText(/isn't available for projects hosted on a Team Host yet/)).toBeDefined();
  });

  it('inline variant renders the same message in a compact strip', () => {
    render(<HostedUnavailable info={{ capability: 'Backup and restore', message: 'raw' }} variant="inline" />);
    expect(screen.getByText(/Backup and restore isn't available/)).toBeDefined();
  });
});
