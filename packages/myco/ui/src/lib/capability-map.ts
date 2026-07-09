/**
 * Symbiont -> capability chips.
 *
 * Pure module: takes a `SymbiontInfo` and returns the ordered list of
 * capability chips the Symbionts page renders for that symbiont. Each
 * chip's `to` is a project-relative suffix (the consumer wraps it with
 * `useProjectPathBuilder()` so the link lands in the active project).
 *
 * Vocabulary is locked here — every label in this file is canonical
 * and matches the names users see in the rest of the Myco UI. If you
 * find yourself adding a new capability, add it here once; never branch
 * the labels at the call site.
 */

import type { SymbiontInfo } from '../hooks/use-symbionts';

export type CapabilityTone = 'sage' | 'ochre' | 'outline';

export interface CapabilityChipDescriptor {
  /** Unique key per symbiont row (for React keys). */
  id: string;
  /** Chip label, exactly as it appears in the UI. */
  label: string;
  /** Project-relative path (starts with `/`). The consumer joins this
   *  with the active project's route prefix. */
  to: string;
  /** Visual tone — `sage` for live, `outline` for configured-but-quiet,
   *  `ochre` only used for genuine warnings (none currently emitted). */
  tone: CapabilityTone;
  /** Tooltip shown on hover. */
  title?: string;
}

/**
 * Build the chip list for one symbiont. Chips are returned in the
 * fixed display order locked by the page design — do not re-sort at
 * the call site.
 *
 * Only chips for capabilities the symbiont actually supports are
 * returned. A symbiont that supports nothing returns `[]` — the
 * SymbiontRow renders an empty state for that case.
 */
export function buildCapabilityChips(s: SymbiontInfo): CapabilityChipDescriptor[] {
  const chips: CapabilityChipDescriptor[] = [];
  const agentParam = `agent=${encodeURIComponent(s.name)}`;

  if (s.supportsSessions) {
    chips.push({
      id: 'sessions',
      label: 'Sessions',
      to: `/sessions?${agentParam}`,
      tone: 'sage',
      title: 'Prompts, tool calls, and responses captured from this symbiont',
    });
  }

  // Cortex Instructions and Cortex Digest both ride session-start
  // injection — if a symbiont has it, both features are available
  // to the user; if it doesn't, neither chip shows.
  if (s.supportsSessionStartInjection) {
    chips.push({
      id: 'cortex-instructions',
      label: 'Cortex Instructions',
      to: '/cortex?tab=instructions',
      tone: 'sage',
      title: 'Project-scoped instructions injected at session start',
    });
    chips.push({
      id: 'cortex-digest',
      label: 'Cortex Digest',
      to: '/cortex?tab=digest',
      tone: 'sage',
      title: 'Project state digest injected at session start',
    });
  }

  if (s.supportsCanopyInjection) {
    chips.push({
      id: 'cortex-canopy',
      label: 'Cortex Canopy',
      to: '/cortex?tab=canopy',
      tone: 'sage',
      title: 'File-read context injected on tool use',
    });
  }

  if (s.supportsSubagentStartInjection) {
    chips.push({
      id: 'cortex-subagent',
      label: 'Subagent context',
      to: '/cortex?tab=instructions',
      tone: 'sage',
      title: 'Myco can inject a Cortex primer when this symbiont starts a subagent',
    });
  }

  // Spores are produced by any symbiont that records sessions — the
  // intelligence pipeline writes them after the fact. So the chip is
  // gated on `supportsSessions`, not on a separate manifest field.
  if (s.supportsSessions) {
    chips.push({
      id: 'cortex-spores',
      label: 'Cortex Spores',
      to: '/mycelium?tab=spores',
      tone: 'sage',
      title: 'Durable knowledge mined from this symbiont’s sessions',
    });
  }

  if (s.supportsPlanCapture) {
    chips.push({
      id: 'plans',
      label: 'Plans',
      to: `/sessions?${agentParam}&has_plan=true`,
      tone: 'sage',
      title: 'Plans this symbiont produced',
    });
  }

  if (s.supportsSkills) {
    chips.push({
      id: 'skills',
      label: 'Skills',
      to: '/skills',
      tone: 'sage',
      title: 'Myco skills exposed inside this symbiont',
    });
  }

  if (s.supportsMcp) {
    const live = s.mcpActive === true;
    chips.push({
      id: 'mcp',
      label: live ? 'MCP' : 'MCP (quiet)',
      to: '/skills',
      tone: live ? 'sage' : 'outline',
      title: live
        ? 'Myco MCP tools called within the last 7 days'
        : 'MCP is configured but no recent tool calls were observed',
    });
  }

  // OKF chip is symbiont-derived ONLY — it reflects whether this symbiont
  // can call Myco's OKF MCP tools, not whether OKF is enabled for the
  // active project. Project-level OKF state (enabled/validation/pointer)
  // lives exclusively in OkfReadinessPanel on the Symbionts page; mixing
  // it into this pure function would make the chip depend on data this
  // module never receives, and would misuse `ochre` (reserved for genuine
  // warnings) for what is really just "not configured yet".
  if (s.supportsMcp) {
    chips.push({
      id: 'okf',
      label: 'OKF tools',
      to: '/okf',
      tone: 'sage',
      title: 'This symbiont can call Myco OKF MCP tools',
    });
  } else {
    chips.push({
      id: 'okf',
      label: 'OKF (CLI)',
      to: '/okf',
      tone: 'outline',
      title: 'This symbiont falls back to the myco CLI / reading the OKF markdown directly',
    });
  }

  return chips;
}
