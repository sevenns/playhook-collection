// Hash routing. One HTML document, two screens: the landing page and a collection entry's preview.
// A hash — not a path — because GitHub Pages serves static files with no rewrite rules, so /collection
// would 404 on a reload; and because staying on one document keeps the hero cross-fade and the popup
// alive across a route change instead of reloading and recomputing the palette.
//
// Collection is NOT a screen. The mockups show it as a popup VIEW that opens over whatever is behind it
// (the home screen or a game), so `#/collection` is a deep link meaning "home with the game list open",
// not a third route. Its hash is written with replaceState, never location.hash: the list opens and
// closes with every menu visit, and a history entry per visit would turn the browser's Back button into
// a menu toggle.

import { req } from './dom.js';
import { isValidSlug } from './collection.js';

export type Route = { readonly kind: 'home' } | { readonly kind: 'game'; readonly slug: string };

const HOME_TITLE = 'Playhook';
const HOME_STATUS = 'Bring console vibes to your PC';
const HOME_DOCUMENT_TITLE = 'Playhook - bring console vibes to your PC';
/** The bar's bold line on a game screen — the product, with the game name as the status below it. */
const GAME_TITLE = 'Playhook - Collection';

export interface Router {
  current(): Route;
  /** Navigates by writing the hash; the hashchange listener does the rendering (one code path). */
  go(route: Route): void;
  /**
   * The game screen's second line: the entry's title once the feed resolves the slug, a load state
   * until then. `documentTitle` is what goes after "Playhook - Collection -" in the tab, or null to
   * leave the tab at the bare screen name (loading / an error is not a page title).
   */
  setGameCopy(status: string, documentTitle: string | null): void;
  /** Keeps the address bar honest while the game list is open on the home screen (replaceState only). */
  setCollectionVisible(visible: boolean): void;
  /** Sends the user to the catalogue with the list open. Where an unknown slug lands — and it REPLACES
   *  the current entry, because a dead link has no business sitting in the back stack. */
  showCollection(): void;
  /** Leaves the game screen for home. Prefers the browser's own history when this session has already
   *  navigated inside the site, so B / Esc and the Back button end up in the same place; a cold deep
   *  link has nothing to go back to, so it writes the hash instead. */
  goHome(): void;
  /** Renders the current route and starts listening for hash changes. */
  start(onChange: (route: Route, wantsCollection: boolean) => void): void;
}

/** What the hash means: the route, plus whether the game list should be open over it. */
interface Parsed {
  readonly route: Route;
  readonly wantsCollection: boolean;
}

function parse(hash: string): Parsed {
  const path = hash.replace(/^#\/?/, '');
  if (path === 'collection') return { route: { kind: 'home' }, wantsCollection: true };
  const match = /^collection\/([^/?#]+)$/.exec(path);
  const slug = match?.[1];
  // A slug arrives from the URL, i.e. from untrusted input: reject anything that isn't a slug BEFORE it
  // can become part of a feed URL. Anything unrecognised is home, as is `#/` itself.
  if (slug !== undefined && isValidSlug(slug)) {
    return { route: { kind: 'game', slug }, wantsCollection: false };
  }
  return { route: { kind: 'home' }, wantsCollection: false };
}

/** Structural comparison — the union's members are fresh objects on every parse, so `===` is always false. */
function sameRoute(a: Route, b: Route): boolean {
  if (a.kind === 'home' && b.kind === 'home') return true;
  if (a.kind === 'game' && b.kind === 'game') return a.slug === b.slug;
  return false;
}

const hashOf = (route: Route): string =>
  route.kind === 'home' ? '#/' : `#/collection/${route.slug}`;

export function createRouter(): Router {
  const titleEl = req('title');
  const statusEl = req('status');
  const app = req('app');

  const initial = parse(window.location.hash);
  let route: Route = initial.route;
  let wantsCollection = initial.wantsCollection;
  // The game screen's status line, owned by whoever resolves the slug against the feed.
  let gameStatus = '';
  let gameDocumentTitle: string | null = null;
  // Whether this session has pushed a history entry of its own. Without one, history.back() would leave
  // the site entirely — which is not what "step out of this game" means.
  let navigated = false;

  function render(): void {
    app.dataset['route'] = route.kind;
    if (route.kind === 'home') {
      titleEl.textContent = HOME_TITLE;
      statusEl.textContent = HOME_STATUS;
      document.title = HOME_DOCUMENT_TITLE;
      return;
    }
    titleEl.textContent = GAME_TITLE;
    statusEl.textContent = gameStatus;
    document.title =
      gameDocumentTitle === null ? GAME_TITLE : `${GAME_TITLE} - ${gameDocumentTitle}`;
  }

  return {
    current: (): Route => route,

    go(next: Route): void {
      navigated = true;
      // Writing the hash pushes a history entry, so the browser's Back button works.
      window.location.hash = hashOf(next);
    },

    setGameCopy(status: string, documentTitle: string | null): void {
      gameStatus = status;
      gameDocumentTitle = documentTitle;
      if (route.kind === 'game') render();
    },

    setCollectionVisible(visible: boolean): void {
      // Only home has a hash to swap: on a game screen the list opens over `#/collection/<slug>`, which
      // already names where you are.
      if (route.kind !== 'home') return;
      if (visible === wantsCollection) return;
      wantsCollection = visible;
      history.replaceState(null, '', visible ? '#/collection' : '#/');
    },

    showCollection(): void {
      window.location.replace('#/collection');
    },

    goHome(): void {
      if (route.kind === 'home') return;
      if (navigated) {
        history.back();
        return;
      }
      window.location.hash = '#/';
    },

    start(onChange: (next: Route, collection: boolean) => void): void {
      window.addEventListener('hashchange', () => {
        const next = parse(window.location.hash);
        if (sameRoute(next.route, route) && next.wantsCollection === wantsCollection) return;
        route = next.route;
        wantsCollection = next.wantsCollection;
        gameStatus = '';
        gameDocumentTitle = null;
        render();
        onChange(route, wantsCollection);
      });
      render();
      onChange(route, wantsCollection);
    },
  };
}
