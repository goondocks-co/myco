import { classify, emit } from '../telemetry.js';
import type { ServerEnv } from './adapters.js';
import { parseTraces, countSignal } from './otlp.js';
import { TELEMETRY_BODY_BYTES, TELEMETRY_KEY_PATTERN } from './telemetry-policy.js';
import { countTelemetry, storeTelemetrySpans, telemetryKeyEnded } from '../db/telemetry/ingest.js';
import { telemetryKeyForHash } from '../db/telemetry/keys.js';
import { sha256Hex } from '../hash.js';
import { readBoundedBody } from '../ingest/body.js';
import { authorizeHttp } from '../auth/http-authorization.js';
import { deploymentIdentity } from '../auth/authorization.js';
import { TELEMETRY_INGEST_POLICY } from '../auth/telemetry-policy.js';

const denied = () =>
  Response.json(
    { code: 16, message: 'telemetry key required' },
    { status: 401, headers: { 'www-authenticate': 'Bearer realm="myco-telemetry"' } },
  );
const limited = () =>
  Response.json(
    { code: 8, message: 'telemetry rate limit reached; retry after 60 seconds' },
    { status: 429, headers: { 'retry-after': '60' } },
  );
const malformed = (message: string) => Response.json({ code: 3, message }, { status: 400 });

/** The only ingest-key surface. Its response never describes stored Projects or sessions. */
export async function receiveTelemetry(
  env: ServerEnv,
  request: Request,
  now: number,
  source: string,
): Promise<Response> {
  const presented = /^Bearer ([^\s]+)$/i.exec(request.headers.get('authorization') ?? '')?.[1];
  if (presented === undefined || !TELEMETRY_KEY_PATTERN.test(presented)) return denied();
  const url = new URL(request.url);
  if (request.method !== 'POST' || !['/v1/traces', '/v1/logs', '/v1/metrics'].includes(url.pathname))
    return malformed('send POST to /v1/traces, /v1/logs or /v1/metrics');
  if (
    (request.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/json' ||
    (request.headers.get('content-encoding') !== null &&
      request.headers.get('content-encoding') !== 'identity')
  )
    return malformed('send uncompressed OTLP/HTTP with Content-Type: application/json');
  if (!(await env.sourceLimit.limit({ key: `telemetry:${source}` })).success) return limited();
  const key = await telemetryKeyForHash(env.db, await sha256Hex(presented));
  if (key === null) return denied();
  if (
    !(await authorizeHttp(
      env,
      TELEMETRY_INGEST_POLICY,
      { kind: 'telemetry', deploymentId: await deploymentIdentity(env.db), transport: 'http', live: true },
      {},
    ))
  )
    return denied();
  if (!(await env.tokenLimit.limit({ key: `telemetry:key:${key.id}` })).success) return limited();
  if (!(await env.sourceLimit.limit({ key: 'telemetry:deployment' })).success) return limited();
  try {
    const body = await readBoundedBody(request, TELEMETRY_BODY_BYTES);
    if (!body.ok) return Response.json({ code: 8, message: body.reason }, { status: 413 });
    let raw: unknown;
    try {
      raw = JSON.parse(body.text);
    } catch {
      return malformed('body must be a valid OTLP object encoded as application/json');
    }
    const signal = new URL(request.url).pathname.split('/').at(-1);
    if (signal === 'traces') {
      let parsed: ReturnType<typeof parseTraces>;
      try {
        parsed = parseTraces(raw, now);
      } catch (error) {
        return malformed((error as Error).message);
      }
      const saved = await storeTelemetrySpans(env.db, { key: key.id, spans: parsed.spans, now });
      const rejected = parsed.rejected + parsed.spans.length - saved.accepted;
      await countTelemetry(env.db, { key: key.id, now, rejected });
      if (saved.wake)
        env.afterResponse(async () => {
          try {
            await env.wake?.();
          } catch (error) {
            emit({ kind: 'request_error', error_class: classify(error, env.platform.classifyError) });
          }
        });
      return Response.json(
        rejected === 0
          ? {}
          : {
              partialSuccess: {
                rejectedSpans: String(rejected),
                errorMessage: [
                  ...parsed.reasons,
                  ...(saved.accepted < parsed.spans.length
                    ? [
                        saved.quotaReached
                          ? `telemetry key span quota reached (${saved.usedSpans}/${saved.spanQuota} spans); wait until retained spans age below the quota or ask an administrator to reduce the number of live senders`
                          : 'trace or server capacity reached, server capacity reached',
                      ]
                    : []),
                ].join('; '),
              },
            },
      );
    }
    if (signal !== 'logs' && signal !== 'metrics') return malformed('unknown signal');
    let count: number;
    try {
      count = countSignal(raw, signal);
    } catch (error) {
      return malformed((error as Error).message);
    }
    return Response.json({});
  } catch (error) {
    if (telemetryKeyEnded(error)) return denied();
    throw error;
  }
}
