// Ported 1:1 from playhook @ c348f4246752286b594c8a8eddd2253ea88b0f12 : src/renderer/dom.ts
// Do not diverge without reason — see PORTED-FROM.md.
// Small DOM lookup helpers shared across the renderer modules. Throw on a missing element
// so a broken index.html fails loudly at startup rather than producing silent null-deref bugs later.

export function req<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) throw new Error(`#${id} not found`);
  return el as T;
}

export function reqQuery<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (el === null) throw new Error(`${selector} not found`);
  return el;
}
