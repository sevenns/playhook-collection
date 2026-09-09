// Pure (DOM-free) declaration of the Customize screen: the draft being built plus what the page knows
// about it in, a list of sections and rows out. Ported from playhook @ c26fae7 (release/v0.8.0) :
// src/renderer/game-settings-model.ts.
//
// The screen is the launcher's, WHOLE — the same sections in the same order, the same rows with the same
// labels, hints and placeholders, showing what a launcher form holds before anything is typed into it.
// What differs is which rows can be touched. A web page has no card, no executable to point at, no
// installer to run, no save directory and no Proton prefix, so those rows are INERT: shown to be read,
// at the launcher's own dimmed opacity.
//
// What IS live is everything a catalogue entry is actually made of: the title, the id, the backgrounds,
// the cover and the soundtrack — filled from files on the user's own disk, which become blob URLs and
// live until the page is reloaded.
//
// "Find online" is shown and inert. The launcher's own search runs in its MAIN process, where the
// browser's cross-origin rule does not exist; none of its providers (Steam, GOG, SteamGridDB, Khinsider)
// authorises a page to read their answers, so a static site cannot ask them at all. See PORTED-FROM.md.
import type {
  CoreListRow,
  CoreNoteRow,
  CoreNumberRow,
  CoreOption,
  CorePathRow,
  CoreSelectRow,
  CoreTextRow,
  CoreToggleRow,
} from './row-view-core.js';

/**
 * Every row of this screen, named by the manifest path it stands for — the launcher's own ids, so the
 * two forms can be diffed row by row.
 */
export type GameRowId =
  | 'source'
  | 'title'
  | 'id'
  | 'launchMode'
  | 'executable'
  | 'args'
  | 'runAsAdmin'
  | 'copyToPc'
  | 'watchProcesses'
  | 'heroImage'
  | 'gridImage'
  | 'pcSavePath'
  | 'saveOnCard'
  | 'backgroundMusic'
  | 'launchTimeoutSec'
  | 'killTimeoutSec'
  | 'winetricks'
  | 'umuGameId'
  | 'note.showcase'
  | 'note.cannotSave';

export type GameSettingsRow =
  | CoreTextRow<GameRowId>
  | CoreNumberRow<GameRowId>
  | CorePathRow<GameRowId>
  | CoreListRow<GameRowId>
  | CoreSelectRow<GameRowId>
  | CoreToggleRow<GameRowId>
  | CoreNoteRow<GameRowId>;

export type GameSectionId =
  'basics' | 'launch' | 'images' | 'saves' | 'audio' | 'advanced' | 'linux';

export interface GameSettingsSection {
  readonly id: GameSectionId;
  readonly title: string;
  readonly rows: readonly GameSettingsRow[];
}

export interface GameSettingsModel {
  readonly sections: readonly GameSettingsSection[];
}

/** One artwork the user picked: the blob URL that shows it, and the file name that names it. */
export interface PickedFile {
  readonly url: string;
  readonly name: string;
}

/** The draft the screen is building — the live half of the launcher's ManifestFormModel. */
export interface GameForm {
  readonly title: string;
  readonly id: string;
  readonly heroes: readonly PickedFile[];
  readonly cover: PickedFile | null;
  readonly music: PickedFile | null;
}

/** What the model needs beyond the draft: the problems the page found in it. */
export interface GameSettingsEnv {
  /** Per-row validation messages, keyed by the row they belong to. */
  readonly issues: Readonly<Partial<Record<GameRowId, string>>>;
  /** Whether anything has been typed or picked yet — the launcher's `dirty`. */
  readonly dirty: boolean;
  /** Whether Save may run at all. */
  readonly canSave: boolean;
}

/** playhook's own cap on hero backgrounds (MAX_HERO_IMAGES in its shared/types.ts). */
export const MAX_HERO_IMAGES = 3;

/**
 * The launcher's defaults for the fields this page has no say over — what its form holds before anything
 * is filled in (`emptyFormModel` in configure-form-model.ts, whose default launch mode is `executable`).
 * They are frozen VALUES, not state: nothing writes them, and the rows that show them are inert.
 */
const LAUNCH_MODE = 'executable';

const LAUNCH_MODE_OPTIONS: readonly CoreOption[] = [
  { value: 'executable', label: 'Run from the card' },
  { value: 'installer', label: 'Install from the card' },
  { value: 'steam', label: 'Steam' },
  { value: 'pc', label: 'Executable file' },
  { value: 'none', label: 'Not set up yet' },
];

/** Where a new game goes. The launcher offers the drives it can see; a page has nowhere to put a file. */
const SOURCE_OPTIONS: readonly CoreOption[] = [{ value: 'pc', label: 'This PC' }];

const SECTION_TITLE: Readonly<Record<GameSectionId, string>> = {
  basics: 'Basics',
  launch: 'Launch',
  images: 'Artwork',
  saves: 'Saves',
  audio: 'Audio',
  advanced: 'Advanced',
  linux: 'Linux',
};

/** Whether a row can be edited on the site at all — every other row is shown and inert. */
export function isLiveRow(id: GameRowId): boolean {
  return (
    id === 'title' ||
    id === 'id' ||
    id === 'heroImage' ||
    id === 'gridImage' ||
    id === 'backgroundMusic'
  );
}

/**
 * The whole screen as data, in the launcher's section order: Basics, Launch, Artwork, Saves, Audio,
 * Advanced, Linux. The action stack (Find online / Add / Close) is the sidebar's, as it is there.
 */
export function buildGameSettingsModel(form: GameForm, env: GameSettingsEnv): GameSettingsModel {
  const error = (id: GameRowId): { readonly error?: string } => {
    const message = env.issues[id];
    return message === undefined ? {} : { error: message };
  };
  const off = { inert: true } as const;

  const basics: readonly GameSettingsRow[] = [
    {
      kind: 'note',
      id: 'note.showcase',
      tone: 'info',
      text: "Playhook's own Add game form, shown whole. The name, the id and the artwork are live — they are what a catalogue entry is made of. The rest describes a game on a card, and is here to be read.",
    },
    {
      kind: 'select',
      id: 'source',
      label: 'Add to',
      hint: 'A card carries the game with it; a game added to this PC stays on this machine.',
      value: 'pc',
      options: SOURCE_OPTIONS,
      ...off,
    },
    {
      kind: 'text',
      id: 'title',
      label: 'Title',
      value: form.title,
      placeholder: 'not set',
      ...error('title'),
    },
    {
      kind: 'text',
      id: 'id',
      label: 'Id',
      value: form.id,
      placeholder: 'not set',
      ...error('id'),
    },
  ];

  const launch: readonly GameSettingsRow[] = [
    {
      kind: 'select',
      id: 'launchMode',
      label: 'Launch type',
      value: LAUNCH_MODE,
      options: LAUNCH_MODE_OPTIONS,
      ...off,
    },
    {
      kind: 'path',
      id: 'executable',
      label: 'Executable',
      hint: 'Relative to the card root.',
      value: '',
      placeholder: 'not set',
      ...off,
    },
    {
      kind: 'list',
      id: 'args',
      label: 'Launch arguments',
      items: [],
      max: 0,
      placeholder: 'empty',
      ...off,
    },
    { kind: 'toggle', id: 'runAsAdmin', label: 'Run as administrator', value: false, ...off },
    {
      kind: 'toggle',
      id: 'copyToPc',
      label: 'Move game to PC',
      hint: 'The game is copied to this PC and runs from there; the card keeps its copy.',
      value: false,
      ...off,
    },
    {
      kind: 'list',
      id: 'watchProcesses',
      label: 'Watched processes',
      hint: 'What shows the game is still running, when it starts through a launcher of its own.',
      items: [],
      max: 0,
      placeholder: 'empty',
      ...off,
    },
  ];

  const images: readonly GameSettingsRow[] = [
    {
      kind: 'list',
      id: 'heroImage',
      label: 'Backgrounds',
      items: form.heroes.map((hero) => hero.name),
      max: MAX_HERO_IMAGES,
      placeholder: 'empty',
      preview: 'wide',
      thumbs: form.heroes.map((hero) => hero.url),
      ...error('heroImage'),
    },
    {
      kind: 'path',
      id: 'gridImage',
      label: 'Card artwork',
      value: form.cover?.name ?? '',
      placeholder: 'cropped from the first background',
      preview: 'portrait',
      thumbs: form.cover === null ? [] : [form.cover.url],
      ...error('gridImage'),
    },
  ];

  const saves: readonly GameSettingsRow[] = [
    {
      kind: 'path',
      id: 'pcSavePath',
      label: 'Save folder on the PC',
      value: '',
      placeholder: 'not set',
      ...off,
    },
    {
      kind: 'path',
      id: 'saveOnCard',
      label: 'Save folder on the card',
      hint: 'Saves are copied here once you finish playing.',
      value: '',
      placeholder: 'not set',
      ...off,
    },
  ];

  const audio: readonly GameSettingsRow[] = [
    {
      kind: 'path',
      id: 'backgroundMusic',
      label: 'Background music',
      value: form.music?.name ?? '',
      placeholder: 'no music',
      ...error('backgroundMusic'),
    },
  ];

  const advanced: readonly GameSettingsRow[] = [
    {
      kind: 'number',
      id: 'launchTimeoutSec',
      label: 'Launch timeout',
      hint: 'How long to wait for the game to appear after it is started before giving up on it.',
      value: '',
      placeholder: '30 s (default)',
      ...off,
    },
    {
      kind: 'number',
      id: 'killTimeoutSec',
      label: 'Force-close timeout',
      hint: 'How long a force-close waits for the game to actually die before reporting it did not.',
      value: '',
      placeholder: '60 s (default)',
      ...off,
    },
  ];

  const linux: readonly GameSettingsRow[] = [
    {
      kind: 'list',
      id: 'winetricks',
      label: 'Winetricks',
      hint: 'Extra verbs provisioned into the prefix before the game runs (Linux).',
      items: [],
      max: 0,
      placeholder: 'empty',
      ...off,
    },
    {
      kind: 'text',
      id: 'umuGameId',
      label: 'umu GAMEID',
      hint: 'Applies that game’s protonfix instead of the generic one (Linux).',
      value: '',
      placeholder: 'automatic',
      ...off,
    },
  ];

  return {
    sections: [
      { id: 'basics', title: SECTION_TITLE.basics, rows: withCannotSave(basics, env) },
      { id: 'launch', title: SECTION_TITLE.launch, rows: launch },
      { id: 'images', title: SECTION_TITLE.images, rows: images },
      { id: 'saves', title: SECTION_TITLE.saves, rows: saves },
      { id: 'audio', title: SECTION_TITLE.audio, rows: audio },
      { id: 'advanced', title: SECTION_TITLE.advanced, rows: advanced },
      { id: 'linux', title: SECTION_TITLE.linux, rows: linux },
    ],
  };
}

/**
 * Why Add is inert, said next to the fields it is about. The launcher puts this note above its Save
 * button; here Save lives in the sidebar, where a note cannot go, so it sits at the foot of the section
 * that holds every field it can be about.
 */
function withCannotSave(
  rows: readonly GameSettingsRow[],
  env: GameSettingsEnv,
): readonly GameSettingsRow[] {
  if (env.canSave || !env.dirty) return rows;
  return [
    ...rows,
    {
      kind: 'note',
      id: 'note.cannotSave',
      tone: 'error',
      text: 'Fix the problems marked above to save. Every field with one is outlined on the left.',
    },
  ];
}
