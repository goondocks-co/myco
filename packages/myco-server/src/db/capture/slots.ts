import type { BindValue } from '../index.js';

const TOKENS = /'(?:''|[^'])*'|"(?:""|[^"])*"|\?(\d*)/g;

/**
 * The numbered slots of one statement assembled at module load, each named by a label. A label used twice shares one
 * slot, so a statement binds each value once, by name, in the order the slots were first taken.
 */
export class Slots<Label extends string> {
  private readonly labels: Label[] = [];

  /** The `?N` slot that holds `label`. */
  at(label: Label): string {
    const held = this.labels.indexOf(label);
    if (held >= 0) return `?${held + 1}`;
    this.labels.push(label);
    return `?${this.labels.length}`;
  }

  /** A fragment written with positional `?` slots elsewhere, each slot in order given the label that fills it. */
  place(sql: string, labels: readonly Label[]): string {
    let next = 0;
    const placed = sql.replace(TOKENS, (token, number: string | undefined) => {
      if (number === undefined) return token;
      if (number !== '') throw new Error('a placed fragment uses positional ? slots only');
      const label = labels[next++];
      if (label === undefined) throw new Error('a placed fragment has more slots than labels');
      return this.at(label);
    });
    if (next !== labels.length) throw new Error('a placed fragment has fewer slots than labels');
    return placed;
  }

  /** The values to bind, in slot order. Every label the statement uses must be given a value, null included. */
  values(bound: Readonly<Record<Label, BindValue>>): BindValue[] {
    return this.labels.map(label => {
      const value = bound[label];
      if (value === undefined) throw new Error(`no value bound for slot ${label}`);
      return value;
    });
  }
}
