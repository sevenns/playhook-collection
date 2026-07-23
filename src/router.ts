// Hash routing. One HTML document, two screens: the landing page and the (still empty) Collection.
// A hash — not a path — because GitHub Pages serves static files with no rewrite rules, so /collection
// would 404 on a reload; and because staying on one document keeps the hero cross-fade and the popup
// alive across a route change instead of reloading and recomputing the palette.

import { req } from './dom.js';

export type Route = 'home' | 'collection';

/** The bar copy for a route: the title line and the status line under it. */
interface RouteCopy {
  readonly title: string;
  readonly status: string;
  /** Label of the menu's top button — it always points at the OTHER route. */
  readonly otherLabel: string;
  readonly other: Route;
}

const COPY: Readonly<Record<Route, RouteCopy>> = {
  home: {
    title: 'Playhook',
    status: 'Bring console vibes to your PC',
    otherLabel: 'Collection',
    other: 'collection',
  },
  collection: {
    title: 'Collection',
    status: 'Coming soon',
    otherLabel: 'Home',
    other: 'home',
  },
};

export interface Router {
  current(): Route;
  /** The route the menu's top button leads to, with its label. */
  other(): { readonly route: Route; readonly label: string };
  /** Navigates by writing the hash; the hashchange listener does the rendering (one code path). */
  go(route: Route): void;
  /** Renders the current route and starts listening for hash changes. */
  start(onChange: (route: Route) => void): void;
}

function parse(hash: string): Route {
  return hash.replace(/^#\/?/, '') === 'collection' ? 'collection' : 'home';
}

export function createRouter(): Router {
  const titleEl = req('title');
  const statusEl = req('status');
  const app = req('app');

  let route: Route = parse(window.location.hash);

  function render(): void {
    const copy = COPY[route];
    app.dataset['route'] = route;
    titleEl.textContent = copy.title;
    statusEl.textContent = copy.status;
    document.title =
      route === 'home' ? 'Playhook — bring console vibes to your PC' : 'Playhook — Collection';
  }

  return {
    current: (): Route => route,
    other: () => {
      const copy = COPY[route];
      return { route: copy.other, label: copy.otherLabel };
    },
    go(next: Route): void {
      // Writing the hash pushes a history entry, so the browser's Back button works — but the menu
      // offers its own way back from either route, so nobody has to reach for it.
      window.location.hash = next === 'home' ? '#/' : '#/collection';
    },
    start(onChange: (next: Route) => void): void {
      window.addEventListener('hashchange', () => {
        const next = parse(window.location.hash);
        if (next === route) return;
        route = next;
        render();
        onChange(route);
      });
      render();
      onChange(route);
    },
  };
}
