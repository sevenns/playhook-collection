// The row vocabulary shared by the site's two list screens (Settings and Customize): the row types and
// the DOM builders/patchers for the kinds both draw. Ported from playhook @ c26fae7 (release/v0.8.0) :
// src/renderer/row-view-core.ts, with its i18n layer resolved away — a label here is a plain string,
// because the site has no translator to hand one to.
//
// Everything is generic over the row `id`, so each screen keeps its own literal-union ids (and the
// exhaustive switches that come with them) while the DOM lives in one place.
//
// One rename against the launcher: its `disabled` is `inert` here. There it means "this screen has no
// business changing this field"; here it means "this is the launcher's, and a web page has nothing to
// change it with" — the same treatment, a different reason, and the site says which.
//
// Inline SVG built with createElementNS, never innerHTML: the CSP forbids external resources, and
// building the nodes is the project's rule for markup that isn't in index.html.

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One dropdown option: a bundled file's proper name, or a phrase of the launcher's own. */
export interface CoreOption {
  readonly value: string;
  readonly label: string;
}

/** The shape a row's thumbnails are drawn in — the ARTWORK's own shape, not a uniform tile. */
export type PreviewAspect = 'wide' | 'portrait';

/**
 * What every labelled row carries.
 *
 * `error` is the field's own validation problem, shown inside the row rather than in a list at the
 * bottom: a form of thirty fields makes "id: already taken" useless when you cannot see which row it
 * means. `inert` is the launcher's `disabled` — see the module note.
 */
interface LabeledRow<Id extends string> {
  readonly id: Id;
  readonly label: string;
  readonly hint?: string;
  readonly error?: string;
  readonly inert?: boolean;
}

export interface CoreToggleRow<Id extends string = string> extends LabeledRow<Id> {
  readonly kind: 'toggle';
  readonly value: boolean;
}

export interface CoreSelectRow<Id extends string = string> extends LabeledRow<Id> {
  readonly kind: 'select';
  readonly value: string;
  readonly options: readonly CoreOption[];
}

export interface CoreSliderRow<Id extends string = string> extends LabeledRow<Id> {
  readonly kind: 'slider';
  /** 0..100, rounded — the display unit; the controller divides by 100 before it stores. */
  readonly percent: number;
}

/** A free-text field. The value is edited through the on-screen keyboard, never typed into the row. */
export interface CoreTextRow<Id extends string = string> extends LabeledRow<Id> {
  readonly kind: 'text';
  readonly value: string;
  /** Shown greyed in place of an empty value ("not set", "automatic"). */
  readonly placeholder?: string;
}

/** A number field: ‹ value › steps it. Kept as TEXT, like the launcher's form: '' means "omitted". */
export interface CoreNumberRow<Id extends string = string> extends LabeledRow<Id> {
  readonly kind: 'number';
  readonly value: string;
  readonly placeholder?: string;
}

/** A path field: one file. On the site that file comes from the browser's own picker. */
export interface CorePathRow<Id extends string = string> extends LabeledRow<Id> {
  readonly kind: 'path';
  readonly value: string;
  readonly placeholder?: string;
  /** Draw the value as a thumbnail as well, in the artwork's own proportions. */
  readonly preview?: PreviewAspect;
  /** The thumbnails to draw, when `preview` is set (blob URLs the page minted). */
  readonly thumbs?: readonly string[];
}

/** A list field (arguments, watched processes, backgrounds): several values in one row. */
export interface CoreListRow<Id extends string = string> extends LabeledRow<Id> {
  readonly kind: 'list';
  readonly items: readonly string[];
  /** 0 = unlimited. `heroImage` caps at MAX_HERO_IMAGES. */
  readonly max: number;
  readonly placeholder?: string;
  readonly preview?: PreviewAspect;
  readonly thumbs?: readonly string[];
}

/** A free-standing message inside the list. Not focusable — navigation steps over it. */
export interface CoreNoteRow<Id extends string = string> {
  readonly kind: 'note';
  readonly id: Id;
  readonly text: string;
  readonly tone: 'info' | 'warning' | 'error';
}

export type CoreRow<Id extends string = string> =
  | CoreToggleRow<Id>
  | CoreSelectRow<Id>
  | CoreSliderRow<Id>
  | CoreTextRow<Id>
  | CoreNumberRow<Id>
  | CorePathRow<Id>
  | CoreListRow<Id>
  | CoreNoteRow<Id>;

/** The nodes a controller updates after a row has been built. */
export interface CoreRendered {
  readonly el: HTMLElement;
  /** The value node whose content changes: the dropdown's text, the slider's percent, a path. */
  readonly valueEl: HTMLElement;
  /** The slider's filled track. */
  readonly fillEl: HTMLElement | null;
  /** The thumbnail strip of an artwork row. */
  readonly previewEl: HTMLElement | null;
}

/** Whether a row can hold the focus. A note is text on the screen, not a control. */
export function isFocusable(row: CoreRow): boolean {
  return row.kind !== 'note';
}

/** Whether a row is here to be READ rather than changed (see the module note on `inert`). */
export function isInert(row: CoreRow): boolean {
  return row.kind !== 'note' && row.inert === true;
}

export function div(className: string, text?: string): HTMLElement {
  const el = document.createElement('div');
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** The inline check glyph of a toggle. */
function checkIcon(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'setting-check');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M4 12.5 L9.5 18 L20 6.5');
  svg.append(path);
  return svg;
}

/** A left/right chevron of a dropdown or number row (clickable with the mouse). */
export function chevron(direction: 'prev' | 'next'): HTMLElement {
  const button = document.createElement('span');
  button.className = `setting-chevron is-${direction}`;
  button.dataset['chevron'] = direction;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', direction === 'prev' ? 'M15 4 L7 12 L15 20' : 'M9 4 L17 12 L9 20');
  svg.append(path);
  button.append(svg);
  return button;
}

/**
 * Builds an option's label as a clipped, scrollable line. A label wider than the column is NOT
 * ellipsized — the bundled font renders the ellipsis as three vertically-centred dots, and a cut-off
 * word is worse than a moving one anyway. The clip fades at both edges and the focused option's text
 * slides to reveal its start (styles.css).
 */
export function optionLabelNode(text: string): HTMLElement {
  const clip = document.createElement('span');
  clip.className = 'settings-option-clip';
  const inner = document.createElement('span');
  inner.className = 'settings-option-text';
  inner.textContent = text;
  clip.append(inner);
  return clip;
}

/** The label a dropdown shows for its current value (the raw value, if no option claims it). */
function selectedLabel(row: CoreSelectRow): string {
  const option = row.options.find((candidate) => candidate.value === row.value);
  return option === undefined ? row.value : option.label;
}

/** Positions a slider's fill + knob for a 0..100 percent. */
export function applySliderPercent(fill: HTMLElement, knob: HTMLElement, percent: number): void {
  fill.style.width = `${percent}%`;
  knob.style.left = `${percent}%`;
}

/** What a value cell shows: the value, or the placeholder when the value is empty. */
function valueOrPlaceholder(
  value: string,
  placeholder: string | undefined,
): { readonly text: string; readonly empty: boolean } {
  if (value !== '') return { text: value, empty: false };
  return { text: placeholder ?? '', empty: true };
}

/**
 * The text beside an ARTWORK value — which is nothing, once there is a picture to look at. The thumbnail
 * already answers "what is set here", and repeating the name next to it only crowds the row. An EMPTY
 * artwork field still shows its placeholder, because then there is no picture and the row would
 * otherwise be blank.
 */
function artworkText(
  hasValue: boolean,
  placeholder: string | undefined,
): { readonly text: string; readonly empty: boolean } {
  if (hasValue) return { text: '', empty: false };
  return { text: placeholder ?? '', empty: true };
}

/** The summary a list row shows in place of its items: "3 items" is useless, the items are not. */
function listSummary(row: CoreListRow): { readonly text: string; readonly empty: boolean } {
  if (row.preview !== undefined) return artworkText(row.items.length > 0, row.placeholder);
  if (row.items.length > 0) return { text: row.items.join(', '), empty: false };
  return { text: row.placeholder ?? '', empty: true };
}

/** What a path row's value cell shows — the artwork rule when it draws a thumbnail. */
function pathSummary(row: CorePathRow): { readonly text: string; readonly empty: boolean } {
  if (row.preview !== undefined) return artworkText(row.value !== '', row.placeholder);
  return valueOrPlaceholder(row.value, row.placeholder);
}

/** The label side of a row (absent for a note, which is nothing but its own text). */
function appendLabelBox(el: HTMLElement, row: CoreRow): void {
  if (row.kind === 'note') return;
  const labelBox = div('setting-label-box');
  labelBox.append(div('setting-label', row.label));
  if (row.hint !== undefined) labelBox.append(div('setting-hint', row.hint));
  const error = div('setting-error', row.error ?? '');
  error.classList.toggle('is-hidden', row.error === undefined);
  labelBox.append(error);
  el.classList.toggle('has-error', row.error !== undefined);
  el.append(labelBox);
}

/** Re-applies a row's error line without rebuilding it (the validator answers on its own schedule). */
function patchError(rendered: CoreRendered, error: string | undefined): void {
  const el = rendered.el.querySelector<HTMLElement>('.setting-error');
  if (el !== null) {
    el.textContent = error ?? '';
    el.classList.toggle('is-hidden', error === undefined);
  }
  rendered.el.classList.toggle('has-error', error !== undefined);
}

/**
 * Fills an artwork row's thumbnail strip. On the site every one of these is a blob URL the page minted
 * from a file the user picked, so there is nothing to decode and nothing to cache — the launcher's
 * bounded preview cache has no counterpart here.
 */
export function applyThumbnails(
  box: HTMLElement,
  urls: readonly string[],
  aspect: PreviewAspect,
): void {
  const thumbs = urls.map((url) => {
    const image = document.createElement('img');
    image.className = 'setting-thumb';
    image.src = url;
    image.alt = '';
    return image;
  });
  box.classList.toggle('is-portrait', aspect === 'portrait');
  box.replaceChildren(...thumbs);
  box.classList.toggle('is-hidden', thumbs.length === 0);
}

/** The thumbnail strip of an artwork row, appended and filled — or null for every other row. */
function appendPreview(el: HTMLElement, row: CoreRow): HTMLElement | null {
  if (row.kind !== 'path' && row.kind !== 'list') return null;
  if (row.preview === undefined) return null;
  const box = div('setting-thumbs');
  applyThumbnails(box, row.thumbs ?? [], row.preview);
  el.append(box);
  return box;
}

/** Builds one row's element, marking it inert when the row says so. */
export function buildCoreRow(row: CoreRow): CoreRendered {
  const el = div('setting-row');
  el.dataset['kind'] = row.kind;
  el.dataset['row'] = row.id;
  if (isInert(row)) el.classList.add('is-disabled');
  if (!isFocusable(row)) el.classList.add('is-inert');
  appendLabelBox(el, row);

  switch (row.kind) {
    case 'toggle': {
      const control = div('setting-toggle');
      control.append(checkIcon());
      control.classList.toggle('is-on', row.value);
      el.append(control);
      return { el, valueEl: control, fillEl: null, previewEl: null };
    }
    case 'select': {
      const control = div('setting-select');
      const value = div('setting-value', selectedLabel(row));
      control.append(chevron('prev'), value, chevron('next'));
      el.append(control);
      return { el, valueEl: value, fillEl: null, previewEl: null };
    }
    case 'number': {
      const control = div('setting-select');
      const shown = valueOrPlaceholder(row.value, row.placeholder);
      const value = div('setting-value', shown.text);
      value.classList.toggle('is-empty', shown.empty);
      control.append(chevron('prev'), value, chevron('next'));
      el.append(control);
      return { el, valueEl: value, fillEl: null, previewEl: null };
    }
    case 'slider': {
      const control = div('setting-slider');
      const track = div('setting-track');
      const fill = div('setting-fill');
      const knob = div('setting-knob');
      track.append(fill, knob);
      const value = div('setting-value', `${row.percent}%`);
      control.append(track, value);
      applySliderPercent(fill, knob, row.percent);
      el.append(control);
      return { el, valueEl: value, fillEl: fill, previewEl: null };
    }
    case 'text':
    case 'path':
    case 'list': {
      const shown =
        row.kind === 'text'
          ? valueOrPlaceholder(row.value, row.placeholder)
          : row.kind === 'path'
            ? pathSummary(row)
            : listSummary(row);
      const value = div('setting-value setting-value-wide', shown.text);
      value.classList.toggle('is-empty', shown.empty);
      el.append(value);
      const previewEl = appendPreview(el, row);
      return { el, valueEl: value, fillEl: null, previewEl };
    }
    case 'note': {
      el.classList.add('setting-row-note', `is-${row.tone}`);
      const text = div('setting-note-text', row.text);
      el.append(text);
      return { el, valueEl: text, fillEl: null, previewEl: null };
    }
  }
}

/**
 * Applies a new model row onto an already-rendered one, touching only what changed. Rebuilding the list
 * on every keystroke would restart every transition and lose the scroll position; a change in the row
 * COMPOSITION goes through a full re-render instead.
 */
export function patchCoreRow(rendered: CoreRendered, row: CoreRow): void {
  if (row.kind !== 'note') patchError(rendered, row.error);
  switch (row.kind) {
    case 'toggle':
      rendered.valueEl.classList.toggle('is-on', row.value);
      break;
    case 'select':
      rendered.valueEl.textContent = selectedLabel(row);
      break;
    case 'slider': {
      rendered.valueEl.textContent = `${row.percent}%`;
      const knob = rendered.el.querySelector<HTMLElement>('.setting-knob');
      if (rendered.fillEl !== null && knob !== null) {
        applySliderPercent(rendered.fillEl, knob, row.percent);
      }
      break;
    }
    case 'text':
    case 'number':
    case 'path':
    case 'list': {
      const shown =
        row.kind === 'path'
          ? pathSummary(row)
          : row.kind === 'list'
            ? listSummary(row)
            : valueOrPlaceholder(row.value, row.placeholder);
      rendered.valueEl.textContent = shown.text;
      rendered.valueEl.classList.toggle('is-empty', shown.empty);
      if (rendered.previewEl !== null && (row.kind === 'path' || row.kind === 'list')) {
        if (row.preview !== undefined) {
          applyThumbnails(rendered.previewEl, row.thumbs ?? [], row.preview);
        }
      }
      break;
    }
    case 'note':
      rendered.valueEl.textContent = row.text;
      break;
  }
}
