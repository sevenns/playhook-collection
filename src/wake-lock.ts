// The browser's counterpart of playhook's `preventScreensaver` — the one General setting a web page can
// actually honour. The launcher asks Electron's powerSaveBlocker to hold the display awake for as long
// as it is open; a page asks the Screen Wake Lock API for the same thing.
//
// BROWSER: a wake lock is not a promise the page can keep on its own. It is released by the browser
// whenever the document stops being visible (another tab, a minimised window, a locked screen), and it
// is not restored automatically — so the lock is re-taken on `visibilitychange`, which is the pattern the
// API's own guidance prescribes. It can also be refused outright (an unsupported browser, an insecure
// origin, a battery saver), and there is nothing to do about that but keep working silently: this is a
// convenience on a showcase, not a feature anything depends on.
//
// There is no such thing as a launcher whose screensaver setting fails, which is why this file has no
// counterpart there at all.

/** The slice of the API we use — it is absent from the DOM types this project compiles against. */
interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>;
}

export interface WakeLock {
  /** Turns the lock on or off. Idempotent: the same value twice does nothing. */
  set(wanted: boolean): void;
}

function wakeLockApi(): WakeLockLike | null {
  const nav = navigator as Navigator & { wakeLock?: WakeLockLike };
  return nav.wakeLock ?? null;
}

export function createWakeLock(): WakeLock {
  const api = wakeLockApi();
  let wanted = false;
  let sentinel: WakeLockSentinelLike | null = null;
  /** A request already in flight — two overlapping ones would leave a lock nobody holds a handle to. */
  let pending = false;

  async function acquire(): Promise<void> {
    if (api === null || pending || sentinel !== null) return;
    if (!wanted || document.visibilityState !== 'visible') return;
    pending = true;
    try {
      const next = await api.request('screen');
      // The setting may have been turned off while the request was in flight.
      if (!wanted) {
        void next.release().catch(() => undefined);
        return;
      }
      sentinel = next;
      next.addEventListener('release', () => {
        sentinel = null;
      });
    } catch {
      // Refused: unsupported, insecure, or the browser simply said no. Nothing to report.
    } finally {
      pending = false;
    }
  }

  function release(): void {
    const held = sentinel;
    sentinel = null;
    if (held !== null) void held.release().catch(() => undefined);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void acquire();
  });

  return {
    set(next: boolean): void {
      if (next === wanted) return;
      wanted = next;
      if (next) void acquire();
      else release();
    },
  };
}
