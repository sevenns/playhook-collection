// A pretend game session, so the Play button in the bar does something instead of only making a noise.
//
// The launcher's real state machine is much larger (install, Proton config, save sync in and out, Steam
// downloads — see state-view.ts there); what is reproduced here is the one path a showcase can honestly
// show: launch, run, force-close, save, back to ready. The phase names, the status strings and the
// busy-visual mapping are the launcher's, so the bar behaves identically — the only difference is that
// nothing is actually started, and the durations are constants instead of the time real work takes.
//
// State lives in this module for as long as the tab does: leaving the entry screen, browsing the
// carousel or going back to the landing page do not end the session, exactly as the launcher keeps
// running a game while you flip through the strip. A reload does end it — there is no main process here
// to outlive the page.

/** The phases of the one path the site models. Names match the launcher's AppState kinds. */
export type SessionPhase = 'launching' | 'running' | 'killing' | 'syncing-out';

export interface Session {
  readonly slug: string;
  readonly phase: SessionPhase;
  /** When the session entered `running`; null until it does. Drives the playtime the panel then shows. */
  readonly runningSince: number | null;
}

/** What a finished session added to an entry's figures (see stats.ts for the invented baseline). */
export interface RecordedSessions {
  readonly launches: number;
  readonly seconds: number;
  readonly lastEndedAt: Date | null;
}

const NOTHING_RECORDED: RecordedSessions = { launches: 0, seconds: 0, lastEndedAt: null };

// How long each phase is shown. The launcher's are however long the work takes; here they are the
// shortest values that still read as a step rather than a flicker.
const LAUNCH_MS = 2200;
const KILL_MS = 1200;
const SAVE_MS = 1600;

export interface SessionController {
  /** The session in flight, or null. */
  current(): Session | null;
  /** Starts one for `slug`. Refused while another is in flight — the launcher runs one game at a time. */
  start(slug: string): void;
  /** Force close: `running` → `killing` → `syncing-out` → gone. A no-op outside `running`. */
  requestKill(): void;
  /** What finished sessions added to this entry's statistics. */
  recordedFor(slug: string): RecordedSessions;
  /** Called on every phase change (and on the end of a session). */
  subscribe(listener: () => void): void;
}

/** The status line for a phase — `statusOf` in the launcher's state-view.ts, English strings inlined. */
export function statusOf(phase: SessionPhase): string {
  switch (phase) {
    case 'launching':
      return 'Launching...';
    case 'running':
      return 'Running...';
    case 'killing':
      return 'Force closing...';
    case 'syncing-out':
      return 'Saving progress...';
  }
}

/**
 * Which busy visual the Play button wears — `busyKindOf` in the launcher's state-view.ts. `running` is
 * its own kind on purpose: there the launcher is summoned OVER the game and Play shows the triangle
 * again (pressing it returns to the game), not the spinner the other phases use.
 */
export function busyKindOf(phase: SessionPhase): 'game' | 'running' {
  return phase === 'running' ? 'running' : 'game';
}

export function createSessionController(): SessionController {
  let session: Session | null = null;
  let timer = 0;
  const listeners: (() => void)[] = [];
  const recorded = new Map<string, RecordedSessions>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const setPhase = (next: Session | null): void => {
    session = next;
    notify();
  };

  const after = (ms: number, step: () => void): void => {
    if (timer !== 0) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = 0;
      step();
    }, ms);
  };

  /** Books the finished session against the entry, the way StatsService does on the launcher's side. */
  const record = (slug: string, runningSince: number | null): void => {
    const previous = recorded.get(slug) ?? NOTHING_RECORDED;
    const seconds = runningSince === null ? 0 : Math.round((Date.now() - runningSince) / 1000);
    recorded.set(slug, {
      launches: previous.launches + 1,
      seconds: previous.seconds + seconds,
      lastEndedAt: new Date(),
    });
  };

  return {
    current: () => session,

    start(slug: string): void {
      if (session !== null) return;
      setPhase({ slug, phase: 'launching', runningSince: null });
      after(LAUNCH_MS, () => {
        setPhase({ slug, phase: 'running', runningSince: Date.now() });
      });
    },

    requestKill(): void {
      const active = session;
      if (active === null || active.phase !== 'running') return;
      setPhase({ ...active, phase: 'killing' });
      after(KILL_MS, () => {
        setPhase({ ...active, phase: 'syncing-out' });
        after(SAVE_MS, () => {
          record(active.slug, active.runningSince);
          setPhase(null);
        });
      });
    },

    recordedFor: (slug: string) => recorded.get(slug) ?? NOTHING_RECORDED,

    subscribe(listener: () => void): void {
      listeners.push(listener);
    },
  };
}
