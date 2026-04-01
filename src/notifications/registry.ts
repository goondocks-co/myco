/**
 * Notification registry — domains register their notification descriptors here.
 *
 * Each subsystem (agents, sessions, skills, mycelium) calls `register()`
 * with its descriptor at module load time. The registry is then consumed by:
 *   - Config UI: to render per-domain toggle sections
 *   - Notification API: to validate incoming notification types
 *   - Settings: to discover all configurable domains dynamically
 */

import type { NotificationDomainDescriptor, NotificationTypeDescriptor } from './types.js';

const domains = new Map<string, NotificationDomainDescriptor>();

/** Register a domain's notification descriptor. Idempotent — re-registering the same domain replaces it. */
export function register(descriptor: NotificationDomainDescriptor): void {
  domains.set(descriptor.domain, descriptor);
}

/** Get a specific domain descriptor. */
export function getDomain(domain: string): NotificationDomainDescriptor | undefined {
  return domains.get(domain);
}

/** Get all registered domain descriptors, sorted by domain name. */
export function getAllDomains(): NotificationDomainDescriptor[] {
  return [...domains.values()].sort((a, b) => a.domain.localeCompare(b.domain));
}

/** Look up a specific notification type across all domains. */
export function getType(typeId: string): { domain: NotificationDomainDescriptor; type: NotificationTypeDescriptor } | undefined {
  for (const descriptor of domains.values()) {
    const match = descriptor.types.find((t) => t.id === typeId);
    if (match) return { domain: descriptor, type: match };
  }
  return undefined;
}

/** Check if a domain is registered. */
export function hasDomain(domain: string): boolean {
  return domains.has(domain);
}

/** Clear all registrations (for testing). */
export function clearAll(): void {
  domains.clear();
}
