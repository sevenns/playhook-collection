// The hash parser: the one place untrusted input (the address bar) turns into a route. Anything that is
// not exactly `#/collection/<slug>` with a slug the feed could publish is the carousel — never a game
// route with a slug that could be spliced into a feed URL.
import { describe, expect, it } from 'vitest';
import { parse } from '../src/router.js';

describe('parse', () => {
  it('reads an entry route from a well-formed hash', () => {
    expect(parse('#/collection/tunic')).toEqual({ kind: 'game', slug: 'tunic' });
    expect(parse('#/collection/gta-vice-city-de')).toEqual({
      kind: 'game',
      slug: 'gta-vice-city-de',
    });
  });

  it.each(['', '#', '#/', '#/collection', '#/collection/', '#collection', 'collection'])(
    'treats %j as the carousel',
    (hash) => {
      expect(parse(hash)).toEqual({ kind: 'home' });
    },
  );

  it.each([
    '#/collection/Tunic',
    '#/collection/tunic.json',
    '#/collection/../index',
    '#/collection/tunic/extra',
    '#/collection/tunic?x=1',
    '#/collection/a%20b',
    '#/collection/tun_ic',
    '#/collection/тuniс',
  ])('refuses %j as a slug and falls back to the carousel', (hash) => {
    expect(parse(hash)).toEqual({ kind: 'home' });
  });

  it.each(['#/nonsense', '#/game/tunic', '#/collection/tunic/', '#//collection/tunic'])(
    'treats an unrecognised path %j as the carousel',
    (hash) => {
      expect(parse(hash)).toEqual({ kind: 'home' });
    },
  );
});
