/**
 * Cross-package pins between the member and the worker. The two live under
 * separate npm roots and share no module, so every value both sides must agree
 * on is asserted here against the worker's own exports.
 */
import { describe, expect, it } from 'bun:test';
import { LINEAGE_REPLAY_GRACE_MS, MAX_BLOB_BYTES, MIN_COMPAT_MEMBER_PROTOCOL, PROTOCOL_HEADER as SERVER_PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { CLASSIFIERS, UNAVAILABLE } from '@myco-server-worker/telemetry.js';
import { isProjectId as serverIsProjectId, PROJECT_ID as SERVER_PROJECT_ID } from '@myco-server-worker/pipeline.js';
import { JOIN_PATH as SERVER_JOIN_PATH } from '@myco-server-worker/constants.js';
import { ENROLLMENT_KEY_PATTERN as SERVER_ENROLLMENT_KEY_PATTERN } from '@myco-server-worker/auth/enrollment.js';
import { CHANNELS as SERVER_CHANNELS, ID_GRAMMAR, MAX_PAYLOAD_BYTES, PRODUCER_GRAMMAR } from '@myco-server-worker/ingest/envelope.js';
import { IMPORT_PLAN_MAX_CANDIDATES as SERVER_PLAN_MAX } from '@myco-server-worker/constants.js';
import { IMPORT_PLAN_MAX_CANDIDATES as MEMBER_PLAN_MAX } from '@myco/member/import.js';
import { OUTBOUND_CHANNELS as MEMBER_CHANNELS } from '@myco/member/envelope.js';
import { KINDS, kindSpec, PLAN_SOURCES as SERVER_PLAN_SOURCES, PLAN_STATUSES as SERVER_PLAN_STATUSES, PROMPT_ORIGINS as SERVER_PROMPT_ORIGINS, TRANSCRIPT_ROLES as SERVER_TRANSCRIPT_ROLES } from '@myco-server-worker/ingest/kinds.js';
import { MEMBER_KINDS, PLAN_SOURCES, PLAN_STATUSES, PROMPT_ORIGINS, TRANSCRIPT_ROLES } from '@goondocks/myco-shared/member-protocol';
import { CaptureRuleSchema } from '@goondocks/myco-shared/capture-rule-schema';
import { MEMBER_TOKEN_PATTERN as SERVER_TOKEN_PATTERN, MEMBER_TOKEN_REFRESH_WINDOW_MS as SERVER_REFRESH_WINDOW_MS } from '@myco-server-worker/auth/tokens.js';
import { longestDeclaredHookTimeoutMs } from '@myco/member/budget.js';
import { isProjectId as memberIsProjectId, PROJECT_ID_PATTERN as MEMBER_PROJECT_ID_PATTERN } from '@myco/member/constants.js';
import {
  ENROLLMENT_KEY_PATTERN, JOIN_PATH,
  MEMBER_CODES, MEMBER_ID_NAMESPACE, MEMBER_INLINE_TEXT_MAX_BYTES, MEMBER_PROTOCOL, MEMBER_TOKEN_PATTERN, MEMBER_TOKEN_REFRESH_WINDOW_MS, PARKED_CODE, PROTOCOL_HEADER, RESLICE_CODES, TRANSCRIPT_SLICE_BYTES,
} from '@myco/member/constants.js';
import { BOUNDS, producerIdentifier, wireOrigin } from '@myco/member/envelope.js';
import { HOOK_CONFIG } from '@myco/hooks/hook-config.generated.js';
import { getPluginVersion } from '@myco/version.js';

/** Where each member bound lands in the worker catalogue: [kind, field]. */
const BOUND_FIELDS: Record<keyof typeof BOUNDS, [string, string] | [string, string, 'item']> = {
  agent: ['session.start', 'agent'],
  branch: ['session.start', 'branch'],
  originPath: ['session.start', 'originPath'],
  parentReason: ['session.start', 'parentReason'],
  toolName: ['tool.use', 'toolName'],
  output: ['tool.use', 'output'],
  errorMessage: ['tool.failure', 'errorMessage'],
  mycoTool: ['tool.use', 'mycoTool'],
  mycoOp: ['tool.use', 'mycoOp'],
  agentType: ['subagent.start', 'agentType'],
  trigger: ['compaction.pre', 'trigger'],
  message: ['notification', 'message'],
  level: ['notification', 'level'],
  threadLabel: ['prompt', 'threadLabel'],
  title: ['plan', 'title'],
  description: ['attachment', 'description'],
  fileItem: ['tool.use', 'filesAffected', 'item'],
  tagItem: ['plan', 'tags', 'item'],
};

/**
 * What the worker judges final about a record's own shape, per member
 * protocol: the channels, and per kind its required fields, its enum values
 * and its exactly-one and at-most-one pairs; and the kinds a member ships.
 * A kind a Deployment does not know is held rather than dropped, so a member
 * shipping one before its Deployment knows it holds that session's capture. A record outside any of them is
 * refused `invalid_field` and dropped, never held. A member that widens one of
 * these, or a worker that adds a required field, would have its records
 * dropped by the other side at the same protocol, so the change is a member
 * protocol bump and a new row here, never an edit of an existing row.
 */
const FINAL_SHAPE_BY_PROTOCOL: Record<number, { memberKinds: readonly string[]; channels: readonly string[]; kinds: Record<string, unknown> }> = {
  1: {
    memberKinds: [
      'attachment', 'compaction.post', 'compaction.pre', 'error', 'notification', 'plan', 'prompt', 'response', 'session.end',
      'session.start', 'stop.failure', 'subagent.start', 'subagent.stop', 'task.completed', 'tool.failure', 'tool.use', 'transcript.segment',
    ],
    channels: ['cli', 'http', 'import'],
    kinds: {
      'attachment': { required: ['attachmentId', 'blob'], enums: {} },
      'compaction.post': { required: [], enums: {}, atMostOne: ['summary', 'blob'] },
      'compaction.pre': { required: [], enums: {}, atMostOne: ['summary', 'blob'] },
      'error': { required: ['message'], enums: {} },
      'notification': { required: ['message'], enums: {} },
      'plan': { required: ['planKey'], enums: { source: ['path', 'save', 'tag'], status: ['abandoned', 'active', 'completed', 'in_progress'] }, exactlyOne: ['content', 'blob'] },
      'prompt': { required: ['origin', 'promptId'], enums: { origin: ['agent_dispatch', 'hook_injected', 'system', 'unknown', 'user'] }, exactlyOne: ['text', 'blob'] },
      'response': { required: ['responseId'], enums: {}, exactlyOne: ['text', 'blob'] },
      'session.end': { required: [], enums: {} },
      'session.start': { required: ['agent'], enums: {} },
      'stop.failure': { required: [], enums: {} },
      'subagent.start': { required: ['subagentId'], enums: {} },
      'subagent.stop': { required: ['subagentId'], enums: {} },
      'task.completed': { required: [], enums: {} },
      'tool.failure': { required: ['errorMessage', 'success', 'toolCallId', 'toolName'], enums: {}, exactlyOne: ['input', 'blob'], atMostOne: ['output', 'outputBlob'] },
      'tool.use': { required: ['success', 'toolCallId', 'toolName'], enums: {}, exactlyOne: ['input', 'blob'], atMostOne: ['output', 'outputBlob'] },
      'transcript.segment': { required: ['baseOffset', 'blob', 'length', 'transcriptId'], enums: { role: ['primary', 'subagent'] } },
    },
  },
};

/** The worker's final-shape judgements, read from its own catalogue. */
function finalShape(): unknown {
  const kinds = Object.fromEntries([...KINDS].sort((a, b) => a.name.localeCompare(b.name)).map((spec) => {
    const required = Object.entries(spec.fields).filter(([, f]) => f.required === true).map(([field]) => field).sort();
    const enums = Object.fromEntries(Object.entries(spec.fields)
      .flatMap(([field, f]) => (f.bound.type === 'enum' ? [[field, [...f.bound.values].sort()] as const] : []))
      .sort(([a], [b]) => a.localeCompare(b)));
    return [spec.name, { required, enums, ...(spec.exactlyOne ? { exactlyOne: [...spec.exactlyOne] } : {}), ...(spec.atMostOne ? { atMostOne: [...spec.atMostOne] } : {}) }];
  }));
  return { channels: [...SERVER_CHANNELS].sort(), kinds };
}

describe('member ↔ worker pins', () => {
  it('MEMBER_PROTOCOL is inside the server window', () => {
    expect(MEMBER_PROTOCOL).toBeGreaterThanOrEqual(MIN_COMPAT_MEMBER_PROTOCOL);
    expect(MEMBER_PROTOCOL).toBeLessThanOrEqual(SERVER_PROTOCOL);
    expect(PROTOCOL_HEADER).toBe(SERVER_PROTOCOL_HEADER);
  });

  it('changes what the worker judges final about a record\'s shape only with a member protocol bump: channels, required fields, enum values and field pairs are pinned per protocol', () => {
    const workerShape = (protocol: number) => {
      const { memberKinds: _memberKinds, ...shape } = FINAL_SHAPE_BY_PROTOCOL[protocol] ?? { memberKinds: [] };
      return shape;
    };
    expect({ protocol: MEMBER_PROTOCOL, shape: finalShape() }).toEqual({ protocol: MEMBER_PROTOCOL, shape: workerShape(MEMBER_PROTOCOL) });
    expect({ protocol: SERVER_PROTOCOL, shape: finalShape() }).toEqual({ protocol: SERVER_PROTOCOL, shape: workerShape(SERVER_PROTOCOL) });
  });

  it('changes the kinds a member ships only with a member protocol bump, and ships only kinds the worker catalogues', () => {
    expect({ protocol: MEMBER_PROTOCOL, memberKinds: [...MEMBER_KINDS].sort() as readonly string[] }).toEqual({ protocol: MEMBER_PROTOCOL, memberKinds: FINAL_SHAPE_BY_PROTOCOL[MEMBER_PROTOCOL]?.memberKinds });
    expect(MEMBER_KINDS.filter((kind) => kindSpec(kind) === null)).toEqual([]);
  });

  it('judges a record\'s enum fields against the lists the member\'s emitted values are typed from', () => {
    // The member's prompt origin, plan status and transcript role are typed
    // from these lists, so the worker admitting a list of its own would let the
    // two drift apart with no protocol row changing.
    expect(SERVER_PROMPT_ORIGINS).toBe(PROMPT_ORIGINS);
    expect(SERVER_PLAN_STATUSES).toBe(PLAN_STATUSES);
    expect(SERVER_PLAN_SOURCES).toBe(PLAN_SOURCES);
    expect(SERVER_TRANSCRIPT_ROLES).toBe(TRANSCRIPT_ROLES);
  });

  it('sends every origin a capture rule can set as a prompt origin the worker admits', () => {
    const ruleOrigins = [...CaptureRuleSchema.shape.set_origin.unwrap().options, undefined];
    for (const origin of ruleOrigins) {
      expect({ origin, admitted: (SERVER_PROMPT_ORIGINS as readonly string[]).includes(wireOrigin(origin)) }).toEqual({ origin, admitted: true });
    }
  });

  it('the member code list is exactly the worker classifiers plus unavailable', () => {
    expect(new Set(MEMBER_CODES)).toEqual(new Set([...CLASSIFIERS, UNAVAILABLE]));
    expect(MEMBER_CODES).toHaveLength(CLASSIFIERS.length + 1);
  });

  it('agrees on the channels an envelope may carry, and on the candidates one import plan holds', () => {
    // Every channel the member can build is one the worker admits. A subset,
    // not an equality: `http` is a channel the worker takes from a caller the
    // member is not. A member channel the worker does not know is a refusal the
    // member cannot see coming.
    expect(MEMBER_CHANNELS.filter((c) => !SERVER_CHANNELS.has(c))).toEqual([]);
    expect(MEMBER_CHANNELS).toContain('import');
    // The member trims to this before it asks; the route refuses above it. A
    // member trimming to more than the route takes is a refused request rather
    // than a smaller import.
    expect(MEMBER_PLAN_MAX).toBe(SERVER_PLAN_MAX);
    expect(CLASSIFIERS as readonly string[]).not.toContain(UNAVAILABLE);
  });

  it('an invite link the member reads is one the worker mints: same path, same key shape', () => {
    expect(JOIN_PATH).toBe(SERVER_JOIN_PATH);
    expect(ENROLLMENT_KEY_PATTERN.source).toBe(SERVER_ENROLLMENT_KEY_PATTERN.source);
  });

  it('the action classes name worker classifiers', () => {
    for (const code of RESLICE_CODES) expect(CLASSIFIERS as readonly string[]).toContain(code);
    expect(CLASSIFIERS as readonly string[]).toContain(PARKED_CODE);
  });

  it('inline and slice ceilings sit under the server caps', () => {
    expect(MEMBER_INLINE_TEXT_MAX_BYTES).toBeLessThan(MAX_PAYLOAD_BYTES);
    expect(TRANSCRIPT_SLICE_BYTES).toBeLessThanOrEqual(MAX_BLOB_BYTES);
  });

  it('the derivation namespace is itself in the id grammar', () => {
    expect(ID_GRAMMAR.test(MEMBER_ID_NAMESPACE)).toBe(true);
  });

  it('the token shape the member checks is the shape the server mints', () => {
    expect(MEMBER_TOKEN_PATTERN.source).toBe(SERVER_TOKEN_PATTERN.source);
  });

  it('every producer identifier the member can emit satisfies the grammar the server holds it to', () => {
    // The value that broke a live run: a dev build's version carries semver
    // build metadata, and `+` is outside the class. The refusal is terminal,
    // so the event is dropped rather than retried.
    const shapes = [
      '0.0.0-dev+1.4.8-6-ge1c936ce-dirty',
      '1.4.8',
      `${'9'.repeat(90)}.0.0`,
      'has a space',
      'slash/and+plus',
      '',
      '…unicode…',
      getPluginVersion(),
    ];
    for (const shape of shapes) {
      const identifier = producerIdentifier(shape);
      expect({ shape, matches: PRODUCER_GRAMMAR.test(identifier) }).toEqual({ shape, matches: true });
    }
    // Legible, not just legal: the build is still identifiable afterwards.
    expect(producerIdentifier('0.0.0-dev+1.4.8-6-ge1c936ce-dirty')).toBe('0.0.0-dev-1.4.8-6-ge1c936ce-dirty');
    // Every symbiont the member can run under passes too — the grammar covers
    // the adapter name as well as the version.
    for (const agent of Object.keys(HOOK_CONFIG)) {
      expect({ agent, matches: PRODUCER_GRAMMAR.test(producerIdentifier(agent)) }).toEqual({ agent, matches: true });
    }
  });

  it('the window the member assumes before the server announces one is the window the server keeps', () => {
    expect(MEMBER_TOKEN_REFRESH_WINDOW_MS).toBe(SERVER_REFRESH_WINDOW_MS);
  });

  it('admits exactly the project ids the server does — no more, since the member decides one before the server ever sees it', () => {
    // `myco member join` records a Project id and its only server contact is a body-less
    // health check, so the server never sees the id until the first capture. A member
    // that admits a superset therefore reports a successful join and is then refused
    // every request, which the spool reads as terminal: events dropped, rotation dead.
    expect(MEMBER_PROJECT_ID_PATTERN.source).toBe(SERVER_PROJECT_ID.source);
    for (const id of ['proj_1', 'a', 'a.b-c_d', 'x'.repeat(64)]) {
      expect({ id, member: memberIsProjectId(id), server: serverIsProjectId(id) }).toEqual({ id, member: true, server: true });
    }
    for (const id of ['', '.', '..', 'x'.repeat(65), 'has space', 'my:proj', 'a/b', 'a\\b']) {
      expect({ id, member: memberIsProjectId(id), server: serverIsProjectId(id) }).toEqual({ id, member: false, server: false });
    }
  });

  it("the server's replay grace outlasts the longest hook any symbiont declares, so a rotation race is never recorded as unexplained", () => {
    // Two hooks on one machine can both be in flight when one rotates; the loser reaches
    // the server on a credential the winner's first use has just revoked. The harness
    // kills a hook at its declared timeout, so that is the longest such a request can
    // lag. A grace at or below it starts marking ordinary races `withinHookRace: false`,
    // which is the signal an operator would act on.
    const longest = longestDeclaredHookTimeoutMs();
    expect(longest).toBeGreaterThan(0);
    expect({ grace: LINEAGE_REPLAY_GRACE_MS, longest, outlasts: LINEAGE_REPLAY_GRACE_MS > longest })
      .toEqual({ grace: LINEAGE_REPLAY_GRACE_MS, longest, outlasts: true });
  });

  it('every member string bound equals the worker bound on the field it truncates for', () => {
    for (const [name, max] of Object.entries(BOUNDS) as Array<[keyof typeof BOUNDS, number]>) {
      const [kind, field, item] = BOUND_FIELDS[name];
      const spec = kindSpec(kind);
      expect({ name, spec: spec !== null }).toEqual({ name, spec: true });
      const bound = spec!.fields[field]?.bound;
      expect({ name, bound: bound?.type }).toEqual({ name, bound: item ? 'stringArray' : 'string' });
      const serverMax = bound!.type === 'stringArray' ? bound!.maxItem : bound!.type === 'string' ? bound!.max : -1;
      expect({ name, max }).toEqual({ name, max: serverMax });
    }
  });
});
