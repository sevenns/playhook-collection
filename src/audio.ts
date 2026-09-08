// UI sound effects + the looping background music of whichever collection entry is on screen.
//
// The SFX half was written fresh for this site; the music half is a port of playhook's audio.ts, minus
// its source layer. The launcher juggles THREE music sources — the browsed game's track, the inserted
// card's own and an app-wide ambience, resolved through applyEffective() — and none of that has a
// counterpart here: the site has exactly one source, the entry's `backgroundMusic`. What IS ported 1:1
// is the crossfade engine: at most two live <audio> elements, a volume ramp on requestAnimationFrame,
// and the pause guard. That is not fidelity for its own sake — flipping through the carousel switches
// tracks with every card, and a hard cut there is audible.
//
// Slot → file is NOT 1:1, and the mismatch is silent if you get it wrong (an unknown slot just never
// plays): `navigate` is served by move.ogg. That quirk comes from playhook's asset-reader.ts, where the
// sound-set folders predate the slot vocabulary.
//
// The set is `playhook-abyss`, playhook 0.8.0's own out-of-the-box choice (asset-reader.ts,
// DEFAULT_SOUND_SET) — the showcase should sound like the product does. It is ONE set for the whole page
// and an entry cannot override it: per-card UI sounds left the card format in 0.7.0, so the launcher
// plays the set chosen in its Settings and nothing else. Only the music still travels with an entry.
// One of the launcher's nine slots is not here: `notify`, since a showcase has nothing to notify about
// (see PORTED-FROM.md).
import { shouldPlayLimit } from './sfx-limit.js';

/**
 * The UI sound slots. `play` exists here too now: the bar has a Play button (see controls.ts). `limit`
 * is the dead end — a press that changed nothing — `popup-open` / `popup-close` bracket the menu, and
 * `typing` is a keystroke on the on-screen keyboard (osk.ts).
 */
export type SfxName =
  | 'navigate'
  | 'button'
  | 'back'
  | 'play'
  | 'limit'
  | 'popup-open'
  | 'popup-close'
  | 'typing';

const SFX_FILES: Readonly<Record<SfxName, string>> = {
  navigate: './sfx/move.ogg',
  button: './sfx/button.ogg',
  back: './sfx/back.ogg',
  play: './sfx/play.ogg',
  limit: './sfx/limit.ogg',
  'popup-open': './sfx/popup-open.ogg',
  'popup-close': './sfx/popup-close.ogg',
  typing: './sfx/typing.ogg',
};

const SFX_NAMES = Object.keys(SFX_FILES) as readonly SfxName[];

/** Crossfade / fade-in duration in ms. A whole 0→1 volume ramp takes this long; partial ramps scale down. */
const FADE_MS = 800;
/** Volume within this of the target counts as "arrived" (float ramps never land exactly). */
const FADE_EPSILON = 0.001;
const MUSIC_VOLUME = 0.5;

export interface AudioController {
  /** Plays a one-shot UI sound. Best-effort: a browser that blocks audio before the first user gesture
   *  simply drops it. */
  play(name: SfxName): void;
  /**
   * Plays the `limit` dead-end sound, at most once per series of blocked attempts. Every call counts as
   * an attempt (that is what keeps a held direction from re-arming the latch by idling); the sound only
   * comes out when the latch is armed — see sfx-limit.ts.
   */
  playLimit(): void;
  /** Ends the current series of blocked attempts, so the next one sounds again. Called on release. */
  rearmLimit(): void;
  /** Switches to an entry's background track; null fades out to silence. */
  setGameMusic(url: string | null): void;
  /** Starts/stops the background music to match the desired playing state (the visibility gate). */
  setMusicPlaying(shouldPlay: boolean): void;
}

/** A live music element paired with the source URL it holds. */
interface Player {
  readonly el: HTMLAudioElement;
  readonly url: string;
}

export function createAudioController(): AudioController {
  const sfx = new Map<SfxName, HTMLAudioElement>();
  // The `limit` latch: one sound per series of blocked attempts, armed by a release. App-wide on
  // purpose, not per slot or per surface — a left edge and a dead Y 100 ms later are one dead end to
  // the ear, and a doubled `limit` sounds worse than a swallowed second one.
  let limitArmed = true;
  let lastLimitAttemptAt = Number.NEGATIVE_INFINITY;

  const playSfx = (name: SfxName): void => {
    const el = sfx.get(name);
    if (el === undefined) return;
    // Clone so rapid retriggers (fast navigation) overlap instead of cutting each other off.
    const node = el.cloneNode() as HTMLAudioElement;
    void node.play().catch(() => undefined);
  };

  function loadSfx(): void {
    for (const name of SFX_NAMES) {
      const el = new Audio(SFX_FILES[name]);
      el.preload = 'auto';
      sfx.set(name, el);
    }
  }

  // ── Music ──────────────────────────────────────────────────────────────────

  // The currently-primary player (fading IN or steady) and, during a crossfade, the outgoing one (fading
  // OUT). `activeUrl` mirrors the source we've committed to — the idempotence key.
  let active: Player | null = null;
  let outgoing: Player | null = null;
  let activeUrl: string | null = null;

  // The gate result (the tab is visible). NOT a short-circuit: a repeated `true` re-issues play() on the
  // live element without restarting the fade.
  let wantPlay = false;

  let fadeHandle: number | null = null;
  let lastTs = 0;

  const stepToward = (current: number, target: number, maxDelta: number): number =>
    current < target ? Math.min(target, current + maxDelta) : Math.max(target, current - maxDelta);

  const drop = (player: Player): void => {
    player.el.pause();
    player.el.removeAttribute('src');
    player.el.load();
  };

  // A fresh looping element at volume 0. The pause guard resumes an element the OS or the browser paused
  // with no user intent — but ONLY while it is the ACTIVE one and we still want playback: an outgoing
  // (fading-out) element's guard no-ops, so a crossfade never ends up double-playing both.
  const createEl = (url: string): HTMLAudioElement => {
    const el = new Audio(url);
    el.loop = true;
    el.volume = 0;
    el.preload = 'auto';
    el.addEventListener('pause', () => {
      if (wantPlay && active?.el === el) void el.play().catch(() => undefined);
    });
    return el;
  };

  const tick = (ts: number): void => {
    fadeHandle = null;
    const maxDelta = Math.max(0, ts - lastTs) / FADE_MS;
    lastTs = ts;
    let busy = false;

    if (outgoing !== null) {
      const next = stepToward(outgoing.el.volume, 0, maxDelta);
      outgoing.el.volume = next;
      if (next <= FADE_EPSILON) {
        drop(outgoing);
        outgoing = null;
      } else {
        busy = true;
      }
    }

    if (active !== null && Math.abs(active.el.volume - MUSIC_VOLUME) > FADE_EPSILON) {
      active.el.volume = stepToward(active.el.volume, MUSIC_VOLUME, maxDelta);
      busy = true;
    }

    if (busy && wantPlay) fadeHandle = requestAnimationFrame(tick);
  };

  const ensureFade = (): void => {
    if (fadeHandle !== null) return;
    lastTs = performance.now();
    fadeHandle = requestAnimationFrame(tick);
  };

  const stopFade = (): void => {
    if (fadeHandle === null) return;
    cancelAnimationFrame(fadeHandle);
    fadeHandle = null;
  };

  // Silent source swap (used while paused / not wanted): no audible transition, so just replace the
  // loaded element at volume 0. A later setMusicPlaying(true) fades it in from 0.
  const hardSwap = (target: string | null): void => {
    if (outgoing !== null) {
      drop(outgoing);
      outgoing = null;
    }
    if (active !== null) {
      drop(active);
      active = null;
    }
    activeUrl = target;
    if (target !== null) active = { el: createEl(target), url: target };
  };

  // Audible source change: the current active fades out while a new element fades in (target null = fade
  // out to silence). A second change mid-fade drops the already-outgoing element (cap: two live elements).
  const crossfadeTo = (target: string | null): void => {
    if (outgoing !== null) drop(outgoing);
    outgoing = active;
    active = null;
    activeUrl = target;
    if (target !== null) {
      const el = createEl(target);
      active = { el, url: target };
      void el.play().catch(() => undefined);
    }
    ensureFade();
  };

  const setMusic = (target: string | null): void => {
    if (target === activeUrl) return; // idempotent: the same source never restarts playback
    if (wantPlay) crossfadeTo(target);
    else hardSwap(target);
  };

  // BROWSER: play() before the first user gesture is rejected outright. On the ordinary path (home →
  // menu → Collection → a game) the gesture has already happened; the one case that has none is a cold
  // deep link straight to `#/collection/<slug>`. The pause guard cannot rescue that — a rejected play()
  // fires no `pause` event, so the music would simply never start, silently. Hence a one-shot unlock.
  // A gamepad-only user still hears nothing: polling navigator.getGamepads() produces no DOM event and
  // no sticky activation. That is the same limitation the SFX have always carried.
  let unlocked = false;
  const unlock = (): void => {
    if (unlocked) return;
    unlocked = true;
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
    if (wantPlay && active !== null) {
      void active.el.play().catch(() => undefined);
      ensureFade();
    }
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  loadSfx();

  return {
    play: playSfx,

    playLimit(): void {
      const now = performance.now();
      const sound = shouldPlayLimit(limitArmed, lastLimitAttemptAt, now);
      lastLimitAttemptAt = now;
      if (!sound) return;
      limitArmed = false;
      playSfx('limit');
    },

    rearmLimit(): void {
      limitArmed = true;
    },

    setGameMusic(url: string | null): void {
      setMusic(url);
    },

    setMusicPlaying(shouldPlay: boolean): void {
      wantPlay = shouldPlay;
      if (shouldPlay) {
        // Always (re-)issue play() on the live elements — this is what resurrects an element the OS
        // muted. Then ramp only if we're not already at the target.
        if (active !== null) void active.el.play().catch(() => undefined);
        if (outgoing !== null) void outgoing.el.play().catch(() => undefined);
        const settled =
          active === null || Math.abs(active.el.volume - MUSIC_VOLUME) <= FADE_EPSILON;
        if (!settled || outgoing !== null) ensureFade();
        return;
      }
      stopFade();
      if (active !== null) active.el.pause();
      if (outgoing !== null) {
        drop(outgoing);
        outgoing = null;
      }
    },
  };
}
