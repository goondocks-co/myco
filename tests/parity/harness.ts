import { Database } from 'bun:sqlite';
import { expect } from 'bun:test';
import { PROJECT_HEADER, PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { withParityRequests, type RequestFailure } from './requests.ts';
import type {ReadTrace} from '../helpers/statement-recorder.js';

/**
 * One booted server target. A scenario receives this and nothing else, so a
 * scenario that passes against both targets has proven the behavior on both.
 *
 * `sql` reads and writes the target's own store (bun:sqlite on the self-hosted
 * volume, `wrangler d1 execute --local` on the Worker's local D1) — seeding and
 * assertion go through the same store the server serves from.
 */
export interface ParityTarget {
  name: 'selfhosted' | 'cloudflare';
  url: string;
  /** Deployment identity read from this target's live database. */
  deploymentId: string;
  /** Physical local resources supplied to the front door; null means this target has no vector binding. */
  bindings: { database: string; blob: string; secret: string; vector: string | null };
  memberToken: string;
  projectId: string;
  /**
   * Headers an owner request carries: the signed session cookie — and on the
   * Cloudflare target the `cf-connecting-ip` header, which wrangler dev never
   * injects on its own; without a source identity the pipeline answers 503 to
   * every non-public route. The Bun target reads the socket and ignores it.
   */
  ownerHeaders(): Record<string, string>;
  memberHeaders(extra?: Record<string, string>): Record<string, string>;
  /** Headers a request over an External Agent grant carries: the key alone names the Project, so no Project or protocol header rides with it. */
  grantHeaders(key: string): Record<string, string>;
  sql(command: string): Promise<Record<string, unknown>[]>;
  /** One wake of the target's own clock: the hosted clock object through the cron floor, the self-hosted wake loop's tick. */
  clockWake(at?:number): Promise<void>;
  clockAlarm?(at?:number):Promise<void>;
  primeEmbedding?(projectId:string):Promise<void>;
  readTrace?():Promise<ReadTrace>;
  /** Whether the runtime serving this target is up, its exit status, its last output, and any failure writing that output. */
  runtime?(): { alive: boolean; exitCode: number | null; tail: string; logFailure?: string };
  requestFailure?(failure: RequestFailure): Promise<void>;
  transportHeaders?: Record<string, string>;
  healthy?(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Runs one scenario against one target. A failure reports the runtime's exit status and last output when the runtime
 * is gone, and any failure writing that output, keeping the scenario's own failure as the cause.
 */
export async function runScenario(target: ParityTarget, scenario: ParityScenario, peer?: ParityTarget): Promise<void> {
  try {
    const observed=[target,...(peer===undefined?[]:[peer])].map(source=>{
      let prepares=0;
      return {source,get prepares(){return prepares;},target:{...source,readTrace:async()=>{
        if(source.readTrace===undefined)throw new Error('parity_store_unobserved: '+source.name+'/'+scenario.name);
        const trace=await source.readTrace();prepares+=trace.events.filter(event=>event.kind==='prepare').length;return trace;
      }}};
    });
    for(const row of observed)await row.source.readTrace?.();
    const primary=observed[0]!.target,secondary=observed[1]?.target;
    await withParityRequests(observed.map(row=>row.target), async () => {
      await target.healthy?.();
      await peer?.healthy?.();
      await scenario.run(primary, secondary);
      await target.healthy?.();
      await peer?.healthy?.();
    });
    for(const row of observed){
      await row.target.readTrace();
      if(row.prepares===0)throw new Error('parity_store_unobserved: '+row.source.name+'/'+scenario.name);
      console.log(JSON.stringify({kind:'view_store_scenario_witness',scenario:scenario.name,target:row.source.name,prepares:row.prepares}));
    }
  } catch (error) {
    const runtime = target.runtime?.();
    if (runtime === undefined) throw error;
    const raised = error instanceof Error ? error.message : String(error);
    const sink = runtime.logFailure === undefined ? '' : `\nlog sink failed: ${runtime.logFailure}`;
    if (!runtime.alive) {
      throw new Error(
        `the ${target.name} runtime exited (code ${runtime.exitCode}) during "${scenario.name}": ${raised}`
        + `${sink}\nruntime output:\n${runtime.tail}`,
        { cause: error },
      );
    }
    if (sink !== '') throw new Error(`${raised}${sink}`, { cause: error });
    if (runtime.tail !== '') throw new Error(`${raised}\nruntime output:\n${runtime.tail}`, { cause: error });
    throw error;
  }
}

export interface ParityScenario {
  name: string;
  run(target: ParityTarget, peer?: ParityTarget): Promise<void>;
  /** A target-specific lifecycle check runs only on that target. */
  only?: 'cloudflare';
  /** The scenario needs two independently booted Deployments on this target runtime. */
  paired?: true;
  /**
   * A scenario whose bindings or settings would change what the others observe runs against targets booted for it
   * alone. On Cloudflare, `main` names the Worker entry that boot serves, relative to `packages/myco-server`;
   * `sqliteVec` marks a scenario whose self-hosted run queries vectors, which needs an extension-enabled SQLite.
   */
  dedicated?: { cloudflare?: { main?: string; latestSchemaUpgrade?: boolean;embeddingFixture?:boolean }; stopRace?: boolean; receiptSnapshots?: boolean; viewWriter?:boolean; sqliteVec?: boolean; timeoutMs: number };
}

export const MEMBER_ID = 'mem_parity';
export const MACHINE_ID = 'machine_parity';
export const PROJECT_ID = 'proj_parity';
export const GITHUB_SUB = '424242';
export const SESSION_SECRET = 'parity-session-secret-0123456789abcdef';

/** The member request headers both targets accept; the source header is load-bearing only on Cloudflare. */
export function memberHeadersFor(token: string, projectId: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    [PROJECT_HEADER]: projectId,
    [PROTOCOL_HEADER]: String(SERVER_PROTOCOL),
    'cf-connecting-ip': '1.2.3.4',
    ...extra,
  };
}

/** The grant request headers: the key alone; a target that needs a source identity adds it the way it does for the owner. */
export function grantHeadersFor(key: string): Record<string, string> {
  return { authorization: `Bearer ${key}` };
}

/** A write's answer as the server persisted it. Ingest answers a refusal as a 200 with `persisted: false`, so the status alone proves nothing; a scenario's writes go through this. */
export async function expectPersisted(res: Response, label: string): Promise<void> {
  const body = (await res.json()) as { persisted?: boolean; stored?: boolean; code?: string; reason?: string };
  const landed = body.persisted === true || body.stored === true;
  expect(`${label}: ${res.status} ${landed ? 'persisted' : `refused ${body.code ?? ''} ${body.reason ?? ''}`.trim()}`).toBe(`${label}: 200 persisted`);
}

/** A single-quoted SQL literal; scenario values MUST pass through this on their way into `target.sql`. */
export const lit = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** Polls `read` until `pred` answers true or `ms` elapses; answers the last read either way. */
export async function waitFor<T>(read: () => Promise<T>, pred: (value: T) => boolean, ms = 45_000): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!pred(last) && Date.now() < deadline) {
    await Bun.sleep(300);
    last = await read();
  }
  return last;
}

/** Opens a read/write connection on a self-hosted volume; WAL keeps it safe beside the serving process. */
export function volumeSql(databasePath: string) {
  return async (command: string): Promise<Record<string, unknown>[]> => {
    const sqlite = new Database(databasePath);
    sqlite.exec('PRAGMA foreign_keys = ON');
    sqlite.exec('PRAGMA busy_timeout = 5000');
    try {
      return sqlite.query(command).all() as Record<string, unknown>[];
    } finally {
      sqlite.close();
    }
  };
}
