// The site's own cards, sitting at the tail of the collection carousel. Ported from playhook @ c26fae7
// (release/v0.8.0) : src/renderer/system-cards.ts, where there are four of them — Library,
// Notifications, Settings and System. Only the first has anything behind it here: a showcase has nothing
// to notify about, no settings to keep and no machine to power down (see PORTED-FROM.md).
//
// They belong to the PAGE, not to the feed: the collection owns entries, while this is pure UI, and
// pushing it through CollectionEntry would make the catalogue know about buttons. carousel.ts splices
// them in after the entries.
//
// No DOM here on purpose: the list is the contract with the mockup. The icons live in
// system-card-icons.ts. The launcher's captions come from its i18n layer; the site has none, so they are
// plain strings.

/** Which site card this is (also the value carousel.ts reports to main on activation). */
export type SystemCardId = 'library';

export interface SystemCard {
  readonly id: SystemCardId;
  /** The caption shown in #title while the card is selected — the same place an entry's name goes. */
  readonly title: string;
  /** The card node's aria-label. */
  readonly aria: string;
}

/** The cards, in the mockup's order (they always sit after the entries, never between them). */
export const SYSTEM_CARDS: readonly SystemCard[] = [
  { id: 'library', title: 'Library', aria: 'Library' },
] as const;
