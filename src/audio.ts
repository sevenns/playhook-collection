// UI sound effects + the looping background music of whichever collection entry is on screen, plus the
// app-wide ambience that plays whenever there is no entry music to play.
//
// The SFX half was written fresh for this site; the music half is a port of playhook's audio.ts. The
// launcher juggles THREE music sources — the browsed game's track, the inserted card's own and an
// app-wide ambience — resolved through the effective source `browseMusic ?? cardMusic ?? ambient`. The
// middle one has no counterpart here (there is no card), so the site resolves TWO: the entry's own
// `backgroundMusic` and the ambience chosen in Settings. What IS ported 1:1 is the crossfade engine: at
// most two live <audio> elements, a volume ramp on requestAnimationFrame, and the pause guard. That is
// not fidelity for its own sake — flipping through the carousel switches tracks with every card, and a
// hard cut there is audible.
//
// The `idle` half of setBrowseMusic is the launcher's rule verbatim: standing on a SITE CARD is not the
// same as an entry with no music of its own. Both end up on the ambience here, but they have to be said
// separately, because a null alone would fall through the same chain the launcher's card music sits in.
//
// Slot → file is NOT 1:1, and the mismatch is silent if you get it wrong (an unknown slot just never
// plays): `navigate` is served by move.ogg. That quirk comes from playhook's asset-reader.ts, where the
// sound-set folders predate the slot vocabulary.
//
// Every one of the launcher's eighteen sound sets is bundled, under its own name (public/sfx/<set>/),
// and the set is switched live from the Settings screen exactly as it is there — a card cannot override
// it, since per-card UI sounds left the card format in 0.7.0. One of the launcher's nine slots is not
// here: `notify`, since a showcase has nothing to notify about (see PORTED-FROM.md).
import { shouldPlayLimit } from './sfx-limit.js';

/**
 * The UI sound slots. `play` exists here too now: the bar has a Play button (see controls.ts). `limit`
 * is the dead end — a press that changed nothing — `popup-open` / `popup-close` bracket the menu, and
 * `typing` is a keystroke on the on-screen keyboard (osk.ts).
 */
export type SfxName =
  'navigate' | 'button' | 'back' | 'play' | 'limit' | 'popup-open' | 'popup-close' | 'typing';

/** Slot → the file that serves it inside a set's folder (see the note on `navigate` above). */
const SFX_FILES: Readonly<Record<SfxName, string>> = {
  navigate: 'move.ogg',
  button: 'button.ogg',
  back: 'back.ogg',
  play: 'play.ogg',
  limit: 'limit.ogg',
  'popup-open': 'popup-open.ogg',
  'popup-close': 'popup-close.ogg',
  typing: 'typing.ogg',
};

const SFX_NAMES = Object.keys(SFX_FILES) as readonly SfxName[];

/** What the build found in public/ — the launcher's AudioOptions, arriving over a fetch (settings.ts). */
export interface AudioOptions {
  readonly soundSets: readonly string[];
  /** Without the extension; `ambientUrl` adds it back. */
  readonly ambientTracks: readonly string[];
}

/** The files of one bundled sound set. */
function soundSetUrl(set: string, slot: SfxName): string {
  return `./sfx/${set}/${SFX_FILES[slot]}`;
}

/** The file of one bundled ambience track (the settings keep the bare name). */
export function ambientUrl(track: string | null): string | null {
  return track === null ? null : `./ambience/${track}.ogg`;
}

/** Crossfade / fade-in duration in ms. A whole 0→1 volume ramp takes this long; partial ramps scale down. */
const FADE_MS = 800;
/** Volume within this of the target counts as "arrived" (float ramps never land exactly). */
const FADE_EPSILON = 0.001;
/** Until the stored settings are applied — the launcher's own fallbacks (its audio.ts). */
const DEFAULT_MUSIC_VOLUME = 0.5;
const DEFAULT_SFX_VOLUME = 1;

/**
 * playhook 0.8.0's own out-of-the-box choices (its DEFAULT_SETTINGS) — the showcase should sound like
 * the product does. They live HERE rather than in settings.ts so the controller is audible from the
 * moment it is built, before any stored settings have been applied to it.
 */
export const DEFAULT_SOUND_SET = 'playhook-abyss';
export const DEFAULT_AMBIENT_TRACK = 'playhook-abyss';

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
  /**
   * What is ON SCREEN, musically, in ONE statement — the launcher's `setBrowseMusic`:
   *  • `url` — the entry's own background track; null falls through to the ambience;
   *  • `idle` — there is no entry on screen at all (a site card is selected, or the landing page is up).
   *
   * The two travel together because applying them one at a time passes through a third state in between,
   * which starts a crossfade the next call immediately interrupts — and an interrupted crossfade drops
   * its outgoing element outright, which is heard as a cut rather than a fade.
   */
  setBrowseMusic(url: string | null, idle: boolean): void;
  /** The app-wide ambience (a bundled track), or null for "No ambience". */
  setAmbient(url: string | null): void;
  /** Ambience wins over an entry's own music instead of standing in for it (the Settings toggle). */
  setOnlyGlobalAmbient(only: boolean): void;
  /** Switches the bundled UI sound set — every sound the page plays, on every screen. */
  setSounds(set: string): void;
  /** The background-music/ambience volume (0..1), live. */
  setMusicVolume(volume: number): void;
  /** The UI sound-effects volume (0..1), live. */
  setSfxVolume(volume: number): void;
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

  let sfxVolume = DEFAULT_SFX_VOLUME;
  /** The set whose elements are loaded; a repeated name never rebuilds them. */
  let soundSet: string | null = null;

  const playSfx = (name: SfxName): void => {
    const el = sfx.get(name);
    if (el === undefined) return;
    // Clone so rapid retriggers (fast navigation) overlap instead of cutting each other off.
    const node = el.cloneNode() as HTMLAudioElement;
    node.volume = sfxVolume;
    void node.play().catch(() => undefined);
  };

  /** Builds the <audio> elements of one bundled set, replacing whatever was loaded before. */
  function loadSfx(set: string): void {
    sfx.clear();
    for (const name of SFX_NAMES) {
      const el = new Audio(soundSetUrl(set, name));
      el.volume = sfxVolume;
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

  // The two music sources, and the state that decides between them (see `effective`). `browseIdle` is
  // "there is no entry on screen at all", which the launcher tracks the same way.
  let browseMusic: string | null = null;
  let ambient: string | null = null;
  let browseIdle = false;
  let onlyGlobalAmbient = false;

  let musicVolume = DEFAULT_MUSIC_VOLUME;

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

    if (active !== null && Math.abs(active.el.volume - musicVolume) > FADE_EPSILON) {
      active.el.volume = stepToward(active.el.volume, musicVolume, maxDelta);
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

  /**
   * Which source is actually heard. The launcher's chain, with its card layer removed:
   *  • "only global ambience" is the user's override, and it says exactly what it says — an entry's own
   *    track is not consulted at all, so an ambience of "None" is silence (that is what main answers in
   *    the launcher too);
   *  • standing on a site card, or on the landing page, is `idle`: there IS no entry, so the ambience is
   *    what the page sounds like;
   *  • otherwise the entry's own track, falling back to the ambience when it has none.
   */
  const effective = (): string | null => {
    if (onlyGlobalAmbient) return ambient;
    if (browseIdle) return ambient;
    return browseMusic ?? ambient;
  };

  const applyEffective = (): void => {
    const target = effective();
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

  loadSfx(DEFAULT_SOUND_SET);
  soundSet = DEFAULT_SOUND_SET;

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

    setBrowseMusic(url: string | null, idle: boolean): void {
      browseMusic = url;
      browseIdle = idle;
      applyEffective();
    },

    setAmbient(url: string | null): void {
      ambient = url;
      applyEffective();
    },

    setOnlyGlobalAmbient(only: boolean): void {
      onlyGlobalAmbient = only;
      applyEffective();
    },

    setSounds(set: string): void {
      if (set === soundSet) return;
      soundSet = set;
      loadSfx(set);
    },

    setMusicVolume(volume: number): void {
      musicVolume = volume;
      // Live: the ramp walks the ACTIVE element to the new target, so a slider drag is heard as it moves
      // rather than on the next track change. A paused element keeps its frozen volume until playback
      // resumes, exactly as it does across a crossfade.
      if (wantPlay && active !== null) ensureFade();
    },

    setSfxVolume(volume: number): void {
      sfxVolume = volume;
      for (const el of sfx.values()) el.volume = volume;
    },

    setMusicPlaying(shouldPlay: boolean): void {
      wantPlay = shouldPlay;
      if (shouldPlay) {
        // Always (re-)issue play() on the live elements — this is what resurrects an element the OS
        // muted. Then ramp only if we're not already at the target.
        if (active !== null) void active.el.play().catch(() => undefined);
        if (outgoing !== null) void outgoing.el.play().catch(() => undefined);
        const settled = active === null || Math.abs(active.el.volume - musicVolume) <= FADE_EPSILON;
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
