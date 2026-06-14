// SPDX-License-Identifier: Apache-2.0

function entitySuffix(base: string, id: string): string {
  return `${base}/${encodeURIComponent(id)}`;
}

export function sessionSuffix(id: string): string {
  return entitySuffix('/sessions', id);
}

export function agentRunSuffix(id: string): string {
  return entitySuffix('/agent', id);
}

export function agentTaskSuffix(id: string): string {
  const params = new URLSearchParams({ tab: 'tasks', task: id });
  return `/agent?${params.toString()}`;
}

export function sporeSuffix(id: string): string {
  const params = new URLSearchParams({ tab: 'spores', spore: id });
  return `/mycelium?${params.toString()}`;
}

export function canopyEntrySuffix(path: string): string {
  const params = new URLSearchParams({ tab: 'canopy', section: 'entries', path });
  return `/cortex?${params.toString()}`;
}
