/**
 * Backup domain — public surface.
 *
 * Single home for all backup logic: the pure dump/restore engine, the
 * per-Grove directory resolver, the high-level service operations, and the
 * one-time legacy migration. Consumers (daemon API, auto-backup job,
 * maintenance) import from here so the logic cannot drift across copies.
 */
export * from './engine.js';
