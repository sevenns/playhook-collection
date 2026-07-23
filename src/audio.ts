// UI sound effects. Written fresh rather than ported: playhook's audio.ts is ~230 lines, of which ~200
// are the music/ambience crossfade engine (two <audio> elements, volume ramps, an OS-pause guard) that
// this site has no use for — there is no background music here on purpose. What is kept is its SFX half:
// one preloaded element per slot, cloned on each play so rapid navigation overlaps instead of cutting.
//
// Slot → file is NOT 1:1, and the mismatch is silent if you get it wrong (an unknown slot just never
// plays): `navigate` is served by move.ogg. That quirk comes from playhook's asset-reader.ts, where the
// sound-set folders predate the slot vocabulary. The `play` slot has no source on the site at all — both
// of its triggers (the Play button and a main-process push) belong to the launcher.
//
// The set is `winhanced`, playhook's own default (app-settings.ts) — the showcase should sound like the
// product does out of the box. The launcher's other sets (dark-souls, hl2, ps5, psp, steam-vr, switch,
// tactile) are a folder swap away if that ever changes.

/** The UI sound slots this site actually triggers (playhook additionally has 'play'). */
export type SfxName = 'navigate' | 'button' | 'back';

const SFX_FILES: Readonly<Record<SfxName, string>> = {
  navigate: './sfx/move.ogg',
  button: './sfx/button.ogg',
  back: './sfx/back.ogg',
};

export interface AudioController {
  /** Plays a one-shot UI sound. Best-effort: a browser that blocks audio before the first user gesture
   *  simply drops it. */
  play(name: SfxName): void;
}

export function createAudioController(): AudioController {
  const sfx = new Map<SfxName, HTMLAudioElement>();
  for (const name of Object.keys(SFX_FILES) as SfxName[]) {
    const el = new Audio(SFX_FILES[name]);
    el.preload = 'auto';
    sfx.set(name, el);
  }

  return {
    play(name: SfxName): void {
      const el = sfx.get(name);
      if (el === undefined) return;
      // Clone so rapid retriggers (fast navigation) overlap instead of cutting each other off.
      const node = el.cloneNode() as HTMLAudioElement;
      void node.play().catch(() => undefined);
    },
  };
}
