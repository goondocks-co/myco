/**
 * Where the Deployment's clock is kept, in a module of its own: the clock reads it, and so does anything that must name
 * the clock without loading it.
 */

/**
 * The one clock a Deployment keeps, by the name `clockStub` addresses it by. An object is placed where it is first
 * addressed and never moves, so a clock placed in a new region is a clock under a new name.
 */
export const CLOCK_NAME = 'deployment-enam';
/** Where the clock is placed: beside the database's primary, which every tick reads and writes over and over. */
export const CLOCK_LOCATION_HINT = 'enam' as const;
/**
 * Names the clock is no longer kept under. An object under one of them still holds the alarm it last armed;
 * when that alarm fires it deletes it and ticks nothing, so only the clock under `CLOCK_NAME` ever ticks.
 */
export const RETIRED_CLOCK_NAMES: readonly string[] = ['deployment'];
