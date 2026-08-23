import type { SourceIdentity } from '../../core/adapters.js';
import { canonicalAddress } from '../../core/address.js';

/** Source identity on this platform: the edge-set client address, which the edge overwrites on every request, in canonical form. */
export const cloudflareSourceOf: SourceIdentity = (request) => {
  const address = request.headers.get('cf-connecting-ip');
  return address === null ? null : canonicalAddress(address);
};
