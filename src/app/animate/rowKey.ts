// rowKey — pressing I over a setting keys that setting (#1845), as Blender's
// `anim.keyframe_insert_button` does for the button under the mouse.
//
// A row that can be keyed says so by carrying one marked control: the diamond, or the Influence
// row's small one. The rule then needs no edit at any of the rows. Pressing I adds a key and never
// removes one: the diamond's own click toggles, which is why this calls the keyer directly and does
// not click the diamond.
//
// WHICH ROW. A row is named, never guessed from its size: a `<label>` (how most rows are built), an
// element carrying `data-key-row` (a row of several fields, which a label cannot wrap), or the
// mark's direct parent (its own label and glyph). Size does not work: the whole timebar and the
// Mesh section each hold one mark and are row-sized, and the mouse on Play is not on scene speed.

import { useEffect, useRef } from 'react';

export type RowKeyResult = { ok: true } | { ok: false; reason: string };
type RowKeyer = () => RowKeyResult;

export const ROW_KEY_ATTR = 'data-row-key';
/** On a row that is not a `<label>`: everything inside it is that one setting. */
export const KEY_ROW_ATTR = 'data-key-row';

const keyers = new WeakMap<Element, { current: RowKeyer }>();

/** Exported for the test, which has no React tree. `useRowKeyer` is the door. */
export function registerRowKeyer(el: Element, keyer: { current: RowKeyer }): () => void {
  keyers.set(el, keyer);
  return () => keyers.delete(el);
}

/** Marks the element the returned ref lands on as the key of its row. `key` is read when pressed. */
export function useRowKeyer<E extends Element>(key: RowKeyer) {
  const latest = useRef(key);
  useEffect(() => {
    latest.current = key;
  });
  const ref = useRef<E | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return registerRowKeyer(el, latest);
  }, []);
  return ref;
}

export type UnderMouse =
  | { kind: 'row'; key: RowKeyer }
  /** A field on no keyable row: it cannot be keyed, and the press says so. */
  | { kind: 'field' }
  | { kind: 'none' };

/** What a press of I finds under the mouse, from the elements hovered, outermost first. */
export function underMouse(hovered: readonly Element[]): UnderMouse {
  const deepest = hovered[hovered.length - 1];
  if (!deepest) return { kind: 'none' };
  for (let at: Element | null = deepest; at; at = at.parentElement) {
    const named = at.matches(`label, [${KEY_ROW_ATTR}]`);
    const own = at.matches(`[${ROW_KEY_ATTR}]`)
      ? [at]
      : [...at.children].filter((c) => c.matches(`[${ROW_KEY_ATTR}]`));
    if (!named && own.length === 0) continue;
    const marks = named ? [...at.querySelectorAll(`[${ROW_KEY_ATTR}]`)] : own;
    // A label with no key may be one field of a row that has one (an axis of a position).
    if (marks.length === 0) continue;
    const keyer = marks.length === 1 ? keyers.get(marks[0]) : undefined;
    if (keyer) return { kind: 'row', key: () => keyer.current() };
    break;
  }
  return deepest.closest('input, select, textarea') ? { kind: 'field' } : { kind: 'none' };
}

/** The elements under the mouse now, outermost first. The browser keeps this list itself. */
export function hoveredElements(): Element[] {
  return [...document.querySelectorAll(':hover')];
}
