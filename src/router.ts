// Hash routing. One HTML document, two screens: the landing page and a collection entry's preview.
// A hash — not a path — because GitHub Pages serves static files with no rewrite rules, so /collection
// would 404 on a reload; and because staying on one document keeps the hero cross-fade and the popup
// alive across a route change instead of reloading and recomputing the palette.
//
// Collection is NOT a route. It is a LAYER over the landing page — the carousel of covers, which in the
// launcher is a screen level rather than a place — so `#/collection` is a deep link meaning "home with
// the carousel up", not a third member of the union. Its hash is written with replaceState wherever it
// is toggled in place (opening and closing it repeatedly would otherwise turn the browser's Back button
// into a menu toggle); only the step BACK to it from an entry, where the two really are different
// places, pushes a history entry of its own.

import { req } from './dom.js';
import { isValidSlug } from './collection.js';

export type Route = { readonly kind: 'home' } | { readonly kind: 'game'; readonly slug: string };

const HOME_TITLE = 'Playhook';
const HOME_STATUS = 'Bring console vibes to your PC';
const HOME_DOCUMENT_TITLE = 'Playhook - bring console vibes to your PC';
/** What goes in the tab before the entry's name. There is no on-screen counterpart: an entry's own name
 *  is the whole bar copy, and a caption repeated under every one of them said nothing. */
const ENTRY_DOCUMENT_TITLE = 'Playhook - Collection';

export interface Router {
  current(): Route;
  /** Navigates by writing the hash; the hashchange listener does the rendering (one code path). */
  go(route: Route): void;
  /**
   * The entry screen's bold line: the entry's name once the feed resolves the slug, a load state until
   * then. `documentTitle` is what goes after "Playhook - Collection -" in the tab, or null to leave the
   * tab at the bare screen name (loading / an error is not a page title).
   */
  setGameCopy(name: string, documentTitle: string | null): void;
  /**
   * The second line while a session is in flight ("Running...", "Saving progress..."). It belongs to the
   * ENTRY, not to a screen, so it shows wherever that entry is on screen — its own screen or its card in
   * the carousel — and is empty everywhere else. Empty is also the resting state: an entry that is not
   * doing anything has nothing to report.
   */
  setSessionStatus(status: string): void;
  /**
   * The landing page's two lines while the carousel is browsing: the selected entry's name in place of
   * "Playhook", with the same caption under it that its own screen carries. `null` restores the landing
   * page's own copy — which is what closing the carousel does.
   */
  setBrowseCopy(name: string | null): void;
  /** Opens or closes the carousel over the landing page (replaceState — it is a toggle, not a place). */
  setCollectionVisible(visible: boolean): void;
  /** Sends the user to the catalogue with the carousel up. Where an unknown slug lands — and it REPLACES
   *  the current entry, because a dead link has no business sitting in the back stack. */
  showCollection(): void;
  /** Back to the carousel FROM an entry (the Go back menu item). A pushed hash, not a replaced one: the
   *  entry you are leaving is a real place, and the browser's Back button should return to it. */
  goCollection(): void;
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
  // The entry screen's name line, owned by whoever resolves the slug against the feed.
  let gameName = '';
  let gameDocumentTitle: string | null = null;
  // The session line for whichever entry is on screen; '' when none is doing anything.
  let sessionStatus = '';
  // The name the carousel is browsing over the landing page; null = the landing page's own copy.
  let browseName: string | null = null;
  // Set once start() has run, so the toggles below can re-render through the same path a hashchange takes.
  let notify: ((route: Route, collection: boolean) => void) | null = null;
  // Whether this session has pushed a history entry of its own. Without one, history.back() would leave
  // the site entirely — which is not what "step out of this game" means.
  let navigated = false;

  /**
   * Tells the CSS whether there IS a second line, the way the launcher's app.ts does. Without it the name
   * would stay lifted over an empty slot on every screen that has no status — sitting off-centre for no
   * reason the reader can see. Set from the text that was just written, so the two can never disagree.
   */
  function applyStatusFlag(): void {
    if (statusEl.textContent === '') delete app.dataset['status'];
    else app.dataset['status'] = 'shown';
  }

  function render(): void {
    app.dataset['route'] = route.kind;
    if (route.kind === 'home') {
      titleEl.textContent = browseName ?? HOME_TITLE;
      // The bare landing page has its tagline; browsing a card in the carousel, the card's name is all
      // there is to say — unless that card's game is doing something, which is the one thing worth
      // saying over it.
      statusEl.textContent = browseName === null ? HOME_STATUS : sessionStatus;
      applyStatusFlag();
      document.title = HOME_DOCUMENT_TITLE;
      return;
    }
    titleEl.textContent = gameName;
    statusEl.textContent = sessionStatus;
    applyStatusFlag();
    document.title =
      gameDocumentTitle === null
        ? ENTRY_DOCUMENT_TITLE
        : `${ENTRY_DOCUMENT_TITLE} - ${gameDocumentTitle}`;
  }

  return {
    current: (): Route => route,

    go(next: Route): void {
      navigated = true;
      // Writing the hash pushes a history entry, so the browser's Back button works.
      window.location.hash = hashOf(next);
    },

    setGameCopy(name: string, documentTitle: string | null): void {
      gameName = name;
      gameDocumentTitle = documentTitle;
      if (route.kind === 'game') render();
    },

    setSessionStatus(status: string): void {
      if (status === sessionStatus) return;
      sessionStatus = status;
      render();
    },

    setBrowseCopy(name: string | null): void {
      browseName = name;
      if (route.kind === 'home') render();
    },

    setCollectionVisible(visible: boolean): void {
      // Only home carries this bit: an entry screen is a place of its own, and `#/collection/<slug>`
      // already names it.
      if (route.kind !== 'home') return;
      if (visible === wantsCollection) return;
      wantsCollection = visible;
      history.replaceState(null, '', visible ? '#/collection' : '#/');
      // replaceState fires no hashchange, so the listener that normally repaints never runs — tell the
      // app ourselves, or the carousel would stay up with the address bar saying otherwise.
      notify?.(route, wantsCollection);
    },

    showCollection(): void {
      window.location.replace('#/collection');
    },

    goCollection(): void {
      navigated = true;
      window.location.hash = '#/collection';
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
      notify = onChange;
      window.addEventListener('hashchange', () => {
        const next = parse(window.location.hash);
        if (sameRoute(next.route, route) && next.wantsCollection === wantsCollection) return;
        route = next.route;
        wantsCollection = next.wantsCollection;
        gameName = '';
        gameDocumentTitle = null;
        browseName = null;
        // NOT sessionStatus: a session belongs to an entry, not to the screen you happen to be on, and
        // main re-applies it for whatever the new screen is browsing (see applySession there).
        render();
        onChange(route, wantsCollection);
      });
      render();
      onChange(route, wantsCollection);
    },
  };
}
