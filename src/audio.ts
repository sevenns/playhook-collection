// UI sound effects + the looping background music of whichever collection entry is on screen.
//
// The SFX half was written fresh for this site; the music half is a port of playhook's audio.ts, minus
// its source layer. The launcher juggles TWO music sources — the card's own track and an app-wide
// ambience, with "the game's music wins" resolved through applyEffective() — and none of that has a
// counterpart here: the site has exactly one source, the entry's `backgroundMusic`. What IS ported 1:1
// is the crossfade engine: at most two live <audio> elements, a volume ramp on requestAnimationFrame,
// and the pause guard. That is not fidelity for its own sake — switching straight from one game to
// another out of the open menu is a normal move (mockup 5), and a hard cut there is audible.
//
// Slot → file is NOT 1:1, and the mismatch is silent if you get it wrong (an unknown slot just never
// plays): `navigate` is served by move.ogg. That quirk comes from playhook's asset-reader.ts, where the
// sound-set folders predate the slot vocabulary.
//
// The default set is `winhanced`, playhook's own out-of-the-box choice (app-settings.ts) — the showcase
// should sound like the product does. An entry may override any slot from its own assets/.

/** The UI sound slots. `play` exists here too now: the bar has a Play button (see controls.ts). */
export type SfxName = 'navigate' | 'button' | 'back' | 'play';

const SFX_FILES: Readonly<Record<SfxName, string>> = {
  navigate: './sfx/move.ogg',
  button: './sfx/button.ogg',
  back: './sfx/back.ogg',
  play: './sfx/play.ogg',
};

const SFX_NAMES = Object.keys(SFX_FILES) as readonly SfxName[];

/** Crossfade / fade-in duration in ms. A whole 0→1 volume ramp takes this long; partial ramps scale down. */
const FADE_MS = 800;
/** Volume within this of the target counts as "arrived" (float ramps never land exactly). */
const FADE_EPSILON = 0.001;
const MUSIC_VOLUME = 0.5;

/** An entry's audio: per-slot sound overrides and its background track. */
export interface GameAudio {
  readonly sounds: Partial<Record<SfxName, string>>;
  readonly music: string | null;
}

export interface AudioController {
  /** Plays a one-shot UI sound. Best-effort: a browser that blocks audio before the first user gesture
   *  simply drops it. */
  play(name: SfxName): void;
  /** Switches to an entry's sounds and music; null returns to the site's default set and fades out. */
  setGameAssets(assets: GameAudio | null): void;
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
  let gameSounds: Partial<Record<SfxName, string>> = {};

  // Per-slot override with a fallback to the site's set. Written as an explicit lookup rather than an
  // index chain because `noUncheckedIndexedAccess` types the Partial's index as `string | undefined` —
  // SFX_FILES is a full Record, so it is not affected.
  const resolveSfx = (slot: SfxName): string => gameSounds[slot] ?? SFX_FILES[slot];

  function rebuildSfx(): void {
    sfx.clear();
    for (const name of SFX_NAMES) {
      const el = new Audio(resolveSfx(name));
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

  rebuildSfx();

  return {
    play(name: SfxName): void {
      const el = sfx.get(name);
      if (el === undefined) return;
      // Clone so rapid retriggers (fast navigation) overlap instead of cutting each other off.
      const node = el.cloneNode() as HTMLAudioElement;
      void node.play().catch(() => undefined);
    },

    setGameAssets(assets: GameAudio | null): void {
      gameSounds = assets?.sounds ?? {};
      rebuildSfx();
      setMusic(assets?.music ?? null);
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
