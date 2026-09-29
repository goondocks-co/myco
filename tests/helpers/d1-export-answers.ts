/**
 * Every shape of answer the D1 export API is known to give, as one table both callers of it are driven through
 * (#1480, #1484): the recovery producer's port and the operator backup's export. Each must act on an answer as
 * `readD1ExportAnswer` reads it, so neither ever reads `at_bookmark` or `signed_url` itself.
 */
const ok = (result: unknown) => ({ success: true, errors: [], result });

export const D1_EXPORT_ANSWERS: ReadonlyArray<{ what: string; status: number; body: unknown; asked: string | null }> = [
  { what: 'running', status: 200, body: ok({ success: true, status: 'active', at_bookmark: 'b2' }), asked: 'b1' },
  { what: 'running with no status', status: 200, body: ok({ at_bookmark: 'b2' }), asked: 'b1' },
  { what: 'nothing at all', status: 200, body: ok({}), asked: 'b1' },
  { what: 'running with no bookmark on a fresh request', status: 200, body: ok({ status: 'active' }), asked: null },
  { what: 'complete', status: 200, body: ok({ status: 'complete', at_bookmark: 'b3', result: { signed_url: 'https://signed.example/one' } }), asked: 'b1' },
  { what: 'complete with no bookmark', status: 200, body: ok({ status: 'complete', result: { signed_url: 'https://signed.example/one' } }), asked: null },
  { what: 'complete with no download', status: 200, body: ok({ status: 'complete', at_bookmark: 'b3' }), asked: 'b1' },
  { what: 'ended', status: 200, body: ok({ status: 'error', error: 'reset' }), asked: 'b1' },
  // A bookmark whose export finished, lost its result or was reset: Cloudflare says nothing is exporting.
  { what: 'nothing exporting', status: 200, body: ok({ success: false, error: 'Not currently exporting anything.' }), asked: 'b1' },
  { what: 'nothing exporting, as a refusal', status: 400, body: { success: false, errors: [{ message: 'Not currently exporting anything.' }] }, asked: 'b1' },
  { what: 'a failed result', status: 200, body: ok({ success: false, error: 'busy' }), asked: 'b1' },
  { what: 'an error with no status', status: 200, body: ok({ error: 'busy' }), asked: 'b1' },
  { what: 'a null result', status: 200, body: { success: true, result: null }, asked: 'b1' },
  { what: 'an outer refusal', status: 200, body: { success: false, errors: [{ code: 7500, message: 'internal' }] }, asked: 'b1' },
  { what: 'a body that is not JSON', status: 200, body: undefined, asked: 'b1' },
  { what: 'D1 internal error', status: 400, body: { success: false, errors: [{ code: 7500, message: 'internal' }] }, asked: 'b1' },
  { what: 'a 403 that is not an authentication error', status: 403, body: { success: false, errors: [{ code: 7403, message: 'no' }] }, asked: 'b1' },
  { what: 'an authentication error', status: 403, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] }, asked: null },
  { what: 'a 401', status: 401, body: undefined, asked: 'b1' },
  { what: 'a 408', status: 408, body: undefined, asked: 'b1' },
  { what: 'a 503', status: 503, body: undefined, asked: null },
];
