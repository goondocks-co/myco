// SPDX-License-Identifier: Apache-2.0

export function agentRunNotificationLink(runId: string): string {
  return `/agent/${encodeURIComponent(runId)}`;
}
