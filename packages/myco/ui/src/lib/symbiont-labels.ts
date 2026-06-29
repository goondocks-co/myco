// SPDX-License-Identifier: Apache-2.0

export interface SymbiontDisplayLabelSource {
  name: string;
  displayName: string;
}

export function buildSymbiontDisplayNameResolver(
  symbionts: readonly SymbiontDisplayLabelSource[],
): (agent: string | null | undefined) => string {
  const lookup = new Map<string, string>();
  for (const symbiont of symbionts) {
    lookup.set(symbiont.name, symbiont.displayName);
  }
  return (agent: string | null | undefined): string => {
    if (!agent) return 'unknown';
    return lookup.get(agent) ?? agent;
  };
}
