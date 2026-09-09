// The site's own cards, sitting at the tail of the collection carousel. Ported from playhook @ c26fae7
// (release/v0.8.0) : src/renderer/system-cards.ts, where there are four of them — Library,
// Notifications, Settings and System. Three of them are here; only Notifications stays behind, because a
// showcase has nothing to notify about and no inbox to show empty (see PORTED-FROM.md).
//
// They belong to the PAGE, not to the feed: the collection owns entries, while this is pure UI, and
// pushing it through CollectionEntry would make the catalogue know about buttons. carousel.ts splices
// them in after the entries.
//
// No DOM here on purpose: the list is the contract with the mockup. The icons live in
// system-card-icons.ts. The launcher's captions come from its i18n layer; the site has none, so they are
// plain strings.

/** Which site card this is (also the value carousel.ts reports to main on activation). */
export type SystemCardId = 'library' | 'settings' | 'power';

export interface SystemCard {
  readonly id: SystemCardId;
  /**
   * The caption shown in #title while the card is selected — the same place an entry's name goes. Null
   * for the System card: the launcher's mockup shows no caption for that one at all, and the site keeps
   * that (its `titleKey` is null there too).
   */
  readonly title: string | null;
  /** The card node's aria-label — the only name the System card has, since it shows no caption. */
  readonly aria: string;
}

/** The cards, in the mockup's order (they always sit after the entries, never between them). */
export const SYSTEM_CARDS: readonly SystemCard[] = [
  { id: 'library', title: 'Library', aria: 'Library' },
  { id: 'settings', title: 'Settings', aria: 'Settings' },
  { id: 'power', title: null, aria: 'System' },
] as const;
