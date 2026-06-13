// useFlyoutSide — place a submenu (flyout) panel so it always stays within the
// viewport.
//
// THE BUG THIS KILLS (UX backlog #5, H91 family)
// ==============================================
// Both `MenuBar.tsx` (Submenu) and `AddMenu.tsx` hardcoded their submenu panel
// to `absolute left-full top-0` — always opening to the RIGHT of the trigger.
// That is a placement constant that ignores the available space (the same class
// as H91's stale toolbar anchor): a submenu off a right-side menu (View ▸
// Shading at a narrow width) or off an Add menu the root-clamp pushed against
// the right edge runs straight off the viewport — observed off-screen by 56px
// (View ▸ Shading @640w) and 191px (Add ▸ Light @1280w near the edge).
//
// THE FIX
// =======
// Measure the trigger CONTAINER's rect when the flyout opens, then choose a
// horizontal offset (relative to the container) by preference:
//   1. open RIGHT (the natural reading-order direction) if it fits;
//   2. else open LEFT if that fits (a free-floating menu near the right edge
//      with room on its left — the Add-menu case);
//   3. else CLAMP to the viewport edge (a left-aligned menu bar too narrow to
//      fit the submenu on either side — the View ▸ Shading case, where the
//      panel sits near x=0 so a left-flip would itself fall off the left edge).
// The decision runs in a layout effect (synchronously, before paint) so there
// is no visible flash on flip/clamp; the default `left: '100%'` keeps the
// common (fits-right) case flash-free even on the very first open.
//
// Shared by both menu surfaces (V34 — one placement rule, one home), so a
// future chrome relocation can never reintroduce the overflow in just one.
//
// REF: UX-BACKLOG #5; .anvi/hetvabhasa.md H91 (placement-constant family);
//      src/app/MenuBar.tsx (Submenu), src/app/AddMenu.tsx (AddMenuGroup).

import { useLayoutEffect, useRef, useState } from 'react';

export interface FlyoutPlacement<T extends HTMLElement> {
  /** Attach to the `position:relative` container that wraps the trigger + panel. */
  containerRef: React.MutableRefObject<T | null>;
  /** Inline horizontal style for the panel: `{ left }` relative to the container. */
  style: { left: number | string };
}

/**
 * @param open        whether the flyout is currently open (recompute on each open)
 * @param panelWidth  the flyout panel's width in CSS px (matches its `width`)
 * @param margin      minimum gap to keep from the viewport edge (default 8px)
 */
export function useFlyoutSide<T extends HTMLElement = HTMLElement>(
  open: boolean,
  panelWidth: number,
  margin = 8,
): FlyoutPlacement<T> {
  const containerRef = useRef<T | null>(null);
  // Default `left: '100%'` == Tailwind `left-full` == opens to the RIGHT. This
  // is the common case (a menu with room to its right), so the first paint is
  // correct with no flash; the layout effect only changes it to flip/clamp.
  const [left, setLeft] = useState<number | string>('100%');

  useLayoutEffect(() => {
    if (!open) return;
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;

    // Candidate viewport-x for the panel's LEFT edge, by preference.
    const openRight = rect.right; // panel just right of the container
    const openLeft = rect.left - panelWidth; // panel just left of the container
    let vpLeft: number;
    if (openRight + panelWidth + margin <= vw) {
      vpLeft = openRight; // (1) fits to the right
    } else if (openLeft >= margin) {
      vpLeft = openLeft; // (2) fits to the left
    } else {
      vpLeft = openRight; // (3) neither fits cleanly — start right, clamp below
    }
    // Final clamp: never let either edge leave the viewport.
    vpLeft = Math.max(margin, Math.min(vpLeft, vw - panelWidth - margin));

    // Express relative to the container (the panel is absolutely positioned in
    // it). `left-full` would be `rect.width`; we generalise to an exact offset.
    setLeft(vpLeft - rect.left);
  }, [open, panelWidth, margin]);

  return { containerRef, style: { left } };
}
