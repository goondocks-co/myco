import { httpPolicy } from './http-authorization.js';

/** Telemetry keys append telemetry only; every read and every other resource refuses them. */
export const TELEMETRY_INGEST_POLICY = httpPolicy('telemetry', 'append', 'deployment', ['telemetry']);
