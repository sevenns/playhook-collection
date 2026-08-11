// The play statistics shown in the menu's Details view — ported in SHAPE from playhook's info panel
// (`buildInfoPanel` in src/renderer/app.ts, `src/renderer/format.ts`) but not in substance: there the
// three numbers come from StatsService, which counts real sessions on the user's own machine. A showcase
// has no sessions to count, so they are INVENTED here.
//
// Invented, not random: the numbers are derived from the entry's slug, so a given card always shows the
// same figures. A fresh roll per render would change them under the reader mid-look, and per visit it
// would make the panel obviously fake for the wrong reason — the point is to show what the launcher's
// panel looks like, not to claim anybody played Bloodborne for 96 hours.
//
// The one thing that does move is the date: it is an offset back from today, so the demo never ages into
// "last played in 2026".

/** What the panel shows, mirroring the launcher's `Stats` minus everything the site cannot have. */
export interface EntryStats {
  readonly lastPlayedAt: Date;
  readonly totalPlaySeconds: number;
  readonly launchCount: number;
}

/** FNV-1a. Any stable string→int would do; this one is short and has no collisions worth caring about. */
function hash(value: string): number {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** mulberry32: a tiny PRNG, so the three figures are independent draws rather than slices of one hash. */
function seeded(seed: number): () => number {
  let state = seed;
  return (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const between = (random: () => number, min: number, max: number): number =>
  min + Math.floor(random() * (max - min + 1));

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Plausible figures for one entry. Playtime is derived from the launch count rather than drawn on its
 * own — a card with 90 launches and 40 minutes played reads as a bug, and the panel's whole job is to
 * look like the launcher's.
 */
export function statsFor(slug: string): EntryStats {
  const random = seeded(hash(slug));
  const launchCount = between(random, 4, 120);
  const sessionMinutes = between(random, 25, 110);
  const daysAgo = between(random, 0, 45);
  const hour = between(random, 17, 23);
  const minute = between(random, 0, 59);

  const lastPlayedAt = new Date(Date.now() - daysAgo * DAY_MS);
  lastPlayedAt.setHours(hour, minute, 0, 0);

  return {
    lastPlayedAt,
    totalPlaySeconds: launchCount * sessionMinutes * 60,
    launchCount,
  };
}

/** `formatPlaytime` from the launcher, with the translator's plural units written out in English. */
export function formatPlaytime(totalSeconds: number): string {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `${hours} h ${minutes} min`;
  if (minutes > 0) return `${minutes} min`;
  return 'Less than a minute';
}

/** `formatDate` from the launcher. en-GB because the site is English-only — the launcher picks by locale. */
export function formatDate(date: Date): string {
  return date.toLocaleString('en-GB');
}
