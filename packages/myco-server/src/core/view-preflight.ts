import type { RelationalStore } from './adapters.js';
import {
  preflightTranscript,
  preflightRanges,
  preflightCoverage,
  preflightCoverageSession,
  preflightCoveragePins,
  preflightClasses,
  preflightPlans,
  preflightReceipt,
  preflightReceiptEntries,
  preflightBundles,
} from '../read/view-store.js';

export const PREFLIGHT_PAGE_SIZE = 64;
const CURSOR_VERSION = 3;
const INVENTORY_KINDS = ['prompt', 'response', 'tool', 'plan', 'receipt', 'bundle'] as const;
type InventoryKind = (typeof INVENTORY_KINDS)[number];
const COUNT_KEYS = [
  'acknowledged',
  'ceiling',
  'parser_plans',
  'edited_or_unverified',
  'named_plans',
  'missing_plans',
  ...['prompt', 'response', 'tool'].flatMap((kind) =>
    ['fact', 'legacy', 'unverified'].map((value) => kind + ':' + value),
  ),
];
export interface PreflightCursor {
  stage: 'transcripts' | 'ranges' | 'coverage' | 'inventory';
  id: string;
  size?: number;
  base?: number;
  length?: number;
  end?: number;
  gap?: boolean;
  first?: number | null;
  kind?: InventoryKind;
  part?: number;
  active?: boolean;
  counts?: Record<string, number>;
  session?: string;
  coverageStage?: 'sessions' | 'pins' | 'prompts';
  scheme?: string | null;
  mixed?: boolean;
  rowid?: number;
  createdAt?: number;
}

export function encodeViewPreflightCursor(project: string, cursor: PreflightCursor): string {
  return btoa(JSON.stringify({ version: CURSOR_VERSION, project, ...cursor }));
}

export function decodeViewPreflightCursor(project: string, token: string | null): PreflightCursor {
  if (token === null) return { stage: 'transcripts', id: '' };
  if (token.length > 4096) throw new Error('invalid_preflight_cursor');
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(atob(token));
  } catch {
    throw new Error('invalid_preflight_cursor');
  }
  if (
    !value ||
    value.version !== CURSOR_VERSION ||
    value.project !== project ||
    !['transcripts', 'ranges', 'coverage', 'inventory'].includes(String(value.stage)) ||
    typeof value.id !== 'string' ||
    value.id.length > 256
  )
    throw new Error('invalid_preflight_cursor');
  if (value.createdAt !== undefined && !Number.isSafeInteger(value.createdAt))
    throw new Error('invalid_preflight_cursor');
  for (const field of ['size', 'base', 'length', 'end', 'first', 'part', 'rowid']) {
    if (
      value[field] !== undefined &&
      value[field] !== null &&
      (!Number.isSafeInteger(value[field]) ||
        Number(value[field]) < (['base', 'length', 'part'].includes(field) ? -1 : 0))
    )
      throw new Error('invalid_preflight_cursor');
  }
  if (
    value.stage === 'ranges' &&
    (['size', 'base', 'length', 'end'].some((field) => typeof value[field] !== 'number') ||
      typeof value.gap !== 'boolean')
  )
    throw new Error('invalid_preflight_cursor');
  if (value.kind !== undefined && !INVENTORY_KINDS.some((kind) => kind === value.kind))
    throw new Error('invalid_preflight_cursor');
  if (value.active !== undefined && typeof value.active !== 'boolean') throw new Error('invalid_preflight_cursor');
  if (value.session !== undefined && (typeof value.session !== 'string' || value.session.length > 256))
    throw new Error('invalid_preflight_cursor');
  if (value.coverageStage !== undefined && !['sessions', 'pins', 'prompts'].includes(String(value.coverageStage)))
    throw new Error('invalid_preflight_cursor');
  if (
    value.scheme !== undefined &&
    value.scheme !== null &&
    (typeof value.scheme !== 'string' || value.scheme.length > 128)
  )
    throw new Error('invalid_preflight_cursor');
  if (value.mixed !== undefined && typeof value.mixed !== 'boolean') throw new Error('invalid_preflight_cursor');
  if (
    value.counts !== undefined &&
    (value.counts === null ||
      typeof value.counts !== 'object' ||
      Array.isArray(value.counts) ||
      Object.entries(value.counts).some(
        ([key, count]) => !COUNT_KEYS.includes(key) || !Number.isSafeInteger(count) || Number(count) < 0,
      ))
  )
    throw new Error('invalid_preflight_cursor');
  return value as unknown as PreflightCursor;
}

/** Every stage advances a metadata keyset and carries its accumulated counts in the Project-bound cursor. */
export async function readViewPreflightPage(
  db: RelationalStore,
  project: string,
  cursor: PreflightCursor = { stage: 'transcripts', id: '' },
) {
  const counts = { ...cursor.counts };
  const coverageTotals = (complete: boolean) => {
    const acknowledged = counts.acknowledged ?? 0,
      ceiling = counts.ceiling ?? 0;
    return {
      acknowledged,
      reofferedFloor: acknowledged - ceiling,
      carryCeiling: ceiling,
      confirmedCarried: null,
      complete,
    };
  };
  const add = (key: string, n: number) => {
    counts[key] = (counts[key] ?? 0) + n;
  };
  if (cursor.stage === 'transcripts') {
    const row = await preflightTranscript(db)
      .bind(project, cursor.id)
      .first<{ transcript_id: string; size: number; parsed_offset: number }>();
    return {
      project,
      transcripts: row ? [{ ...row, rangeScan: 'pending' as const }] : [],
      coverage: null,
      nextCursor: row
        ? {
            stage: 'ranges' as const,
            id: row.transcript_id,
            size: row.size,
            base: -1,
            length: -1,
            end: 0,
            gap: false,
            first: null,
          }
        : { stage: 'coverage' as const, id: '' },
      complete: false,
    };
  }
  if (cursor.stage === 'ranges') {
    const rows = (
      await preflightRanges(db)
        .bind(
          project,
          cursor.id,
          cursor.size,
          cursor.base,
          cursor.base,
          cursor.length,
          project,
          cursor.id,
          cursor.size,
          cursor.base,
          cursor.base,
          cursor.length,
          PREFLIGHT_PAGE_SIZE + 1,
        )
        .all<{ base_offset: number; length: number }>()
    ).results;
    const more = rows.length > PREFLIGHT_PAGE_SIZE,
      held = rows.slice(0, PREFLIGHT_PAGE_SIZE),
      size = cursor.size!;
    let end = cursor.end!,
      gap = cursor.gap!,
      first = cursor.first ?? null;
    const gaps: { from: number; to: number }[] = [];
    for (const range of held) {
      first ??= range.base_offset;
      if (range.base_offset > end) {
        gaps.push({ from: end, to: range.base_offset });
        gap = true;
      }
      end = Math.max(end, Math.min(size, range.base_offset + range.length));
    }
    if (!more && end < size) {
      gaps.push({ from: end, to: size });
      gap = true;
    }
    const last = held.at(-1);
    return {
      project,
      transcripts: [
        {
          transcript_id: cursor.id,
          size,
          firstHeldByte: first,
          heldFromZero: more ? null : !gap && end >= size,
          gaps,
          rangeScan: more ? 'pending' : 'complete',
        },
      ],
      coverage: null,
      nextCursor: more
        ? { ...cursor, base: last!.base_offset, length: last!.length, end, gap, first }
        : { stage: 'transcripts' as const, id: cursor.id },
      complete: false,
    };
  }
  if (cursor.stage === 'coverage') {
    const stage = cursor.coverageStage ?? 'sessions';
    if (stage === 'sessions') {
      const row = await preflightCoverageSession(db)
        .bind(project, cursor.session ?? '')
        .first<{ session_id: string }>();
      return {
        project,
        transcripts: [],
        coverage: row ? null : coverageTotals(true),
        nextCursor: row
          ? { stage: 'coverage' as const, coverageStage: 'pins' as const, session: row.session_id, id: '', counts }
          : { stage: 'inventory' as const, kind: 'prompt' as const, id: '', counts },
        complete: false,
      };
    }
    if (stage === 'pins') {
      const rows = (
        await preflightCoveragePins(db)
          .bind(project, cursor.session, cursor.rowid ?? 0, PREFLIGHT_PAGE_SIZE + 1)
          .all<{ rowid: number; prompt_identity_scheme: string | null }>()
      ).results;
      const held = rows.slice(0, PREFLIGHT_PAGE_SIZE),
        more = rows.length > PREFLIGHT_PAGE_SIZE;
      let scheme = cursor.scheme ?? null,
        mixed = cursor.mixed ?? false;
      for (const row of held)
        if (row.prompt_identity_scheme !== null) {
          if (scheme !== null && scheme !== row.prompt_identity_scheme) mixed = true;
          scheme ??= row.prompt_identity_scheme;
        }
      return {
        project,
        transcripts: [],
        coverage: null,
        nextCursor: more
          ? { ...cursor, rowid: held.at(-1)!.rowid, scheme, mixed, counts }
          : {
              ...cursor,
              coverageStage: 'prompts' as const,
              id: '',
              scheme: mixed ? 'mixed' : (scheme ?? 'mixed'),
              mixed,
              counts,
            },
        complete: false,
      };
    }
    const rows = (
      await preflightCoverage(db)
        .bind(
          project,
          cursor.session,
          cursor.createdAt ?? Number.MIN_SAFE_INTEGER,
          cursor.id,
          PREFLIGHT_PAGE_SIZE + 1,
          cursor.scheme,
        )
        .all<{ id: string; created_at: number; acknowledged: number; ceiling: number }>()
    ).results;
    const held = rows.slice(0, PREFLIGHT_PAGE_SIZE),
      more = rows.length > PREFLIGHT_PAGE_SIZE;
    for (const row of held) {
      add('acknowledged', row.acknowledged);
      add('ceiling', row.ceiling);
    }
    return {
      project,
      transcripts: [],
      coverage: coverageTotals(false),
      nextCursor: more
        ? { ...cursor, id: held.at(-1)!.id, createdAt: held.at(-1)!.created_at, counts }
        : { stage: 'coverage' as const, coverageStage: 'sessions' as const, session: cursor.session, id: '', counts },
      complete: false,
    };
  }
  const kind = cursor.kind ?? 'prompt';
  let next: PreflightCursor | null;
  let bundles: Record<string, unknown>[] = [];
  if (kind === 'prompt' || kind === 'response' || kind === 'tool') {
    const rows = (
      await preflightClasses(db, kind)
        .bind(project, cursor.id, PREFLIGHT_PAGE_SIZE + 1)
        .all<{ id: string; class: string }>()
    ).results;
    const held = rows.slice(0, PREFLIGHT_PAGE_SIZE);
    for (const row of held) add(kind + ':' + row.class, 1);
    next =
      rows.length > PREFLIGHT_PAGE_SIZE
        ? { ...cursor, kind, id: held.at(-1)!.id, counts }
        : { stage: 'inventory', kind: INVENTORY_KINDS[INVENTORY_KINDS.indexOf(kind) + 1]!, id: '', counts };
  } else if (kind === 'plan') {
    const rows = (
      await preflightPlans(db)
        .bind(project, cursor.id, PREFLIGHT_PAGE_SIZE + 1)
        .all<{ id: string; parser_plan: number; edited: number }>()
    ).results;
    const held = rows.slice(0, PREFLIGHT_PAGE_SIZE);
    for (const row of held)
      if (row.parser_plan === 1) {
        add('parser_plans', 1);
        add('edited_or_unverified', row.edited);
      }
    next =
      rows.length > PREFLIGHT_PAGE_SIZE
        ? { ...cursor, kind, id: held.at(-1)!.id, counts }
        : { stage: 'inventory', kind: 'receipt', id: '', counts };
  } else if (kind === 'receipt') {
    const row = await preflightReceipt(db, cursor.active === true)
      .bind(project, cursor.id)
      .first<{ id: string }>();
    if (row === null) next = { stage: 'inventory', kind: 'bundle', id: '', counts };
    else {
      const rows = (
        await preflightReceiptEntries(db)
          .bind(project, row.id, cursor.active ? (cursor.part ?? -1) : -1, PREFLIGHT_PAGE_SIZE + 1)
          .all<{ part: number; missing: number }>()
      ).results;
      const held = rows.slice(0, PREFLIGHT_PAGE_SIZE),
        more = rows.length > PREFLIGHT_PAGE_SIZE;
      for (const item of held) {
        add('named_plans', 1);
        add('missing_plans', item.missing);
      }
      next = {
        stage: 'inventory',
        kind,
        id: row.id,
        active: more,
        ...(more ? { part: held.at(-1)!.part } : {}),
        counts,
      };
    }
  } else {
    bundles = (
      await preflightBundles(db)
        .bind(project, Number(cursor.id || 0), PREFLIGHT_PAGE_SIZE + 1)
        .all<Record<string, unknown>>()
    ).results;
    const more = bundles.length > PREFLIGHT_PAGE_SIZE;
    bundles = bundles.slice(0, PREFLIGHT_PAGE_SIZE);
    next = more ? { ...cursor, kind, id: String(bundles.at(-1)!.id), counts } : null;
  }
  const classes = ['prompt', 'response', 'tool'].flatMap((material) =>
    ['fact', 'legacy', 'unverified']
      .filter((value) => counts[material + ':' + value] !== undefined)
      .map((value) => ({ kind: material, class: value, n: counts[material + ':' + value]! })),
  );
  return {
    project,
    transcripts: [],
    coverage: null,
    inventory: {
      classes,
      plans: { parser_plans: counts.parser_plans ?? 0, edited_or_unverified: counts.edited_or_unverified ?? 0 },
      receipts: { named_plans: counts.named_plans ?? 0, missing_plans: counts.missing_plans ?? 0 },
      bundles,
      peakD1Growth: { state: 'unavailable', reason: 'requires measured row and index growth coefficients' },
      dropTableSizes: {
        state: 'unavailable',
        reason: 'per-table physical byte measurements are not available on this adapter',
      },
    },
    nextCursor: next,
    complete: next === null,
  };
}
