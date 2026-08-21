// The daemon client lives in daemon/client.ts; hooks still reach it through
// this path until the member seam replaces their daemon calls.
export * from '../daemon/client.js';
