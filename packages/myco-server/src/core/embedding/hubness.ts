import type { Bound } from '../../db/index.js';
import {
  calibrationHasWork, calibrationView, calibrationWrites, commitCalibration, commitVectorPageSeal, departingVectors,
  foreignModelToRetire, leftOutVectors, moveCalibrationProbe, operatingMembers, outlivesPopulation, settledMembers, settledMoments, uncoveredVectors,
  type CalibrationPopulation, type CalibrationProbe, type MemberMoments, type MemberVector, type QueuedVector,
} from '../../db/embeddings/calibration.js';
import { beginVectorPage, inlineVectors, noteVectorPageMissing, reclaimVectorPages, releaseUnsealedObject, vectorPageRows, VECTOR_PAGE_MEMBERS } from '../../db/embeddings/vector-pages.js';
import { OBJECT_PUT_IN_FLIGHT_MS } from '../../constants.js';
import { emit } from '../../telemetry.js';
import type { RelationalStore } from '../adapters.js';
import type { EmbeddingContext, EmbeddingStep } from './reconcile.js';
import { VECTOR_LOST_MS, VECTOR_REWRITE_LIMIT } from './provider.js';
import { HUBNESS_MEMBER as MEMBER } from './receipt-state.js';
import { encodeVectorPage, readSealedVectors, storeVectorPage, vectorPageKey, VectorPageUnavailable, type SealedMember } from './vector-pages.js';
import { recordedWork, WORK_PREDICATE_VERSION } from './work-state.js';

/** Settled members one step reads. */
const HUBNESS_PAGE = 50;
/** The most spore vectors one operation adds or removes, which bounds one step to about a thousand distances. */
const HUBNESS_SUBJECTS = 20;
/** The most members of another model, or members whose moments are miscounted, one step removes. */
const HUBNESS_REPAIR_PAGE = 200;

interface Moments { n: number; mean: number; m2: number }
type Loaded = MemberVector & { values: Float32Array };

/** Welford's update with one more sample. */
function include(m: Moments, x: number): Moments {
  const n = m.n + 1;
  const delta = x - m.mean;
  const mean = m.mean + delta / n;
  return { n, mean, m2: m.m2 + delta * (x - mean) };
}

/** Welford's update with one sample taken back out: the exact inverse of `include`, up to rounding. */
function exclude(m: Moments, x: number): Moments {
  if (m.n <= 1) return { n: 0, mean: 0, m2: 0 };
  const n = m.n - 1;
  const mean = (m.n * m.mean - x) / n;
  return { n, mean, m2: m.m2 - (x - m.mean) * (x - mean) };
}

/** The mean and population standard deviation a search reads; absent without a sample. */
const neighborStats = (m: Moments): [number | null, number | null] =>
  m.n === 0 ? [null, null] : [m.mean, Math.sqrt(Math.max(0, m.m2 / m.n))];

/**
 * `1 - cosineSimilarity` over copies whose zero tail is dropped: the dimensions past a copy's length are zero, so the
 * sums, and the distance, are those of the full stored vectors.
 */
function distance(a: Float32Array, b: Float32Array): number {
  const shared = Math.min(a.length, b.length);
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < shared; i++) {
    const x = a[i]!, y = b[i]!;
    dot += x * y; aa += x ** 2; bb += y ** 2;
  }
  for (let i = shared; i < a.length; i++) aa += a[i]! ** 2;
  for (let i = shared; i < b.length; i++) bb += b[i]! ** 2;
  return 1 - (aa === 0 || bb === 0 ? 0 : Math.max(-1, Math.min(1, dot / Math.sqrt(aa * bb))));
}

/** A stored vector as float32 bytes in base64, without its zero tail. */
function encodeVector(values: ArrayLike<number>): string {
  let length = values.length;
  while (length > 0 && values[length - 1] === 0) length--;
  const floats = new Float32Array(length);
  for (let i = 0; i < length; i++) floats[i] = values[i]!;
  const bytes = new Uint8Array(floats.buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x2000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  return btoa(binary);
}

function vectorBytes(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Each current spore vector's moments cover its cosine distance to every other current spore vector. The membership
 * record changes by operations of at most `HUBNESS_SUBJECTS` spore vectors, all joining or all leaving: an operation adds or
 * removes its subjects' distances on every settled member one page per step, reading vectors from the members' copies,
 * and a joining subject collects its own moments on the way. Leaving starts before joining: a joiner waits until the
 * vector store returns its vector, and a spore that is gone leaves the calibration meanwhile. A receipt's
 * neighbour statistics change only when its moments cover every other current spore vector; until then it keeps the
 * statistics it has. Each step's writes commit only against the token it read.
 *
 * A joiner is waited on for `VECTOR_LOST_MS` from its write. A vector the store still does not return then is taken as
 * lost: its receipt goes back to the write path, and its spore is left out of calibration, which publishes the other
 * members' statistics in one pass. A left-out vector is looked for on each step until `VECTOR_LOST_MS` after each new
 * write, joins once the store returns it, and is written again at most `VECTOR_REWRITE_LIMIT` times.
 *
 * What is left to do is read from the maintained population and queues; nothing recounts the corpus. Members of another
 * model, miscounted moments, and every member once fewer than two current vectors remain are removed a page per step,
 * with no distance computed. A step reads the population and the commit token together,
 * and every commit is fenced by that token and that revision: a step commits only against the population it read.
 *
 * At rest, every full page of settled members holding their bytes is written to a stored page, verified, and only then
 * do those rows give their bytes up, and pages no member names are released. A stored page that cannot be read ends the
 * step with the retryable `vector-page` phase and nothing computed from it; a page still gone `VECTOR_LOST_MS` after it
 * first went missing is taken as lost, and the model's members are rebuilt from the vector store.
 */
export async function reconcileHubness(context: EmbeddingContext, projectId: string, now: number): Promise<EmbeddingStep> {
  try {
    return await calibrationStep(context, projectId, now);
  } catch (error) {
    if (!(error instanceof VectorPageUnavailable)) throw error;
    emit({ kind: 'hubness_vector_page_unavailable', fault: error.fault });
    const { page, fault } = error;
    if (page !== null && fault !== 'store') {
      if (page.missing_at === null) await noteVectorPageMissing(context.db, page.page_id, now);
      else if (now - page.missing_at >= VECTOR_LOST_MS) return rebuildMembers(context, projectId);
    }
    return { phase: 'vector-page', processed: 0 };
  }
}

/** A stored page is lost: every member of the model leaves, a page per step, and calibration runs again from the vector store. */
async function rebuildMembers(context: EmbeddingContext, projectId: string): Promise<EmbeddingStep> {
  const model = context.provider.modelKey;
  return dropMembers(context.db, projectId, model, model, ['clearCount']);
}

/** One page of `members`' memberships goes under calibration of `model`, a model's own by clearing its count too. */
async function dropMembers(db: RelationalStore, projectId: string, model: string, members: string, move: Parameters<typeof commitCalibration>[5]): Promise<EmbeddingStep> {
  const { token, population } = await calibrationView(db, projectId, model, true);
  const done = await commitCalibration(db, projectId, token, population.revision, [calibrationWrites.dropModelPage(projectId, members, HUBNESS_REPAIR_PAGE, token)], move);
  return { phase: 'hubness', processed: done ? 1 : 0 };
}

async function calibrationStep(context: EmbeddingContext, projectId: string, now: number): Promise<EmbeddingStep> {
  const { db, vectors, provider, blobs } = context;
  const model = provider.modelKey;
  const loaded = async (rows: Promise<MemberVector[]>): Promise<Loaded[]> => hydrated(context, await rows);
  let view = await calibrationView(db, projectId, model);
  if (view.population.state === 'building') return { phase: 'visibility', processed: 0 };
  const foreign = await foreignModelToRetire(db, projectId, model, view.population, context.retain ?? []);
  if (foreign !== null) return dropMembers(db, projectId, model, foreign, ['clear']);
  if (outlivesPopulation(view.population)) return dropMembers(db, projectId, model, model, ['clearCount']);
  if (view.population.total < 2) return { phase: 'settled', processed: await reclaimVectorPages(db, projectId, now - OBJECT_PUT_IN_FLIGHT_MS, now) > 0 ? 1 : 0 };
  let { population, token } = view;
  const commit = (statements: readonly Bound[], move: Parameters<typeof commitCalibration>[5]) => commitCalibration(db, projectId, token, population.revision, statements, move);
  const publishNext = async (after: string): Promise<EmbeddingStep> => {
    const page = await settledMoments(db, projectId, model, after, HUBNESS_PAGE + 1);
    const last = page.length <= HUBNESS_PAGE;
    const targets = page.slice(0, HUBNESS_PAGE);
    const done = await commit(publish(projectId, model, token, targets, population.covered, complete(population)),
      last ? ['published', population.revision] : ['publish', targets.at(-1)!.id, population.revision]);
    return {phase:'hubness',processed:done ? 1 : 0};
  };
  let subjects = await loaded(operatingMembers(db, projectId, model, HUBNESS_SUBJECTS));
  let started = false;
  if (subjects.length === 0) {
    if (view.cursor !== null && view.publicationRevision === population.revision && complete(population) && !population.miscounted) return publishNext(view.cursor);
    if (population.miscounted) {
      const done = await commit([calibrationWrites.dropModelPage(projectId, model, HUBNESS_REPAIR_PAGE, token)], ['clearCount']);
      return { phase: 'hubness', processed: done ? 1 : 0 };
    }
    let waiting = false;
    const leaving = await departingVectors(db, projectId, model, population.epoch, HUBNESS_SUBJECTS);
    if (leaving.length > 0) {
      started = await commit([calibrationWrites.markLeaving(projectId, model, leaving.map((r) => r.id), token)], ['clear']);
      if (!started) return { phase: 'hubness', processed: 0 };
    } else {
      const lostBefore = now - VECTOR_LOST_MS;
      const joining = await uncoveredVectors(db, projectId, model, population.epoch, HUBNESS_SUBJECTS);
      const asked = joining.length > 0 ? joining : await leftOut(db, projectId, model, population.epoch, lostBefore, view.probe);
      const visible = asked.length === 0 ? [] : await vectors.get({ projectId, modelKey: model }, asked.map((r) => r.id));
      const seen = new Set(visible.map((v) => v.id));
      const unseen = asked.filter((r) => !seen.has(r.id));
      const lost = unseen.filter((r) => r.updated_at <= lostBefore && r.rewrites < VECTOR_REWRITE_LIMIT);
      waiting = unseen.some((r) => r.updated_at > lostBefore);
      if (visible.length === 0 && lost.length === 0) {
        if (joining.length > 0) return { phase: 'visibility', processed: 0 };
      } else {
        const statements: Bound[] = visible.map((v) => calibrationWrites.addJoiner(projectId, model, v.id, encodeVector(v.values), token));
        if (joining.length === 0 && visible.length > 0) statements.push(calibrationWrites.clearRewrites(projectId, model, visible.map((v) => v.id), token));
        if (lost.length > 0) statements.push(calibrationWrites.requeueLost(projectId, model, lost.map((r) => r.id), lostBefore, token));
        // Joiners start an operation, whose pages publish every member; a joiner left out alone starts a publication pass.
        started = await commit(statements, visible.length > 0 ? ['clear'] : joining.length > 0 ? ['pass'] : ['none']);
        if (!started) return { phase: 'hubness', processed: 0 };
        if (visible.length === 0) return { phase: 'visibility', processed: 1 };
      }
    }
    if (!started) {
      if (view.cursor !== null) return publishNext(view.cursor);
      if (await reclaimVectorPages(db, projectId, now - OBJECT_PUT_IN_FLIGHT_MS, now) > 0) return { phase: 'hubness', processed: 1 };
      const sealing = await sealVectors({ db, blobs }, projectId, model, now, token, population.revision);
      if (sealing !== null) return { phase: 'hubness', processed: sealing ? 1 : 0 };
      return { phase: waiting ? 'visibility' : 'settled', processed: 0 };
    }
    view = await calibrationView(db, projectId, model);
    ({ population, token } = view);
    subjects = await loaded(operatingMembers(db, projectId, model, HUBNESS_SUBJECTS));
    if (subjects.length === 0) return { phase: 'hubness', processed: 1 };
  }

  const joins = subjects[0]!.state === MEMBER.joining;
  const after = view.cursor ?? '';
  const page = await settledMembers(db, projectId, model, after, HUBNESS_PAGE + 1);
  const last = page.length <= HUBNESS_PAGE;
  const targets = await hydrated(context, page.slice(0, HUBNESS_PAGE));
  for (const target of targets) {
    for (const subject of subjects) {
      const d = distance(subject.values, target.values);
      Object.assign(target, joins ? include(target, d) : exclude(target, d));
      if (joins) Object.assign(subject, include(subject, d));
    }
  }
  if (last && joins) {
    for (let i = 0; i < subjects.length; i++) {
      for (let j = i + 1; j < subjects.length; j++) {
        const d = distance(subjects[i]!.values, subjects[j]!.values);
        Object.assign(subjects[i]!, include(subjects[i]!, d));
        Object.assign(subjects[j]!, include(subjects[j]!, d));
      }
    }
  }
  const carried = joins ? [...targets, ...subjects] : targets;
  const statements: Bound[] = [calibrationWrites.carryMoments(projectId, model, token, carried)];
  let done: boolean;
  if (last) {
    statements.push(joins ? calibrationWrites.settleJoiners(projectId, model, token) : calibrationWrites.retireLeavers(projectId, model, token));
    statements.push(...publish(projectId, model, token, carried, population.covered, complete(population)));
    done = await commit(statements, ['settle', model, population.members - (joins ? 0 : subjects.length)]);
  } else {
    statements.push(...publish(projectId, model, token, carried, population.covered, complete(population)));
    done = await commit(statements, ['advance', targets[targets.length - 1]!.id]);
  }
  return { phase: 'hubness', processed: done || started ? 1 : 0 };
}

/** Every current spore vector is a member and no member is stale: statistics may be published. */
const complete = (population: CalibrationPopulation): boolean => population.uncovered === 0 && population.stale === 0;

/** Members with their vectors: from the row until a stored page holds it, then from that page. */
async function hydrated({ db, blobs }: Pick<EmbeddingContext, 'db' | 'blobs'>, rows: readonly MemberVector[]): Promise<Loaded[]> {
  const sealed = rows.filter((r): r is MemberVector & SealedMember => r.page_id !== null);
  const pages = sealed.length === 0 ? [] : await vectorPageRows(db, [...new Set(sealed.map((r) => r.page_id))]);
  const held = await readSealedVectors(blobs, pages, sealed);
  return rows.map((r) => ({ ...r, values: r.page_id === null ? new Float32Array(vectorBytes(r.vector).buffer) : held.get(r.id)! }));
}

/**
 * Moves one full page of settled members' vectors to a stored page, or answers null with fewer than a page held in the
 * database. The object is written and verified before the commit that lets a row give up its bytes. Any exit without a
 * seal, a failed verification included, leaves every row holding its bytes and hands an object whose page row is gone to
 * the release owner.
 */
async function sealVectors({ db, blobs }: Pick<EmbeddingContext, 'db' | 'blobs'>, projectId: string, model: string, now: number, token: string, revision: number): Promise<boolean | null> {
  const members = await inlineVectors(db, projectId, model, VECTOR_PAGE_MEMBERS);
  if (members.length < VECTOR_PAGE_MEMBERS) return null;
  const page = await encodeVectorPage(members.map((m) => ({ id: m.id, bytes: vectorBytes(m.vector) })));
  const key = vectorPageKey(projectId);
  const pageId = await beginVectorPage(db, projectId, model, key, page.bytes.byteLength, now);
  let sealed = false;
  try {
    await storeVectorPage(blobs, key, page);
    sealed = await commitVectorPageSeal(db, projectId, model, token, revision, { id: pageId, objectKey: key }, page.slots.map((s) => [s.id, s.offset, s.length] as const));
    return sealed;
  } finally {
    if (!sealed) await releaseUnsealedObject(db, key, now);
  }
}

/**
 * Left-out spore vectors to look for: those still written again first, then those no longer written again from the
 * probe cursor on, wrapping, so each one is looked for in turn. Moves the probe cursor past the last one taken.
 */
async function leftOut(db: RelationalStore, projectId: string, model: string, epoch: number, lostBefore: number, probe: CalibrationProbe): Promise<QueuedVector[]> {
  const rows = await leftOutVectors(db, projectId, model, epoch, lostBefore, probe, HUBNESS_SUBJECTS);
  const next = rows.filter((r) => r.rewrites >= VECTOR_REWRITE_LIMIT && r.updated_at <= lostBefore).at(-1);
  if (next !== undefined) await moveCalibrationProbe(db, projectId, { at: next.updated_at, id: next.id });
  return rows;
}

/**
 * Publishes the neighbour statistics of the rows whose moments cover every other current spore vector: the members once
 * this operation's leavers are gone are exactly the current spore vectors, and the row counts all of them but itself.
 */
function publish(projectId: string, model: string, token: string, rows: readonly MemberMoments[], count: number, isComplete: boolean): Bound[] {
  if (!isComplete) return [];
  const full = rows.filter((r) => r.n === count - 1);
  if (full.length === 0) return [];
  return [calibrationWrites.publishStatistics(projectId, model, token, full.map((r) => [r.id, r.n, r.mean, r.m2, ...neighborStats(r)] as const))];
}

/** Calibration has work only with at least two current spore vectors. With `fresh`, a row that rests clean is probed again. */
export async function calibrationPending(db: RelationalStore, projectId: string, model: string, now: number, fresh = false, kept: readonly string[] = []): Promise<boolean> {
  return recordedWork(db, projectId, model, 'hubness', JSON.stringify({ predicate: WORK_PREDICATE_VERSION, kept: [...kept].sort() }), now,
    async () => ({ pending: await calibrationHasWork(db, projectId, model, now, kept) }), { fresh });
}
