// DOM for the Settings screen's rows: a SettingsRow in, the nodes the controller patches out. Ported
// from playhook @ c26fae7 (release/v0.8.0) : src/renderer/row-view-core.ts and the Settings-specific
// half of settings-form-view.ts (the update-status row with its progress bar), i18n resolved away.
//
// Inline SVG built with createElementNS, never innerHTML: the CSP forbids external resources, and
// building the nodes is the project's rule for markup that isn't in index.html.
import { isFocusable, type SettingsRow } from './settings-form-model.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** One rendered row: the model row it came from plus the nodes the controller updates. */
export interface RenderedRow {
  /** The row's model at render time — patchRow replaces this as values change. */
  row: SettingsRow;
  /** The focusable row element; the controller toggles `is-focused` / `is-pressed`. */
  readonly el: HTMLElement;
  /** The node whose content changes: the dropdown's text, the slider's percent, the toggle's box. */
  readonly valueEl: HTMLElement;
  /** The slider's filled track, patched as the percent changes. */
  readonly fillEl: HTMLElement | null;
}

function div(className: string, text?: string): HTMLElement {
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

/** A left/right chevron of a dropdown row (clickable with the mouse). */
function chevron(direction: 'prev' | 'next'): HTMLElement {
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
 * ellipsized — the bundled font renders the ellipsis as three vertically-centred dots, and a cut-off word
 * is worse than a moving one anyway. The clip fades at both edges and the focused option's text slides to
 * reveal its start (styles.css).
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
function selectedLabel(row: Extract<SettingsRow, { kind: 'select' }>): string {
  const option = row.options.find((candidate) => candidate.value === row.value);
  return option === undefined ? row.value : option.label;
}

/** Positions a slider's fill + knob for a 0..100 percent. */
function applySliderPercent(fill: HTMLElement, knob: HTMLElement, percent: number): void {
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

/** The label side of a row (absent for the kinds that are nothing but their own content). */
function appendLabelBox(el: HTMLElement, row: SettingsRow): void {
  if (row.kind === 'note' || row.kind === 'update-status') return;
  const labelBox = div('setting-label-box');
  labelBox.append(div('setting-label', row.label));
  if (row.hint !== undefined) labelBox.append(div('setting-hint', row.hint));
  el.append(labelBox);
}

function buildRow(row: SettingsRow): RenderedRow {
  const el = div('setting-row');
  el.dataset['kind'] = row.kind;
  if (row.kind !== 'note' && row.inert === true) el.classList.add('is-disabled');
  appendLabelBox(el, row);

  switch (row.kind) {
    case 'toggle': {
      const control = div('setting-toggle');
      control.append(checkIcon());
      control.classList.toggle('is-on', row.value);
      el.append(control);
      return { row, el, valueEl: control, fillEl: null };
    }
    case 'select': {
      const control = div('setting-select');
      const value = div('setting-value', selectedLabel(row));
      control.append(chevron('prev'), value, chevron('next'));
      el.append(control);
      return { row, el, valueEl: value, fillEl: null };
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
      return { row, el, valueEl: value, fillEl: fill };
    }
    case 'text': {
      const shown = valueOrPlaceholder(row.value, row.placeholder);
      const value = div('setting-value setting-value-wide', shown.text);
      value.classList.toggle('is-empty', shown.empty);
      el.append(value);
      return { row, el, valueEl: value, fillEl: null };
    }
    case 'update-status': {
      el.classList.add('setting-row-status');
      const text = div('setting-status-text', row.text);
      const progress = div('setting-progress');
      progress.append(div('setting-progress-fill'));
      const body = div('setting-status-body');
      body.append(text, progress);
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'text-button';
      button.textContent = row.action;
      el.append(body, button);
      return { row, el, valueEl: text, fillEl: null };
    }
    case 'note': {
      el.classList.add('setting-row-note', 'is-inert', `is-${row.tone}`);
      const text = div('setting-note-text', row.text);
      el.append(text);
      return { row, el, valueEl: text, fillEl: null };
    }
  }
}

/**
 * Renders one section's rows into `container` (replacing its content) and returns the FOCUSABLE ones, in
 * screen order — a note is drawn but never held, so the navigation model is this array's indices and it
 * steps over notes by construction. The stagger index counts every row, notes included, so the arrival
 * runs down the list as it is seen.
 */
export function renderRows(
  container: HTMLElement,
  rows: readonly SettingsRow[],
  entranceSteps: number,
): readonly RenderedRow[] {
  const rendered = rows.map((row) => buildRow(row));
  rendered.forEach((row, at) =>
    row.el.style.setProperty('--row-index', String(Math.min(at, entranceSteps))),
  );
  container.replaceChildren(...rendered.map((row) => row.el));
  return rendered.filter((row) => isFocusable(row.row));
}

/**
 * Applies a new model row onto an already-rendered one, touching only what changed. Rebuilding the list
 * on every change would flash the screen and restart every transition mid-flight; a change in the row
 * COMPOSITION goes through renderRows instead.
 */
export function patchRow(rendered: RenderedRow, row: SettingsRow): void {
  rendered.row = row;
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
    case 'text': {
      const shown = valueOrPlaceholder(row.value, row.placeholder);
      rendered.valueEl.textContent = shown.text;
      rendered.valueEl.classList.toggle('is-empty', shown.empty);
      break;
    }
    case 'update-status':
    case 'note':
      rendered.valueEl.textContent = row.text;
      break;
  }
}
