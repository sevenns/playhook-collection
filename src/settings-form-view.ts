// DOM for the Settings screen's rows. Every kind it draws lives in row-view-core, which the Customize
// screen shares — except one: the Updates row, with its status line, its progress bar and its primary
// button, which is Settings' own here exactly as it is in the launcher (c26fae7 :
// src/renderer/settings-form-view.ts).
import { isFocusable, type SettingsRow } from './settings-form-model.js';
import { buildCoreRow, div, patchCoreRow, type CoreRendered } from './row-view-core.js';

export { optionLabelNode } from './row-view-core.js';

/** One rendered row: the model row it came from plus the nodes the controller updates. */
export interface RenderedRow extends CoreRendered {
  row: SettingsRow;
}

/** The Updates row — this screen's own kind. Its bar never moves here; nothing is downloading. */
function buildStatusRow(row: Extract<SettingsRow, { kind: 'update-status' }>): CoreRendered {
  const el = div('setting-row');
  el.dataset['kind'] = row.kind;
  el.classList.add('setting-row-status');
  if (row.inert === true) el.classList.add('is-disabled');
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
  return { el, valueEl: text, fillEl: null, previewEl: null };
}

function buildRow(row: SettingsRow): RenderedRow {
  if (row.kind === 'update-status') return { row, ...buildStatusRow(row) };
  return { row, ...buildCoreRow(row) };
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
  if (row.kind === 'update-status') {
    rendered.valueEl.textContent = row.text;
    return;
  }
  patchCoreRow(rendered, row);
}
