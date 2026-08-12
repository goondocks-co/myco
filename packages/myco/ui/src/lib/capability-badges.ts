/**
 * Per-project capability badge descriptors.
 *
 * Pure function: maps resolved gate booleans to `CapabilityChipDescriptor`
 * values that the Groves page renders via `CapabilityChipVisual` inside the
 * badge-strip button. Mirrors the shape of
 * `capability-map.ts:buildCapabilityChips` so the same visual component and
 * tone vocabulary applies.
 *
 * When every opt-in capability is off a single "Capture-only" badge is
 * returned; otherwise one sage badge per enabled capability.
 */

import { CAPABILITIES } from '@myco/config/capabilities';
import type { CapabilityId } from '@myco/config/scope';
import type { CapabilityChipDescriptor } from './capability-map';

/** The locked capture-only vocabulary — every surface that names the mode uses these strings. */
export const CAPTURE_ONLY_BADGE = {
  label: 'Capture-only',
  title: 'Sessions, search, and MCP only',
} as const;

/** Build capability badge descriptors from resolved per-project gate values. */
export function buildCapabilityBadges(gates: Record<CapabilityId, boolean>): CapabilityChipDescriptor[] {
  const enabled = (Object.keys(CAPABILITIES) as CapabilityId[]).filter((id) => gates[id]);
  if (enabled.length === 0) {
    return [{ id: 'capture-only', label: CAPTURE_ONLY_BADGE.label, to: '', tone: 'outline', title: CAPTURE_ONLY_BADGE.title }];
  }
  return enabled.map((id) => ({
    id,
    label: CAPABILITIES[id].label,
    to: CAPABILITIES[id].advancedSettingsLink,
    tone: 'sage' as const,
    title: `${CAPABILITIES[id].label} enabled`,
  }));
}
