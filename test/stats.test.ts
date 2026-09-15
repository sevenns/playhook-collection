// The invented play statistics. Invented, not random: the whole point of deriving them from the slug is
// that a card shows the same figures every time it is looked at — so that is what is checked, along
// with the ranges that keep the panel looking like the launcher's rather than like a bug.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatDate, formatPlaytime, statsFor } from '../src/stats.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('statsFor', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-15T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is deterministic: the same slug gives the same figures, call after call', () => {
    expect(statsFor('bloodborne')).toEqual(statsFor('bloodborne'));
    expect(statsFor('tunic')).toEqual(statsFor('tunic'));
  });

  it('gives different entries different figures', () => {
    const slugs = ['bloodborne', 'tunic', 'nfs-mw-2005', 'lineage-2', 'the-elder-scrolls-v-skyrim'];
    const launches = new Set(slugs.map((slug) => statsFor(slug).launchCount));
    expect(launches.size).toBeGreaterThan(1);
  });

  it('keeps the figures in ranges that read as real', () => {
    for (const slug of ['a', 'bloodborne', 'zz-top', 'the-first-berserker-khazan']) {
      const stats = statsFor(slug);
      expect(stats.launchCount).toBeGreaterThanOrEqual(4);
      expect(stats.launchCount).toBeLessThanOrEqual(120);
      // Playtime is launches × a session of 25..110 minutes, so it is whole minutes and never tiny.
      expect(stats.totalPlaySeconds % 60).toBe(0);
      expect(stats.totalPlaySeconds / 60 / stats.launchCount).toBeGreaterThanOrEqual(25);
      expect(stats.totalPlaySeconds / 60 / stats.launchCount).toBeLessThanOrEqual(110);
      // Last played: within the past 45 days, in the evening, on the minute.
      const ago = Date.now() - stats.lastPlayedAt.getTime();
      expect(ago).toBeGreaterThanOrEqual(0);
      expect(ago).toBeLessThanOrEqual(46 * DAY_MS);
      expect(stats.lastPlayedAt.getHours()).toBeGreaterThanOrEqual(17);
      expect(stats.lastPlayedAt.getHours()).toBeLessThanOrEqual(23);
      expect(stats.lastPlayedAt.getSeconds()).toBe(0);
    }
  });

  it('moves the date with today, so the demo never ages', () => {
    const before = statsFor('tunic').lastPlayedAt;
    vi.setSystemTime(new Date('2027-09-15T12:00:00Z'));
    const after = statsFor('tunic').lastPlayedAt;
    expect(after.getTime() - before.getTime()).toBe(365 * DAY_MS);
  });
});

describe('formatPlaytime', () => {
  it('writes hours and minutes the way the launcher does', () => {
    expect(formatPlaytime(0)).toBe('Less than a minute');
    expect(formatPlaytime(59)).toBe('Less than a minute');
    expect(formatPlaytime(60)).toBe('1 min');
    expect(formatPlaytime(3599)).toBe('59 min');
    expect(formatPlaytime(3600)).toBe('1 h 0 min');
    expect(formatPlaytime(96 * 3600 + 5 * 60)).toBe('96 h 5 min');
  });
});

describe('formatDate', () => {
  it('formats in en-GB, day first', () => {
    expect(formatDate(new Date(2026, 8, 15, 19, 5))).toBe('15/09/2026, 19:05:00');
  });
});
