import { describe, it, expect } from 'vitest';
import { formatLogLine, formatLocalTime, parseIntFlag, parseStringFlag } from '@myco/logs/format';

describe('formatLogLine', () => {
  it('formats a basic log entry', () => {
    const line = formatLogLine({
      timestamp: '2026-03-14T14:23:39.000Z',
      level: 'info',
      component: 'hooks',
      message: 'Stop received',
    });
    expect(line).toContain('INFO');
    expect(line).toContain('[hooks]');
    expect(line).toContain('Stop received');
  });

  it('appends extra fields as key=value', () => {
    const line = formatLogLine({
      timestamp: '2026-03-14T14:23:39.000Z',
      level: 'warn',
      component: 'processor',
      message: 'Failed',
      session_id: 'abc123',
    });
    expect(line).toContain('session_id=abc123');
  });

  it('truncates long extra values', () => {
    const longValue = 'x'.repeat(200);
    const line = formatLogLine({
      timestamp: '2026-03-14T14:23:39.000Z',
      level: 'info',
      component: 'd',
      message: 'test',
      data: longValue,
    });
    expect(line).toContain('...');
    expect(line.length).toBeLessThan(longValue.length + 100);
  });

  it('pads level to 5 chars for alignment', () => {
    const info = formatLogLine({ timestamp: '2026-03-14T14:00:00Z', level: 'info', component: 'd', message: 'x' });
    const warn = formatLogLine({ timestamp: '2026-03-14T14:00:00Z', level: 'warn', component: 'd', message: 'x' });
    expect(info).toMatch(/INFO\s/);
    expect(warn).toMatch(/WARN\s/);
  });
});

describe('formatLocalTime', () => {
  it('produces HH:mm:ss from ISO timestamp', () => {
    const result = formatLocalTime('2026-03-14T14:23:39.000Z');
    expect(result).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });
});

describe('parseIntFlag', () => {
  it('parses long flag', () => {
    expect(parseIntFlag(['--tail', '20'], '--tail')).toBe(20);
  });

  it('parses short flag', () => {
    expect(parseIntFlag(['-n', '5'], '--tail', '-n')).toBe(5);
  });

  it('returns undefined for missing flag', () => {
    expect(parseIntFlag(['--other', 'x'], '--tail')).toBeUndefined();
  });

  it('returns undefined for non-numeric value', () => {
    expect(parseIntFlag(['--tail', 'abc'], '--tail')).toBeUndefined();
  });
});

describe('parseStringFlag', () => {
  it('parses long flag', () => {
    expect(parseStringFlag(['--level', 'warn'], '--level')).toBe('warn');
  });

  it('parses short flag', () => {
    expect(parseStringFlag(['-l', 'error'], '--level', '-l')).toBe('error');
  });

  it('returns undefined for missing flag', () => {
    expect(parseStringFlag(['--other', 'x'], '--level')).toBeUndefined();
  });
});
